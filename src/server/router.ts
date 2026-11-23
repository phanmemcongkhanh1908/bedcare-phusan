import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { HisPermissionLevel, UserRole } from '../types/bedcare';
import {
  canManageHisConfigAndQuotas,
  canSyncAndMapHis,
  canViewHisModule,
  evaluateHisAndBhytCompliance,
  parseHisPayloadInput,
  resolveEffectiveHisPermission,
} from '../utils/hisAuditEngine';
import { evaluateSystemAlerts } from '../utils/alertsEngine';
import {
  evaluateBedRegistrationRules,
  type BedRegistrationCheckResult,
} from '../utils/bedRegistrationEngine';
import {
  calculateBedOccupancyRate,
  calculateStayMetrics,
  computeExpectedDischargeAt,
  type BedDayConfig,
} from '../utils/bedDays';
import { canReserveInRoom, validateRoomAndBeds } from '../utils/roomBedValidation';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_STAFF_RESET_PASSWORD,
  MIN_USER_PASSWORD_LENGTH,
  isDefaultAdminAccount,
  validateUserDeleteRule,
  validateUserStatusRule,
  validateUserUpdateRule,
} from '../utils/userAccountRules';
import {
  analyzeCustomerRegistrationTrends,
  rankSmartTransferBeds,
} from '../utils/bedCoordinatorIntelligence';
import {
  evaluate24HourThresholdAlerts,
  predict48HourVacancies,
  predict4HourBedVacancies,
  predict7DayCapacity,
} from '../utils/vacancyPredictor';
import { SlidingWindowRateLimiter } from '../utils/serverGuards';
import { hashPassword, verifyPassword } from './crypto';
import { getConfigMap } from './db';
import { clearDemoOperationalData, seedDemoClusterIfEmpty } from './demoData';
import {
  BedcareCluster,
  ConsensusConflictError,
  SecurityRejectionError,
} from './p2pCluster';

interface AuthUser {
  id: string;
  username: string;
  full_name: string;
  role: UserRole;
  department_id: string | null;
  his_permission: HisPermissionLevel;
}

interface AuthedRequest extends Request {
  authUser?: AuthUser;
}

const TOKEN_SECRET = process.env.BEDCARE_AUTH_SECRET || 'BEDCARE-SESSION-HMAC-KEY-2026';

function signSessionToken(user: AuthUser): string {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Date.now() + 24 * 60 * 60 * 1000 }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string): AuthUser | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthUser & { exp: number };
  if (Date.now() > parsed.exp) return null;
  return {
    id: parsed.id,
    username: parsed.username,
    full_name: parsed.full_name,
    role: parsed.role,
    department_id: parsed.department_id,
    his_permission: resolveEffectiveHisPermission(parsed.role, parsed.his_permission),
  };
}

function getDayConfig(cfg: Record<string, string>): BedDayConfig {
  return {
    method: (cfg.day_calculation_method as BedDayConfig['method']) || 'CALENDAR_DAYS',
    dayStartHour: Number(cfg.day_start_hour || '0'),
    includeAdmissionDay: cfg.include_admission_day !== 'false',
    roundingRule: (cfg.rounding_rule as BedDayConfig['roundingRule']) || 'CEIL',
    dueSoonHours: Number(cfg.due_soon_hours || '24'),
  };
}

function nullIfEmpty(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

function resolvePatientIdByCode(db: ReturnType<BedcareCluster['getActiveNode']>['db'], patientCode: string, fallbackId?: string): string {
  const cleanCode = patientCode.trim();
  if (cleanCode) {
    const existing = db.prepare('SELECT id FROM patients WHERE patient_code = ?').get(cleanCode) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  return fallbackId?.trim() || `pat-${crypto.randomUUID().slice(0, 8)}`;
}

export function createBedcareRouter(cluster: BedcareCluster) {
  const router = express.Router();

  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Vui lòng đăng nhập để tiếp tục.' });
      return;
    }
    const decoded = verifySessionToken(token);
    if (!decoded) {
      res.status(401).json({ error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ.' });
      return;
    }
    // Check live user status in active node SQLite DB (synced across cluster!)
    const db = cluster.getActiveNode().db;
    const liveUser = db.prepare('SELECT id, username, full_name, role, department_id, his_permission, status FROM users WHERE id = ?').get(decoded.id) as
      | (AuthUser & { status: string })
      | undefined;
    if (!liveUser || liveUser.status !== 'ACTIVE') {
      res.status(403).json({ error: 'Tài khoản đã bị khóa hoặc thu hồi quyền truy cập.' });
      return;
    }
    req.authUser = {
      id: liveUser.id,
      username: liveUser.username,
      full_name: liveUser.full_name,
      role: liveUser.role,
      department_id: liveUser.department_id,
      his_permission: resolveEffectiveHisPermission(liveUser.role, liveUser.his_permission),
    };
    next();
  };

  const requireRoles = (...allowed: UserRole[]) => {
    return (req: AuthedRequest, res: Response, next: NextFunction) => {
      if (!req.authUser || !allowed.includes(req.authUser.role)) {
        res.status(403).json({ error: 'Tài khoản không có quyền thực hiện thao tác này.' });
        return;
      }
      next();
    };
  };

  const enforceWardScope = (user: AuthUser, targetDeptId: string): boolean => {
    if (user.role === 'WARD_STAFF' && user.department_id && user.department_id !== targetDeptId) {
      return false;
    }
    return true;
  };

  const getScopedDeptId = (user?: AuthUser): string | null => {
    if (!user) return null;
    if (user.role === 'WARD_STAFF' && user.department_id) {
      return user.department_id;
    }
    return null;
  };

  const safeParseJson = (raw: unknown): unknown => {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

  // --- AUTH ---
  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
      return;
    }
    const node = cluster.getActiveNode();
    const userRow = node.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username.trim()) as (AuthUser & { password_hash: string; status: string }) | undefined;

    if (!userRow || !verifyPassword(password, userRow.password_hash)) {
      res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
      return;
    }
    if (userRow.status !== 'ACTIVE') {
      res.status(403).json({ error: `Tài khoản đang ở trạng thái ${userRow.status}.` });
      return;
    }
    const authUser: AuthUser = {
      id: userRow.id,
      username: userRow.username,
      full_name: userRow.full_name,
      role: userRow.role,
      department_id: userRow.department_id,
      his_permission: resolveEffectiveHisPermission(userRow.role, userRow.his_permission),
    };
    const token = signSessionToken(authUser);
    res.json({
      token,
      user: authUser,
      activeNode: {
        deviceId: node.deviceId,
        nodeName: node.nodeName,
        isCoordinator: node.isCoordinator,
      },
    });
  });

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
    const node = cluster.getActiveNode();
    res.json({
      user: req.authUser,
      activeNode: {
        deviceId: node.deviceId,
        nodeName: node.nodeName,
        isCoordinator: node.isCoordinator,
        online: node.online,
        partitionGroup: node.partitionGroup,
      },
    });
  });

  // --- HEALTH ---
  router.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const active = cluster.getActiveNode();
    res.json({
      ok: true,
      activeNodeId: active.deviceId,
      nodeCount: cluster.nodes.size,
      quorumRequired: cluster.getRequiredQuorum(),
    });
  });

  // Protect unauthenticated customer portal endpoints against polling/flood storms
  const publicPortalLimiter = new SlidingWindowRateLimiter(90, 60_000);
  router.use('/public', (req, res, next) => {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const clientIp = forwarded || req.socket.remoteAddress || 'unknown';
    const check = publicPortalLimiter.check(clientIp);
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSeconds));
      res.status(429).json({
        error: `Bạn đang gửi yêu cầu quá nhanh. Vui lòng thử lại sau ${check.retryAfterSeconds} giây.`,
      });
      return;
    }
    next();
  });

  // --- PUBLIC CUSTOMER PORTAL (UNAUTHENTICATED, ZERO PATIENT PII) ---
  router.get('/public/availability', (_req, res) => {
    const db = cluster.getActiveNode().db;
    const depts = db
      .prepare("SELECT id, code, name, description FROM departments WHERE status = 'ACTIVE' ORDER BY name ASC")
      .all() as Array<{ id: string; code: string; name: string; description: string }>;
    const rooms = db
      .prepare(
        `SELECT id, department_id, code, name, floor, capacity, toilet_type, room_type, is_service,
                standard_ids, exclusive_locked, occupancy_status
         FROM rooms
         WHERE status = 'ACTIVE'
         ORDER BY code ASC`
      )
      .all() as Array<Record<string, unknown>>;
    const beds = db
      .prepare(
        `SELECT b.id, b.room_id, b.department_id, b.code, b.name, b.status,
                bt.id as bed_type_id, bt.code as bed_type_code, bt.name as bed_type_name,
                COALESCE(NULLIF(b.daily_price, 0), bt.daily_price, 0) as daily_price,
                COALESCE(bt.hourly_price, 0) as hourly_price
         FROM beds b
         LEFT JOIN bed_types bt ON b.bed_type_id = bt.id
         WHERE b.status != 'INACTIVE'
         ORDER BY b.code ASC`
      )
      .all() as Array<Record<string, unknown>>;
    const roomStandards = db
      .prepare("SELECT id, name, code, category, description, attributes FROM room_standards WHERE status = 'ACTIVE' ORDER BY is_default DESC, name ASC")
      .all() as Array<Record<string, unknown>>;
    const bedTypes = db
      .prepare("SELECT id, code, name, daily_price, hourly_price, description FROM bed_types WHERE status = 'ACTIVE' ORDER BY daily_price ASC")
      .all();
    const diagnoses = db
      .prepare('SELECT id, name, default_days, description FROM diagnosis_configs WHERE is_active = 1 ORDER BY name ASC')
      .all();

    const stdMap = Object.fromEntries(roomStandards.map((s) => [String(s.id), String(s.name)]));

    const roomsView = rooms.map((r) => {
      const rBeds = beds.filter((b) => b.room_id === r.id);
      const vacantBeds = rBeds.filter((b) => b.status === 'VACANT');
      const standardIds = (safeParseJson(r.standard_ids) as string[]) || [];
      const canBookWholeRoom = !r.exclusive_locked && rBeds.length > 0 && rBeds.every((b) => b.status === 'VACANT');
      const reserveCheck = canReserveInRoom(
        {
          code: String(r.code),
          name: String(r.name),
          exclusive_locked: Number(r.exclusive_locked ?? 0),
        },
        rBeds.map((b) => ({ code: String(b.code), status: String(b.status) }))
      );
      return {
        id: String(r.id),
        department_id: String(r.department_id),
        code: String(r.code),
        name: String(r.name),
        floor: String(r.floor || 'Tầng 1'),
        capacity: Number(r.capacity ?? 1),
        toilet_type: String(r.toilet_type || 'INTERNAL'),
        room_type: String(r.room_type || 'STANDARD'),
        is_service: Boolean(r.is_service),
        exclusive_locked: Boolean(r.exclusive_locked),
        occupancy_status: String(r.occupancy_status || 'AVAILABLE'),
        can_reserve_single_bed: reserveCheck.allowed,
        reserve_block_reason: reserveCheck.reason ?? null,
        can_book_whole_room: canBookWholeRoom,
        standard_ids: standardIds,
        standard_names: standardIds.map((sid) => stdMap[sid] || sid),
        total_beds: rBeds.length,
        vacant_beds_count: vacantBeds.length,
        min_daily_price: vacantBeds.length > 0 ? Math.min(...vacantBeds.map((b) => Number(b.daily_price || 0))) : 0,
        vacant_beds: vacantBeds.map((b) => ({
          id: String(b.id),
          code: String(b.code),
          name: String(b.name),
          bed_type_name: String(b.bed_type_name || 'Giường tiêu chuẩn'),
          daily_price: Number(b.daily_price || 0),
          hourly_price: Number(b.hourly_price || 0),
        })),
      };
    });

    const departmentsView = depts.map((d) => {
      const dRooms = roomsView.filter((r) => r.department_id === d.id);
      const totalBeds = dRooms.reduce((sum, r) => sum + r.total_beds, 0);
      const vacantBeds = dRooms.reduce((sum, r) => sum + r.vacant_beds_count, 0);
      return {
        ...d,
        total_rooms: dRooms.length,
        total_beds: totalBeds,
        vacant_beds: vacantBeds,
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      departments: departmentsView,
      rooms: roomsView,
      roomStandards: roomStandards.map((s) => ({
        ...s,
        attributes: safeParseJson(s.attributes) || {},
      })),
      bedTypes,
      diagnoses,
    });
  });

  router.post('/public/bookings', (req, res) => {
    try {
      const b = req.body as {
        patient_name?: string;
        full_name?: string;
        phone: string;
        date_of_birth?: string;
        diagnosis_group?: string;
        expected_admission_date?: string;
        desired_standard_ids?: string[];
        department_id?: string | null;
        room_id?: string | null;
        bed_id?: string | null;
        booking_type?: 'WAITLIST' | 'SINGLE_BED' | 'WHOLE_ROOM';
        notes?: string;
      };

      const cleanName = (b.patient_name || b.full_name)?.trim();
      const cleanPhone = b.phone?.trim() || '';
      const phoneDigits = cleanPhone.replace(/\D/g, '');
      if (!cleanName || phoneDigits.length < 8 || phoneDigits.length > 15) {
        res.status(400).json({ error: 'Vui lòng nhập đầy đủ họ tên và số điện thoại hợp lệ (8–15 chữ số).' });
        return;
      }

      if (b.expected_admission_date && Number.isNaN(new Date(b.expected_admission_date).getTime())) {
        res.status(400).json({ error: 'Thời gian dự kiến nhập viện không hợp lệ.' });
        return;
      }
      if (b.date_of_birth && Number.isNaN(new Date(b.date_of_birth).getTime())) {
        res.status(400).json({ error: 'Ngày sinh không hợp lệ.' });
        return;
      }

      const db = cluster.getActiveNode().db;
      const cfg = getConfigMap(db);
      const dayCfg = getDayConfig(cfg);
      const diagName = b.diagnosis_group?.trim() || 'Khác';
      const diagRow = db.prepare('SELECT default_days FROM diagnosis_configs WHERE name = ?').get(diagName) as
        | { default_days: number }
        | undefined;

      let cleanDeptId = nullIfEmpty(b.department_id);
      let cleanRoomId = nullIfEmpty(b.room_id);
      const cleanBedId = nullIfEmpty(b.bed_id);
      const bookingType = b.booking_type || (cleanBedId ? 'SINGLE_BED' : cleanRoomId ? 'WHOLE_ROOM' : 'WAITLIST');
      if (!['WAITLIST', 'SINGLE_BED', 'WHOLE_ROOM'].includes(bookingType)) {
        res.status(400).json({ error: 'Hình thức đặt giường không hợp lệ.' });
        return;
      }

      if (cleanDeptId && !db.prepare("SELECT id FROM departments WHERE id = ? AND status = 'ACTIVE'").get(cleanDeptId)) {
        res.status(400).json({ error: 'Khoa lựa chọn không còn hoạt động.' });
        return;
      }

      let roomRow:
        | { id: string; code: string; name: string; department_id: string; exclusive_locked: number }
        | undefined;
      if (cleanRoomId) {
        roomRow = db
          .prepare("SELECT id, code, name, department_id, exclusive_locked FROM rooms WHERE id = ? AND status = 'ACTIVE'")
          .get(cleanRoomId) as typeof roomRow;
        if (!roomRow) {
          res.status(400).json({ error: 'Phòng lựa chọn không còn hoạt động.' });
          return;
        }
        if (cleanDeptId && roomRow.department_id !== cleanDeptId) {
          res.status(400).json({ error: 'Phòng lựa chọn không thuộc khoa đã chọn.' });
          return;
        }
        if (!cleanDeptId) cleanDeptId = roomRow.department_id;
        if (roomRow.exclusive_locked) {
          res.status(409).json({
            error: `Phòng ${roomRow.name} hiện đang được khóa bao trọn riêng tư. Vui lòng chọn phòng khác hoặc đăng ký chờ khoa xếp giường.`,
          });
          return;
        }
      }

      if (cleanBedId) {
        const bedRow = db
          .prepare('SELECT id, code, room_id, department_id, status FROM beds WHERE id = ?')
          .get(cleanBedId) as
          | { id: string; code: string; room_id: string; department_id: string; status: string }
          | undefined;
        if (!bedRow) {
          res.status(400).json({ error: 'Giường lựa chọn không tồn tại.' });
          return;
        }
        if (cleanRoomId && bedRow.room_id !== cleanRoomId) {
          res.status(400).json({ error: 'Giường lựa chọn không thuộc phòng đã chọn.' });
          return;
        }
        if (cleanDeptId && bedRow.department_id !== cleanDeptId) {
          res.status(400).json({ error: 'Giường lựa chọn không thuộc khoa đã chọn.' });
          return;
        }
        if (!cleanRoomId) {
          cleanRoomId = bedRow.room_id;
          roomRow = db
            .prepare("SELECT id, code, name, department_id, exclusive_locked FROM rooms WHERE id = ? AND status = 'ACTIVE'")
            .get(cleanRoomId) as typeof roomRow;
        }
        if (!cleanDeptId) cleanDeptId = bedRow.department_id;
        if (bedRow.status !== 'VACANT') {
          res.status(409).json({ error: 'Giường bạn vừa chọn đã có người đăng ký hoặc đang sử dụng. Vui lòng chọn giường khác.' });
          return;
        }
        if (roomRow) {
          const roomBeds = db
            .prepare("SELECT code, status FROM beds WHERE room_id = ? AND status != 'INACTIVE'")
            .all(roomRow.id) as Array<{ code: string; status: string }>;
          const reserveCheck = canReserveInRoom(
            { code: roomRow.code, name: roomRow.name, exclusive_locked: roomRow.exclusive_locked },
            roomBeds
          );
          if (!reserveCheck.allowed) {
            res.status(409).json({
              error: `Phòng ${roomRow.name} hiện đã có sản phụ đang nằm điều trị nên hệ thống không nhận đặt giữ lẻ giường cùng phòng. Quý khách vui lòng chọn phòng trống khác hoặc chọn "Nhờ khoa xếp giường phù hợp".`,
            });
            return;
          }
        }
      }

      if (bookingType === 'WHOLE_ROOM') {
        if (!cleanRoomId || !roomRow) {
          res.status(400).json({ error: 'Vui lòng chọn phòng cụ thể để đăng ký bao trọn phòng.' });
          return;
        }
        const roomBeds = db
          .prepare("SELECT id, code, status FROM beds WHERE room_id = ? AND status != 'INACTIVE'")
          .all(cleanRoomId) as Array<{ id: string; code: string; status: string }>;
        if (roomBeds.length === 0 || roomBeds.some((bed) => bed.status !== 'VACANT')) {
          res.status(409).json({
            error: `Phòng ${roomRow.name} hiện không còn trống toàn bộ giường để bao trọn phòng. Vui lòng chọn phòng khác.`,
          });
          return;
        }
      }

      const expectedAdmit = b.expected_admission_date
        ? new Date(b.expected_admission_date).toISOString()
        : new Date().toISOString();
      const expectedDischarge = computeExpectedDischargeAt(expectedAdmit, diagRow?.default_days ?? 3, dayCfg);
      const regId = `reg-${crypto.randomUUID().slice(0, 8)}`;
      const patCode = `KH-${new Date().getFullYear().toString().slice(-2)}${String(Math.floor(10000 + Math.random() * 89999))}`;
      const patId = resolvePatientIdByCode(db, patCode);
      const regCode = `DK-KH-${String(Math.floor(10000 + Math.random() * 89999))}`;
      const deptName = cleanDeptId
        ? ((db.prepare('SELECT name FROM departments WHERE id = ?').get(cleanDeptId) as { name: string } | undefined)?.name ?? '')
        : 'Chờ điều phối khoa';
      const roomName = cleanRoomId
        ? ((db.prepare('SELECT name FROM rooms WHERE id = ?').get(cleanRoomId) as { name: string } | undefined)?.name ?? '')
        : '';
      const bedCode = cleanBedId
        ? ((db.prepare('SELECT code FROM beds WHERE id = ?').get(cleanBedId) as { code: string } | undefined)?.code ?? '')
        : '';

      cluster.commitStandardEvent(cluster.activeNodeId, 'customer-portal', 'REGISTRATION_CREATE', 'REGISTRATION', regId, {
        id: regId,
        registration_code: regCode,
        patient_id: patId,
        patient_code: patCode,
        his_record_code: '',
        patient_name: cleanName,
        date_of_birth: b.date_of_birth || '1990-01-01',
        phone: cleanPhone,
        diagnosis_group: diagName,
        expected_admission_date: expectedAdmit,
        expected_discharge_date: expectedDischarge,
        desired_standard_ids: Array.isArray(b.desired_standard_ids) ? b.desired_standard_ids : [],
        registration_mode: cleanDeptId ? 'KNOWN_DEPT' : 'UNKNOWN_DEPT',
        department_id: cleanDeptId,
        room_id: cleanRoomId,
        bed_id: cleanBedId,
        reservation_type: bookingType,
        status: 'WAITING',
        notes: `[Đặt trực tuyến bởi Khách hàng]${b.notes?.trim() ? ` ${b.notes.trim()}` : ''}`,
        created_by: 'customer-portal',
        created_by_name: 'Cổng Khách hàng (Đặt trực tuyến)',
        audit_action: 'CUSTOMER_PORTAL_BOOKING',
        audit_details: `Khách hàng ${cleanName} (${cleanPhone}) gửi yêu cầu đặt giường ${regCode}`,
      });

      res.status(201).json({
        id: regId,
        registration_code: regCode,
        status: 'WAITING',
        department_name: deptName,
        room_name: roomName,
        bed_code: bedCode,
        expected_admission_date: expectedAdmit,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/public/bookings/:code', (req, res) => {
    const cleanCode = String(req.params.code || '').trim().toUpperCase();
    if (!cleanCode) {
      res.status(400).json({ error: 'Vui lòng nhập mã phiếu đăng ký.' });
      return;
    }
    const db = cluster.getActiveNode().db;
    const row = db
      .prepare(
        `SELECT reg.registration_code, reg.status, reg.reservation_type, reg.expected_admission_date,
                reg.created_at, reg.created_by_name,
                d.name as department_name, r.name as room_name, b.code as bed_code
         FROM registrations reg
         LEFT JOIN departments d ON reg.department_id = d.id
         LEFT JOIN rooms r ON reg.room_id = r.id
         LEFT JOIN beds b ON reg.bed_id = b.id
         WHERE UPPER(reg.registration_code) = ?
         LIMIT 1`
      )
      .get(cleanCode) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: `Không tìm thấy hồ sơ đăng ký mã ${cleanCode}.` });
      return;
    }
    res.json(row);
  });

  // --- CLUSTER / NODES / SYNC / CONSENSUS ---
  router.get('/cluster/status', requireAuth, (_req, res) => {
    const active = cluster.getActiveNode();
    const devices = active.db.prepare('SELECT * FROM devices ORDER BY is_coordinator DESC, node_name ASC').all();
    const events = (active.db.prepare('SELECT * FROM events ORDER BY sequence_no DESC LIMIT 80').all() as Array<Record<string, unknown>>).map((ev) => ({
      ...ev,
      payload_parsed: safeParseJson(ev.payload),
    }));
    const syncQueue = (
      active.db
        .prepare(
          `SELECT sq.*, e.event_type, e.aggregate_type, e.aggregate_id, e.device_id as source_device_id,
                  e.user_id, e.lamport_clock, e.payload as event_payload
           FROM sync_queue sq
           LEFT JOIN events e ON sq.event_id = e.event_id
           ORDER BY sq.created_at DESC
           LIMIT 80`
        )
        .all() as Array<Record<string, unknown>>
    ).map((sq) => ({
      ...sq,
      payload_parsed: safeParseJson(sq.event_payload),
    }));
    const consensusLogs = active.db.prepare('SELECT * FROM consensus_log ORDER BY created_at DESC LIMIT 80').all();
    const conflicts = active.db.prepare('SELECT * FROM conflicts ORDER BY created_at DESC LIMIT 50').all();
    const pendingRequests = (active.db.prepare('SELECT * FROM pending_requests ORDER BY created_at DESC LIMIT 50').all() as Array<Record<string, unknown>>).map((pr) => ({
      ...pr,
      payload_parsed: safeParseJson(pr.payload),
    }));

    const runtimeNodes = Array.from(cluster.nodes.values()).map((n) => ({
      deviceId: n.deviceId,
      nodeName: n.nodeName,
      departmentId: n.departmentId,
      online: n.online,
      revoked: n.revoked,
      isCoordinator: n.isCoordinator,
      partitionGroup: n.partitionGroup,
      lamportClock: n.lamportClock,
      term: n.term,
      eventCount: (n.db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c,
      pendingSyncCount: (n.db.prepare("SELECT COUNT(*) as c FROM sync_queue WHERE status = 'PENDING'").get() as { c: number }).c,
    }));

    res.json({
      activeNodeId: cluster.activeNodeId,
      quorumRequired: cluster.getRequiredQuorum(),
      runtimeNodes,
      devices,
      events,
      syncQueue,
      consensusLogs,
      conflicts,
      pendingRequests,
    });
  });

  router.post('/cluster/switch-node', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req, res) => {
    const { deviceId } = req.body as { deviceId: string };
    if (!cluster.nodes.has(deviceId)) {
      res.status(404).json({ error: 'Không tìm thấy thiết bị.' });
      return;
    }
    cluster.activeNodeId = deviceId;
    res.json({ activeNodeId: deviceId });
  });

  router.post('/cluster/node-state', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req, res) => {
    const { deviceId, online, isCoordinator, partitionGroup } = req.body as {
      deviceId: string;
      online?: boolean;
      isCoordinator?: boolean;
      partitionGroup?: string;
    };
    cluster.setNodeState(deviceId, { online, isCoordinator, partitionGroup });
    res.json({ ok: true });
  });

  router.post('/cluster/reconcile', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF', 'CASHIER'), async (_req, res) => {
    const result = await cluster.reconcileCluster();
    res.json(result);
  });

  router.post('/cluster/conflicts/:id/resolve', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req, res) => {
    const { resolutionNote } = req.body as { resolutionNote?: string };
    const now = new Date().toISOString();
    for (const node of cluster.nodes.values()) {
      node.db
        .prepare("UPDATE conflicts SET status = 'RESOLVED', resolution_note = ?, resolved_at = ? WHERE id = ?")
        .run(resolutionNote || 'Đã kiểm tra và xác nhận thủ công', now, req.params.id);
    }
    res.json({ ok: true });
  });

  router.post('/cluster/simulate-race', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), async (req: AuthedRequest, res) => {
    const { bedId, nodeIds } = req.body as { bedId: string; nodeIds?: string[] };
    const candidates = (nodeIds && nodeIds.length >= 2 ? nodeIds : Array.from(cluster.nodes.keys())).slice(0, 5);
    const activeDb = cluster.getActiveNode().db;
    const bed = activeDb.prepare('SELECT * FROM beds WHERE id = ?').get(bedId) as
      | { id: string; room_id: string; department_id: string; code: string; status: string }
      | undefined;

    if (!bed) {
      res.status(404).json({ error: 'Không tìm thấy giường.' });
      return;
    }

    const runTag = crypto.randomUUID().slice(0, 5).toUpperCase();
    const attempts = await Promise.allSettled(
      candidates.map((nid, idx) => {
        const admId = `adm-race-${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        return cluster.proposeCriticalAllocation({
          nodeId: nid,
          userId: req.authUser!.id,
          requestType: 'ASSIGN_BED',
          eventType: 'ADMISSION_CONFIRM',
          aggregateType: 'ADMISSION',
          aggregateId: admId,
          bedId: bed.id,
          roomId: bed.room_id,
          payloadObj: {
            id: admId,
            admission_code: `RACE-${runTag}-${idx + 1}`,
            patient_id: `pat-race-${runTag}-${idx + 1}`,
            patient_code: `BN-RACE-${runTag}-${idx + 1}`,
            patient_name: `Bệnh nhân Kiểm thử Race #${idx + 1} (${nid})`,
            date_of_birth: '1995-01-01',
            phone: '0900000000',
            diagnosis_group: 'Sinh thường',
            department_id: bed.department_id,
            room_id: bed.room_id,
            bed_id: bed.id,
            is_whole_room: false,
            hospital_admitted_at: now,
            bed_assigned_at: now,
            expected_discharge_at: new Date(Date.now() + 3 * 86400000).toISOString(),
            calculation_method: 'CALENDAR_DAYS',
            status: 'ACTIVE',
            notes: `Kiểm thử đồng thời từ ${nid}`,
            confirmed_by: req.authUser!.id,
            confirmed_by_name: req.authUser!.full_name,
          },
        });
      })
    );

    const results = attempts.map((r, i) => ({
      nodeId: candidates[i],
      outcome: r.status === 'fulfilled' ? (r.value.pendingConfirmation ? 'PENDING_QUORUM' : 'WON_COMMITTED') : 'REJECTED_CONFLICT',
      detail: r.status === 'fulfilled' ? r.value.event.event_id : (r.reason as Error).message,
    }));
    res.json({ bedCode: bed.code, results });
  });

  // --- DEVICES ---
  router.post('/devices/pair', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { nodeName, departmentId } = req.body as { nodeName: string; departmentId?: string | null };
    if (!nodeName?.trim()) {
      res.status(400).json({ error: 'Tên thiết bị không được để trống.' });
      return;
    }
    const created = cluster.pairNewDevice(nodeName.trim(), departmentId || null, req.authUser!.id);
    res.status(201).json({ deviceId: created.deviceId, nodeName: created.nodeName });
  });

  router.post('/devices/:deviceId/revoke', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    try {
      cluster.revokeDevice(req.params.deviceId, req.authUser!.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // --- DASHBOARD & OVERVIEW ---
  router.get('/dashboard/overview', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const cfg = getConfigMap(db);
    const dayCfg = getDayConfig(cfg);
    const nowIso = new Date().toISOString();
    const nowMs = new Date(nowIso).getTime();
    const scopedDeptId = getScopedDeptId(req.authUser);

    const allDepts = db.prepare('SELECT * FROM departments ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    const allRooms = db.prepare('SELECT * FROM rooms').all() as Array<Record<string, unknown>>;
    const allBeds = db
      .prepare(
        `SELECT b.*, r.code as room_code, r.name as room_name, r.floor, r.room_type, r.standard_ids,
                r.exclusive_locked, r.exclusive_lock_id,
                bt.daily_price as bt_daily_price,
                COALESCE(NULLIF(b.daily_price, 0), bt.daily_price, 0) as effective_daily_price,
                a.patient_name, a.patient_code,
                rsv.patient_name as rsv_patient_name,
                cl.id as cleaning_log_id, cl.status as cleaning_status, cl.requested_at as cleaning_requested_at
         FROM beds b
         JOIN rooms r ON b.room_id = r.id
         LEFT JOIN bed_types bt ON b.bed_type_id = bt.id
         LEFT JOIN admissions a ON b.current_admission_id = a.id
         LEFT JOIN reservations rsv ON b.current_reservation_id = rsv.id
         LEFT JOIN cleaning_logs cl ON cl.bed_id = b.id AND cl.status IN ('PENDING', 'IN_PROGRESS')
         ORDER BY r.code ASC, b.code ASC`
      )
      .all() as Array<Record<string, unknown>>;
    const rawAdmissions = db.prepare('SELECT * FROM admissions').all() as Array<Record<string, unknown>>;
    const rawReservations = db.prepare("SELECT * FROM reservations WHERE status = 'ACTIVE'").all() as Array<Record<string, unknown>>;
    const rawRegistrations = db.prepare('SELECT * FROM registrations').all() as Array<Record<string, unknown>>;
    const devices = db.prepare('SELECT * FROM devices').all() as Array<Record<string, unknown>>;
    const rawPendingTransferReqs = db
      .prepare(
        `SELECT tr.*, fd.name as from_department_name, td.name as to_department_name,
                fb.code as from_bed_code, tb.code as to_bed_code
         FROM transfer_requests tr
         JOIN departments fd ON tr.from_department_id = fd.id
         JOIN departments td ON tr.to_department_id = td.id
         JOIN beds fb ON tr.from_bed_id = fb.id
         JOIN beds tb ON tr.to_bed_id = tb.id
         WHERE tr.status = 'PENDING'
         ORDER BY tr.requested_at ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const depts = scopedDeptId ? allDepts.filter((d) => d.id === scopedDeptId) : allDepts;
    const rooms = scopedDeptId ? allRooms.filter((r) => r.department_id === scopedDeptId) : allRooms;
    const beds = scopedDeptId ? allBeds.filter((b) => b.department_id === scopedDeptId) : allBeds;
    const allAdmissions = scopedDeptId ? rawAdmissions.filter((a) => a.department_id === scopedDeptId) : rawAdmissions;
    const admissions = allAdmissions.filter((a) => a.status === 'ACTIVE' || a.status === 'PENDING_CONFIRMATION');
    const reservations = scopedDeptId ? rawReservations.filter((r) => r.department_id === scopedDeptId) : rawReservations;
    const allRegistrations = scopedDeptId
      ? rawRegistrations.filter((r) => !r.department_id || r.department_id === scopedDeptId)
      : rawRegistrations;
    const registrations = allRegistrations.filter((r) => r.status === 'WAITING');
    const pendingTransferReqs = scopedDeptId
      ? rawPendingTransferReqs.filter((tr) => tr.from_department_id === scopedDeptId || tr.to_department_id === scopedDeptId)
      : rawPendingTransferReqs;

    const pendingSyncCount = (db.prepare("SELECT COUNT(*) as c FROM sync_queue WHERE status = 'PENDING'").get() as { c: number }).c;
    const openConflictCount = (db.prepare("SELECT COUNT(*) as c FROM conflicts WHERE status = 'OPEN'").get() as { c: number }).c;
    const failedBackupCount = (db.prepare("SELECT COUNT(*) as c FROM backups WHERE status = 'FAILED'").get() as { c: number }).c;
    const pendingRequestCount = (db.prepare("SELECT COUNT(*) as c FROM pending_requests WHERE status = 'WAITING_QUORUM'").get() as { c: number }).c;

    const deptNames: Record<string, string> = {};
    for (const d of depts) deptNames[d.id as string] = d.name as string;

    const roomMap = new Map<string, Record<string, unknown>>();
    const roomNames: Record<string, string> = {};
    for (const r of rooms) {
      roomNames[r.id as string] = r.name as string;
      roomMap.set(String(r.id), r);
    }

    const enrichedBeds: Array<Record<string, unknown>> = beds.map((b) => ({
      ...b,
      department_name: deptNames[b.department_id as string] ?? '',
      room_name: String(b.room_name ?? roomNames[b.room_id as string] ?? ''),
      daily_price: Number(b.effective_daily_price ?? b.daily_price ?? 0),
      exclusive_locked: Boolean(b.exclusive_locked),
      is_exclusive_companion: Boolean(
        b.exclusive_locked && !b.current_admission_id && (b.status === 'RESERVED' || b.status === 'PENDING_CONFIRMATION')
      ),
      reservation_patient_name: (b.rsv_patient_name as string | null) ?? null,
      standard_ids: JSON.parse((b.standard_ids as string) || '[]'),
    }));

    const bedCodes: Record<string, string> = {};
    for (const b of beds) bedCodes[b.id as string] = b.code as string;

    const enrichedAdmissions: Array<Record<string, unknown>> = admissions.map((a) => {
      const rm = roomMap.get(String(a.room_id));
      return {
        ...a,
        bed_code: bedCodes[a.bed_id as string] ?? '',
        room_name: rm ? String(rm.name ?? '') : '',
        room_type: rm ? String(rm.room_type ?? 'STANDARD') : 'STANDARD',
        floor: rm ? String(rm.floor ?? 'Tầng 1') : 'Tầng 1',
        department_name: deptNames[a.department_id as string] ?? '',
      };
    });

    const alerts = evaluateSystemAlerts({
      admissions: enrichedAdmissions as never[],
      reservations: reservations.map((r) => ({ ...r, room_name: roomNames[r.room_id as string] ?? '' })) as never[],
      registrations: registrations as never[],
      beds: enrichedBeds as never[],
      devices: devices as never[],
      pendingSyncCount,
      openConflictCount,
      failedBackupCount,
      pendingRequestCount,
      deptNames,
      dayConfig: dayCfg,
      reservationWarnMinutes: Number(cfg.reservation_warn_minutes || '120'),
      nowIso,
    });

    const countByStatus = (status: string) => beds.filter((b) => b.status === status).length;
    const operationalBeds = beds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length;
    const occupiedCount = countByStatus('OCCUPIED');

    const deptStats = depts.map((d) => {
      const dBeds = beds.filter((b) => b.department_id === d.id);
      const dOps = dBeds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length;
      const dOcc = dBeds.filter((b) => b.status === 'OCCUPIED').length;
      return {
        ...d,
        total_rooms: rooms.filter((r) => r.department_id === d.id).length,
        total_beds: dBeds.length,
        occupied_beds: dOcc,
        vacant_beds: dBeds.filter((b) => b.status === 'VACANT').length,
        reserved_beds: dBeds.filter((b) => b.status === 'RESERVED').length,
        cleaning_beds: dBeds.filter((b) => b.status === 'PENDING_CLEANING' || b.status === 'CLEANING').length,
        maintenance_beds: dBeds.filter((b) => b.status === 'MAINTENANCE').length,
        occupancy_rate: calculateBedOccupancyRate(dOcc, dOps),
      };
    });

    const dueSoonCount = alerts.filter((a) => a.type === 'BED_DUE_SOON' || a.type === 'BED_DUE_TODAY').length;
    const overdueCount = alerts.filter((a) => a.type === 'BED_OVERDUE').length;

    const historicalDischarges = db
      .prepare("SELECT diagnosis_group, bed_assigned_at, actual_discharge_at FROM admissions WHERE status = 'DISCHARGED' AND actual_discharge_at IS NOT NULL")
      .all() as Array<{ diagnosis_group: string; bed_assigned_at: string; actual_discharge_at: string }>;
    const diagnosisBaselines = db
      .prepare('SELECT name, default_days FROM diagnosis_configs WHERE is_active = 1')
      .all() as Array<{ name: string; default_days: number }>;

    const activeStayInputs = enrichedAdmissions.map((a) => ({
      id: String(a.id),
      bed_id: String(a.bed_id),
      bed_code: String(a.bed_code ?? ''),
      room_id: String(a.room_id),
      room_name: String(a.room_name ?? ''),
      department_id: String(a.department_id),
      department_name: String(a.department_name ?? ''),
      patient_name: String(a.patient_name ?? ''),
      diagnosis_group: String(a.diagnosis_group ?? ''),
      bed_assigned_at: String(a.bed_assigned_at),
      expected_discharge_at: String(a.expected_discharge_at),
      extension_count: Number(a.extension_count ?? 0),
      is_whole_room: Number(a.is_whole_room ?? 0),
      status: String(a.status),
    }));

    const turnaroundInputs = enrichedBeds.map((b) => ({
      id: String(b.id),
      code: String(b.code),
      room_id: String(b.room_id),
      room_name: String(b.room_name ?? ''),
      department_id: String(b.department_id),
      department_name: String(b.department_name ?? ''),
      status: String(b.status),
      updated_at: String(b.updated_at ?? ''),
    }));

    const predictiveAdmissions = allAdmissions.map((a) => ({
      id: String(a.id),
      department_id: String(a.department_id),
      bed_assigned_at: String(a.bed_assigned_at),
      expected_discharge_at: String(a.expected_discharge_at),
      actual_discharge_at: a.actual_discharge_at ? String(a.actual_discharge_at) : null,
      status: String(a.status),
      diagnosis_group: String(a.diagnosis_group ?? ''),
    }));

    const predictiveRegistrations = allRegistrations.map((r) => ({
      id: String(r.id),
      department_id: r.department_id ? String(r.department_id) : null,
      expected_admission_date: String(r.expected_admission_date),
      status: String(r.status),
    }));

    const predictiveBeds = beds.map((b) => ({
      id: String(b.id),
      department_id: String(b.department_id),
      status: String(b.status),
    }));

    const vacancyPrediction = predict4HourBedVacancies({
      activeAdmissions: activeStayInputs,
      turnaroundBeds: turnaroundInputs,
      historicalDischarges,
      diagnosisBaselines,
      nowIso,
    });

    const vacancyPrediction48h = predict48HourVacancies({
      activeAdmissions: activeStayInputs,
      allAdmissions: predictiveAdmissions,
      turnaroundBeds: turnaroundInputs,
      vacantBedCount: countByStatus('VACANT'),
      operationalBedCount: operationalBeds,
      registrations: predictiveRegistrations,
      historicalDischarges,
      diagnosisBaselines,
      nowIso,
    });

    const capacityForecast7d = predict7DayCapacity({
      activeAdmissions: activeStayInputs,
      allAdmissions: predictiveAdmissions,
      beds: predictiveBeds,
      registrations: predictiveRegistrations,
      historicalDischarges,
      diagnosisBaselines,
      nowIso,
    });

    const thresholdAlerts24h = evaluate24HourThresholdAlerts({
      departments: depts.map((d) => ({ id: String(d.id), name: String(d.name), status: String(d.status) })),
      beds: predictiveBeds,
      activeAdmissions: activeStayInputs,
      registrations: predictiveRegistrations,
      reservations: reservations.map((r) => ({
        id: String(r.id),
        department_id: String(r.department_id),
        status: String(r.status),
        is_whole_room: Number(r.is_whole_room ?? 0),
      })),
      nowIso,
    });

    const criticalCapacityDepartments = deptStats
      .filter((d) => Number(d.occupancy_rate) > 90)
      .sort((a, b) => Number(b.occupancy_rate) - Number(a.occupancy_rate));

    const triagePatients = enrichedAdmissions
      .filter((a) => a.status === 'ACTIVE')
      .map((a) => {
        const expectedMs = new Date(String(a.expected_discharge_at)).getTime();
        const overdueHours = (nowMs - expectedMs) / 3600000;
        const storedPriority = String(a.triage_priority || 'NORMAL');
        const noteAlert = String(a.vitals_alert || '');

        let computedPriority: 'CRITICAL' | 'HIGH' | 'NORMAL' = 'NORMAL';
        const reasons: string[] = [];
        if (storedPriority === 'CRITICAL' || overdueHours > 0) {
          computedPriority = 'CRITICAL';
        } else if (storedPriority === 'HIGH' || overdueHours > -12) {
          computedPriority = 'HIGH';
        }
        if (overdueHours > 0) reasons.push(`Quá hạn trả giường ${overdueHours.toFixed(1)}h`);
        else if (overdueHours > -12) reasons.push(`Sắp đến hạn trả (${Math.abs(overdueHours).toFixed(1)}h)`);
        if (noteAlert) reasons.push(noteAlert);

        return {
          id: String(a.id),
          admission_code: String(a.admission_code),
          patient_name: String(a.patient_name),
          patient_code: String(a.patient_code),
          bed_id: String(a.bed_id),
          bed_code: String(a.bed_code ?? ''),
          room_id: String(a.room_id),
          room_name: String(a.room_name ?? ''),
          room_type: String(a.room_type ?? 'STANDARD'),
          floor: String(a.floor ?? 'Tầng 1'),
          department_id: String(a.department_id),
          department_name: String(a.department_name ?? ''),
          diagnosis_group: String(a.diagnosis_group ?? ''),
          is_whole_room: Number(a.is_whole_room ?? 0),
          priority: computedPriority,
          expected_discharge_at: String(a.expected_discharge_at),
          reason_summary: reasons.length > 0 ? reasons.join(' · ') : 'Lưu trú đúng kế hoạch',
        };
      })
      .sort((a, b) => {
        const rank = { CRITICAL: 0, HIGH: 1, NORMAL: 2 };
        return rank[a.priority] - rank[b.priority];
      });

    const priorityQueue = {
      cleaningBeds: enrichedBeds.filter((b) => b.status === 'PENDING_CLEANING' || b.status === 'CLEANING'),
      pendingConfirmationBeds: enrichedBeds.filter((b) => b.status === 'PENDING_CONFIRMATION'),
      isolationBeds: enrichedBeds.filter((b) => b.room_type === 'ISOLATION'),
      delayedTransfers: pendingTransferReqs
        .map((tr) => {
          const elapsedMinutes = Math.max(0, Math.round((nowMs - new Date(String(tr.requested_at)).getTime()) / 60000));
          return {
            ...tr,
            elapsed_minutes: elapsedMinutes,
            is_delayed: elapsedMinutes > 30,
          };
        })
        .filter((tr) => tr.is_delayed),
    };

    res.json({
      summary: {
        totalDepartments: depts.filter((d) => d.status === 'ACTIVE').length,
        totalRooms: rooms.filter((r) => r.status === 'ACTIVE').length,
        totalBeds: beds.length,
        operationalBeds,
        vacantBeds: countByStatus('VACANT'),
        occupiedBeds: occupiedCount,
        reservedBeds: countByStatus('RESERVED'),
        pendingConfirmationBeds: countByStatus('PENDING_CONFIRMATION'),
        cleaningBeds: countByStatus('PENDING_CLEANING') + countByStatus('CLEANING'),
        isolationBeds: priorityQueue.isolationBeds.length,
        maintenanceBeds: countByStatus('MAINTENANCE'),
        inactiveBeds: countByStatus('INACTIVE'),
        activeInpatients: admissions.filter((a) => a.status === 'ACTIVE').length,
        dueSoonBeds: dueSoonCount,
        overdueBeds: overdueCount,
        delayedTransferCount: priorityQueue.delayedTransfers.length,
        occupancyRate: calculateBedOccupancyRate(occupiedCount, operationalBeds),
        occupancyFormula: 'Số giường đang sử dụng / Tổng giường hoạt động (loại trừ Bảo trì & Ngừng hoạt động)',
        demoModeActive: cfg.demo_mode_active === 'true',
      },
      scopedDepartmentId: scopedDeptId,
      deptStats,
      criticalCapacityDepartments,
      thresholdAlerts24h,
      triagePatients,
      priorityQueue,
      quickDispatchPatients: triagePatients,
      quickDispatchBeds: enrichedBeds,
      alerts,
      vacancyPrediction,
      vacancyPrediction48h,
      capacityForecast7d,
    });
  });

  // --- DEPARTMENTS ---
  router.get('/departments', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = req.query.scope === 'all' ? null : getScopedDeptId(req.authUser);
    const allDepts = db.prepare('SELECT * FROM departments ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    const depts = scopedDeptId ? allDepts.filter((d) => d.id === scopedDeptId) : allDepts;
    const rooms = db.prepare('SELECT * FROM rooms').all() as Array<Record<string, unknown>>;
    const beds = db.prepare('SELECT * FROM beds').all() as Array<Record<string, unknown>>;

    const result = depts.map((d) => {
      const dBeds = beds.filter((b) => b.department_id === d.id);
      const dOps = dBeds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length;
      const dOcc = dBeds.filter((b) => b.status === 'OCCUPIED').length;
      return {
        ...d,
        total_rooms: rooms.filter((r) => r.department_id === d.id).length,
        total_beds: dBeds.length,
        occupied_beds: dOcc,
        vacant_beds: dBeds.filter((b) => b.status === 'VACANT').length,
        occupancy_rate: calculateBedOccupancyRate(dOcc, dOps),
      };
    });
    res.json(result);
  });

  router.post('/departments', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { id, code, name, description, status } = req.body as {
      id?: string;
      code: string;
      name: string;
      description?: string;
      status?: 'ACTIVE' | 'INACTIVE';
    };
    if (!code?.trim() || !name?.trim()) {
      res.status(400).json({ error: 'Mã khoa và tên khoa là bắt buộc.' });
      return;
    }
    const deptId = id || `dept-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'DEPARTMENT_UPSERT', 'DEPARTMENT', deptId, {
      id: deptId,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      description: description?.trim() || '',
      status: status || 'ACTIVE',
      audit_action: id ? 'UPDATE_DEPARTMENT' : 'CREATE_DEPARTMENT',
      audit_details: `${id ? 'Cập nhật' : 'Thêm'} khoa ${name}`,
    });
    res.status(201).json({ id: deptId });
  });

  // --- ROOM STANDARDS ---
  router.get('/room-standards', requireAuth, (_req, res) => {
    const db = cluster.getActiveNode().db;
    const rows = db.prepare('SELECT * FROM room_standards ORDER BY is_default DESC, name ASC').all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((r) => ({
        ...r,
        attributes: JSON.parse((r.attributes as string) || '{}'),
      }))
    );
  });

  router.post('/room-standards', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { id, name, code, category, description, attributes, status } = req.body as {
      id?: string;
      name: string;
      code: string;
      category: 'CAPACITY' | 'TOILET' | 'SERVICE' | 'CUSTOM';
      description?: string;
      attributes?: Record<string, unknown>;
      status?: 'ACTIVE' | 'INACTIVE';
    };
    if (!name?.trim() || !code?.trim()) {
      res.status(400).json({ error: 'Tên và mã tiêu chuẩn là bắt buộc.' });
      return;
    }
    const stdId = id || `std-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'ROOM_STANDARD_UPSERT', 'ROOM_STANDARD', stdId, {
      id: stdId,
      name: name.trim(),
      code: code.trim().toUpperCase(),
      category: category || 'CUSTOM',
      description: description?.trim() || '',
      attributes: attributes ?? {},
      is_default: 0,
      status: status || 'ACTIVE',
      audit_action: 'UPSERT_ROOM_STANDARD',
      audit_details: `Cấu hình tiêu chuẩn phòng ${name}`,
    });
    res.status(201).json({ id: stdId });
  });

  // --- BED TYPES & PRICING ---
  router.get('/bed-types', requireAuth, (_req, res) => {
    const db = cluster.getActiveNode().db;
    res.json(db.prepare('SELECT * FROM bed_types ORDER BY daily_price ASC, name ASC').all());
  });

  router.post('/bed-types', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { id, code, name, daily_price, hourly_price, description, status } = req.body as {
      id?: string;
      code: string;
      name: string;
      daily_price: number;
      hourly_price?: number;
      description?: string;
      status?: 'ACTIVE' | 'INACTIVE';
    };
    if (!code?.trim() || !name?.trim() || Number(daily_price) < 0) {
      res.status(400).json({ error: 'Mã loại giường, tên loại giường và đơn giá hợp lệ là bắt buộc.' });
      return;
    }
    const btId = id || `bt-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'BED_TYPE_UPSERT', 'BED_TYPE', btId, {
      id: btId,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      daily_price: Number(daily_price) || 0,
      hourly_price: Number(hourly_price) || 0,
      description: description?.trim() || '',
      status: status || 'ACTIVE',
      audit_action: id ? 'UPDATE_BED_TYPE' : 'CREATE_BED_TYPE',
      audit_details: `${id ? 'Cập nhật' : 'Thêm'} loại giường ${name} (${Number(daily_price).toLocaleString('vi-VN')} đ/ngày)`,
    });
    res.status(201).json({ id: btId });
  });

  // --- ROOMS ---
  router.get('/rooms', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const deptFilter = scopedDeptId || (req.query.departmentId as string | undefined);
    const depts = db.prepare('SELECT id, name FROM departments').all() as Array<{ id: string; name: string }>;
    const deptMap = Object.fromEntries(depts.map((d) => [d.id, d.name]));

    const rooms = (
      deptFilter
        ? db.prepare('SELECT * FROM rooms WHERE department_id = ? ORDER BY code ASC').all(deptFilter)
        : db.prepare('SELECT * FROM rooms ORDER BY code ASC').all()
    ) as Array<Record<string, unknown>>;

    res.json(
      rooms.map((r) => ({
        ...r,
        department_name: deptMap[r.department_id as string] ?? '',
        standard_ids: JSON.parse((r.standard_ids as string) || '[]'),
      }))
    );
  });

  router.post('/rooms', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const b = req.body as {
      id?: string;
      department_id: string;
      code: string;
      name: string;
      floor?: string;
      capacity: number;
      toilet_type: 'INTERNAL' | 'EXTERNAL';
      room_type: 'STANDARD' | 'SERVICE' | 'VIP' | 'ISOLATION';
      is_service: boolean;
      standard_ids: string[];
      status?: 'ACTIVE' | 'INACTIVE';
      notes?: string;
    };
    if (!b.department_id || !b.code?.trim() || !b.name?.trim() || !b.capacity || b.capacity < 1) {
      res.status(400).json({ error: 'Thông tin phòng và số giường (>= 1) không hợp lệ.' });
      return;
    }

    const db = cluster.getActiveNode().db;
    const deptExists = db.prepare('SELECT id FROM departments WHERE id = ?').get(b.department_id);
    if (!deptExists) {
      res.status(400).json({ error: 'Khoa phòng được chọn không tồn tại trong hệ thống.' });
      return;
    }

    const cleanCode = b.code.trim().toUpperCase();
    const dupRoom = db
      .prepare('SELECT id FROM rooms WHERE department_id = ? AND UPPER(code) = ? AND id != ?')
      .get(b.department_id, cleanCode, b.id || '');
    if (dupRoom) {
      res.status(409).json({ error: `Mã phòng "${cleanCode}" đã tồn tại trong khoa này.` });
      return;
    }

    const roomId = b.id || `room-${crypto.randomUUID().slice(0, 8)}`;
    if (b.id) {
      const existingBeds = db.prepare('SELECT COUNT(*) as c FROM beds WHERE room_id = ?').get(b.id) as { c: number };
      const busyBeds = db
        .prepare("SELECT COUNT(*) as c FROM beds WHERE room_id = ? AND status IN ('OCCUPIED', 'RESERVED', 'PENDING_CONFIRMATION')")
        .get(b.id) as { c: number };
      if (b.capacity < busyBeds.c || b.capacity < existingBeds.c) {
        res.status(400).json({
          error: `Không thể giảm số giường xuống ${b.capacity} vì phòng đã có ${existingBeds.c} giường được khai báo (${busyBeds.c} giường đang có giao dịch).`,
        });
        return;
      }
    }

    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'ROOM_UPSERT', 'ROOM', roomId, {
      id: roomId,
      department_id: b.department_id,
      code: cleanCode,
      name: b.name.trim(),
      floor: b.floor || 'Tầng 1',
      capacity: b.capacity,
      toilet_type: b.toilet_type || 'INTERNAL',
      room_type: b.room_type || 'STANDARD',
      is_service: b.is_service ? 1 : 0,
      standard_ids: b.standard_ids || [],
      status: b.status || 'ACTIVE',
      notes: b.notes || '',
      audit_action: b.id ? 'UPDATE_ROOM' : 'CREATE_ROOM',
      audit_details: `${b.id ? 'Cập nhật' : 'Tạo'} phòng ${b.name} (${b.capacity} giường)`,
    });

    // Pick valid default bed_type_id when auto-creating beds for a room
    const preferredBtId = b.room_type === 'VIP' ? 'bt-vip' : b.is_service ? 'bt-svc' : 'bt-std';
    const defaultBt =
      (db.prepare('SELECT id, daily_price FROM bed_types WHERE id = ?').get(preferredBtId) as
        | { id: string; daily_price: number }
        | undefined) ??
      (db.prepare("SELECT id, daily_price FROM bed_types WHERE status = 'ACTIVE' ORDER BY daily_price ASC LIMIT 1").get() as
        | { id: string; daily_price: number }
        | undefined);

    const currentBeds = db.prepare('SELECT COUNT(*) as c FROM beds WHERE room_id = ?').get(roomId) as { c: number };
    for (let i = currentBeds.c + 1; i <= b.capacity; i++) {
      const bId = `bed-${crypto.randomUUID().slice(0, 8)}`;
      const bCode = `${cleanCode}-G${String(i).padStart(2, '0')}`;
      cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'BED_UPSERT', 'BED', bId, {
        id: bId,
        room_id: roomId,
        department_id: b.department_id,
        bed_type_id: defaultBt?.id ?? null,
        daily_price: defaultBt?.daily_price ?? 0,
        code: bCode,
        name: `Giường ${String(i).padStart(2, '0')} - ${b.name.trim()}`,
        status: 'VACANT',
      });
    }

    res.status(201).json({ id: roomId });
  });

  router.delete('/rooms/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const roomId = req.params.id;
    const hasAdmissions = (db.prepare('SELECT COUNT(*) as c FROM admissions WHERE room_id = ?').get(roomId) as { c: number }).c;
    const hasReservations = (db.prepare('SELECT COUNT(*) as c FROM reservations WHERE room_id = ?').get(roomId) as { c: number }).c;
    const hasRegistrations = (db.prepare('SELECT COUNT(*) as c FROM registrations WHERE room_id = ?').get(roomId) as { c: number }).c;
    const hasBeds = (db.prepare('SELECT COUNT(*) as c FROM beds WHERE room_id = ?').get(roomId) as { c: number }).c;
    if (hasAdmissions > 0 || hasReservations > 0 || hasRegistrations > 0 || hasBeds > 0) {
      res.status(400).json({ error: 'Không thể xóa phòng đã có giường hoặc dữ liệu nghiệp vụ liên quan.' });
      return;
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'ROOM_DELETE', 'ROOM', roomId, {
      id: roomId,
      audit_action: 'DELETE_ROOM',
      audit_details: `Xóa phòng ${roomId}`,
    });
    res.json({ ok: true });
  });

  // --- BEDS ---
  router.get('/beds', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const deptFilter = scopedDeptId || (req.query.departmentId as string | undefined);
    const statusFilter = req.query.status as string | undefined;

    const rows = db
      .prepare(
        `SELECT b.*, r.code as room_code, r.name as room_name, r.floor, r.exclusive_locked, r.exclusive_lock_id,
                r.occupancy_status as room_occupancy_status, r.toilet_type, r.room_type, r.standard_ids,
                d.name as department_name,
                bt.name as bed_type_name, bt.code as bed_type_code, bt.hourly_price as bt_hourly_price,
                COALESCE(NULLIF(b.daily_price, 0), bt.daily_price, 0) as effective_daily_price,
                cl.id as cleaning_log_id,
                a.admission_code, a.patient_name, a.patient_code, a.his_record_code, a.date_of_birth,
                a.diagnosis_group, a.confirmed_by_name, a.bed_assigned_at, a.hospital_admitted_at,
                a.expected_discharge_at, a.notes as admission_notes, a.is_whole_room,
                rsv.patient_name as rsv_patient_name, rsv.expires_at as rsv_expires_at,
                a_excl.patient_name as excl_adm_patient_name, a_excl.expected_discharge_at as excl_adm_discharge_at,
                rsv_excl.patient_name as excl_rsv_patient_name, rsv_excl.expires_at as excl_rsv_expires_at
         FROM beds b
         JOIN rooms r ON b.room_id = r.id
         JOIN departments d ON b.department_id = d.id
         LEFT JOIN bed_types bt ON b.bed_type_id = bt.id
         LEFT JOIN cleaning_logs cl ON cl.bed_id = b.id AND cl.status IN ('PENDING', 'IN_PROGRESS')
         LEFT JOIN admissions a ON b.current_admission_id = a.id
         LEFT JOIN reservations rsv ON b.current_reservation_id = rsv.id
         LEFT JOIN admissions a_excl ON r.exclusive_lock_id = a_excl.id
         LEFT JOIN reservations rsv_excl ON r.exclusive_lock_id = rsv_excl.id
         ORDER BY d.name ASC, r.code ASC, b.code ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const wardStaffRows = db
      .prepare("SELECT full_name, department_id FROM users WHERE status = 'ACTIVE' AND role = 'WARD_STAFF' AND department_id IS NOT NULL")
      .all() as Array<{ full_name: string; department_id: string }>;

    const staffByDept = new Map<string, string[]>();
    for (const u of wardStaffRows) {
      const list = staffByDept.get(u.department_id) ?? [];
      list.push(u.full_name);
      staffByDept.set(u.department_id, list);
    }

    const filtered = rows.filter((b) => {
      if (deptFilter && b.department_id !== deptFilter) return false;
      if (statusFilter && b.status !== statusFilter) return false;
      return true;
    });

    res.json(
      filtered.map((b) => {
        const primary = b.confirmed_by_name ? [String(b.confirmed_by_name)] : [];
        const deptTeam = staffByDept.get(String(b.department_id)) ?? [];
        const careTeam = Array.from(new Set([...primary, ...deptTeam]));
        const isExclusiveLocked = Boolean(b.exclusive_locked);
        const exclusiveHolderName =
          (b.excl_adm_patient_name as string | null) ??
          (b.excl_rsv_patient_name as string | null) ??
          null;
        const isExclusiveCompanion = Boolean(
          isExclusiveLocked && !b.current_admission_id && (b.status === 'RESERVED' || b.status === 'PENDING_CONFIRMATION')
        );
        const reservationPatientName =
          (b.rsv_patient_name as string | null) ?? exclusiveHolderName;
        const reservationExpiresAt =
          (b.rsv_expires_at as string | null) ??
          (b.excl_rsv_expires_at as string | null) ??
          (b.excl_adm_discharge_at as string | null) ??
          null;

        return {
          ...b,
          daily_price: Number(b.effective_daily_price ?? b.daily_price ?? 0),
          hourly_price: Number(b.bt_hourly_price ?? 0),
          exclusive_locked: isExclusiveLocked,
          exclusive_holder_name: exclusiveHolderName,
          is_exclusive_companion: isExclusiveCompanion,
          reservation_patient_name: reservationPatientName,
          reservation_expires_at: reservationExpiresAt,
          standard_ids: JSON.parse((b.standard_ids as string) || '[]'),
          care_team: careTeam,
        };
      })
    );
  });

  router.get('/beds/:id/history', requireAuth, (req, res) => {
    const db = cluster.getActiveNode().db;
    const bed = db
      .prepare(
        `SELECT b.*, r.name as room_name, r.floor, d.name as department_name
         FROM beds b
         JOIN rooms r ON b.room_id = r.id
         JOIN departments d ON b.department_id = d.id
         WHERE b.id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!bed) {
      res.status(404).json({ error: 'Không tìm thấy giường bệnh.' });
      return;
    }

    const cfg = getConfigMap(db);
    const dayCfg = getDayConfig(cfg);
    const nowIso = new Date().toISOString();

    const directRows = db
      .prepare(
        `SELECT a.*, d.name as department_name, r.name as room_name, b.code as bed_code
         FROM admissions a
         JOIN departments d ON a.department_id = d.id
         JOIN rooms r ON a.room_id = r.id
         JOIN beds b ON a.bed_id = b.id
         WHERE a.bed_id = ?
         ORDER BY a.bed_assigned_at DESC`
      )
      .all(req.params.id) as Array<Record<string, unknown>>;

    const transferRows = db
      .prepare(
        `SELECT t.*, a.admission_code, a.patient_code, a.his_record_code, a.patient_name, a.date_of_birth,
                a.diagnosis_group, a.bed_assigned_at, a.expected_discharge_at, a.actual_discharge_at,
                a.status as admission_status, a.extension_count, a.confirmed_by_name, a.calculation_method,
                a.notes as admission_notes,
                d_from.name as from_dept_name, b_from.code as from_bed_code,
                d_to.name as to_dept_name, b_to.code as to_bed_code
         FROM bed_transfers t
         JOIN admissions a ON t.admission_id = a.id
         JOIN departments d_from ON t.from_department_id = d_from.id
         JOIN beds b_from ON t.from_bed_id = b_from.id
         JOIN departments d_to ON t.to_department_id = d_to.id
         JOIN beds b_to ON t.to_bed_id = b_to.id
         WHERE t.from_bed_id = ? OR t.to_bed_id = ?
         ORDER BY t.performed_at DESC`
      )
      .all(req.params.id, req.params.id) as Array<Record<string, unknown>>;

    const seenIds = new Set<string>();
    const history: Array<Record<string, unknown>> = [];

    for (const a of directRows) {
      seenIds.add(String(a.id));
      const metrics = calculateStayMetrics(
        a.bed_assigned_at as string,
        a.expected_discharge_at as string,
        (a.actual_discharge_at as string | null) ?? null,
        (a.calculation_method as BedDayConfig['method']) || 'CALENDAR_DAYS',
        dayCfg,
        nowIso
      );
      const matchingTransferIn = transferRows.find((t) => t.admission_id === a.id && t.to_bed_id === req.params.id);
      history.push({
        id: a.id,
        admission_code: a.admission_code,
        patient_code: a.patient_code,
        his_record_code: a.his_record_code,
        patient_name: a.patient_name,
        date_of_birth: a.date_of_birth,
        diagnosis_group: a.diagnosis_group,
        department_name: a.department_name,
        room_name: a.room_name,
        bed_code: a.bed_code,
        bed_assigned_at: a.bed_assigned_at,
        expected_discharge_at: a.expected_discharge_at,
        actual_discharge_at: a.actual_discharge_at,
        status: a.status,
        extension_count: a.extension_count,
        confirmed_by_name: a.confirmed_by_name,
        notes: a.notes,
        days_stayed: metrics.daysStayed,
        relation_type: matchingTransferIn ? 'TRANSFERRED_IN' : 'DIRECT',
        transfer_note: matchingTransferIn
          ? `Chuyển từ giường ${matchingTransferIn.from_bed_code} (${matchingTransferIn.reason})`
          : undefined,
      });
    }

    for (const t of transferRows) {
      if (t.from_bed_id === req.params.id && !seenIds.has(String(t.admission_id))) {
        seenIds.add(String(t.admission_id));
        const metrics = calculateStayMetrics(
          t.bed_assigned_at as string,
          t.expected_discharge_at as string,
          (t.actual_discharge_at as string | null) ?? (t.performed_at as string),
          (t.calculation_method as BedDayConfig['method']) || 'CALENDAR_DAYS',
          dayCfg,
          nowIso
        );
        history.push({
          id: String(t.admission_id),
          admission_code: t.admission_code,
          patient_code: t.patient_code,
          his_record_code: t.his_record_code,
          patient_name: t.patient_name,
          date_of_birth: t.date_of_birth,
          diagnosis_group: t.diagnosis_group,
          department_name: t.from_dept_name,
          room_name: bed.room_name,
          bed_code: t.from_bed_code,
          bed_assigned_at: t.bed_assigned_at,
          expected_discharge_at: t.expected_discharge_at,
          actual_discharge_at: t.performed_at,
          status: 'TRANSFERRED',
          extension_count: t.extension_count,
          confirmed_by_name: t.confirmed_by_name,
          notes: t.admission_notes,
          days_stayed: metrics.daysStayed,
          relation_type: 'TRANSFERRED_OUT',
          transfer_note: `Đã chuyển sang giường ${t.to_bed_code} (${t.to_dept_name}) · Lý do: ${t.reason}`,
        });
      }
    }

    history.sort((x, y) => String(y.bed_assigned_at).localeCompare(String(x.bed_assigned_at)));
    res.json({ bed, history });
  });

  router.post('/beds', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { id, room_id, department_id, bed_type_id, daily_price, code, name, status, notes } = req.body as {
      id?: string;
      room_id: string;
      department_id: string;
      bed_type_id?: string | null;
      daily_price?: number;
      code: string;
      name: string;
      status?: string;
      notes?: string;
    };
    if (!room_id || !department_id || !code?.trim() || !name?.trim()) {
      res.status(400).json({ error: 'Thiếu thông tin giường bệnh.' });
      return;
    }
    const db = cluster.getActiveNode().db;
    const roomExists = db.prepare('SELECT id, department_id FROM rooms WHERE id = ?').get(room_id) as
      | { id: string; department_id: string }
      | undefined;
    const deptExists = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
    if (!roomExists || !deptExists) {
      res.status(400).json({ error: 'Phòng bệnh hoặc khoa phòng không tồn tại.' });
      return;
    }

    const cleanCode = code.trim().toUpperCase();
    const dupBed = db
      .prepare('SELECT id FROM beds WHERE room_id = ? AND UPPER(code) = ? AND id != ?')
      .get(room_id, cleanCode, id || '');
    if (dupBed) {
      res.status(409).json({ error: `Mã giường "${cleanCode}" đã tồn tại trong phòng này.` });
      return;
    }

    const cleanBedTypeId = nullIfEmpty(bed_type_id);
    let resolvedPrice = Number(daily_price ?? 0);
    if (cleanBedTypeId) {
      const bt = db.prepare('SELECT daily_price FROM bed_types WHERE id = ?').get(cleanBedTypeId) as
        | { daily_price: number }
        | undefined;
      if (!bt) {
        res.status(400).json({ error: 'Loại giường được chọn không tồn tại.' });
        return;
      }
      if (!resolvedPrice) resolvedPrice = bt.daily_price;
    }

    const bedId = id || `bed-${crypto.randomUUID().slice(0, 8)}`;
    const existingBed = id
      ? (db.prepare('SELECT status, current_admission_id, current_reservation_id FROM beds WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'BED_UPSERT', 'BED', bedId, {
      id: bedId,
      room_id,
      department_id: roomExists.department_id,
      bed_type_id: cleanBedTypeId,
      daily_price: resolvedPrice,
      code: cleanCode,
      name: name.trim(),
      status: existingBed ? (status ?? existingBed.status) : (status ?? 'VACANT'),
      current_admission_id: existingBed?.current_admission_id ?? null,
      current_reservation_id: existingBed?.current_reservation_id ?? null,
      notes: notes || '',
      audit_action: id ? 'UPDATE_BED' : 'CREATE_BED',
      audit_details: `${id ? 'Cập nhật' : 'Thêm'} giường ${cleanCode}`,
    });
    res.status(201).json({ id: bedId });
  });

  router.delete('/beds/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const bedId = req.params.id;
    const bed = db.prepare('SELECT id, code, status FROM beds WHERE id = ?').get(bedId) as
      | { id: string; code: string; status: string }
      | undefined;
    if (!bed) {
      res.status(404).json({ error: 'Không tìm thấy giường bệnh.' });
      return;
    }
    if (['OCCUPIED', 'RESERVED', 'PENDING_CONFIRMATION'].includes(bed.status)) {
      res.status(400).json({ error: `Không thể xóa giường ${bed.code} đang có người bệnh hoặc giữ chỗ.` });
      return;
    }
    const refCount =
      (db.prepare('SELECT COUNT(*) as c FROM admissions WHERE bed_id = ?').get(bedId) as { c: number }).c +
      (db.prepare('SELECT COUNT(*) as c FROM reservations WHERE bed_id = ?').get(bedId) as { c: number }).c +
      (db.prepare('SELECT COUNT(*) as c FROM cleaning_logs WHERE bed_id = ?').get(bedId) as { c: number }).c +
      (db.prepare('SELECT COUNT(*) as c FROM transfer_requests WHERE from_bed_id = ? OR to_bed_id = ?').get(bedId, bedId) as { c: number }).c +
      (db.prepare('SELECT COUNT(*) as c FROM registrations WHERE bed_id = ?').get(bedId) as { c: number }).c;
    if (refCount > 0) {
      res.status(400).json({
        error: `Giường ${bed.code} đã có lịch sử lưu trú/vệ sinh liên quan. Vui lòng chuyển sang trạng thái "Ngừng hoạt động" để bảo toàn khóa ngoại.`,
      });
      return;
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'BED_DELETE', 'BED', bedId, {
      id: bedId,
      audit_action: 'DELETE_BED',
      audit_details: `Xóa giường ${bed.code}`,
    });
    res.json({ ok: true });
  });

  router.post('/beds/fix-conflicts', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const countConflicts = () => {
      const rooms = db.prepare('SELECT id, code, name, exclusive_locked, exclusive_lock_id, occupancy_status FROM rooms').all() as Array<{
        id: string;
        code: string;
        name: string;
        exclusive_locked: number;
        exclusive_lock_id: string | null;
        occupancy_status: string | null;
      }>;
      const beds = db.prepare('SELECT id, room_id, code, status, current_admission_id, current_reservation_id FROM beds').all() as Array<{
        id: string;
        room_id: string;
        code: string;
        status: string;
        current_admission_id: string | null;
        current_reservation_id: string | null;
      }>;
      const activeWholeIds = new Set([
        ...(db.prepare("SELECT id FROM admissions WHERE status = 'ACTIVE' AND is_whole_room = 1").all() as Array<{ id: string }>).map((r) => r.id),
        ...(db.prepare("SELECT id FROM reservations WHERE status = 'ACTIVE' AND is_whole_room = 1").all() as Array<{ id: string }>).map((r) => r.id),
      ]);
      const activeAdmIds = new Set(
        (db.prepare("SELECT id FROM admissions WHERE status = 'ACTIVE'").all() as Array<{ id: string }>).map((r) => r.id)
      );
      const conflictRooms: string[] = [];
      let conflictCount = 0;
      for (const r of rooms) {
        const rBeds = beds.filter((b) => b.room_id === r.id);
        const v = validateRoomAndBeds(r, rBeds, activeWholeIds, activeAdmIds);
        if (v.hasConflict) {
          conflictRooms.push(r.code);
          conflictCount += v.conflicts.length;
        }
      }
      return { conflictCount, conflictRooms };
    };

    const before = countConflicts();
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'ROOM_CONFLICTS_BATCH_FIX', 'ROOM', 'batch-fix', {
      audit_action: 'BATCH_FIX_ROOM_BED_CONFLICTS',
      audit_details: `Đồng bộ & sửa xung đột trạng thái phòng/giường hàng loạt (${before.conflictCount} xung đột tại ${before.conflictRooms.join(', ') || '0 phòng'})`,
    });
    const after = countConflicts();

    res.json({
      ok: true,
      fixedConflicts: Math.max(0, before.conflictCount - after.conflictCount),
      remainingConflicts: after.conflictCount,
      fixedRooms: before.conflictRooms,
    });
  });

  router.post('/beds/:id/status', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const bed = db.prepare('SELECT * FROM beds WHERE id = ?').get(req.params.id) as
      | { id: string; department_id: string; status: string; code: string }
      | undefined;
    if (!bed) {
      res.status(404).json({ error: 'Không tìm thấy giường.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, bed.department_id)) {
      res.status(403).json({ error: 'Nhân viên khoa không được phép sửa giường thuộc khoa khác.' });
      return;
    }
    const { status, notes } = req.body as { status: 'VACANT' | 'MAINTENANCE' | 'INACTIVE'; notes?: string };
    if (!['VACANT', 'MAINTENANCE', 'INACTIVE'].includes(status)) {
      res.status(400).json({ error: 'Chỉ được chuyển thủ công sang Trống, Bảo trì hoặc Ngừng hoạt động.' });
      return;
    }
    if (['OCCUPIED', 'RESERVED', 'PENDING_CONFIRMATION'].includes(bed.status)) {
      res.status(400).json({ error: `Giường ${bed.code} đang có bệnh nhân hoặc đang giữ chỗ, không thể chuyển trạng thái.` });
      return;
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'BED_STATUS_CHANGE', 'BED', bed.id, {
      bed_id: bed.id,
      status,
      notes,
      audit_action: 'CHANGE_BED_STATUS',
      audit_details: `Đổi trạng thái giường ${bed.code} -> ${status}`,
    });
    res.json({ ok: true });
  });

  // --- REGISTRATIONS (Form A & B + HIS/Excel Import) ---
  router.get('/registrations', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const rows = db
      .prepare(
        `SELECT reg.*, d.name as department_name, r.name as room_name, b.code as bed_code
         FROM registrations reg
         LEFT JOIN departments d ON reg.department_id = d.id
         LEFT JOIN rooms r ON reg.room_id = r.id
         LEFT JOIN beds b ON reg.bed_id = b.id
         ORDER BY reg.created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    const visible = scopedDeptId
      ? rows.filter((r) => !r.department_id || r.department_id === scopedDeptId)
      : rows;
    res.json(
      visible.map((r) => ({
        ...r,
        desired_standard_ids: JSON.parse((r.desired_standard_ids as string) || '[]'),
      }))
    );
  });

  router.get('/patients/lookup', requireAuth, (req, res) => {
    const code = String(req.query.code ?? '').trim();
    if (!code) {
      res.json({ found: false, patient: null, activeAdmission: null, openRegistration: null });
      return;
    }
    const db = cluster.getActiveNode().db;
    const patient = db
      .prepare('SELECT id, patient_code, his_record_code, full_name, date_of_birth, phone FROM patients WHERE patient_code = ?')
      .get(code) as
      | { id: string; patient_code: string; his_record_code: string; full_name: string; date_of_birth: string; phone: string }
      | undefined;

    const activeAdmission = db
      .prepare(
        `SELECT a.id, a.admission_code, b.code as bed_code, d.name as department_name
         FROM admissions a
         JOIN beds b ON a.bed_id = b.id
         JOIN departments d ON a.department_id = d.id
         WHERE a.patient_code = ? AND a.status = 'ACTIVE'
         LIMIT 1`
      )
      .get(code) as { id: string; admission_code: string; bed_code: string; department_name: string } | undefined;

    const openRegistration = db
      .prepare(
        `SELECT reg.id, reg.registration_code, reg.status, d.name as department_name, b.code as bed_code
         FROM registrations reg
         LEFT JOIN departments d ON reg.department_id = d.id
         LEFT JOIN beds b ON reg.bed_id = b.id
         WHERE reg.patient_code = ? AND reg.status IN ('WAITING', 'RESERVED')
         ORDER BY reg.created_at DESC
         LIMIT 1`
      )
      .get(code) as
      | { id: string; registration_code: string; status: string; department_name: string | null; bed_code: string | null }
      | undefined;

    res.json({
      found: Boolean(patient),
      patient: patient ?? null,
      activeAdmission: activeAdmission ?? null,
      openRegistration: openRegistration ?? null,
    });
  });

  router.post('/registrations', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'), async (req: AuthedRequest, res) => {
    try {
      const b = req.body as {
        patient_code: string;
        his_record_code?: string;
        patient_name: string;
        date_of_birth: string;
        phone?: string;
        diagnosis_group: string;
        expected_admission_date: string;
        expected_discharge_date?: string;
        desired_standard_ids: string[];
        registration_mode: 'UNKNOWN_DEPT' | 'KNOWN_DEPT';
        department_id?: string | null;
        room_id?: string | null;
        bed_id?: string | null;
        reservation_type: 'NONE' | 'WAITLIST' | 'SINGLE_BED' | 'WHOLE_ROOM';
        notes?: string;
      };
      if (!b.patient_code?.trim() || !b.patient_name?.trim() || !b.date_of_birth || !b.diagnosis_group) {
        res.status(400).json({ error: 'Vui lòng nhập đầy đủ mã bệnh nhân, họ tên, ngày sinh và nhóm chẩn đoán.' });
        return;
      }

      const db = cluster.getActiveNode().db;
      const cfg = getConfigMap(db);
      const dayCfg = getDayConfig(cfg);
      const diagRow = db.prepare('SELECT default_days FROM diagnosis_configs WHERE name = ?').get(b.diagnosis_group) as
        | { default_days: number }
        | undefined;
      const expectedDischarge =
        b.expected_discharge_date ||
        computeExpectedDischargeAt(b.expected_admission_date || new Date().toISOString(), diagRow?.default_days ?? 3, dayCfg);

      const cleanDeptId = b.registration_mode === 'KNOWN_DEPT' ? nullIfEmpty(b.department_id) : null;
      const cleanRoomId = nullIfEmpty(b.room_id);
      const cleanBedId = nullIfEmpty(b.bed_id);

      if (cleanDeptId && !db.prepare('SELECT id FROM departments WHERE id = ?').get(cleanDeptId)) {
        res.status(400).json({ error: 'Khoa phòng được chọn không tồn tại.' });
        return;
      }
      if (cleanRoomId) {
        const roomCheckRow = db.prepare('SELECT id, department_id FROM rooms WHERE id = ?').get(cleanRoomId) as
          | { id: string; department_id: string }
          | undefined;
        if (!roomCheckRow) {
          res.status(400).json({ error: 'Phòng bệnh được chọn không tồn tại.' });
          return;
        }
        if (cleanDeptId && roomCheckRow.department_id !== cleanDeptId) {
          res.status(400).json({ error: 'Phòng bệnh được chọn không thuộc khoa đã chọn.' });
          return;
        }
      }
      if (cleanBedId) {
        const bedCheckRow = db.prepare('SELECT id, room_id, department_id FROM beds WHERE id = ?').get(cleanBedId) as
          | { id: string; room_id: string; department_id: string }
          | undefined;
        if (!bedCheckRow) {
          res.status(400).json({ error: 'Giường bệnh được chọn không tồn tại.' });
          return;
        }
        if (cleanRoomId && bedCheckRow.room_id !== cleanRoomId) {
          res.status(400).json({ error: 'Giường bệnh được chọn không thuộc phòng đã chọn.' });
          return;
        }
        if (cleanDeptId && bedCheckRow.department_id !== cleanDeptId) {
          res.status(400).json({ error: 'Giường bệnh được chọn không thuộc khoa đã chọn.' });
          return;
        }
      }

      let registrationLogicCheck: BedRegistrationCheckResult | null = null;
      if (cleanDeptId || cleanBedId || cleanRoomId || b.patient_code?.trim() || b.his_record_code?.trim()) {
        const regCheck = evaluateBedRegistrationRules({
          departmentId: cleanDeptId ?? '',
          roomId: cleanRoomId ?? undefined,
          bedId: cleanBedId ?? undefined,
          patientCode: b.patient_code,
          hisRecordCode: b.his_record_code,
          isWholeRoom: b.reservation_type === 'WHOLE_ROOM',
          departments: db.prepare("SELECT * FROM departments WHERE status = 'ACTIVE'").all() as any,
          rooms: (db.prepare("SELECT * FROM rooms WHERE status = 'ACTIVE'").all() as Array<Record<string, unknown>>).map((r) => ({
            ...r,
            standard_ids: safeParseJson(r.standard_ids) ?? [],
          })) as any,
          beds: db.prepare('SELECT * FROM beds').all() as any,
          activeAdmissions: db
            .prepare("SELECT * FROM admissions WHERE status IN ('ACTIVE', 'PENDING_CONFIRMATION')")
            .all() as any,
          hisMappings: db.prepare('SELECT bed_id, his_bed_code, his_dept_code, his_bed_type_code FROM his_bed_mappings').all() as any,
          hisAssignments: db
            .prepare("SELECT his_record_code, patient_code, patient_name, his_bed_code, status FROM his_bed_assignments WHERE status = 'ACTIVE'")
            .all() as any,
        });
        registrationLogicCheck = regCheck;
        const hardBedBlocker = regCheck.blocks.find((blk) =>
          [
            'DUPLICATE_BED_ID',
            'BED_OCCUPIED_UNDISCHARGED',
            'BED_NOT_VACANT_STATUS',
            'ALREADY_ADMITTED',
            'DUPLICATE_HIS_RECORD_ID',
            'DUPLICATE_HIS_BED_MAPPING',
            'EXCLUSIVE_ROOM_CONFLICT',
            'ROOM_NOT_EMPTY_FOR_WHOLE_ROOM',
          ].includes(blk.code)
        );
        if (hardBedBlocker) {
          res.status(409).json({
            code: hardBedBlocker.code,
            error: hardBedBlocker.message,
            violations: regCheck.blocks,
            warnings: regCheck.warnings,
            departmentQuota: regCheck.departmentQuota,
          });
          return;
        }
      }

      const regId = `reg-${crypto.randomUUID().slice(0, 8)}`;
      const patId = resolvePatientIdByCode(db, b.patient_code);
      const regCode = `DK-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;

      cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'REGISTRATION_CREATE', 'REGISTRATION', regId, {
        id: regId,
        registration_code: regCode,
        patient_id: patId,
        patient_code: b.patient_code.trim(),
        his_record_code: b.his_record_code?.trim() || '',
        patient_name: b.patient_name.trim(),
        date_of_birth: b.date_of_birth,
        phone: b.phone?.trim() || '',
        diagnosis_group: b.diagnosis_group,
        expected_admission_date: b.expected_admission_date || new Date().toISOString(),
        expected_discharge_date: expectedDischarge,
        desired_standard_ids: b.desired_standard_ids || [],
        registration_mode: b.registration_mode,
        department_id: cleanDeptId,
        room_id: cleanRoomId,
        bed_id: cleanBedId,
        reservation_type: b.reservation_type || 'NONE',
        status: 'WAITING',
        notes: b.notes || '',
        created_by: req.authUser!.id,
        created_by_name: req.authUser!.full_name,
        audit_action: 'CREATE_REGISTRATION',
        audit_details: `Đăng ký trước ${regCode} cho bệnh nhân ${b.patient_name}`,
      });

      let consensusResult: { committed: boolean; pendingConfirmation: boolean } | null = null;

      if (cleanDeptId && cleanRoomId && (b.reservation_type === 'SINGLE_BED' || b.reservation_type === 'WHOLE_ROOM')) {
        const resId = `res-${crypto.randomUUID().slice(0, 8)}`;
        const holdHours = Number(cfg.reservation_hold_hours || '12');
        const startTime = new Date().toISOString();
        const expiresAt = new Date(Date.now() + holdHours * 3600 * 1000).toISOString();
        const isWholeRoom = b.reservation_type === 'WHOLE_ROOM';
        const roomBeds = db.prepare("SELECT id FROM beds WHERE room_id = ? AND status != 'INACTIVE'").all(cleanRoomId) as Array<{ id: string }>;

        consensusResult = await cluster.proposeCriticalAllocation({
          nodeId: cluster.activeNodeId,
          userId: req.authUser!.id,
          requestType: isWholeRoom ? 'EXCLUSIVE_ROOM' : 'RESERVE_BED',
          eventType: 'RESERVATION_CREATE',
          aggregateType: 'RESERVATION',
          aggregateId: resId,
          bedId: isWholeRoom ? null : cleanBedId,
          roomId: cleanRoomId,
          isWholeRoom,
          payloadObj: {
            id: resId,
            registration_id: regId,
            patient_id: patId,
            patient_code: b.patient_code.trim(),
            his_record_code: b.his_record_code?.trim() || '',
            date_of_birth: b.date_of_birth,
            phone: b.phone?.trim() || '',
            patient_name: b.patient_name.trim(),
            department_id: cleanDeptId,
            room_id: cleanRoomId,
            bed_id: isWholeRoom ? null : cleanBedId,
            is_whole_room: isWholeRoom,
            locked_bed_ids: isWholeRoom ? roomBeds.map((x) => x.id) : (cleanBedId ? [cleanBedId] : []),
            start_time: startTime,
            expires_at: expiresAt,
            status: 'ACTIVE',
            notes: b.notes || (isWholeRoom ? 'Giữ trọn phòng từ đăng ký trước' : 'Giữ giường từ đăng ký trước'),
            created_by: req.authUser!.id,
            created_by_name: req.authUser!.full_name,
            audit_action: isWholeRoom ? 'RESERVE_WHOLE_ROOM' : 'RESERVE_BED',
            audit_details: `Giữ chỗ cho hồ sơ ${regCode}`,
          },
        });
      }

      res.status(201).json({
        id: regId,
        registration_code: regCode,
        pendingConfirmation: consensusResult?.pendingConfirmation ?? false,
        warnings: registrationLogicCheck?.warnings ?? [],
        departmentQuota: registrationLogicCheck?.departmentQuota ?? null,
      });
    } catch (err) {
      if (err instanceof ConsensusConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof SecurityRejectionError) {
        res.status(403).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/registrations/:id/cancel', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const reg = db.prepare('SELECT id, registration_code, status FROM registrations WHERE id = ?').get(req.params.id) as
      | { id: string; registration_code: string; status: string }
      | undefined;
    if (!reg) {
      res.status(404).json({ error: 'Không tìm thấy phiếu đăng ký.' });
      return;
    }
    if (reg.status === 'ADMITTED') {
      res.status(400).json({ error: 'Phiếu đăng ký đã nhập khoa nội trú, không thể hủy.' });
      return;
    }
    if (reg.status === 'RESERVED') {
      res.status(400).json({ error: 'Phiếu đang có lượt giữ chỗ hoạt động. Vui lòng hủy giữ chỗ giường/phòng trước.' });
      return;
    }
    const { notes } = req.body as { notes?: string };
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'REGISTRATION_CANCEL', 'REGISTRATION', reg.id, {
      registration_id: reg.id,
      notes: notes || 'Hủy phiếu đăng ký chờ giường',
      audit_action: 'CANCEL_REGISTRATION',
      audit_details: `Hủy đăng ký ${reg.registration_code}`,
    });
    res.json({ ok: true });
  });

  // --- RESERVATIONS ---
  router.get('/reservations', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const rows = db
      .prepare(
        `SELECT rsv.*, d.name as department_name, rm.name as room_name, b.code as bed_code
         FROM reservations rsv
         JOIN departments d ON rsv.department_id = d.id
         JOIN rooms rm ON rsv.room_id = rm.id
         LEFT JOIN beds b ON rsv.bed_id = b.id
         ORDER BY rsv.created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    const visible = scopedDeptId ? rows.filter((r) => r.department_id === scopedDeptId) : rows;
    res.json(
      visible.map((r) => ({
        ...r,
        locked_bed_ids: JSON.parse((r.locked_bed_ids as string) || '[]'),
      }))
    );
  });

  router.post('/reservations', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'), async (req: AuthedRequest, res) => {
    try {
      const b = req.body as {
        registration_id?: string;
        patient_id?: string;
        patient_name: string;
        department_id: string;
        room_id: string;
        bed_id?: string | null;
        is_whole_room: boolean;
        hold_hours?: number;
        notes?: string;
      };
      if (!b.patient_name?.trim() || !b.department_id || !b.room_id || (!b.is_whole_room && !b.bed_id)) {
        res.status(400).json({ error: 'Vui lòng chọn bệnh nhân, khoa, phòng và giường (hoặc bao trọn phòng).' });
        return;
      }
      if (!enforceWardScope(req.authUser!, b.department_id)) {
        res.status(403).json({ error: 'Không có quyền giữ chỗ cho khoa khác.' });
        return;
      }

      const db = cluster.getActiveNode().db;
      const cleanRegId = nullIfEmpty(b.registration_id);
      const cleanBedId = b.is_whole_room ? null : nullIfEmpty(b.bed_id);
      if (cleanRegId && !db.prepare('SELECT id FROM registrations WHERE id = ?').get(cleanRegId)) {
        res.status(400).json({ error: 'Hồ sơ đăng ký liên kết không tồn tại.' });
        return;
      }
      if (!db.prepare('SELECT id FROM rooms WHERE id = ?').get(b.room_id)) {
        res.status(400).json({ error: 'Phòng bệnh được chọn không tồn tại.' });
        return;
      }

      const cfg = getConfigMap(db);
      const hours = b.hold_hours || Number(cfg.reservation_hold_hours || '12');
      const resId = `res-${crypto.randomUUID().slice(0, 8)}`;
      const patId = b.patient_id?.trim() || `pat-${crypto.randomUUID().slice(0, 8)}`;
      const roomBeds = db.prepare("SELECT id FROM beds WHERE room_id = ? AND status != 'INACTIVE'").all(b.room_id) as Array<{ id: string }>;

      const result = await cluster.proposeCriticalAllocation({
        nodeId: cluster.activeNodeId,
        userId: req.authUser!.id,
        requestType: b.is_whole_room ? 'EXCLUSIVE_ROOM' : 'RESERVE_BED',
        eventType: 'RESERVATION_CREATE',
        aggregateType: 'RESERVATION',
        aggregateId: resId,
        bedId: cleanBedId,
        roomId: b.room_id,
        isWholeRoom: b.is_whole_room,
        payloadObj: {
          id: resId,
          registration_id: cleanRegId,
          patient_id: patId,
          patient_code: patId,
          patient_name: b.patient_name.trim(),
          department_id: b.department_id,
          room_id: b.room_id,
          bed_id: cleanBedId,
          is_whole_room: b.is_whole_room,
          locked_bed_ids: b.is_whole_room ? roomBeds.map((x) => x.id) : (cleanBedId ? [cleanBedId] : []),
          start_time: new Date().toISOString(),
          expires_at: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
          status: 'ACTIVE',
          notes: b.notes || '',
          created_by: req.authUser!.id,
          created_by_name: req.authUser!.full_name,
          audit_action: b.is_whole_room ? 'RESERVE_WHOLE_ROOM' : 'RESERVE_BED',
          audit_details: `Giữ chỗ cho ${b.patient_name}`,
        },
      });
      res.status(201).json({ id: resId, ...result });
    } catch (err) {
      if (err instanceof ConsensusConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/reservations/:id/extend', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const { additional_hours, notes } = req.body as { additional_hours: number; notes?: string };
    const db = cluster.getActiveNode().db;
    const rsv = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id) as { expires_at: string; department_id: string } | undefined;
    if (!rsv) {
      res.status(404).json({ error: 'Không tìm thấy lượt giữ chỗ.' });
      return;
    }
    const newExp = new Date(new Date(rsv.expires_at).getTime() + (additional_hours || 6) * 3600 * 1000).toISOString();
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'RESERVATION_EXTEND', 'RESERVATION', req.params.id, {
      reservation_id: req.params.id,
      expires_at: newExp,
      notes: notes || `Gia hạn giữ chỗ thêm ${additional_hours || 6} giờ`,
      audit_action: 'EXTEND_RESERVATION',
      audit_details: `Gia hạn giữ chỗ ${req.params.id}`,
    });
    res.json({ ok: true, expires_at: newExp });
  });

  router.post('/reservations/:id/cancel', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const rsv = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id) as { department_id: string } | undefined;
    if (!rsv) {
      res.status(404).json({ error: 'Không tìm thấy lượt giữ chỗ.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, rsv.department_id)) {
      res.status(403).json({ error: 'Không có quyền hủy giữ chỗ của khoa khác.' });
      return;
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'RESERVATION_CANCEL', 'RESERVATION', req.params.id, {
      reservation_id: req.params.id,
      audit_action: 'CANCEL_RESERVATION',
      audit_details: `Hủy giữ chỗ ${req.params.id}`,
    });
    res.json({ ok: true });
  });

  // --- ADMISSIONS (INPATIENTS & WARD CONFIRMATION) ---
  router.get('/admissions', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const statusFilter = req.query.status as string | undefined;
    const cfg = getConfigMap(db);
    const dayCfg = getDayConfig(cfg);
    const nowIso = new Date().toISOString();

    const rows = db
      .prepare(
        `SELECT a.*, d.name as department_name, r.name as room_name, r.room_type, r.floor, b.code as bed_code
         FROM admissions a
         JOIN departments d ON a.department_id = d.id
         JOIN rooms r ON a.room_id = r.id
         JOIN beds b ON a.bed_id = b.id
         ORDER BY a.bed_assigned_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    const filtered = rows.filter((a) => {
      if (scopedDeptId && a.department_id !== scopedDeptId) return false;
      if (statusFilter && a.status !== statusFilter) return false;
      return true;
    });
    res.json(
      filtered.map((a) => ({
        ...a,
        stay_metrics: calculateStayMetrics(
          a.bed_assigned_at as string,
          a.expected_discharge_at as string,
          (a.actual_discharge_at as string | null) ?? null,
          (a.calculation_method as BedDayConfig['method']) || 'CALENDAR_DAYS',
          dayCfg,
          nowIso
        ),
      }))
    );
  });

  // Patient bed position audit log
  router.get('/admissions/:id/audit-log', requireAuth, (req, res) => {
    const db = cluster.getActiveNode().db;
    const adm = db
      .prepare(
        `SELECT a.*, d.name as department_name, r.name as room_name, r.floor, b.code as bed_code
         FROM admissions a
         JOIN departments d ON a.department_id = d.id
         JOIN rooms r ON a.room_id = r.id
         JOIN beds b ON a.bed_id = b.id
         WHERE a.id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!adm) {
      res.status(404).json({ error: 'Không tìm thấy hồ sơ lưu trú bệnh nhân.' });
      return;
    }

    const entries: Array<{
      id: string;
      timestamp: string;
      category: 'ADMISSION' | 'EXTENSION' | 'TRANSFER_REQUEST' | 'TRANSFER' | 'CLEANING' | 'DISCHARGE' | 'SYSTEM';
      title: string;
      detail: string;
      locationLabel: string;
      actorName: string;
    }> = [];

    const initialTransfer = db
      .prepare(
        `SELECT t.*, fd.name as from_dept, td.name as to_dept, fr.name as from_room, fb.code as from_bed
         FROM bed_transfers t
         JOIN departments fd ON t.from_department_id = fd.id
         JOIN departments td ON t.to_department_id = td.id
         JOIN rooms fr ON t.from_room_id = fr.id
         JOIN beds fb ON t.from_bed_id = fb.id
         WHERE t.admission_id = ?
         ORDER BY t.performed_at ASC
         LIMIT 1`
      )
      .get(adm.id as string) as Record<string, unknown> | undefined;

    const initialLoc = initialTransfer
      ? `${initialTransfer.from_dept} · ${initialTransfer.from_room} · ${initialTransfer.from_bed}`
      : `${adm.department_name} · ${adm.room_name} · ${adm.bed_code}`;

    entries.push({
      id: `aud-adm-${adm.id}`,
      timestamp: String(adm.bed_assigned_at),
      category: 'ADMISSION',
      title: 'Tiếp nhận & Cấp giường ban đầu',
      detail: `Mã HS: ${adm.admission_code} · Chẩn đoán: ${adm.diagnosis_group}${adm.is_whole_room ? ' · Bao trọn phòng' : ''}${adm.notes ? ` · Ghi chú: ${adm.notes}` : ''}`,
      locationLabel: initialLoc,
      actorName: String(adm.confirmed_by_name || adm.confirmed_by || 'Hệ thống'),
    });

    const extensions = db
      .prepare('SELECT * FROM bed_extensions WHERE admission_id = ? ORDER BY performed_at ASC')
      .all(adm.id as string) as Array<Record<string, unknown>>;
    for (const ext of extensions) {
      entries.push({
        id: `aud-ext-${ext.id}`,
        timestamp: String(ext.performed_at),
        category: 'EXTENSION',
        title: 'Gia hạn ngày nằm giường',
        detail: `Gia hạn từ ${new Date(String(ext.old_expected_discharge_at)).toLocaleDateString('vi-VN')} -> ${new Date(String(ext.new_expected_discharge_at)).toLocaleDateString('vi-VN')} · Lý do: ${ext.reason}`,
        locationLabel: `Giường ${ext.bed_code}`,
        actorName: String(ext.performed_by_name || ext.performed_by),
      });
    }

    const transferReqs = db
      .prepare(
        `SELECT tr.*, fd.name as fd_name, td.name as td_name, fb.code as fb_code, tb.code as tb_code
         FROM transfer_requests tr
         JOIN departments fd ON tr.from_department_id = fd.id
         JOIN departments td ON tr.to_department_id = td.id
         JOIN beds fb ON tr.from_bed_id = fb.id
         JOIN beds tb ON tr.to_bed_id = tb.id
         WHERE tr.admission_id = ?
         ORDER BY tr.requested_at ASC`
      )
      .all(adm.id as string) as Array<Record<string, unknown>>;
    for (const tr of transferReqs) {
      entries.push({
        id: `aud-trq-${tr.id}`,
        timestamp: String(tr.requested_at),
        category: 'TRANSFER_REQUEST',
        title: `Tạo yêu cầu chuyển giường (${tr.status === 'COMPLETED' ? 'Đã hoàn tất' : tr.status === 'CANCELLED' ? 'Đã hủy' : 'Đang chờ xử lý'})`,
        detail: `Đề xuất chuyển ${tr.fb_code} -> ${tr.tb_code} · Lý do: ${tr.reason}`,
        locationLabel: `${tr.fd_name} (${tr.fb_code}) -> ${tr.td_name} (${tr.tb_code})`,
        actorName: String(tr.requested_by_name || tr.requested_by),
      });
    }

    const transfers = db
      .prepare(
        `SELECT t.*, fd.name as fd_name, td.name as td_name, fr.name as fr_name, trm.name as tr_name,
                fb.code as fb_code, tb.code as tb_code
         FROM bed_transfers t
         JOIN departments fd ON t.from_department_id = fd.id
         JOIN departments td ON t.to_department_id = td.id
         JOIN rooms fr ON t.from_room_id = fr.id
         JOIN rooms trm ON t.to_room_id = trm.id
         JOIN beds fb ON t.from_bed_id = fb.id
         JOIN beds tb ON t.to_bed_id = tb.id
         WHERE t.admission_id = ?
         ORDER BY t.performed_at ASC`
      )
      .all(adm.id as string) as Array<Record<string, unknown>>;
    for (const t of transfers) {
      entries.push({
        id: `aud-trf-${t.id}`,
        timestamp: String(t.performed_at),
        category: 'TRANSFER',
        title: `Điều chuyển vị trí giường (${t.fb_code} -> ${t.tb_code})`,
        detail: `Lý do điều chuyển: ${t.reason}`,
        locationLabel: `${t.fd_name} / ${t.fr_name} (${t.fb_code}) -> ${t.td_name} / ${t.tr_name} (${t.tb_code})`,
        actorName: String(t.performed_by_name || t.performed_by),
      });
    }

    const cleanings = db
      .prepare(
        `SELECT cl.*, b.code as bed_code, r.name as room_name, d.name as dept_name
         FROM cleaning_logs cl
         JOIN beds b ON cl.bed_id = b.id
         JOIN rooms r ON cl.room_id = r.id
         JOIN departments d ON cl.department_id = d.id
         WHERE cl.admission_id = ?
         ORDER BY cl.requested_at ASC`
      )
      .all(adm.id as string) as Array<Record<string, unknown>>;
    for (const cl of cleanings) {
      entries.push({
        id: `aud-cln-${cl.id}`,
        timestamp: String(cl.completed_at || cl.started_at || cl.requested_at),
        category: 'CLEANING',
        title: `Vệ sinh khử khuẩn giường cũ ${cl.bed_code} (${cl.status === 'COMPLETED' ? 'Hoàn tất' : cl.status === 'IN_PROGRESS' ? 'Đang thực hiện' : 'Chờ dọn'})`,
        detail: String(cl.notes || 'Kích hoạt quy trình làm sạch giường'),
        locationLabel: `${cl.dept_name} · ${cl.room_name} · ${cl.bed_code}`,
        actorName: String(cl.completed_by_name || cl.assigned_to || 'Tổ vệ sinh'),
      });
    }

    if (adm.status === 'DISCHARGED' && adm.actual_discharge_at) {
      entries.push({
        id: `aud-dis-${adm.id}`,
        timestamp: String(adm.actual_discharge_at),
        category: 'DISCHARGE',
        title: 'Xuất viện & Trả giường',
        detail: 'Hoàn tất lưu trú và giải phóng giường sang hàng đợi vệ sinh.',
        locationLabel: `${adm.department_name} · ${adm.room_name} · ${adm.bed_code}`,
        actorName: String(adm.discharged_by || adm.confirmed_by_name || 'Nhân viên khoa'),
      });
    }

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({
      admission: {
        id: adm.id,
        admission_code: adm.admission_code,
        patient_code: adm.patient_code,
        patient_name: adm.patient_name,
        diagnosis_group: adm.diagnosis_group,
        department_name: adm.department_name,
        room_name: adm.room_name,
        bed_code: adm.bed_code,
        status: adm.status,
        bed_assigned_at: adm.bed_assigned_at,
        expected_discharge_at: adm.expected_discharge_at,
      },
      entries,
    });
  });

  // Smart Match Top-3 recommendations for transfer
  router.get('/admissions/:id/smart-match', requireAuth, (req, res) => {
    const db = cluster.getActiveNode().db;
    const adm = db
      .prepare(
        `SELECT a.*, r.floor as room_floor, r.room_type as room_type, reg.desired_standard_ids as reg_standards
         FROM admissions a
         JOIN rooms r ON a.room_id = r.id
         LEFT JOIN registrations reg ON a.registration_id = reg.id
         WHERE a.id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!adm) {
      res.status(404).json({ error: 'Không tìm thấy hồ sơ bệnh nhân đang nằm.' });
      return;
    }

    const depts = db.prepare('SELECT id, name FROM departments').all() as Array<{ id: string; name: string }>;
    const stds = db.prepare('SELECT id, name FROM room_standards').all() as Array<{ id: string; name: string }>;
    const rooms = db.prepare('SELECT * FROM rooms').all() as Array<Record<string, unknown>>;
    const beds = db
      .prepare(
        `SELECT b.*, COALESCE(NULLIF(b.daily_price, 0), bt.daily_price, 0) as effective_daily_price
         FROM beds b
         LEFT JOIN bed_types bt ON b.bed_type_id = bt.id`
      )
      .all() as Array<Record<string, unknown>>;

    const deptNames = Object.fromEntries(depts.map((d) => [d.id, d.name]));
    const standardNames = Object.fromEntries(stds.map((s) => [s.id, s.name]));

    const ranked = rankSmartTransferBeds({
      admission: {
        id: String(adm.id),
        patient_name: String(adm.patient_name),
        diagnosis_group: String(adm.diagnosis_group),
        department_id: String(adm.department_id),
        room_id: String(adm.room_id),
        bed_id: String(adm.bed_id),
        room_floor: String(adm.room_floor || 'Tầng 1'),
        room_type: String(adm.room_type || 'STANDARD'),
        desired_standard_ids: adm.reg_standards ? JSON.parse(String(adm.reg_standards)) : [],
      },
      rooms: rooms.map((r) => ({
        id: String(r.id),
        department_id: String(r.department_id),
        code: String(r.code),
        name: String(r.name),
        floor: String(r.floor || 'Tầng 1'),
        capacity: Number(r.capacity ?? 1),
        toilet_type: String(r.toilet_type || 'INTERNAL'),
        room_type: String(r.room_type || 'STANDARD'),
        is_service: Number(r.is_service ?? 0),
        standard_ids: JSON.parse(String(r.standard_ids || '[]')),
        exclusive_locked: Number(r.exclusive_locked ?? 0),
        status: String(r.status || 'ACTIVE'),
      })),
      beds: beds.map((b) => ({
        id: String(b.id),
        room_id: String(b.room_id),
        department_id: String(b.department_id),
        code: String(b.code),
        name: String(b.name),
        status: String(b.status),
        daily_price: Number(b.effective_daily_price ?? 0),
      })),
      deptNames,
      standardNames,
    });

    res.json({
      admissionId: adm.id,
      patientName: adm.patient_name,
      currentBedId: adm.bed_id,
      ...ranked,
    });
  });

  const runAdmissionPrecheck = (params: {
    department_id: string;
    room_id?: string;
    bed_id?: string;
    patient_code?: string;
    his_record_code?: string;
    reservation_id?: string;
    is_whole_room?: boolean;
    override_quota_limit?: boolean;
  }): BedRegistrationCheckResult => {
    const db = cluster.getActiveNode().db;
    const departments = db.prepare("SELECT * FROM departments WHERE status = 'ACTIVE'").all() as any[];
    const rooms = (db.prepare("SELECT * FROM rooms WHERE status = 'ACTIVE'").all() as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      standard_ids: safeParseJson(r.standard_ids) ?? [],
    })) as any[];
    const beds = db
      .prepare(
        `SELECT b.*, b.code as code FROM beds b`
      )
      .all() as any[];
    const activeAdmissions = db
      .prepare(
        `SELECT a.*, b.code as bed_code
         FROM admissions a
         JOIN beds b ON a.bed_id = b.id
         WHERE a.status IN ('ACTIVE', 'PENDING_CONFIRMATION')`
      )
      .all() as any[];
    const hisMappings = db
      .prepare('SELECT bed_id, his_bed_code, his_dept_code, his_bed_type_code FROM his_bed_mappings')
      .all() as any[];
    const hisAssignments = db
      .prepare("SELECT his_record_code, patient_code, patient_name, his_bed_code, status FROM his_bed_assignments WHERE status = 'ACTIVE'")
      .all() as any[];

    return evaluateBedRegistrationRules({
      departmentId: params.department_id,
      roomId: nullIfEmpty(params.room_id) ?? undefined,
      bedId: nullIfEmpty(params.bed_id) ?? undefined,
      patientCode: params.patient_code,
      hisRecordCode: params.his_record_code,
      reservationId: nullIfEmpty(params.reservation_id) ?? undefined,
      isWholeRoom: Boolean(params.is_whole_room),
      overrideQuotaLimit: Boolean(params.override_quota_limit),
      departments,
      rooms,
      beds,
      activeAdmissions,
      hisMappings,
      hisAssignments,
    });
  };

  router.post('/admissions/precheck', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body as {
      department_id?: string;
      room_id?: string;
      bed_id?: string;
      patient_code?: string;
      his_record_code?: string;
      reservation_id?: string;
      is_whole_room?: boolean;
      override_quota_limit?: boolean;
    };
    const isAdmin = req.authUser!.role === 'SUPER_ADMIN' || req.authUser!.role === 'ADMIN';
    const result = runAdmissionPrecheck({
      department_id: b.department_id || '',
      room_id: b.room_id,
      bed_id: b.bed_id,
      patient_code: b.patient_code,
      his_record_code: b.his_record_code,
      reservation_id: b.reservation_id,
      is_whole_room: b.is_whole_room,
      override_quota_limit: isAdmin && Boolean(b.override_quota_limit),
    });
    res.json(result);
  });

  router.post('/admissions/confirm', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), async (req: AuthedRequest, res) => {
    try {
      const b = req.body as {
        registration_id?: string;
        reservation_id?: string;
        patient_id?: string;
        patient_code: string;
        his_record_code?: string;
        patient_name: string;
        date_of_birth: string;
        phone?: string;
        diagnosis_group: string;
        department_id: string;
        room_id: string;
        bed_id: string;
        is_whole_room?: boolean;
        override_quota_limit?: boolean;
        expected_discharge_at?: string;
        notes?: string;
      };
      if (!b.patient_code?.trim() || !b.patient_name?.trim() || !b.department_id || !b.room_id || !b.bed_id) {
        res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin bệnh nhân, khoa, phòng và giường.' });
        return;
      }
      if (!enforceWardScope(req.authUser!, b.department_id)) {
        res.status(403).json({ error: 'Nhân viên khoa nội trú không được xác nhận nhập khoa cho khoa khác.' });
        return;
      }

      const db = cluster.getActiveNode().db;
      const cleanRegId = nullIfEmpty(b.registration_id);
      const cleanRsvId = nullIfEmpty(b.reservation_id);
      if (cleanRegId && !db.prepare('SELECT id FROM registrations WHERE id = ?').get(cleanRegId)) {
        res.status(400).json({ error: 'Phiếu đăng ký liên kết không tồn tại.' });
        return;
      }
      if (cleanRsvId && !db.prepare('SELECT id FROM reservations WHERE id = ?').get(cleanRsvId)) {
        res.status(400).json({ error: 'Lượt giữ chỗ liên kết không tồn tại.' });
        return;
      }
      if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(b.department_id) || !db.prepare('SELECT id FROM rooms WHERE id = ?').get(b.room_id)) {
        res.status(400).json({ error: 'Khoa phòng hoặc phòng bệnh không tồn tại.' });
        return;
      }

      const canOverrideQuota = req.authUser!.role === 'SUPER_ADMIN' || req.authUser!.role === 'ADMIN';
      const logicCheck = runAdmissionPrecheck({
        department_id: b.department_id,
        room_id: b.room_id,
        bed_id: b.bed_id,
        patient_code: b.patient_code,
        his_record_code: b.his_record_code,
        reservation_id: cleanRsvId ?? undefined,
        is_whole_room: b.is_whole_room,
        override_quota_limit: canOverrideQuota && Boolean(b.override_quota_limit),
      });

      if (!logicCheck.allowed && logicCheck.blocks.length > 0) {
        const primary = logicCheck.blocks[0];
        res.status(409).json({
          code: primary.code,
          error: primary.message,
          violations: logicCheck.blocks,
          warnings: logicCheck.warnings,
          departmentQuota: logicCheck.departmentQuota,
        });
        return;
      }

      const cfg = getConfigMap(db);
      const dayCfg = getDayConfig(cfg);
      const diagRow = db.prepare('SELECT default_days FROM diagnosis_configs WHERE name = ?').get(b.diagnosis_group) as
        | { default_days: number }
        | undefined;
      const now = new Date().toISOString();
      const expectedDischarge =
        b.expected_discharge_at || computeExpectedDischargeAt(now, diagRow?.default_days ?? 3, dayCfg);

      const admId = `adm-${crypto.randomUUID().slice(0, 8)}`;
      const patId = resolvePatientIdByCode(db, b.patient_code, b.patient_id);
      const admCode = `HS-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;

      const result = await cluster.proposeCriticalAllocation({
        nodeId: cluster.activeNodeId,
        userId: req.authUser!.id,
        requestType: b.is_whole_room ? 'EXCLUSIVE_ROOM' : 'ASSIGN_BED',
        eventType: 'ADMISSION_CONFIRM',
        aggregateType: 'ADMISSION',
        aggregateId: admId,
        bedId: b.bed_id,
        roomId: b.room_id,
        reservationId: cleanRsvId,
        isWholeRoom: Boolean(b.is_whole_room),
        payloadObj: {
          id: admId,
          admission_code: admCode,
          registration_id: cleanRegId,
          reservation_id: cleanRsvId,
          patient_id: patId,
          patient_code: b.patient_code.trim(),
          his_record_code: b.his_record_code?.trim() || '',
          patient_name: b.patient_name.trim(),
          date_of_birth: b.date_of_birth || '1990-01-01',
          phone: b.phone?.trim() || '',
          diagnosis_group: b.diagnosis_group || 'Khác',
          department_id: b.department_id,
          room_id: b.room_id,
          bed_id: b.bed_id,
          is_whole_room: Boolean(b.is_whole_room),
          hospital_admitted_at: now,
          bed_assigned_at: now,
          expected_discharge_at: expectedDischarge,
          calculation_method: dayCfg.method,
          status: 'ACTIVE',
          notes: b.notes || '',
          confirmed_by: req.authUser!.id,
          confirmed_by_name: req.authUser!.full_name,
          audit_action: 'CONFIRM_ADMISSION',
          audit_details: `Tiếp nhận ${b.patient_name} vào giường ${b.bed_id}`,
        },
      });

      res.status(201).json({
        id: admId,
        admission_code: admCode,
        warnings: logicCheck.warnings,
        departmentQuota: logicCheck.departmentQuota,
        ...result,
      });
    } catch (err) {
      if (err instanceof ConsensusConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // --- EXTENSIONS ---
  router.get('/extensions', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    if (scopedDeptId) {
      const rows = db
        .prepare(
          `SELECT be.*
           FROM bed_extensions be
           JOIN admissions a ON be.admission_id = a.id
           WHERE a.department_id = ?
           ORDER BY be.performed_at DESC`
        )
        .all(scopedDeptId);
      res.json(rows);
      return;
    }
    res.json(db.prepare('SELECT * FROM bed_extensions ORDER BY performed_at DESC').all());
  });

  router.post('/admissions/:id/extend', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const { new_expected_discharge_at, reason } = req.body as {
      new_expected_discharge_at: string;
      reason: string;
    };
    if (!new_expected_discharge_at || !reason?.trim()) {
      res.status(400).json({ error: 'Vui lòng chọn ngày trả mới và nhập lý do gia hạn.' });
      return;
    }
    const parsedNewDischarge = new Date(new_expected_discharge_at);
    if (Number.isNaN(parsedNewDischarge.getTime())) {
      res.status(400).json({ error: 'Ngày trả dự kiến mới không hợp lệ.' });
      return;
    }
    const db = cluster.getActiveNode().db;
    const adm = db
      .prepare(
        `SELECT a.*, b.code as bed_code FROM admissions a JOIN beds b ON a.bed_id = b.id WHERE a.id = ? AND a.status = 'ACTIVE'`
      )
      .get(req.params.id) as
      | {
          id: string;
          patient_id: string;
          patient_name: string;
          bed_id: string;
          bed_code: string;
          department_id: string;
          bed_assigned_at: string;
          expected_discharge_at: string;
        }
      | undefined;
    if (!adm) {
      res.status(404).json({ error: 'Không tìm thấy lượt nằm đang hoạt động.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, adm.department_id)) {
      res.status(403).json({ error: 'Không được phép gia hạn cho bệnh nhân của khoa khác.' });
      return;
    }
    if (parsedNewDischarge.getTime() <= new Date(adm.bed_assigned_at).getTime()) {
      res.status(400).json({ error: 'Ngày trả dự kiến mới phải sau thời điểm bệnh nhân nhận giường.' });
      return;
    }

    const normalizedNewDischarge = parsedNewDischarge.toISOString();
    const extId = `ext-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'BED_EXTEND', 'ADMISSION', adm.id, {
      id: extId,
      admission_id: adm.id,
      patient_id: adm.patient_id,
      patient_name: adm.patient_name,
      bed_id: adm.bed_id,
      bed_code: adm.bed_code,
      old_expected_discharge_at: adm.expected_discharge_at,
      new_expected_discharge_at: normalizedNewDischarge,
      reason: reason.trim(),
      performed_by: req.authUser!.id,
      performed_by_name: req.authUser!.full_name,
      performed_at: new Date().toISOString(),
      audit_action: 'EXTEND_BED',
      audit_details: `Gia hạn giường ${adm.bed_code} cho ${adm.patient_name}`,
    });

    res.status(201).json({ id: extId });
  });

  // --- TRANSFERS & TRANSFER REQUESTS (WITH >30 MIN DELAY ALERT) ---
  router.get('/transfers', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const rows = db
      .prepare(
        `SELECT t.*, fd.name as from_department_name, td.name as to_department_name,
                fb.code as from_bed_code, tb.code as to_bed_code
         FROM bed_transfers t
         JOIN departments fd ON t.from_department_id = fd.id
         JOIN departments td ON t.to_department_id = td.id
         JOIN beds fb ON t.from_bed_id = fb.id
         JOIN beds tb ON t.to_bed_id = tb.id
         ORDER BY t.performed_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    res.json(
      scopedDeptId
        ? rows.filter((r) => r.from_department_id === scopedDeptId || r.to_department_id === scopedDeptId)
        : rows
    );
  });

  router.get('/transfer-requests', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const nowMs = Date.now();
    const rows = db
      .prepare(
        `SELECT tr.*,
                fd.name as from_department_name, fr.name as from_room_name, fb.code as from_bed_code,
                td.name as to_department_name, trm.name as to_room_name, tb.code as to_bed_code
         FROM transfer_requests tr
         JOIN departments fd ON tr.from_department_id = fd.id
         JOIN rooms fr ON tr.from_room_id = fr.id
         JOIN beds fb ON tr.from_bed_id = fb.id
         JOIN departments td ON tr.to_department_id = td.id
         JOIN rooms trm ON tr.to_room_id = trm.id
         JOIN beds tb ON tr.to_bed_id = tb.id
         ORDER BY CASE WHEN tr.status = 'PENDING' THEN 0 ELSE 1 END, tr.requested_at ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const visible = scopedDeptId
      ? rows.filter((r) => r.from_department_id === scopedDeptId || r.to_department_id === scopedDeptId)
      : rows;

    res.json(
      visible.map((r) => {
        const endMs = r.completed_at ? new Date(String(r.completed_at)).getTime() : nowMs;
        const elapsedMinutes = Math.max(0, Math.round((endMs - new Date(String(r.requested_at)).getTime()) / 60000));
        return {
          ...r,
          elapsed_minutes: elapsedMinutes,
          is_delayed: r.status === 'PENDING' && elapsedMinutes > 30,
        };
      })
    );
  });

  router.post('/transfer-requests', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const { admission_id, to_department_id, to_room_id, to_bed_id, reason, notes } = req.body as {
      admission_id: string;
      to_department_id: string;
      to_room_id: string;
      to_bed_id: string;
      reason: string;
      notes?: string;
    };
    if (!admission_id || !to_department_id || !to_room_id || !to_bed_id || !reason?.trim()) {
      res.status(400).json({ error: 'Vui lòng chọn bệnh nhân, giường đích và nhập lý do điều chuyển.' });
      return;
    }

    const db = cluster.getActiveNode().db;
    const adm = db.prepare("SELECT * FROM admissions WHERE id = ? AND status = 'ACTIVE'").get(admission_id) as
      | { id: string; patient_id: string; patient_name: string; department_id: string; room_id: string; bed_id: string }
      | undefined;
    if (!adm) {
      res.status(404).json({ error: 'Không tìm thấy lượt nằm đang hoạt động.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, adm.department_id)) {
      res.status(403).json({ error: 'Không được phép tạo lệnh chuyển cho khoa khác.' });
      return;
    }

    const targetBed = db.prepare('SELECT id, room_id, department_id, status FROM beds WHERE id = ?').get(to_bed_id) as
      | { id: string; room_id: string; department_id: string; status: string }
      | undefined;
    if (!targetBed) {
      res.status(404).json({ error: 'Giường đích không tồn tại.' });
      return;
    }
    if (targetBed.id === adm.bed_id) {
      res.status(400).json({ error: 'Giường đích trùng với giường bệnh nhân đang nằm.' });
      return;
    }

    const reqId = `trq-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'TRANSFER_REQUEST_CREATE', 'TRANSFER_REQUEST', reqId, {
      id: reqId,
      admission_id: adm.id,
      patient_id: adm.patient_id,
      patient_name: adm.patient_name,
      from_department_id: adm.department_id,
      from_room_id: adm.room_id,
      from_bed_id: adm.bed_id,
      to_department_id: targetBed.department_id,
      to_room_id: targetBed.room_id,
      to_bed_id: targetBed.id,
      reason: reason.trim(),
      notes: notes || '',
      requested_by: req.authUser!.id,
      requested_by_name: req.authUser!.full_name,
      requested_at: new Date().toISOString(),
      audit_action: 'CREATE_TRANSFER_REQUEST',
      audit_details: `Tạo yêu cầu điều chuyển ${adm.patient_name} sang giường ${targetBed.id}`,
    });
    res.status(201).json({ id: reqId });
  });

  router.post('/transfer-requests/:id/complete', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), async (req: AuthedRequest, res) => {
    try {
      const db = cluster.getActiveNode().db;
      const tr = db.prepare("SELECT * FROM transfer_requests WHERE id = ? AND status = 'PENDING'").get(req.params.id) as
        | {
            id: string;
            admission_id: string;
            patient_id: string;
            patient_name: string;
            to_department_id: string;
            to_room_id: string;
            to_bed_id: string;
            reason: string;
          }
        | undefined;
      if (!tr) {
        res.status(404).json({ error: 'Không tìm thấy yêu cầu điều chuyển đang chờ.' });
        return;
      }
      const adm = db.prepare("SELECT * FROM admissions WHERE id = ? AND status = 'ACTIVE'").get(tr.admission_id) as
        | {
            id: string;
            patient_id: string;
            patient_name: string;
            department_id: string;
            room_id: string;
            bed_id: string;
            is_whole_room: number;
          }
        | undefined;
      if (!adm) {
        res.status(400).json({ error: 'Hồ sơ lưu trú không còn hoạt động để điều chuyển.' });
        return;
      }
      if (!enforceWardScope(req.authUser!, adm.department_id)) {
        res.status(403).json({ error: 'Không có quyền hoàn tất điều chuyển cho khoa khác.' });
        return;
      }

      const transferId = `trf-${crypto.randomUUID().slice(0, 8)}`;
      const cleaningLogId = `cln-${crypto.randomUUID().slice(0, 8)}`;
      const result = await cluster.proposeCriticalAllocation({
        nodeId: cluster.activeNodeId,
        userId: req.authUser!.id,
        requestType: 'ASSIGN_BED',
        eventType: 'BED_TRANSFER',
        aggregateType: 'ADMISSION',
        aggregateId: adm.id,
        bedId: tr.to_bed_id,
        roomId: tr.to_room_id,
        payloadObj: {
          id: transferId,
          transfer_request_id: tr.id,
          admission_id: adm.id,
          patient_id: adm.patient_id,
          patient_name: adm.patient_name,
          from_department_id: adm.department_id,
          from_room_id: adm.room_id,
          from_bed_id: adm.bed_id,
          to_department_id: tr.to_department_id,
          to_room_id: tr.to_room_id,
          to_bed_id: tr.to_bed_id,
          was_whole_room: Boolean(adm.is_whole_room),
          cleaning_log_id: cleaningLogId,
          reason: tr.reason,
          performed_by: req.authUser!.id,
          performed_by_name: req.authUser!.full_name,
          performed_at: new Date().toISOString(),
          audit_action: 'COMPLETE_TRANSFER_REQUEST',
          audit_details: `Hoàn tất lệnh điều chuyển ${adm.patient_name} sang giường ${tr.to_bed_id}`,
        },
      });
      res.json({ ok: true, id: transferId, ...result });
    } catch (err) {
      if (err instanceof ConsensusConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/transfer-requests/:id/cancel', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const tr = db.prepare("SELECT id, from_department_id FROM transfer_requests WHERE id = ? AND status = 'PENDING'").get(req.params.id) as
      | { id: string; from_department_id: string }
      | undefined;
    if (!tr) {
      res.status(404).json({ error: 'Không tìm thấy yêu cầu điều chuyển đang chờ.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, tr.from_department_id)) {
      res.status(403).json({ error: 'Không có quyền hủy yêu cầu chuyển khoa khác.' });
      return;
    }
    const { notes } = req.body as { notes?: string };
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'TRANSFER_REQUEST_CANCEL', 'TRANSFER_REQUEST', tr.id, {
      transfer_request_id: tr.id,
      performed_by: req.authUser!.id,
      performed_by_name: req.authUser!.full_name,
      notes: notes || 'Hủy lệnh điều chuyển',
      audit_action: 'CANCEL_TRANSFER_REQUEST',
      audit_details: `Hủy yêu cầu điều chuyển ${tr.id}`,
    });
    res.json({ ok: true });
  });

  router.post('/admissions/:id/transfer', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), async (req: AuthedRequest, res) => {
    try {
      const { to_department_id, to_room_id, to_bed_id, reason } = req.body as {
        to_department_id: string;
        to_room_id: string;
        to_bed_id: string;
        reason: string;
      };
      if (!to_department_id || !to_room_id || !to_bed_id || !reason?.trim()) {
        res.status(400).json({ error: 'Vui lòng chọn giường đích và nhập lý do điều chuyển.' });
        return;
      }
      const db = cluster.getActiveNode().db;
      const adm = db.prepare("SELECT * FROM admissions WHERE id = ? AND status = 'ACTIVE'").get(req.params.id) as
        | {
            id: string;
            patient_id: string;
            patient_name: string;
            department_id: string;
            room_id: string;
            bed_id: string;
            is_whole_room: number;
          }
        | undefined;
      if (!adm) {
        res.status(404).json({ error: 'Không tìm thấy lượt nằm đang hoạt động.' });
        return;
      }
      if (!enforceWardScope(req.authUser!, adm.department_id)) {
        res.status(403).json({ error: 'Không được phép điều chuyển bệnh nhân của khoa khác.' });
        return;
      }
      if (adm.bed_id === to_bed_id) {
        res.status(400).json({ error: 'Giường đích phải khác giường hiện tại của bệnh nhân.' });
        return;
      }

      const transferId = `trf-${crypto.randomUUID().slice(0, 8)}`;
      const cleaningLogId = `cln-${crypto.randomUUID().slice(0, 8)}`;
      const result = await cluster.proposeCriticalAllocation({
        nodeId: cluster.activeNodeId,
        userId: req.authUser!.id,
        requestType: 'ASSIGN_BED',
        eventType: 'BED_TRANSFER',
        aggregateType: 'ADMISSION',
        aggregateId: adm.id,
        bedId: to_bed_id,
        roomId: to_room_id,
        payloadObj: {
          id: transferId,
          admission_id: adm.id,
          patient_id: adm.patient_id,
          patient_name: adm.patient_name,
          from_department_id: adm.department_id,
          from_room_id: adm.room_id,
          from_bed_id: adm.bed_id,
          to_department_id,
          to_room_id,
          to_bed_id,
          was_whole_room: Boolean(adm.is_whole_room),
          cleaning_log_id: cleaningLogId,
          reason: reason.trim(),
          performed_by: req.authUser!.id,
          performed_by_name: req.authUser!.full_name,
          performed_at: new Date().toISOString(),
          audit_action: 'TRANSFER_BED',
          audit_details: `Điều chuyển ${adm.patient_name} sang giường ${to_bed_id}`,
        },
      });
      res.status(201).json({ id: transferId, ...result });
    } catch (err) {
      if (err instanceof ConsensusConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // --- DISCHARGE ---
  // Note: CASHIER is strictly forbidden from discharging on behalf of WARD_STAFF!
  router.post('/admissions/:id/discharge', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const { notes } = req.body as { notes?: string };
    const db = cluster.getActiveNode().db;
    const adm = db.prepare("SELECT * FROM admissions WHERE id = ? AND status = 'ACTIVE'").get(req.params.id) as
      | { id: string; department_id: string; patient_name: string; bed_id: string }
      | undefined;
    if (!adm) {
      res.status(404).json({ error: 'Không tìm thấy lượt nằm đang hoạt động.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, adm.department_id)) {
      res.status(403).json({ error: 'Nhân viên khoa nội trú không được trả giường hộ khoa khác.' });
      return;
    }

    const cleaningLogId = `cln-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'BED_DISCHARGE', 'ADMISSION', adm.id, {
      admission_id: adm.id,
      actual_discharge_at: new Date().toISOString(),
      performed_by: req.authUser!.id,
      cleaning_log_id: cleaningLogId,
      notes: notes || 'Xuất viện và chuyển giường sang chờ vệ sinh',
      audit_action: 'DISCHARGE_BED',
      audit_details: `Trả giường cho bệnh nhân ${adm.patient_name}`,
    });
    res.json({ ok: true, cleaning_log_id: cleaningLogId });
  });

  // --- CLEANING ---
  router.get('/cleaning', requireAuth, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const scopedDeptId = getScopedDeptId(req.authUser);
    const rows = db
      .prepare(
        `SELECT cl.*, b.code as bed_code, r.name as room_name, d.name as department_name
         FROM cleaning_logs cl
         JOIN beds b ON cl.bed_id = b.id
         JOIN rooms r ON cl.room_id = r.id
         JOIN departments d ON cl.department_id = d.id
         ORDER BY cl.requested_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    res.json(scopedDeptId ? rows.filter((r) => r.department_id === scopedDeptId) : rows);
  });

  router.post('/cleaning/:id/start', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const cl = db.prepare('SELECT * FROM cleaning_logs WHERE id = ?').get(req.params.id) as
      | { id: string; bed_id: string; department_id: string }
      | undefined;
    if (!cl) {
      res.status(404).json({ error: 'Không tìm thấy phiếu vệ sinh.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, cl.department_id)) {
      res.status(403).json({ error: 'Không có quyền thao tác vệ sinh cho khoa khác.' });
      return;
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'CLEANING_START', 'CLEANING', cl.id, {
      cleaning_log_id: cl.id,
      bed_id: cl.bed_id,
      performed_by_name: req.authUser!.full_name,
      audit_action: 'START_CLEANING',
      audit_details: `Bắt đầu vệ sinh giường ${cl.bed_id}`,
    });
    res.json({ ok: true });
  });

  router.post('/cleaning/:id/complete', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const cl = db.prepare('SELECT * FROM cleaning_logs WHERE id = ?').get(req.params.id) as
      | { id: string; bed_id: string; department_id: string }
      | undefined;
    if (!cl) {
      res.status(404).json({ error: 'Không tìm thấy phiếu vệ sinh.' });
      return;
    }
    if (!enforceWardScope(req.authUser!, cl.department_id)) {
      res.status(403).json({ error: 'Không có quyền xác nhận vệ sinh cho khoa khác.' });
      return;
    }
    const { notes } = req.body as { notes?: string };
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'CLEANING_COMPLETE', 'CLEANING', cl.id, {
      cleaning_log_id: cl.id,
      bed_id: cl.bed_id,
      performed_by: req.authUser!.id,
      performed_by_name: req.authUser!.full_name,
      notes,
      audit_action: 'COMPLETE_CLEANING',
      audit_details: `Hoàn tất vệ sinh giường ${cl.bed_id}, sẵn sàng đón bệnh nhân mới`,
    });
    res.json({ ok: true });
  });

  // --- HIS / EXCEL IMPORT ---
  router.post('/import/patients', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN', 'CASHIER'), (req: AuthedRequest, res) => {
    const { fileName, rows } = req.body as {
      fileName: string;
      rows: Array<{
        patient_code: string;
        his_record_code?: string;
        full_name: string;
        date_of_birth: string;
        phone?: string;
        diagnosis_group?: string;
      }>;
    };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'Không có dữ liệu hợp lệ để nhập.' });
      return;
    }

    const db = cluster.getActiveNode().db;
    const cfg = getConfigMap(db);
    const dayCfg = getDayConfig(cfg);
    let importedCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;
    const errors: Array<{ row: number; reason: string }> = [];

    rows.forEach((r, idx) => {
      if (!r.patient_code?.trim() || !r.full_name?.trim() || !r.date_of_birth?.trim()) {
        errorCount++;
        errors.push({ row: idx + 1, reason: 'Thiếu mã BN, họ tên hoặc ngày sinh' });
        return;
      }
      // Never merge solely by full_name! Check exact patient_code OR exact his_record_code
      const existingByCode = db
        .prepare("SELECT id FROM patients WHERE patient_code = ? OR (his_record_code != '' AND his_record_code = ?)")
        .get(r.patient_code.trim(), r.his_record_code?.trim() || '__NONE__');

      if (existingByCode) {
        duplicateCount++;
        return;
      }

      const patId = `pat-${crypto.randomUUID().slice(0, 8)}`;
      const regId = `reg-${crypto.randomUUID().slice(0, 8)}`;
      const regCode = `DK-IMP-${Date.now().toString().slice(-4)}-${idx + 1}`;
      const diag = r.diagnosis_group?.trim() || 'Khác';
      const now = new Date().toISOString();

      cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'REGISTRATION_CREATE', 'REGISTRATION', regId, {
        id: regId,
        registration_code: regCode,
        patient_id: patId,
        patient_code: r.patient_code.trim(),
        his_record_code: r.his_record_code?.trim() || '',
        patient_name: r.full_name.trim(),
        date_of_birth: r.date_of_birth.trim(),
        phone: r.phone?.trim() || '',
        diagnosis_group: diag,
        expected_admission_date: now,
        expected_discharge_date: computeExpectedDischargeAt(now, 3, dayCfg),
        desired_standard_ids: [],
        registration_mode: 'UNKNOWN_DEPT',
        department_id: null,
        reservation_type: 'WAITLIST',
        status: 'WAITING',
        notes: `Nhập từ file ${fileName}`,
        created_by: req.authUser!.id,
        created_by_name: req.authUser!.full_name,
      });
      importedCount++;
    });

    const logId = `imp-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'HIS_IMPORT_LOG', 'IMPORT', logId, {
      id: logId,
      file_name: fileName || 'import.xlsx',
      total_rows: rows.length,
      imported_rows: importedCount,
      duplicate_rows: duplicateCount,
      error_rows: errorCount,
      performed_by: req.authUser!.full_name,
      audit_action: 'IMPORT_HIS_EXCEL',
      audit_details: `Nhập ${importedCount}/${rows.length} dòng từ ${fileName}`,
    });

    res.json({
      totalRows: rows.length,
      importedRows: importedCount,
      duplicateRows: duplicateCount,
      errorRows: errorCount,
      errors,
    });
  });

  router.get('/import/logs', requireAuth, (_req, res) => {
    const db = cluster.getActiveNode().db;
    res.json(db.prepare('SELECT * FROM his_import_logs ORDER BY created_at DESC LIMIT 30').all());
  });

  // --- REPORTS (12 real analytical reports) ---
  router.get('/reports/analytics', requireAuth, (req, res) => {
    const db = cluster.getActiveNode().db;
    const deptFilter = (req.query.departmentId as string) || '';
    const cfg = getConfigMap(db);
    const dayCfg = getDayConfig(cfg);
    const nowIso = new Date().toISOString();

    const depts = db.prepare('SELECT * FROM departments').all() as Array<{ id: string; name: string }>;
    const rooms = db.prepare('SELECT * FROM rooms').all() as Array<{
      id: string;
      name: string;
      code: string;
      department_id: string;
      room_type: string;
      is_service: number;
      standard_ids: string;
      status: string;
      capacity: number;
    }>;
    const beds = db.prepare('SELECT * FROM beds').all() as Array<{ id: string; code: string; room_id: string; department_id: string; status: string }>;
    const admissions = db.prepare('SELECT * FROM admissions').all() as Array<Record<string, unknown>>;
    const registrations = db.prepare('SELECT * FROM registrations').all() as Array<Record<string, unknown>>;
    const reservations = db.prepare('SELECT * FROM reservations').all() as Array<Record<string, unknown>>;
    const roomStandards = db.prepare('SELECT id, name, code FROM room_standards ORDER BY is_default DESC, name ASC').all() as Array<{
      id: string;
      name: string;
      code: string;
    }>;
    const extensions = db.prepare('SELECT * FROM bed_extensions ORDER BY performed_at DESC').all();
    const transfers = db
      .prepare(
        `SELECT t.*, fd.name as from_department_name, td.name as to_department_name,
                fb.code as from_bed_code, tb.code as to_bed_code
         FROM bed_transfers t
         JOIN departments fd ON t.from_department_id = fd.id
         JOIN departments td ON t.to_department_id = td.id
         JOIN beds fb ON t.from_bed_id = fb.id
         JOIN beds tb ON t.to_bed_id = tb.id
         ORDER BY t.performed_at DESC`
      )
      .all();

    const filteredAdmissions = deptFilter ? admissions.filter((a) => a.department_id === deptFilter) : admissions;
    const filteredBeds = deptFilter ? beds.filter((b) => b.department_id === deptFilter) : beds;
    const filteredRooms = deptFilter ? rooms.filter((r) => r.department_id === deptFilter) : rooms;
    const filteredRegistrations = deptFilter ? registrations.filter((r) => r.department_id === deptFilter) : registrations;
    const filteredReservations = deptFilter ? reservations.filter((r) => r.department_id === deptFilter) : reservations;

    const deptUsage = depts.map((d) => {
      const dBeds = beds.filter((b) => b.department_id === d.id);
      const dOps = dBeds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length;
      const dOcc = dBeds.filter((b) => b.status === 'OCCUPIED').length;
      const dAdms = admissions.filter((a) => a.department_id === d.id);
      const dDischarged = dAdms.filter((a) => a.status === 'DISCHARGED').length;
      return {
        department_id: d.id,
        department_name: d.name,
        total_beds: dBeds.length,
        operational_beds: dOps,
        occupied_beds: dOcc,
        occupancy_rate: calculateBedOccupancyRate(dOcc, dOps),
        admission_count: dAdms.length,
        discharge_count: dDischarged,
      };
    });

    const roomUsage = filteredRooms.map((r) => {
      const rBeds = filteredBeds.filter((b) => b.room_id === r.id);
      const rOps = rBeds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length;
      const rOcc = rBeds.filter((b) => b.status === 'OCCUPIED').length;
      return {
        room_id: r.id,
        room_code: r.code,
        room_name: r.name,
        room_type: r.room_type,
        capacity: r.capacity,
        occupied: rOcc,
        occupancy_rate: calculateBedOccupancyRate(rOcc, rOps),
      };
    });

    let totalBedDays = 0;
    let completedCount = 0;
    let completedHours = 0;
    const overdueList: Array<Record<string, unknown>> = [];
    const dueSoonList: Array<Record<string, unknown>> = [];
    const deptNameMap = Object.fromEntries(depts.map((d) => [d.id, d.name]));
    const bedCodeMap = Object.fromEntries(beds.map((b) => [b.id, b.code]));

    for (const a of filteredAdmissions) {
      const metrics = calculateStayMetrics(
        a.bed_assigned_at as string,
        a.expected_discharge_at as string,
        (a.actual_discharge_at as string | null) ?? null,
        (a.calculation_method as BedDayConfig['method']) || 'CALENDAR_DAYS',
        dayCfg,
        nowIso
      );
      totalBedDays += metrics.daysStayed;
      if (a.status === 'DISCHARGED' && a.actual_discharge_at) {
        completedCount++;
        completedHours += Math.max(1, (new Date(a.actual_discharge_at as string).getTime() - new Date(a.bed_assigned_at as string).getTime()) / 3600000);
      }
      if (a.status === 'ACTIVE') {
        const enriched = {
          ...a,
          department_name: deptNameMap[a.department_id as string] ?? '',
          bed_code: bedCodeMap[a.bed_id as string] ?? '',
          stay_metrics: metrics,
        };
        if (metrics.dueState === 'OVERDUE') overdueList.push(enriched);
        if (metrics.dueState === 'DUE_SOON' || metrics.dueState === 'DUE_TODAY') dueSoonList.push(enriched);
      }
    }

    const avgStayDays = completedCount > 0 ? Math.round((completedHours / completedCount / 24) * 10) / 10 : totalBedDays > 0 && filteredAdmissions.length > 0 ? Math.round((totalBedDays / filteredAdmissions.length) * 10) / 10 : 0;

    const customerTrends = analyzeCustomerRegistrationTrends({
      registrations: filteredRegistrations.map((r) => ({
        id: String(r.id),
        status: String(r.status),
        diagnosis_group: String(r.diagnosis_group || ''),
        registration_mode: String(r.registration_mode || 'UNKNOWN_DEPT'),
        reservation_type: String(r.reservation_type || 'NONE'),
        department_id: r.department_id ? String(r.department_id) : null,
        desired_standard_ids: JSON.parse(String(r.desired_standard_ids || '[]')),
      })),
      reservations: filteredReservations.map((r) => ({
        id: String(r.id),
        is_whole_room: Number(r.is_whole_room ?? 0),
        department_id: String(r.department_id),
        status: String(r.status),
      })),
      admissions: filteredAdmissions.map((a) => ({
        id: String(a.id),
        diagnosis_group: String(a.diagnosis_group || ''),
        department_id: String(a.department_id),
        is_whole_room: Number(a.is_whole_room ?? 0),
        room_id: String(a.room_id),
      })),
      rooms: filteredRooms.map((r) => ({
        id: String(r.id),
        department_id: String(r.department_id),
        room_type: String(r.room_type),
        is_service: Number(r.is_service ?? 0),
        standard_ids: JSON.parse(String(r.standard_ids || '[]')),
        status: String(r.status || 'ACTIVE'),
      })),
      beds: filteredBeds,
      roomStandards,
      departments: depts,
    });

    res.json({
      kpi: {
        totalAdmissions: filteredAdmissions.length,
        totalDischarges: filteredAdmissions.filter((a) => a.status === 'DISCHARGED').length,
        totalBedDays,
        totalExtensions: extensions.length,
        totalTransfers: transfers.length,
        avgStayDays,
        occupancyRate: calculateBedOccupancyRate(
          filteredBeds.filter((b) => b.status === 'OCCUPIED').length,
          filteredBeds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length
        ),
      },
      deptUsage,
      roomUsage,
      overdueList,
      dueSoonList,
      transfers,
      extensions,
      customerTrends,
    });
  });

  // --- USERS & RBAC ---
  router.get('/users', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (_req, res) => {
    const db = cluster.getActiveNode().db;
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.his_permission, u.status, u.created_at, u.updated_at, d.name as department_name
         FROM users u
         LEFT JOIN departments d ON u.department_id = d.id
         ORDER BY CASE WHEN LOWER(u.username) = 'admin' THEN 0 ELSE 1 END, u.created_at ASC`
      )
      .all() as Array<{ id: string; username: string; role: UserRole; his_permission?: HisPermissionLevel; [key: string]: unknown }>;
    res.json(
      rows.map((u) => ({
        ...u,
        his_permission: resolveEffectiveHisPermission(u.role, u.his_permission),
        is_default_admin: isDefaultAdminAccount(u),
      }))
    );
  });

  router.post('/users', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { id, username, password, full_name, role, department_id, his_permission, status } = req.body as {
      id?: string;
      username: string;
      password?: string;
      full_name: string;
      role: UserRole;
      department_id?: string | null;
      his_permission?: HisPermissionLevel;
      status?: 'ACTIVE' | 'LOCKED' | 'REVOKED';
    };
    const cleanUsername = username?.trim();
    if (!cleanUsername || !full_name?.trim() || !role) {
      res.status(400).json({ error: 'Thiếu tên đăng nhập, họ tên hoặc nhóm quyền.' });
      return;
    }

    const db = cluster.getActiveNode().db;

    if (id) {
      const existing = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as
        | { id: string; username: string; role: UserRole }
        | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Không tìm thấy tài khoản cần cập nhật.' });
        return;
      }
      const check = validateUserUpdateRule({
        actorRole: req.authUser!.role,
        targetUser: existing,
        nextUsername: cleanUsername,
        nextRole: role,
        nextStatus: status,
      });
      if (!check.allowed) {
        res.status(check.statusCode).json({ error: check.error });
        return;
      }
    } else {
      if (req.authUser!.role === 'ADMIN' && role === 'SUPER_ADMIN') {
        res.status(403).json({ error: 'Admin không được phép tạo tài khoản Super Admin.' });
        return;
      }
      const dup = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(cleanUsername.toLowerCase());
      if (dup) {
        res.status(409).json({ error: `Tên đăng nhập "${cleanUsername}" đã tồn tại trong hệ thống.` });
        return;
      }
      if (!password || password.length < MIN_USER_PASSWORD_LENGTH) {
        res.status(400).json({ error: `Mật khẩu tạo mới tối thiểu ${MIN_USER_PASSWORD_LENGTH} ký tự.` });
        return;
      }
    }

    const userId = id || `usr-${crypto.randomUUID().slice(0, 8)}`;
    const isDefault = id ? isDefaultAdminAccount({ id, username: cleanUsername }) : false;
    const effectiveRole = isDefault ? 'SUPER_ADMIN' : role;
    const effectiveHisPerm =
      effectiveRole === 'SUPER_ADMIN' || effectiveRole === 'ADMIN'
        ? 'FULL'
        : (his_permission === 'VIEW' || his_permission === 'SYNC_AND_MAP' ? his_permission : 'NONE');
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'USER_UPSERT', 'USER', userId, {
      id: userId,
      username: isDefault ? 'admin' : cleanUsername,
      password_hash: password ? hashPassword(password) : '',
      full_name: full_name.trim(),
      role: effectiveRole,
      department_id: isDefault ? null : (effectiveRole === 'WARD_STAFF' ? department_id || null : null),
      his_permission: effectiveHisPerm,
      status: isDefault ? 'ACTIVE' : (status || 'ACTIVE'),
      audit_action: id ? 'UPDATE_USER' : 'CREATE_USER',
      audit_details: `${id ? 'Cập nhật' : 'Tạo'} tài khoản ${cleanUsername} (${effectiveRole} · HIS: ${effectiveHisPerm})`,
    });
    res.status(id ? 200 : 201).json({ id: userId });
  });

  router.put('/users/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const existing = db.prepare('SELECT id, username, role, status FROM users WHERE id = ?').get(req.params.id) as
      | { id: string; username: string; role: UserRole; status: 'ACTIVE' | 'LOCKED' | 'REVOKED' }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      return;
    }

    const { username, full_name, role, department_id, his_permission, status, password } = req.body as {
      username?: string;
      full_name: string;
      role: UserRole;
      department_id?: string | null;
      his_permission?: HisPermissionLevel;
      status?: 'ACTIVE' | 'LOCKED' | 'REVOKED';
      password?: string;
    };

    if (!full_name?.trim() || !role) {
      res.status(400).json({ error: 'Họ tên và nhóm quyền là bắt buộc.' });
      return;
    }
    if (password && password.length < MIN_USER_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Mật khẩu mới tối thiểu ${MIN_USER_PASSWORD_LENGTH} ký tự.` });
      return;
    }

    const check = validateUserUpdateRule({
      actorRole: req.authUser!.role,
      targetUser: existing,
      nextUsername: username,
      nextRole: role,
      nextStatus: status,
    });
    if (!check.allowed) {
      res.status(check.statusCode).json({ error: check.error });
      return;
    }

    const isDefault = isDefaultAdminAccount(existing);
    const effectiveRole = isDefault ? 'SUPER_ADMIN' : role;
    const effectiveHisPerm =
      effectiveRole === 'SUPER_ADMIN' || effectiveRole === 'ADMIN'
        ? 'FULL'
        : (his_permission === 'VIEW' || his_permission === 'SYNC_AND_MAP' ? his_permission : 'NONE');
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'USER_UPSERT', 'USER', existing.id, {
      id: existing.id,
      username: existing.username,
      password_hash: password ? hashPassword(password) : '',
      full_name: full_name.trim(),
      role: effectiveRole,
      department_id: isDefault ? null : (effectiveRole === 'WARD_STAFF' ? department_id || null : null),
      his_permission: effectiveHisPerm,
      status: isDefault ? 'ACTIVE' : (status || existing.status),
      audit_action: 'UPDATE_USER',
      audit_details: `Cập nhật thông tin tài khoản ${existing.username} (${effectiveRole} · HIS: ${effectiveHisPerm})`,
    });

    res.json({ ok: true, id: existing.id });
  });

  router.post('/users/:id/reset-password', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const existing = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id) as
      | { id: string; username: string; role: UserRole }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      return;
    }
    if (req.authUser!.role === 'ADMIN' && existing.role === 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Admin hệ thống không được phép đặt lại mật khẩu tài khoản Super Admin.' });
      return;
    }

    const { new_password } = req.body as { new_password?: string };
    const isDefault = isDefaultAdminAccount(existing);
    const trimmed = new_password?.trim();
    if (trimmed && trimmed.length < MIN_USER_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Mật khẩu đặt lại tối thiểu ${MIN_USER_PASSWORD_LENGTH} ký tự.` });
      return;
    }

    const finalPassword = trimmed || (isDefault ? DEFAULT_ADMIN_PASSWORD : DEFAULT_STAFF_RESET_PASSWORD);
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'USER_PASSWORD_RESET', 'USER', existing.id, {
      user_id: existing.id,
      password_hash: hashPassword(finalPassword),
      audit_action: 'RESET_USER_PASSWORD',
      audit_details: `Reset mật khẩu tài khoản ${existing.username}${trimmed ? ' (mật khẩu tùy chỉnh)' : ` (về mặc định)`}`,
    });

    res.json({
      ok: true,
      resetToDefault: !trimmed,
      defaultHint: trimmed ? null : finalPassword,
    });
  });

  router.post('/users/:id/status', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { status } = req.body as { status: 'ACTIVE' | 'LOCKED' | 'REVOKED' };
    const db = cluster.getActiveNode().db;
    const existing = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id) as
      | { id: string; username: string; role: UserRole }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      return;
    }

    const check = validateUserStatusRule({
      actorId: req.authUser!.id,
      actorRole: req.authUser!.role,
      targetUser: existing,
      nextStatus: status,
    });
    if (!check.allowed) {
      res.status(check.statusCode).json({ error: check.error });
      return;
    }

    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'USER_STATUS_CHANGE', 'USER', existing.id, {
      user_id: existing.id,
      status,
      audit_action: 'CHANGE_USER_STATUS',
      audit_details: `Đổi trạng thái tài khoản ${existing.username} -> ${status}`,
    });
    res.json({ ok: true });
  });

  router.delete('/users/:id', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const existing = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id) as
      | { id: string; username: string; role: UserRole }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      return;
    }

    const check = validateUserDeleteRule({
      actorId: req.authUser!.id,
      actorRole: req.authUser!.role,
      targetUser: existing,
    });
    if (!check.allowed) {
      res.status(check.statusCode).json({ error: check.error });
      return;
    }

    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'USER_DELETE', 'USER', existing.id, {
      user_id: existing.id,
      audit_action: 'DELETE_USER',
      audit_details: `Xóa tài khoản ${existing.username} (${existing.role})`,
    });
    res.json({ ok: true });
  });

  // --- BACKUP & RESTORE ---
  router.get('/backups', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (_req, res) => {
    const db = cluster.getActiveNode().db;
    res.json(db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all());
  });

  router.post('/backups', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const created = cluster.createEncryptedBackup(cluster.activeNodeId, req.authUser!.username);
    res.status(201).json(created);
  });

  router.get('/backups/:id/download', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req, res) => {
    try {
      const { backupName, envelope } = cluster.getEncryptedBackupEnvelope(cluster.activeNodeId, req.params.id);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${backupName}"`);
      res.send(JSON.stringify(envelope, null, 2));
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  router.post('/backups/:id/verify', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req, res) => {
    try {
      const result = cluster.verifyEncryptedBackup(cluster.activeNodeId, req.params.id);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/backups/upload-restore', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), async (req: AuthedRequest, res) => {
    try {
      const { fileName, envelope } = req.body as {
        fileName?: string;
        envelope: {
          version: string;
          algorithm: 'aes-256-gcm';
          iv: string;
          authTag: string;
          ciphertext: string;
          checksum_sha256: string;
        };
      };
      const result = await cluster.restoreFromUploadedEnvelope(
        cluster.activeNodeId,
        fileName || `backup-${Date.now()}.bcare`,
        envelope,
        req.authUser!.username
      );
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/backups/:id/restore', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), async (req: AuthedRequest, res) => {
    try {
      const result = await cluster.restoreEncryptedBackup(cluster.activeNodeId, req.params.id, req.authUser!.username);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // --- SYSTEM CONFIGS & DIAGNOSIS CONFIGS & AUDIT LOGS ---
  router.get('/settings', requireAuth, (_req, res) => {
    const db = cluster.getActiveNode().db;
    const configs = getConfigMap(db);
    const diagnoses = db.prepare('SELECT * FROM diagnosis_configs ORDER BY name ASC').all();
    const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 80').all();
    res.json({ configs, diagnoses, auditLogs });
  });

  router.post('/settings/configs', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { configs } = req.body as { configs: Record<string, string> };
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'SYSTEM_CONFIG_UPDATE', 'CONFIG', 'system', {
      configs,
      audit_action: 'UPDATE_SYSTEM_CONFIG',
      audit_details: 'Cập nhật cấu hình phương pháp tính ngày giường và cảnh báo',
    });
    res.json({ ok: true });
  });

  router.post('/settings/diagnoses', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { id, name, default_days, description, is_active } = req.body as {
      id?: string;
      name: string;
      default_days: number;
      description?: string;
      is_active?: number;
    };
    if (!name?.trim() || !default_days || default_days < 1) {
      res.status(400).json({ error: 'Tên nhóm chẩn đoán và số ngày dự kiến (>= 1) là bắt buộc.' });
      return;
    }
    const diagId = id || `diag-${crypto.randomUUID().slice(0, 8)}`;
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'DIAGNOSIS_CONFIG_UPSERT', 'DIAGNOSIS', diagId, {
      id: diagId,
      name: name.trim(),
      default_days: Number(default_days),
      description: description || '',
      is_active: is_active ?? 1,
      audit_action: 'UPSERT_DIAGNOSIS_CONFIG',
      audit_details: `Cấu hình ngày nằm nhóm ${name}: ${default_days} ngày`,
    });
    res.status(201).json({ id: diagId });
  });

  router.post('/settings/clear-demo-data', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    clearDemoOperationalData(cluster, req.authUser!.id);
    res.json({ ok: true });
  });

  router.post('/settings/seed-demo-data', requireAuth, requireRoles('SUPER_ADMIN'), (_req, res) => {
    const node = cluster.getActiveNode();
    const admCount = (node.db.prepare('SELECT COUNT(*) as c FROM admissions').get() as { c: number }).c;
    if (admCount === 0) {
      // Re-seed operational demo data safely only if empty
      node.db.exec('DELETE FROM users');
      seedDemoClusterIfEmpty(cluster);
    }
    res.json({ ok: true });
  });

  // --- HIS INTEGRATION, BED MAPPING & BHYT COMPLIANCE AUDIT ---
  const requireHisView = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser || !canViewHisModule(req.authUser.role, req.authUser.his_permission)) {
      res.status(403).json({
        error: 'Tài khoản chưa được Admin cấp quyền truy cập phân hệ Kết nối HIS & Giám định BHYT.',
      });
      return;
    }
    next();
  };

  const requireHisSyncAndMap = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser || !canSyncAndMapHis(req.authUser.role, req.authUser.his_permission)) {
      res.status(403).json({
        error: 'Tài khoản chỉ có quyền xem hoặc không có quyền đồng bộ / ánh xạ HIS.',
      });
      return;
    }
    next();
  };

  const buildHisAuditPayload = () => {
    const db = cluster.getActiveNode().db;
    const departments = db.prepare("SELECT * FROM departments WHERE status = 'ACTIVE' ORDER BY name ASC").all() as unknown[];
    const rooms = db.prepare("SELECT * FROM rooms WHERE status = 'ACTIVE' ORDER BY code ASC").all() as unknown[];
    const bedsRaw = db
      .prepare(
        `SELECT b.*, r.code as room_code, r.name as room_name, r.room_type, r.capacity as room_capacity,
                r.exclusive_locked, d.code as department_code, d.name as department_name,
                d.his_dept_code as default_his_dept_code,
                COALESCE(NULLIF(b.daily_price, 0), bt.daily_price, 0) as effective_daily_price
         FROM beds b
         JOIN rooms r ON b.room_id = r.id
         JOIN departments d ON b.department_id = d.id
         LEFT JOIN bed_types bt ON b.bed_type_id = bt.id
         ORDER BY b.code ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const existingMappings = db.prepare('SELECT * FROM his_bed_mappings').all() as Array<Record<string, unknown>>;
    const mapByBedId = new Map(existingMappings.map((m) => [String(m.bed_id), m]));

    const mappings = bedsRaw.map((b) => {
      const m = mapByBedId.get(String(b.id));
      return {
        bed_id: String(b.id),
        bed_code: String(b.code),
        bed_name: String(b.name),
        bed_status: String(b.status) as any,
        room_id: String(b.room_id),
        room_code: String(b.room_code),
        room_name: String(b.room_name),
        room_type: String(b.room_type) as any,
        room_capacity: Number(b.room_capacity ?? 1),
        department_id: String(b.department_id),
        department_code: String(b.department_code),
        department_name: String(b.department_name),
        daily_price: Number(b.effective_daily_price ?? 0),
        his_dept_code: m ? String(m.his_dept_code) : String(b.default_his_dept_code || ''),
        his_room_code: m ? String(m.his_room_code) : '',
        his_bed_code: m ? String(m.his_bed_code) : '',
        his_bed_type_code: m ? String(m.his_bed_type_code) : 'H2',
        bhyt_max_daily_price: m ? Number(m.bhyt_max_daily_price ?? 0) : Number(b.effective_daily_price ?? 0),
        allow_shared_bed: m ? Number(m.allow_shared_bed ?? 0) : 0,
        notes: m ? String(m.notes ?? '') : '',
        updated_by: m ? String(m.updated_by ?? '') : '',
        updated_at: m ? String(m.updated_at ?? '') : '',
      };
    });

    const activeAdmissions = db
      .prepare("SELECT * FROM admissions WHERE status IN ('ACTIVE', 'PENDING_CONFIRMATION')")
      .all() as unknown[];
    const assignments = db
      .prepare('SELECT * FROM his_bed_assignments ORDER BY synced_at DESC, admitted_at DESC')
      .all() as unknown[];
    const resolutions = db.prepare('SELECT * FROM his_audit_resolutions').all() as unknown[];
    const importLogs = db.prepare('SELECT * FROM his_import_logs ORDER BY created_at DESC LIMIT 20').all() as Array<Record<string, unknown>>;

    const report = evaluateHisAndBhytCompliance({
      departments: departments as any,
      rooms: rooms.map((r: any) => ({
        ...r,
        standard_ids: safeParseJson(r.standard_ids) ?? [],
      })),
      beds: bedsRaw.map((b) => ({
        ...b,
        daily_price: Number(b.effective_daily_price ?? 0),
      })) as any,
      activeAdmissions: activeAdmissions as any,
      mappings: mappings as any,
      assignments: assignments as any,
      resolutions: resolutions as any,
      importLogs,
    });

    const cfg = getConfigMap(db);
    return {
      ...report,
      config: {
        his_api_url: cfg.his_api_url || '',
        his_api_enabled: cfg.his_api_enabled === 'true',
        his_sync_mode: cfg.his_sync_mode || 'MANUAL_IMPORT',
        has_token: Boolean(cfg.his_api_token && cfg.his_api_token.trim().length > 0),
      },
    };
  };

  router.get('/his/overview', requireAuth, requireHisView, (req: AuthedRequest, res) => {
    const payload = buildHisAuditPayload();
    res.json({
      ...payload,
      myPermission: resolveEffectiveHisPermission(req.authUser!.role, req.authUser!.his_permission),
      isAdminFull: canManageHisConfigAndQuotas(req.authUser!.role),
    });
  });

  router.post('/his/config', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const { his_api_url, his_api_enabled, his_api_token, his_sync_mode } = req.body as {
      his_api_url?: string;
      his_api_enabled?: boolean;
      his_api_token?: string;
      his_sync_mode?: string;
    };
    const updates: Record<string, string> = {
      his_api_url: String(his_api_url ?? '').trim(),
      his_api_enabled: his_api_enabled ? 'true' : 'false',
      his_sync_mode: String(his_sync_mode || 'MANUAL_IMPORT'),
    };
    if (his_api_token !== undefined && his_api_token.trim() !== '') {
      updates.his_api_token = his_api_token.trim();
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'SYSTEM_CONFIG_UPDATE', 'CONFIG', 'his', {
      configs: updates,
      audit_action: 'UPDATE_HIS_CONFIG',
      audit_details: `Cấu hình kết nối HIS (${updates.his_api_enabled === 'true' ? 'BẬT' : 'TẮT'} · ${updates.his_sync_mode})`,
    });
    res.json({ ok: true });
  });

  router.post('/his/departments/:id/quota', requireAuth, requireRoles('SUPER_ADMIN', 'ADMIN'), (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(req.params.id) as
      | { id: string; name: string }
      | undefined;
    if (!dept) {
      res.status(404).json({ error: 'Không tìm thấy khoa nội trú.' });
      return;
    }
    const { his_dept_code, planned_bhyt_beds, max_bhyt_overage_pct } = req.body as {
      his_dept_code?: string;
      planned_bhyt_beds: number;
      max_bhyt_overage_pct?: number;
    };
    const planned = Number(planned_bhyt_beds);
    const overage = Number(max_bhyt_overage_pct ?? 120);
    if (!Number.isFinite(planned) || planned < 0) {
      res.status(400).json({ error: 'Số giường kế hoạch BHYT phải >= 0.' });
      return;
    }
    if (!Number.isFinite(overage) || overage < 100 || overage > 300) {
      res.status(400).json({ error: 'Ngưỡng cảnh báo công suất BHYT hợp lệ từ 100% đến 300%.' });
      return;
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'DEPARTMENT_HIS_QUOTA_UPDATE', 'DEPARTMENT', dept.id, {
      department_id: dept.id,
      his_dept_code: String(his_dept_code ?? '').trim().toUpperCase(),
      planned_bhyt_beds: Math.round(planned),
      max_bhyt_overage_pct: Math.round(overage),
      audit_action: 'UPDATE_BHYT_DEPT_QUOTA',
      audit_details: `Cập nhật mã HIS & chỉ tiêu BHYT ${dept.name}: ${Math.round(planned)} giường KH (ngưỡng ${Math.round(overage)}%)`,
    });
    res.json({ ok: true });
  });

  router.post('/his/mappings', requireAuth, requireHisSyncAndMap, (req: AuthedRequest, res) => {
    const body = req.body as {
      mappings?: Array<{
        bed_id: string;
        his_dept_code: string;
        his_room_code?: string;
        his_bed_code: string;
        his_bed_type_code?: string;
        bhyt_max_daily_price?: number;
        allow_shared_bed?: boolean | number;
        notes?: string;
      }>;
      bed_id?: string;
      his_dept_code?: string;
      his_room_code?: string;
      his_bed_code?: string;
      his_bed_type_code?: string;
      bhyt_max_daily_price?: number;
      allow_shared_bed?: boolean | number;
      notes?: string;
    };

    const items = Array.isArray(body.mappings)
      ? body.mappings
      : body.bed_id
        ? [
            {
              bed_id: body.bed_id,
              his_dept_code: body.his_dept_code || '',
              his_room_code: body.his_room_code || '',
              his_bed_code: body.his_bed_code || '',
              his_bed_type_code: body.his_bed_type_code || 'H2',
              bhyt_max_daily_price: body.bhyt_max_daily_price ?? 0,
              allow_shared_bed: body.allow_shared_bed ?? 0,
              notes: body.notes || '',
            },
          ]
        : [];

    if (items.length === 0) {
      res.status(400).json({ error: 'Thiếu dữ liệu ánh xạ giường HIS.' });
      return;
    }

    const db = cluster.getActiveNode().db;
    const seenHisCodesInBatch = new Map<string, string>();
    const updatingBedIds = new Set(items.map((i) => i.bed_id));

    for (const item of items) {
      const exists = db.prepare('SELECT id FROM beds WHERE id = ?').get(item.bed_id);
      if (!exists) {
        res.status(404).json({ error: `Không tìm thấy giường ${item.bed_id} trong BEDCARE.` });
        return;
      }
      if (item.his_bed_code?.trim()) {
        const cleanHisCode = item.his_bed_code.trim().toUpperCase();
        const batchOtherBed = seenHisCodesInBatch.get(cleanHisCode);
        if (batchOtherBed && batchOtherBed !== item.bed_id) {
          res.status(409).json({
            error: `Mã giường HIS "${cleanHisCode}" bị gán trùng cho 2 giường trong cùng một lượt lưu.`,
          });
          return;
        }
        seenHisCodesInBatch.set(cleanHisCode, item.bed_id);

        const conflict = db
          .prepare('SELECT bed_id FROM his_bed_mappings WHERE UPPER(his_bed_code) = ? AND bed_id != ?')
          .get(cleanHisCode, item.bed_id) as { bed_id: string } | undefined;
        if (conflict && !updatingBedIds.has(conflict.bed_id)) {
          res.status(409).json({
            error: `Mã giường HIS "${cleanHisCode}" đã được ánh xạ cho một giường khác. Không thể gán trùng 1 mã HIS cho 2 giường vật lý.`,
          });
          return;
        }
      }
    }

    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'HIS_BED_MAPPING_UPSERT', 'HIS_MAPPING', items[0].bed_id, {
      mappings: items.map((i) => ({ ...i, updated_by: req.authUser!.username })),
      audit_action: 'UPSERT_HIS_BED_MAPPING',
      audit_details: `Cập nhật ánh xạ HIS ↔ BEDCARE (${items.length} giường)`,
    });

    res.json({ ok: true, count: items.length });
  });

  router.post('/his/mappings/auto-suggest', requireAuth, requireHisSyncAndMap, (req: AuthedRequest, res) => {
    const db = cluster.getActiveNode().db;
    const rows = db
      .prepare(
        `SELECT b.id as bed_id, b.code as bed_code, b.daily_price, r.code as room_code, r.room_type,
                d.id as department_id, d.code as dept_code, d.his_dept_code,
                COALESCE(NULLIF(b.daily_price, 0), bt.daily_price, 0) as eff_price
         FROM beds b
         JOIN rooms r ON b.room_id = r.id
         JOIN departments d ON b.department_id = d.id
         LEFT JOIN bed_types bt ON b.bed_type_id = bt.id`
      )
      .all() as Array<Record<string, unknown>>;

    const existing = new Set(
      (
        db.prepare("SELECT bed_id FROM his_bed_mappings WHERE TRIM(his_bed_code) != ''").all() as Array<{
          bed_id: string;
        }>
      ).map((x) => x.bed_id)
    );

    const toInsert = rows
      .filter((r) => !existing.has(String(r.bed_id)))
      .map((r) => {
        const hisDept = String(r.his_dept_code || r.dept_code || 'K00').toUpperCase();
        return {
          bed_id: String(r.bed_id),
          his_dept_code: hisDept,
          his_room_code: String(r.room_code),
          his_bed_code: `HIS-${hisDept}-${String(r.bed_code)}`,
          his_bed_type_code:
            r.department_id === 'dept-hoi-suc'
              ? 'H1'
              : r.room_type === 'VIP' || r.room_type === 'SERVICE'
                ? 'DV'
                : 'H2',
          bhyt_max_daily_price: Number(r.eff_price ?? 0),
          allow_shared_bed: r.room_type === 'STANDARD' ? 1 : 0,
          notes: 'Tự động gợi ý ánh xạ theo mã khoa & giường',
          updated_by: req.authUser!.username,
        };
      });

    if (toInsert.length > 0) {
      cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'HIS_BED_MAPPING_UPSERT', 'HIS_MAPPING', 'auto-map', {
        mappings: toInsert,
        audit_action: 'AUTO_MAP_HIS_BEDS',
        audit_details: `Tự động ánh xạ ${toInsert.length} giường chưa có mã HIS`,
      });
    }

    res.json({ ok: true, mappedCount: toInsert.length });
  });

  router.post('/his/sync', requireAuth, requireHisSyncAndMap, async (req: AuthedRequest, res) => {
    try {
      const { mode, payload, api_url, source_label } = req.body as {
        mode: 'LIVE_API' | 'PAYLOAD' | 'SAMPLE_BHYT_AUDIT';
        payload?: unknown;
        api_url?: string;
        source_label?: string;
      };

      const db = cluster.getActiveNode().db;
      const cfg = getConfigMap(db);
      const now = new Date().toISOString();
      const batchId = `his-batch-${crypto.randomUUID().slice(0, 8)}`;

      let parsedRows = [];
      let sourceName = source_label || 'HIS_MANUAL_IMPORT';

      if (mode === 'LIVE_API') {
        const targetUrl = String(api_url || cfg.his_api_url || '').trim();
        if (!targetUrl) {
          res.status(400).json({ error: 'Chưa cấu hình Endpoint API HIS. Admin vui lòng nhập URL HIS hoặc chọn nhập CSV/JSON.' });
          return;
        }
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (cfg.his_api_token?.trim()) {
          headers.Authorization = `Bearer ${cfg.his_api_token.trim()}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let response: globalThis.Response;
        try {
          response = await fetch(targetUrl, { headers, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (!response.ok) {
          res.status(502).json({ error: `Cổng HIS trả về HTTP ${response.status}. Vui lòng kiểm tra kết nối LAN/API HIS.` });
          return;
        }
        const json = await response.json();
        parsedRows = parseHisPayloadInput(json, now);
        sourceName = `HIS_API (${new URL(targetUrl).hostname})`;
      } else if (mode === 'SAMPLE_BHYT_AUDIT') {
        // Build realistic HIS payload reflecting current live admissions + deliberate BHYT & HIS audit anomalies
        const activeAdms = db
          .prepare(
            `SELECT a.*, b.code as bed_code, d.his_dept_code, r.code as room_code, m.his_bed_code, m.his_bed_type_code
             FROM admissions a
             JOIN beds b ON a.bed_id = b.id
             JOIN rooms r ON a.room_id = r.id
             JOIN departments d ON a.department_id = d.id
             LEFT JOIN his_bed_mappings m ON m.bed_id = b.id
             WHERE a.status = 'ACTIVE'`
          )
          .all() as Array<Record<string, unknown>>;

        const sampleInput: Array<Record<string, unknown>> = activeAdms.map((a, idx) => ({
          his_assignment_id: `HIS-ASG-${100 + idx}`,
          his_record_code: String(a.his_record_code || a.admission_code),
          patient_code: String(a.patient_code),
          patient_name: String(a.patient_name),
          date_of_birth: String(a.date_of_birth || '1992-01-01'),
          bhyt_card_no: `DN479${String(1000000000 + idx).slice(-10)}`,
          his_dept_code: String(a.his_dept_code || 'K15'),
          his_room_code: String(a.room_code || ''),
          his_bed_code: String(a.his_bed_code || `HIS-K15-${a.bed_code}`),
          his_bed_type_code: String(a.his_bed_type_code || 'H2'),
          bed_ratio: 1.0,
          bed_days_billed: 2,
          admitted_at: String(a.bed_assigned_at),
          status: 'ACTIVE',
        }));

        // Deliberately inject realistic hospital HIS vs BHYT violations for audit showcase:
        // 1) Double occupancy on HIS-K15-A102-G01 (or A101-G01)
        const targetDup = sampleInput[0] ?? {
          his_dept_code: 'K15',
          his_room_code: 'A101',
          his_bed_code: 'HIS-K15-A101-G01',
        };
        sampleInput.push({
          his_assignment_id: 'HIS-ASG-DUP-1',
          his_record_code: 'HIS-88201',
          patient_code: 'BN-HIS-88201',
          patient_name: 'Phạm Thị Thanh Hà (Trùng HIS)',
          bhyt_card_no: 'GD4792211009911',
          his_dept_code: targetDup.his_dept_code,
          his_room_code: targetDup.his_room_code,
          his_bed_code: targetDup.his_bed_code,
          his_bed_type_code: 'DV',
          bed_ratio: 1.0,
          bed_days_billed: 3,
          admitted_at: new Date(Date.now() - 24 * 3600000).toISOString(),
          status: 'ACTIVE',
        });

        // 2) Same patient billed on 2 HIS beds concurrently + wrong H1 ICU code in Khoa Sản A (A103-G01)
        sampleInput.push({
          his_assignment_id: 'HIS-ASG-TIER-1',
          his_record_code: 'HIS-88202',
          patient_code: 'BN-HIS-88202',
          patient_name: 'Lê Hoàng Bảo Ngọc',
          bhyt_card_no: 'TE1792400112233',
          his_dept_code: 'K15',
          his_room_code: 'A103',
          his_bed_code: 'HIS-K15-A103-G01',
          his_bed_type_code: 'H1',
          bed_ratio: 1.0,
          bed_days_billed: 5,
          admitted_at: new Date(Date.now() - 12 * 3600000).toISOString(),
          status: 'ACTIVE',
        });
        sampleInput.push({
          his_assignment_id: 'HIS-ASG-MULTI-2',
          his_record_code: 'HIS-88202',
          patient_code: 'BN-HIS-88202',
          patient_name: 'Lê Hoàng Bảo Ngọc',
          bhyt_card_no: 'TE1792400112233',
          his_dept_code: 'K15',
          his_room_code: 'A103',
          his_bed_code: 'HIS-K15-A103-G02',
          his_bed_type_code: 'H2',
          bed_ratio: 1.0,
          bed_days_billed: 1,
          admitted_at: new Date(Date.now() - 10 * 3600000).toISOString(),
          status: 'ACTIVE',
        });

        // 3) Maintenance bed billed on HIS (P302-G04)
        sampleInput.push({
          his_assignment_id: 'HIS-ASG-MAINT-1',
          his_record_code: 'HIS-88203',
          patient_code: 'BN-HIS-88203',
          patient_name: 'Đỗ Thị Quỳnh Như',
          bhyt_card_no: 'DN4792100445566',
          his_dept_code: 'K16',
          his_room_code: 'P302',
          his_bed_code: 'HIS-K16-P302-G04',
          his_bed_type_code: 'H2',
          bed_ratio: 1.0,
          bed_days_billed: 1,
          admitted_at: new Date(Date.now() - 6 * 3600000).toISOString(),
          status: 'ACTIVE',
        });

        // 4) Unmapped HIS bed (C101-G02)
        sampleInput.push({
          his_assignment_id: 'HIS-ASG-UNMAP-1',
          his_record_code: 'HIS-88204',
          patient_code: 'BN-HIS-88204',
          patient_name: 'Nguyễn Văn Khải',
          bhyt_card_no: 'HT3792000778899',
          his_dept_code: 'K01',
          his_room_code: 'C101',
          his_bed_code: 'HIS-K01-C101-G02',
          his_bed_type_code: 'H2',
          bed_ratio: 1.0,
          bed_days_billed: 1,
          admitted_at: new Date(Date.now() - 4 * 3600000).toISOString(),
          status: 'ACTIVE',
        });

        // 5) Push Khoa Sản A (K15) over 5 planned BHYT beds (add A103-G03 & A103-G04 -> 7 active in K15 vs 5 planned = 140%)
        sampleInput.push(
          {
            his_assignment_id: 'HIS-ASG-QUOTA-1',
            his_record_code: 'HIS-88205',
            patient_code: 'BN-HIS-88205',
            patient_name: 'Vũ Thị Mai Phương',
            bhyt_card_no: 'DN4792100881122',
            his_dept_code: 'K15',
            his_room_code: 'A103',
            his_bed_code: 'HIS-K15-A103-G03',
            his_bed_type_code: 'H2',
            bed_ratio: 1.0,
            bed_days_billed: 1,
            admitted_at: new Date(Date.now() - 5 * 3600000).toISOString(),
            status: 'ACTIVE',
          },
          {
            his_assignment_id: 'HIS-ASG-QUOTA-2',
            his_record_code: 'HIS-88206',
            patient_code: 'BN-HIS-88206',
            patient_name: 'Hoàng Lan Chi',
            bhyt_card_no: 'DN4792100993344',
            his_dept_code: 'K15',
            his_room_code: 'A103',
            his_bed_code: 'HIS-K15-A103-G04',
            his_bed_type_code: 'H2',
            bed_ratio: 1.0,
            bed_days_billed: 1,
            admitted_at: new Date(Date.now() - 3 * 3600000).toISOString(),
            status: 'ACTIVE',
          }
        );

        parsedRows = parseHisPayloadInput(sampleInput, now);
        sourceName = 'HIS_SANDBOX_BHYT_FEED';
      } else {
        parsedRows = parseHisPayloadInput(payload, now);
      }

      if (parsedRows.length === 0) {
        res.status(400).json({
          error: 'Không đọc được bản ghi cấp giường hợp lệ nào từ dữ liệu HIS (cần tối thiểu patient_name/HO_TEN và his_bed_code/MA_GIUONG).',
        });
        return;
      }

      const rowsWithIds = parsedRows.map((r) => ({
        ...r,
        id: `hisrow-${crypto.randomUUID().slice(0, 8)}`,
      }));

      cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'HIS_ASSIGNMENTS_SYNC', 'HIS_SYNC', batchId, {
        batch_id: batchId,
        source_system: sourceName,
        synced_at: now,
        replace_snapshot: true,
        rows: rowsWithIds,
        audit_action: 'SYNC_HIS_BED_FEED',
        audit_details: `Đồng bộ ${rowsWithIds.length} bản ghi cấp giường từ ${sourceName}`,
      });

      cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'HIS_IMPORT_LOG', 'HIS_IMPORT', batchId, {
        id: batchId,
        file_name: sourceName,
        total_rows: rowsWithIds.length,
        imported_rows: rowsWithIds.length,
        duplicate_rows: 0,
        error_rows: 0,
        performed_by: req.authUser!.username,
      });

      const audit = buildHisAuditPayload();
      res.json({
        ok: true,
        batchId,
        importedCount: rowsWithIds.length,
        auditSummary: audit.summary,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/his/audit/resolve', requireAuth, requireHisSyncAndMap, (req: AuthedRequest, res) => {
    const { issue_key, category, severity, resolution_note, unresolve } = req.body as {
      issue_key: string;
      category?: string;
      severity?: string;
      resolution_note?: string;
      unresolve?: boolean;
    };
    if (!issue_key?.trim()) {
      res.status(400).json({ error: 'Thiếu mã cảnh báo issue_key.' });
      return;
    }
    cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'HIS_AUDIT_RESOLVE', 'HIS_AUDIT', issue_key, {
      issue_key: issue_key.trim(),
      category: category || 'IRRATIONAL_ASSIGNMENT',
      severity: severity || 'HIGH',
      resolution_note: resolution_note?.trim() || 'Đã rà soát và xác nhận xử lý chênh lệch HIS/BHYT',
      resolved_by: req.authUser!.id,
      resolved_by_name: req.authUser!.full_name,
      unresolve: Boolean(unresolve),
      audit_action: unresolve ? 'REOPEN_HIS_AUDIT_ISSUE' : 'RESOLVE_HIS_AUDIT_ISSUE',
      audit_details: `${unresolve ? 'Mở lại' : 'Đã xử lý'} cảnh báo HIS/BHYT ${issue_key}`,
    });
    res.json({ ok: true });
  });

  router.post('/his/audit/auto-admit', requireAuth, requireHisSyncAndMap, async (req: AuthedRequest, res) => {
    try {
      const { bed_id, his_record_code, issue_key } = req.body as {
        bed_id: string;
        his_record_code: string;
        issue_key?: string;
      };
      const db = cluster.getActiveNode().db;
      const bed = db.prepare('SELECT id, room_id, department_id, status, code FROM beds WHERE id = ?').get(bed_id) as
        | { id: string; room_id: string; department_id: string; status: string; code: string }
        | undefined;
      if (!bed) {
        res.status(404).json({ error: 'Không tìm thấy giường trong BEDCARE.' });
        return;
      }
      if (bed.status !== 'VACANT') {
        res.status(409).json({ error: `Giường ${bed.code} hiện đang ở trạng thái ${bed.status}, không thể tự động nhập viện.` });
        return;
      }
      const hisRow = db
        .prepare("SELECT * FROM his_bed_assignments WHERE his_record_code = ? AND status = 'ACTIVE' LIMIT 1")
        .get(his_record_code) as Record<string, unknown> | undefined;
      if (!hisRow) {
        res.status(404).json({ error: 'Không tìm thấy hồ sơ HIS đang mở tương ứng.' });
        return;
      }

      const cfg = getConfigMap(db);
      const dayCfg = getDayConfig(cfg);
      const now = new Date().toISOString();
      const admitAt = String(hisRow.admitted_at || now);
      const expectedDischarge = computeExpectedDischargeAt(admitAt, 3, dayCfg);
      const admId = `adm-${crypto.randomUUID().slice(0, 8)}`;
      const patCode = String(hisRow.patient_code || hisRow.his_record_code);
      const patId = resolvePatientIdByCode(db, patCode);
      const admCode = `HS-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;

      await cluster.proposeCriticalAllocation({
        nodeId: cluster.activeNodeId,
        userId: req.authUser!.id,
        requestType: 'ASSIGN_BED',
        eventType: 'ADMISSION_CONFIRM',
        aggregateType: 'ADMISSION',
        aggregateId: admId,
        bedId: bed.id,
        roomId: bed.room_id,
        reservationId: null,
        isWholeRoom: false,
        payloadObj: {
          id: admId,
          admission_code: admCode,
          registration_id: null,
          reservation_id: null,
          patient_id: patId,
          patient_code: patCode,
          his_record_code: String(hisRow.his_record_code),
          patient_name: String(hisRow.patient_name),
          date_of_birth: String(hisRow.date_of_birth || '1990-01-01'),
          phone: '',
          diagnosis_group: 'Khác',
          department_id: bed.department_id,
          room_id: bed.room_id,
          bed_id: bed.id,
          is_whole_room: false,
          hospital_admitted_at: admitAt,
          bed_assigned_at: admitAt,
          expected_discharge_at: expectedDischarge,
          calculation_method: dayCfg.method,
          status: 'ACTIVE',
          notes: `Đồng bộ tiếp nhận tự động từ HIS (${hisRow.his_record_code})`,
          confirmed_by: req.authUser!.id,
          confirmed_by_name: req.authUser!.full_name,
          audit_action: 'HIS_AUTO_ADMIT',
          audit_details: `Đồng bộ BN ${hisRow.patient_name} (${hisRow.his_record_code}) từ HIS vào giường ${bed.code}`,
        },
      });

      if (issue_key) {
        cluster.commitStandardEvent(cluster.activeNodeId, req.authUser!.id, 'HIS_AUDIT_RESOLVE', 'HIS_AUDIT', issue_key, {
          issue_key,
          category: 'DUPLICATE_BED',
          severity: 'HIGH',
          resolution_note: `Đã đồng bộ tiếp nhận BN vào giường ${bed.code} (${admCode})`,
          resolved_by: req.authUser!.id,
          resolved_by_name: req.authUser!.full_name,
        });
      }

      res.status(201).json({ ok: true, admission_code: admCode });
    } catch (err) {
      if (err instanceof ConsensusConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}

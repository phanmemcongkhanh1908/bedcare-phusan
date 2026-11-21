import type {
  Admission,
  Bed,
  DeviceNode,
  Registration,
  Reservation,
  SystemAlert,
} from '../types/bedcare';
import { calculateStayMetrics, type BedDayConfig } from './bedDays';

export interface AlertEvaluationInput {
  admissions: Admission[];
  reservations: Reservation[];
  registrations: Registration[];
  beds: Bed[];
  devices: DeviceNode[];
  pendingSyncCount: number;
  openConflictCount: number;
  failedBackupCount: number;
  pendingRequestCount: number;
  deptNames: Record<string, string>;
  dayConfig: BedDayConfig;
  reservationWarnMinutes: number;
  nowIso?: string;
}

export function evaluateSystemAlerts(input: AlertEvaluationInput): SystemAlert[] {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();
  const alerts: SystemAlert[] = [];

  // 1, 2, 3: Giường sắp trả, đến hạn trả, quá ngày
  for (const adm of input.admissions) {
    if (adm.status !== 'ACTIVE') continue;
    const metrics = calculateStayMetrics(
      adm.bed_assigned_at,
      adm.expected_discharge_at,
      null,
      adm.calculation_method,
      input.dayConfig,
      nowIso
    );
    const deptName = input.deptNames[adm.department_id] ?? adm.department_name ?? '';
    if (metrics.dueState === 'OVERDUE') {
      alerts.push({
        id: `alert-overdue-${adm.id}`,
        type: 'BED_OVERDUE',
        priority: 'CRITICAL',
        title: `Giường quá ngày trả (${adm.bed_code ?? adm.bed_id})`,
        message: `Bệnh nhân ${adm.patient_name} (${adm.patient_code}) đã quá hạn trả giường ${Math.abs(metrics.daysRemaining)} ngày.`,
        department_id: adm.department_id,
        department_name: deptName,
        entity_id: adm.id,
        created_at: nowIso,
      });
    } else if (metrics.dueState === 'DUE_TODAY') {
      alerts.push({
        id: `alert-duetoday-${adm.id}`,
        type: 'BED_DUE_TODAY',
        priority: 'HIGH',
        title: `Giường đến hạn trả hôm nay (${adm.bed_code ?? adm.bed_id})`,
        message: `Bệnh nhân ${adm.patient_name} dự kiến trả giường trong hôm nay.`,
        department_id: adm.department_id,
        department_name: deptName,
        entity_id: adm.id,
        created_at: nowIso,
      });
    } else if (metrics.dueState === 'DUE_SOON') {
      alerts.push({
        id: `alert-duesoon-${adm.id}`,
        type: 'BED_DUE_SOON',
        priority: 'MEDIUM',
        title: `Giường sắp đến hạn trả (${adm.bed_code ?? adm.bed_id})`,
        message: `Còn khoảng ${Math.max(1, Math.round(metrics.hoursRemaining))} giờ nữa đến hạn trả giường của ${adm.patient_name}.`,
        department_id: adm.department_id,
        department_name: deptName,
        entity_id: adm.id,
        created_at: nowIso,
      });
    }
  }

  // 4. Giữ chỗ sắp hết hạn
  for (const res of input.reservations) {
    if (res.status !== 'ACTIVE') continue;
    const expMs = new Date(res.expires_at).getTime();
    const minsLeft = (expMs - nowMs) / (1000 * 60);
    if (minsLeft <= input.reservationWarnMinutes) {
      alerts.push({
        id: `alert-res-${res.id}`,
        type: 'RESERVATION_EXPIRING',
        priority: minsLeft <= 0 ? 'HIGH' : 'MEDIUM',
        title: minsLeft <= 0 ? `Giữ chỗ đã quá hạn (${res.room_name ?? res.room_id})` : `Giữ chỗ sắp hết hạn (${res.room_name ?? res.room_id})`,
        message: `Lượt giữ chỗ cho ${res.patient_name} ${minsLeft <= 0 ? 'đã quá hạn' : `còn ${Math.max(1, Math.round(minsLeft))} phút`}.`,
        department_id: res.department_id,
        department_name: input.deptNames[res.department_id] ?? res.department_name ?? '',
        entity_id: res.id,
        created_at: nowIso,
      });
    }
  }

  // 5. Đăng ký chưa được phân bổ
  for (const reg of input.registrations) {
    if (reg.status === 'WAITING') {
      alerts.push({
        id: `alert-unalloc-${reg.id}`,
        type: 'UNALLOCATED_REGISTRATION',
        priority: 'MEDIUM',
        title: `Đăng ký chưa phân bổ giường (${reg.registration_code})`,
        message: `${reg.patient_name} · ${reg.diagnosis_group} đang nằm trong danh sách chờ phân bổ.`,
        department_id: reg.department_id ?? undefined,
        department_name: reg.department_id ? (input.deptNames[reg.department_id] ?? '') : 'Chưa xác định khoa',
        entity_id: reg.id,
        created_at: reg.created_at,
      });
    }
  }

  // 6 & 7. Giường chờ vệ sinh / bảo trì
  for (const bed of input.beds) {
    const deptName = input.deptNames[bed.department_id] ?? bed.department_name ?? '';
    if (bed.status === 'PENDING_CLEANING') {
      alerts.push({
        id: `alert-clean-${bed.id}`,
        type: 'BED_PENDING_CLEANING',
        priority: 'MEDIUM',
        title: `Giường chờ vệ sinh (${bed.code})`,
        message: `Giường ${bed.code} (${bed.room_name ?? bed.room_id}) cần vệ sinh trước khi tiếp nhận bệnh nhân mới.`,
        department_id: bed.department_id,
        department_name: deptName,
        entity_id: bed.id,
        created_at: bed.updated_at,
      });
    } else if (bed.status === 'MAINTENANCE') {
      alerts.push({
        id: `alert-maint-${bed.id}`,
        type: 'BED_MAINTENANCE',
        priority: 'LOW',
        title: `Giường đang bảo trì (${bed.code})`,
        message: `Giường ${bed.code} hiện tạm khóa để bảo trì kỹ thuật.`,
        department_id: bed.department_id,
        department_name: deptName,
        entity_id: bed.id,
        created_at: bed.updated_at,
      });
    } else if (bed.status === 'PENDING_CONFIRMATION') {
      alerts.push({
        id: `alert-pendingbed-${bed.id}`,
        type: 'PENDING_CONFIRMATION',
        priority: 'HIGH',
        title: `Yêu cầu cấp giường chờ đồng thuận (${bed.code})`,
        message: `Giường ${bed.code} có yêu cầu đang chờ đủ quorum đồng thuận P2P để xác nhận chính thức.`,
        department_id: bed.department_id,
        department_name: deptName,
        entity_id: bed.id,
        created_at: bed.updated_at,
      });
    }
  }

  // 8. Giao dịch đồng bộ chưa hoàn tất
  if (input.pendingSyncCount > 0) {
    alerts.push({
      id: 'alert-sync-pending',
      type: 'SYNC_PENDING',
      priority: 'HIGH',
      title: `Có ${input.pendingSyncCount} sự kiện đồng bộ đang chờ`,
      message: 'Một số sự kiện chưa được gửi tới thiết bị ngang hàng do ngoại tuyến hoặc phân vùng mạng.',
      created_at: nowIso,
    });
  }

  // 9. Xung đột dữ liệu
  if (input.openConflictCount > 0) {
    alerts.push({
      id: 'alert-conflicts',
      type: 'DATA_CONFLICT',
      priority: 'CRITICAL',
      title: `Phát hiện ${input.openConflictCount} xung đột dữ liệu P2P`,
      message: 'Có tranh chấp cấp giường hoặc bao phòng giữa các máy. Vui lòng kiểm tra mục Đồng bộ & Đồng thuận.',
      created_at: nowIso,
    });
  }

  // 10. Thiết bị mất kết nối
  for (const dev of input.devices) {
    if (dev.status === 'OFFLINE') {
      alerts.push({
        id: `alert-offline-${dev.device_id}`,
        type: 'DEVICE_OFFLINE',
        priority: 'HIGH',
        title: `Thiết bị mất kết nối (${dev.node_name})`,
        message: `Nút ${dev.device_id} hiện đang ngoại tuyến. Hãy kiểm tra mạng LAN/P2P.`,
        department_id: dev.department_id ?? undefined,
        department_name: dev.department_id ? (input.deptNames[dev.department_id] ?? '') : 'Toàn viện',
        entity_id: dev.device_id,
        created_at: dev.last_seen_at,
      });
    }
  }

  // 11. Bản sao lưu lỗi
  if (input.failedBackupCount > 0) {
    alerts.push({
      id: 'alert-backup-failed',
      type: 'BACKUP_FAILED',
      priority: 'HIGH',
      title: `Có ${input.failedBackupCount} bản sao lưu lỗi`,
      message: 'Vui lòng kiểm tra mục Sao lưu & Phục hồi và tạo bản sao lưu mới hợp lệ.',
      created_at: nowIso,
    });
  }

  // 12. Yêu cầu chờ xác nhận
  if (input.pendingRequestCount > 0) {
    alerts.push({
      id: 'alert-pending-requests',
      type: 'PENDING_CONFIRMATION',
      priority: 'HIGH',
      title: `Có ${input.pendingRequestCount} yêu cầu chờ xác nhận đồng thuận`,
      message: 'Các yêu cầu tạo khi mất kết nối/thiếu quorum đang chờ xử lý khi mạng phục hồi.',
      created_at: nowIso,
    });
  }

  const priorityRank: Record<SystemAlert['priority'], number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };
  return alerts.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
}

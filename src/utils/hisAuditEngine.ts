import type {
  Admission,
  Bed,
  Department,
  HisAuditIssue,
  HisAuditReport,
  HisBedAssignment,
  HisBedMapping,
  HisDepartmentQuotaRow,
  HisPermissionLevel,
  Room,
  UserRole,
} from '../types/bedcare';

export const BHYT_BED_TYPE_LABELS: Record<string, string> = {
  H1: 'H1 - Giường hồi sức cấp cứu / ICU (TT22)',
  H2: 'H2 - Giường nội khoa / Sản loại 1 (BHYT)',
  H3: 'H3 - Giường ngoại / Phục hồi loại 2 (BHYT)',
  G_GH: 'G_GH - Giường ghép (tỷ lệ 0.5 ngày giường)',
  DV: 'DV - Giường dịch vụ / Tự nguyện (không BHYT)',
};

export function resolveEffectiveHisPermission(
  role: UserRole,
  storedPermission?: HisPermissionLevel | string | null
): HisPermissionLevel {
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
    return 'FULL';
  }
  if (storedPermission === 'VIEW' || storedPermission === 'SYNC_AND_MAP' || storedPermission === 'FULL') {
    return storedPermission;
  }
  return 'NONE';
}

export function canViewHisModule(role: UserRole, storedPermission?: HisPermissionLevel | string | null): boolean {
  return resolveEffectiveHisPermission(role, storedPermission) !== 'NONE';
}

export function canSyncAndMapHis(role: UserRole, storedPermission?: HisPermissionLevel | string | null): boolean {
  const eff = resolveEffectiveHisPermission(role, storedPermission);
  return eff === 'SYNC_AND_MAP' || eff === 'FULL';
}

export function canManageHisConfigAndQuotas(role: UserRole): boolean {
  return role === 'SUPER_ADMIN' || role === 'ADMIN';
}

export interface NormalizedHisInputRow {
  his_assignment_id: string;
  his_record_code: string;
  patient_code: string;
  patient_name: string;
  date_of_birth: string;
  bhyt_card_no: string;
  his_dept_code: string;
  his_room_code: string;
  his_bed_code: string;
  his_bed_type_code: string;
  bed_ratio: number;
  bed_days_billed: number;
  admitted_at: string;
  discharged_at: string | null;
  status: 'ACTIVE' | 'DISCHARGED';
}

function normalizeIsoDate(raw: unknown, fallbackIso: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return fallbackIso;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallbackIso : d.toISOString();
}

export function parseHisPayloadInput(
  rawInput: unknown,
  nowIso = new Date().toISOString()
): NormalizedHisInputRow[] {
  let rawRows: Array<Record<string, unknown>> = [];

  if (Array.isArray(rawInput)) {
    rawRows = rawInput as Array<Record<string, unknown>>;
  } else if (rawInput && typeof rawInput === 'object') {
    const obj = rawInput as Record<string, unknown>;
    const candidate = obj.records ?? obj.data ?? obj.items ?? obj.assignments;
    if (Array.isArray(candidate)) {
      rawRows = candidate as Array<Record<string, unknown>>;
    }
  } else if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      return parseHisPayloadInput(JSON.parse(trimmed), nowIso);
    }
    // Parse CSV (header line + comma/semicolon-separated rows)
    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return [];
    const delimiter = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''));
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''));
      const rowObj: Record<string, unknown> = {};
      headers.forEach((h, idx) => {
        rowObj[h] = cells[idx] ?? '';
      });
      rawRows.push(rowObj);
    }
  }

  return rawRows
    .map((r, index) => {
      const hisBedCode = String(
        r.his_bed_code ?? r.MA_GIUONG ?? r.bed_code ?? r.ma_giuong ?? ''
      ).trim().toUpperCase();
      const hisDeptCode = String(
        r.his_dept_code ?? r.MA_KHOA ?? r.dept_code ?? r.ma_khoa ?? ''
      ).trim().toUpperCase();
      const patientName = String(
        r.patient_name ?? r.HO_TEN ?? r.ho_ten ?? r.full_name ?? ''
      ).trim();
      const hisRecordCode = String(
        r.his_record_code ?? r.MA_LK ?? r.MA_HSBA ?? r.record_code ?? `HIS-${index + 1}`
      ).trim();
      const patientCode = String(
        r.patient_code ?? r.MA_BN ?? r.ma_bn ?? hisRecordCode
      ).trim();
      const bhytCard = String(
        r.bhyt_card_no ?? r.MA_THE ?? r.ma_the_bhyt ?? ''
      ).trim().toUpperCase();
      const bedRatio = Number(r.bed_ratio ?? r.TY_LE_GIUONG ?? 1.0);
      const bedDaysBilled = Number(r.bed_days_billed ?? r.SO_NGAY_GIUONG ?? 1.0);
      const rawStatus = String(r.status ?? r.TRANG_THAI ?? 'ACTIVE').trim().toUpperCase();

      return {
        his_assignment_id: String(r.his_assignment_id ?? r.id ?? `${hisRecordCode}-${hisBedCode}-${index + 1}`).trim(),
        his_record_code: hisRecordCode,
        patient_code: patientCode,
        patient_name: patientName,
        date_of_birth: String(r.date_of_birth ?? r.NGAY_SINH ?? '1990-01-01').trim(),
        bhyt_card_no: bhytCard,
        his_dept_code: hisDeptCode,
        his_room_code: String(r.his_room_code ?? r.MA_PHONG ?? r.room_code ?? '').trim().toUpperCase(),
        his_bed_code: hisBedCode,
        his_bed_type_code: String(r.his_bed_type_code ?? r.MA_LOAI_GIUONG ?? r.bed_type_code ?? 'H2').trim().toUpperCase(),
        bed_ratio: Number.isFinite(bedRatio) && bedRatio > 0 ? bedRatio : 1.0,
        bed_days_billed: Number.isFinite(bedDaysBilled) && bedDaysBilled >= 0 ? bedDaysBilled : 1.0,
        admitted_at: normalizeIsoDate(r.admitted_at ?? r.NGAY_VAO, nowIso),
        discharged_at: r.discharged_at || r.NGAY_RA ? normalizeIsoDate(r.discharged_at ?? r.NGAY_RA, nowIso) : null,
        status: rawStatus === 'DISCHARGED' || rawStatus === 'RA_VIEN' ? 'DISCHARGED' : 'ACTIVE',
      } satisfies NormalizedHisInputRow;
    })
    .filter((row) => row.patient_name.length > 0 && row.his_bed_code.length > 0);
}

export interface AuditResolutionRecord {
  issue_key: string;
  resolution_note: string;
  resolved_by_name: string;
  resolved_at: string;
}

export interface EvaluateHisAuditInput {
  departments: Department[];
  rooms: Room[];
  beds: Bed[];
  activeAdmissions: Admission[];
  mappings: HisBedMapping[];
  assignments: HisBedAssignment[];
  resolutions: AuditResolutionRecord[];
  importLogs: Array<Record<string, unknown>>;
  nowIso?: string;
}

function normStr(val: string | null | undefined): string {
  return String(val ?? '').trim().toLowerCase();
}

export function evaluateHisAndBhytCompliance(input: EvaluateHisAuditInput): HisAuditReport {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();

  const deptById = new Map(input.departments.map((d) => [d.id, d]));
  const deptByHisCode = new Map<string, Department>();
  for (const d of input.departments) {
    if (d.his_dept_code?.trim()) {
      deptByHisCode.set(d.his_dept_code.trim().toUpperCase(), d);
    }
  }

  const roomById = new Map(input.rooms.map((r) => [r.id, r]));
  const bedById = new Map(input.beds.map((b) => [b.id, b]));
  const mappingByHisBedCode = new Map<string, HisBedMapping>();
  const mappingByBedId = new Map<string, HisBedMapping>();
  for (const m of input.mappings) {
    mappingByBedId.set(m.bed_id, m);
    if (m.his_bed_code?.trim()) {
      mappingByHisBedCode.set(m.his_bed_code.trim().toUpperCase(), m);
    }
  }

  const activeAdmissionByBedId = new Map<string, Admission>();
  for (const adm of input.activeAdmissions) {
    if (adm.status === 'ACTIVE' || adm.status === 'PENDING_CONFIRMATION') {
      activeAdmissionByBedId.set(adm.bed_id, adm);
    }
  }

  const resolutionMap = new Map(input.resolutions.map((r) => [r.issue_key, r]));
  const rawIssues: Omit<HisAuditIssue, 'resolved' | 'resolution_note' | 'resolved_by_name' | 'resolved_at'>[] = [];

  const activeHisRows = input.assignments.filter((a) => a.status === 'ACTIVE');

  // 1. Group active HIS rows by his_bed_code to detect DUPLICATE_BED (concurrent double occupancy on HIS)
  const hisRowsByBedCode = new Map<string, HisBedAssignment[]>();
  for (const row of activeHisRows) {
    const key = row.his_bed_code.trim().toUpperCase();
    const list = hisRowsByBedCode.get(key) ?? [];
    list.push(row);
    hisRowsByBedCode.set(key, list);
  }

  for (const [hisBedCode, rows] of hisRowsByBedCode.entries()) {
    if (rows.length > 1) {
      const mapping = mappingByHisBedCode.get(hisBedCode);
      const totalRatio = rows.reduce((s, r) => s + Number(r.bed_ratio || 1), 0);
      const allowShared = mapping ? Boolean(mapping.allow_shared_bed) : false;
      const exceedsShared = !allowShared || totalRatio > 1.01 || rows.length > 3;

      if (exceedsShared) {
        const dept = mapping ? deptById.get(mapping.department_id) : deptByHisCode.get(rows[0].his_dept_code.toUpperCase());
        rawIssues.push({
          issue_key: `DUP_HIS_BED:${hisBedCode}`,
          category: 'DUPLICATE_BED',
          rule_code: 'HIS_DOUBLE_OCCUPANCY',
          severity: 'CRITICAL',
          title: `Trùng giường trên HIS tại mã ${hisBedCode} (${rows.length} bệnh nhân)`,
          description: allowShared
            ? `Giường ghép vượt tỷ lệ cho phép (tổng hệ số ${totalRatio.toFixed(2)} > 1.0 hoặc quá 3 bệnh nhân).`
            : `Cùng 1 mã giường HIS đang gán đồng thời ${rows.length} bệnh nhân khi chưa khai báo giường ghép BHYT.`,
          bhyt_regulation_ref: 'Thông tư 22/2023/TT-BYT · Chống trùng thanh toán ngày giường',
          department_id: dept?.id ?? null,
          department_name: dept?.name ?? rows[0].his_dept_code,
          room_id: mapping?.room_id ?? null,
          room_name: mapping?.room_name ?? rows[0].his_room_code,
          bed_id: mapping?.bed_id ?? null,
          bed_code: mapping?.bed_code ?? '',
          his_bed_code: hisBedCode,
          his_dept_code: rows[0].his_dept_code,
          his_record_code: rows.map((r) => r.his_record_code).join(', '),
          patient_name: rows.map((r) => r.patient_name).join(' + '),
          his_summary: rows.map((r) => `${r.patient_name} (${r.his_record_code}, HS ${r.bed_ratio})`).join('; '),
          bedcare_summary: mapping
            ? `${mapping.bed_code} (${mapping.bed_status})`
            : 'Chưa ánh xạ vào giường BEDCARE',
        });
      }
    }
  }

  // 2. Detect 1 patient occupying >= 2 active HIS beds concurrently (PATIENT_MULTI_BED_HIS)
  const hisRowsByPatientKey = new Map<string, HisBedAssignment[]>();
  for (const row of activeHisRows) {
    const pKey = (row.his_record_code || row.bhyt_card_no || row.patient_code).trim().toUpperCase();
    if (!pKey) continue;
    const list = hisRowsByPatientKey.get(pKey) ?? [];
    list.push(row);
    hisRowsByPatientKey.set(pKey, list);
  }

  for (const [pKey, rows] of hisRowsByPatientKey.entries()) {
    const distinctBeds = new Set(rows.map((r) => r.his_bed_code.trim().toUpperCase()));
    if (distinctBeds.size > 1) {
      const first = rows[0];
      const mapping = mappingByHisBedCode.get(first.his_bed_code.toUpperCase());
      const dept = mapping ? deptById.get(mapping.department_id) : deptByHisCode.get(first.his_dept_code.toUpperCase());
      rawIssues.push({
        issue_key: `DUP_PATIENT_MULTI_BED:${pKey}`,
        category: 'DUPLICATE_BED',
        rule_code: 'PATIENT_MULTI_BED_HIS',
        severity: 'CRITICAL',
        title: `1 bệnh nhân nằm ${distinctBeds.size} giường HIS cùng lúc (${first.patient_name})`,
        description: `Hồ sơ ${first.his_record_code}${first.bhyt_card_no ? ` · BHYT ${first.bhyt_card_no}` : ''} đang kê đồng thời trên các giường: ${Array.from(distinctBeds).join(', ')}.`,
        bhyt_regulation_ref: 'QĐ 130/QĐ-BYT Bảng 3 · Không thanh toán 2 giường cùng thời điểm cho 1 mã LK',
        department_id: dept?.id ?? null,
        department_name: dept?.name ?? first.his_dept_code,
        his_bed_code: Array.from(distinctBeds).join(', '),
        his_dept_code: first.his_dept_code,
        his_record_code: first.his_record_code,
        patient_name: first.patient_name,
        his_summary: rows.map((r) => `${r.his_bed_code} (${r.his_dept_code})`).join(' & '),
        bedcare_summary: 'Cần kết thúc giường cũ trước khi cấp giường mới trên HIS',
      });
    }
  }

  // 3. Evaluate each active HIS row against mapped BEDCARE bed & room & BHYT compliance rules
  const hisRowsByRoomId = new Map<string, HisBedAssignment[]>();
  const hisActiveUnitsByDeptId = new Map<string, { patients: number; units: number }>();

  for (const row of activeHisRows) {
    const hisBedCode = row.his_bed_code.trim().toUpperCase();
    const hisDeptCode = row.his_dept_code.trim().toUpperCase();
    const mapping = mappingByHisBedCode.get(hisBedCode);
    const hisMappedDept = deptByHisCode.get(hisDeptCode);

    if (!mapping) {
      rawIssues.push({
        issue_key: `UNMAPPED:${hisBedCode}:${row.his_record_code}`,
        category: 'IRRATIONAL_ASSIGNMENT',
        rule_code: 'UNMAPPED_HIS_BED',
        severity: 'HIGH',
        title: `Giường HIS ${hisBedCode} chưa ánh xạ vào BEDCARE`,
        description: `HIS đang cấp giường ${hisBedCode} (${row.his_dept_code}) cho BN ${row.patient_name} nhưng chưa có liên kết tới giường vật lý nào.`,
        bhyt_regulation_ref: 'Chuẩn hóa danh mục giường KCB liên thông HIS ↔ Quản lý giường',
        department_id: hisMappedDept?.id ?? null,
        department_name: hisMappedDept?.name ?? hisDeptCode,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `${row.patient_name} · ${hisBedCode} (${row.his_bed_type_code})`,
        bedcare_summary: 'Chưa gắn ánh xạ giường',
        can_quick_map: true,
      });

      if (hisMappedDept) {
        const cur = hisActiveUnitsByDeptId.get(hisMappedDept.id) ?? { patients: 0, units: 0 };
        cur.patients += 1;
        cur.units += Number(row.bed_ratio || 1);
        hisActiveUnitsByDeptId.set(hisMappedDept.id, cur);
      }
      continue;
    }

    const bed = bedById.get(mapping.bed_id);
    const room = bed ? roomById.get(bed.room_id) : undefined;
    const bedDept = bed ? deptById.get(bed.department_id) : undefined;
    const targetDeptId = bedDept?.id ?? hisMappedDept?.id;

    if (targetDeptId) {
      const cur = hisActiveUnitsByDeptId.get(targetDeptId) ?? { patients: 0, units: 0 };
      cur.patients += 1;
      cur.units += Number(row.bed_ratio || 1);
      hisActiveUnitsByDeptId.set(targetDeptId, cur);
    }

    if (room) {
      const rList = hisRowsByRoomId.get(room.id) ?? [];
      rList.push(row);
      hisRowsByRoomId.set(room.id, rList);
    }

    if (!bed || !room || !bedDept) continue;

    // 3a. Department mismatch between HIS dept code & BEDCARE bed's department
    if (hisMappedDept && hisMappedDept.id !== bed.department_id) {
      rawIssues.push({
        issue_key: `DEPT_MISMATCH:${row.his_record_code}:${bed.id}`,
        category: 'IRRATIONAL_ASSIGNMENT',
        rule_code: 'DEPARTMENT_MISMATCH',
        severity: 'HIGH',
        title: `Lệch khoa HIS (${hisMappedDept.name}) vs Giường thực tế (${bedDept.name})`,
        description: `BN ${row.patient_name} đang được HIS hạch toán tại ${hisMappedDept.name} (${hisDeptCode}), nhưng mã giường ${hisBedCode} lại nằm tại ${bedDept.name} (${bed.code}).`,
        bhyt_regulation_ref: 'QĐ 4210/QĐ-BYT · Sai mã khoa điều trị nội trú',
        department_id: bedDept.id,
        department_name: bedDept.name,
        room_id: room.id,
        room_name: room.name,
        bed_id: bed.id,
        bed_code: bed.code,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `${hisDeptCode} (${hisMappedDept.name}) · ${hisBedCode}`,
        bedcare_summary: `${bedDept.name} · ${bed.code}`,
      });
    }

    // 3b. Maintenance or Inactive bed billed on HIS
    if (bed.status === 'MAINTENANCE' || bed.status === 'INACTIVE') {
      rawIssues.push({
        issue_key: `MAINT_BED:${bed.id}:${row.his_record_code}`,
        category: 'IRRATIONAL_ASSIGNMENT',
        rule_code: 'ASSIGNED_MAINTENANCE_OR_INACTIVE',
        severity: 'CRITICAL',
        title: `Cấp giường đang ${bed.status === 'MAINTENANCE' ? 'BẢO TRÌ' : 'NGƯNG HOẠT ĐỘNG'} (${bed.code})`,
        description: `HIS vẫn ghi nhận BN ${row.patient_name} đang nằm giường ${bed.code}, nhưng giường vật lý hiện đang khóa (${bed.status}).`,
        bhyt_regulation_ref: 'Kiểm soát giường thực kê hoạt động & an toàn người bệnh',
        department_id: bedDept.id,
        department_name: bedDept.name,
        room_id: room.id,
        room_name: room.name,
        bed_id: bed.id,
        bed_code: bed.code,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `${row.patient_name} (Đang nằm trên HIS)`,
        bedcare_summary: `${bed.code} đang ${bed.status}`,
      });
    }

    // 3c. Exclusive room breach
    if (room.exclusive_locked && bed.exclusive_holder_name && normStr(bed.exclusive_holder_name) !== normStr(row.patient_name)) {
      rawIssues.push({
        issue_key: `EXCL_BREACH:${room.id}:${row.his_record_code}`,
        category: 'IRRATIONAL_ASSIGNMENT',
        rule_code: 'EXCLUSIVE_ROOM_BREACH',
        severity: 'CRITICAL',
        title: `Xâm phạm phòng bao trọn ${room.name} (${bed.code})`,
        description: `Phòng ${room.name} đang bao trọn cho ${bed.exclusive_holder_name}, nhưng HIS lại đẩy BN ${row.patient_name} vào giường ${bed.code}.`,
        bhyt_regulation_ref: 'Quy tắc phòng VIP/bao trọn riêng tư bệnh viện',
        department_id: bedDept.id,
        department_name: bedDept.name,
        room_id: room.id,
        room_name: room.name,
        bed_id: bed.id,
        bed_code: bed.code,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `${row.patient_name} (${hisBedCode})`,
        bedcare_summary: `Bao trọn phòng cho ${bed.exclusive_holder_name}`,
      });
    }

    // 3d. Occupant mismatch / Ghost bed state conflict
    const activeAdm = activeAdmissionByBedId.get(bed.id);
    if (activeAdm) {
      const sameHisRecord =
        activeAdm.his_record_code?.trim() &&
        row.his_record_code?.trim() &&
        normStr(activeAdm.his_record_code) === normStr(row.his_record_code);
      const sameName = normStr(activeAdm.patient_name) === normStr(row.patient_name);
      if (!sameHisRecord && !sameName) {
        rawIssues.push({
          issue_key: `OCCUPANT_MISMATCH:${bed.id}:${row.his_record_code}`,
          category: 'DUPLICATE_BED',
          rule_code: 'HIS_BEDCARE_OCCUPANT_MISMATCH',
          severity: 'CRITICAL',
          title: `Trùng/Lệch người nằm tại giường ${bed.code} (HIS ≠ BEDCARE)`,
          description: `HIS ghi BN "${row.patient_name}" (${row.his_record_code}) nằm giường ${bed.code}, nhưng trên BEDCARE giường này đang phục vụ BN "${activeAdm.patient_name}" (${activeAdm.his_record_code || activeAdm.patient_code}).`,
          bhyt_regulation_ref: 'Đối soát người bệnh thực tế & danh sách thanh toán HIS',
          department_id: bedDept.id,
          department_name: bedDept.name,
          room_id: room.id,
          room_name: room.name,
          bed_id: bed.id,
          bed_code: bed.code,
          his_bed_code: hisBedCode,
          his_dept_code: hisDeptCode,
          his_record_code: row.his_record_code,
          patient_name: row.patient_name,
          his_summary: `${row.patient_name} (${row.his_record_code})`,
          bedcare_summary: `${activeAdm.patient_name} (${activeAdm.his_record_code || activeAdm.patient_code})`,
        });
      }
    } else if (bed.status === 'VACANT' || bed.status === 'PENDING_CLEANING' || bed.status === 'CLEANING') {
      rawIssues.push({
        issue_key: `GHOST_BED:${bed.id}:${row.his_record_code}`,
        category: 'DUPLICATE_BED',
        rule_code: 'GHOST_BED_STATE_CONFLICT',
        severity: 'HIGH',
        title: `Lệch trạng thái "Giường ma" tại ${bed.code} (${row.patient_name})`,
        description: `HIS vẫn tính giường đang nằm cho ${row.patient_name}, nhưng BEDCARE ghi nhận giường ${bed.code} đang ${
          bed.status === 'VACANT' ? 'TRỐNG' : 'CHỜ / ĐANG VỆ SINH'
        } (chưa nhận phòng hoặc HIS quên kết thúc ngày giường).`,
        bhyt_regulation_ref: 'Thông tư 39/2018/TT-BYT · Đóng tiền giường ngay khi ra viện',
        department_id: bedDept.id,
        department_name: bedDept.name,
        room_id: room.id,
        room_name: room.name,
        bed_id: bed.id,
        bed_code: bed.code,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `HIS đang mở (${row.patient_name})`,
        bedcare_summary: `BEDCARE đang ${bed.status}`,
        can_auto_admit: bed.status === 'VACANT',
      });
    }

    // 3e. BHYT bed tier mismatch (e.g., H1 ICU billed in non-ICU room, or DV billed in STANDARD room, or BHYT standard billed in VIP room)
    const hisType = row.his_bed_type_code.toUpperCase();
    const isHoiSucDept = bedDept.code === 'HSSM' || bedDept.name.toLowerCase().includes('hồi sức');
    if (hisType === 'H1' && !isHoiSucDept) {
      rawIssues.push({
        issue_key: `TIER_H1:${bed.id}:${row.his_record_code}`,
        category: 'IRRATIONAL_ASSIGNMENT',
        rule_code: 'BHYT_TIER_MISMATCH',
        severity: 'CRITICAL',
        title: `Áp mã giường Hồi sức (H1) sai khoa/phòng tại ${bed.code}`,
        description: `HIS đang áp giá giường Hồi sức cấp cứu (H1) cho ${row.patient_name}, nhưng giường ${bed.code} thuộc ${bedDept.name} (${room.room_type}), không phải khoa Hồi sức.`,
        bhyt_regulation_ref: 'Thông tư 22/2023/TT-BYT · Điều kiện áp giá giường Hồi sức H1',
        department_id: bedDept.id,
        department_name: bedDept.name,
        room_id: room.id,
        room_name: room.name,
        bed_id: bed.id,
        bed_code: bed.code,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `Mã HIS ${hisType} (Hồi sức)`,
        bedcare_summary: `${bedDept.name} · Phòng ${room.room_type}`,
      });
    } else if (hisType === 'DV' && room.room_type === 'STANDARD') {
      rawIssues.push({
        issue_key: `TIER_DV_STD:${bed.id}:${row.his_record_code}`,
        category: 'IRRATIONAL_ASSIGNMENT',
        rule_code: 'BHYT_TIER_MISMATCH',
        severity: 'HIGH',
        title: `Thu tiền giường Dịch vụ (DV) trên Phòng tiêu chuẩn (${bed.code})`,
        description: `HIS đang tính loại giường Dịch vụ cho ${row.patient_name}, nhưng phòng ${room.name} được cấu hình là Phòng tiêu chuẩn BHYT.`,
        bhyt_regulation_ref: 'Quy định công khai giá dịch vụ theo yêu cầu (TT 21/2023/TT-BYT)',
        department_id: bedDept.id,
        department_name: bedDept.name,
        room_id: room.id,
        room_name: room.name,
        bed_id: bed.id,
        bed_code: bed.code,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `Mã HIS DV (Dịch vụ)`,
        bedcare_summary: `${room.name} (STANDARD · ${(bed.daily_price ?? 0).toLocaleString('vi-VN')}đ)`,
      });
    } else if ((hisType === 'H2' || hisType === 'H3') && (room.room_type === 'VIP' || room.room_type === 'SERVICE')) {
      rawIssues.push({
        issue_key: `TIER_BHYT_VIP:${bed.id}:${row.his_record_code}`,
        category: 'IRRATIONAL_ASSIGNMENT',
        rule_code: 'BHYT_TIER_MISMATCH',
        severity: 'MEDIUM',
        title: `Nằm phòng ${room.room_type} nhưng HIS kê mã BHYT (${hisType}) tại ${bed.code}`,
        description: `${row.patient_name} đang sử dụng giường ${room.room_type} (${(bed.daily_price ?? 0).toLocaleString('vi-VN')}đ/ngày) nhưng HIS mới ghi nhận mã giường BHYT tiêu chuẩn ${hisType}. Cần kiểm tra phụ thu chênh lệch tự nguyện.`,
        bhyt_regulation_ref: 'Tách phần BHYT thanh toán và chênh lệch giường yêu cầu',
        department_id: bedDept.id,
        department_name: bedDept.name,
        room_id: room.id,
        room_name: room.name,
        bed_id: bed.id,
        bed_code: bed.code,
        his_bed_code: hisBedCode,
        his_dept_code: hisDeptCode,
        his_record_code: row.his_record_code,
        patient_name: row.patient_name,
        his_summary: `Mã HIS ${hisType} (BHYT chuẩn)`,
        bedcare_summary: `${room.name} (${room.room_type} · ${(bed.daily_price ?? 0).toLocaleString('vi-VN')}đ)`,
      });
    }

    // 3f. Bed-days billed vs actual elapsed days discrepancy
    const admitMs = new Date(row.admitted_at).getTime();
    if (!Number.isNaN(admitMs)) {
      const elapsedDays = Math.max(1, Math.ceil((Math.max(nowMs, admitMs) - admitMs) / (24 * 3600 * 1000)));
      if (row.bed_days_billed > elapsedDays + 1) {
        rawIssues.push({
          issue_key: `DAYS_OVER:${bed.id}:${row.his_record_code}`,
          category: 'IRRATIONAL_ASSIGNMENT',
          rule_code: 'BED_DAYS_DISCREPANCY',
          severity: 'HIGH',
          title: `HIS kê dư ngày giường (${row.bed_days_billed} ngày > ${elapsedDays} ngày thực tế)`,
          description: `BN ${row.patient_name} (${bed.code}) nhập lúc ${row.admitted_at.slice(0, 10)}, thực tế tối đa ${elapsedDays} ngày nhưng HIS đang kê ${row.bed_days_billed} ngày giường.`,
          bhyt_regulation_ref: 'Thông tư 39/2018/TT-BYT · Nguyên tắc tính số ngày giường điều trị nội trú',
          department_id: bedDept.id,
          department_name: bedDept.name,
          room_id: room.id,
          room_name: room.name,
          bed_id: bed.id,
          bed_code: bed.code,
          his_bed_code: hisBedCode,
          his_dept_code: hisDeptCode,
          his_record_code: row.his_record_code,
          patient_name: row.patient_name,
          his_summary: `${row.bed_days_billed} ngày giường HIS`,
          bedcare_summary: `${elapsedDays} ngày theo thời gian nằm`,
        });
      }
    }
  }

  // 4. Room capacity exceeded on HIS
  for (const [roomId, rows] of hisRowsByRoomId.entries()) {
    const room = roomById.get(roomId);
    if (!room) continue;
    const totalRatioUnits = rows.reduce((s, r) => s + Number(r.bed_ratio || 1), 0);
    if (rows.length > room.capacity && totalRatioUnits > room.capacity + 0.01) {
      const dept = deptById.get(room.department_id);
      rawIssues.push({
        issue_key: `ROOM_OVER:${room.id}`,
        category: 'QUOTA_EXCEEDED',
        rule_code: 'ROOM_CAPACITY_EXCEEDED',
        severity: 'CRITICAL',
        title: `Phòng ${room.name} vượt sức chứa thiết kế (${rows.length}/${room.capacity} giường)`,
        description: `HIS đang gán ${rows.length} bệnh nhân (${totalRatioUnits.toFixed(1)} đơn vị giường) vào phòng chỉ có ${room.capacity} giường mà không khai báo tỷ lệ giường ghép.`,
        bhyt_regulation_ref: 'Định mức diện tích & số giường/phòng bệnh (TCVN / BYT)',
        department_id: dept?.id ?? null,
        department_name: dept?.name ?? '',
        room_id: room.id,
        room_name: room.name,
        his_summary: `${rows.length} BN trên HIS (tổng hệ số ${totalRatioUnits.toFixed(1)})`,
        bedcare_summary: `Thiết kế ${room.capacity} giường`,
      });
    }
  }

  // 5. Department BHYT Planned Bed Quota Check
  const departmentQuotas: HisDepartmentQuotaRow[] = input.departments.map((dept) => {
    const deptBeds = input.beds.filter((b) => b.department_id === dept.id && b.status !== 'INACTIVE');
    const physicalBeds = deptBeds.length;
    const bedcareOccupied = deptBeds.filter((b) => b.status === 'OCCUPIED').length;
    const plannedBhyt = dept.planned_bhyt_beds && dept.planned_bhyt_beds > 0 ? dept.planned_bhyt_beds : physicalBeds;
    const maxOveragePct = dept.max_bhyt_overage_pct && dept.max_bhyt_overage_pct >= 100 ? dept.max_bhyt_overage_pct : 120;
    const hisStats = hisActiveUnitsByDeptId.get(dept.id) ?? { patients: 0, units: 0 };

    const effectiveLoad = Math.max(hisStats.units, bedcareOccupied);
    const utilizationPct = plannedBhyt > 0 ? Math.round((effectiveLoad / plannedBhyt) * 100) : 0;

    let status: HisDepartmentQuotaRow['status'] = 'COMPLIANT';
    if (utilizationPct > maxOveragePct || effectiveLoad > physicalBeds) {
      status = 'CRITICAL_OVERAGE';
    } else if (effectiveLoad > plannedBhyt) {
      status = 'OVER_PLANNED';
    }

    if (status !== 'COMPLIANT') {
      rawIssues.push({
        issue_key: `DEPT_QUOTA:${dept.id}`,
        category: 'QUOTA_EXCEEDED',
        rule_code: 'DEPT_EXCEEDS_PLANNED_BHYT_QUOTA',
        severity: status === 'CRITICAL_OVERAGE' ? 'CRITICAL' : 'HIGH',
        title: `${dept.name} vượt số giường quy định BHYT (${effectiveLoad}/${plannedBhyt} giường · ${utilizationPct}%)`,
        description:
          status === 'CRITICAL_OVERAGE'
            ? `Công suất ${utilizationPct}% vượt ngưỡng cho phép (${maxOveragePct}% giường kế hoạch hoặc vượt số giường thực kê ${physicalBeds}). Nguy cơ BHYT từ chối thanh toán phần vượt.`
            : `Đang sử dụng ${effectiveLoad} giường so với ${plannedBhyt} giường kế hoạch được duyệt (${utilizationPct}%). Cần lập hồ sơ giường kê thêm/giường ghép theo quy định.`,
        bhyt_regulation_ref: 'Thông tư 22/2023/TT-BYT & Công văn BHXH Việt Nam về công suất giường kế hoạch',
        department_id: dept.id,
        department_name: dept.name,
        his_dept_code: dept.his_dept_code || dept.code,
        his_summary: `${hisStats.patients} BN HIS (${hisStats.units.toFixed(1)} giường)`,
        bedcare_summary: `KH BHYT: ${plannedBhyt} · Thực kê: ${physicalBeds} · Đang nằm: ${bedcareOccupied}`,
      });
    }

    return {
      department_id: dept.id,
      department_code: dept.code,
      department_name: dept.name,
      his_dept_code: dept.his_dept_code || '',
      planned_bhyt_beds: plannedBhyt,
      max_bhyt_overage_pct: maxOveragePct,
      physical_beds: physicalBeds,
      bedcare_occupied_beds: bedcareOccupied,
      his_active_patients: hisStats.patients,
      his_effective_bed_units: Number(hisStats.units.toFixed(2)),
      quota_utilization_pct: utilizationPct,
      status,
    };
  });

  // Merge resolutions & sort severity
  const severityOrder: Record<'CRITICAL' | 'HIGH' | 'MEDIUM', number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
  };

  const issues: HisAuditIssue[] = rawIssues
    .map((issue) => {
      const res = resolutionMap.get(issue.issue_key);
      return {
        ...issue,
        resolved: Boolean(res),
        resolution_note: res?.resolution_note,
        resolved_by_name: res?.resolved_by_name,
        resolved_at: res?.resolved_at,
      };
    })
    .sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

  const openIssues = issues.filter((i) => !i.resolved);
  const mappedBedsCount = input.mappings.filter((m) => m.his_bed_code?.trim().length > 0).length;

  return {
    summary: {
      total_his_active: activeHisRows.length,
      total_bedcare_occupied: input.beds.filter((b) => b.status === 'OCCUPIED').length,
      mapped_beds_count: mappedBedsCount,
      total_beds_count: input.beds.length,
      open_issues_count: openIssues.length,
      duplicate_count: openIssues.filter((i) => i.category === 'DUPLICATE_BED').length,
      irrational_count: openIssues.filter((i) => i.category === 'IRRATIONAL_ASSIGNMENT').length,
      quota_exceeded_count: openIssues.filter((i) => i.category === 'QUOTA_EXCEEDED').length,
      resolved_count: issues.length - openIssues.length,
      last_synced_at: input.assignments[0]?.synced_at ?? null,
      last_source: input.assignments[0]?.source_system ?? null,
    },
    issues,
    departmentQuotas,
    mappings: input.mappings,
    assignments: input.assignments,
    importLogs: input.importLogs,
  };
}

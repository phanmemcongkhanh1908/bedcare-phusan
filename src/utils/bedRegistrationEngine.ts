import type { Admission, Bed, Department, Room } from '../types/bedcare';

export type RegistrationRuleCode =
  | 'DUPLICATE_BED_ID'
  | 'ALREADY_ADMITTED'
  | 'DUPLICATE_HIS_RECORD_ID'
  | 'DUPLICATE_HIS_BED_MAPPING'
  | 'HIS_BED_OCCUPIED_CONFLICT'
  | 'BED_OCCUPIED_UNDISCHARGED'
  | 'BED_NOT_VACANT_STATUS'
  | 'EXCLUSIVE_ROOM_CONFLICT'
  | 'ROOM_NOT_EMPTY_FOR_WHOLE_ROOM'
  | 'DEPT_QUOTA_EXCEEDED'
  | 'DEPT_QUOTA_WARNING';

export interface RegistrationValidationViolation {
  code: RegistrationRuleCode;
  severity: 'BLOCK' | 'WARNING';
  title: string;
  message: string;
  bed_id?: string;
  bed_code?: string;
  his_bed_code?: string;
  department_id?: string;
}

export interface DepartmentQuotaSnapshot {
  department_id: string;
  department_name: string;
  his_dept_code: string;
  active_occupied_beds: number;
  projected_occupied_beds: number;
  physical_beds: number;
  planned_bhyt_beds: number;
  max_bhyt_overage_pct: number;
  max_allowed_beds: number;
  projected_utilization_pct: number;
  status: 'WITHIN_LIMIT' | 'OVER_PLANNED_WARNING' | 'EXCEEDS_MAX_QUOTA';
}

export interface BedRegistrationCheckInput {
  departmentId: string;
  roomId?: string;
  bedId?: string;
  patientCode?: string;
  hisRecordCode?: string;
  reservationId?: string;
  isWholeRoom?: boolean;
  overrideQuotaLimit?: boolean;
  departments: Department[];
  rooms: Room[];
  beds: Bed[];
  activeAdmissions: Admission[];
  hisMappings?: Array<{
    bed_id: string;
    his_bed_code: string;
    his_dept_code?: string;
    his_bed_type_code?: string;
  }>;
  hisAssignments?: Array<{
    his_record_code: string;
    patient_code: string;
    patient_name: string;
    his_bed_code: string;
    status: string;
  }>;
}

export interface BedRegistrationCheckResult {
  allowed: boolean;
  blocks: RegistrationValidationViolation[];
  warnings: RegistrationValidationViolation[];
  departmentQuota: DepartmentQuotaSnapshot | null;
}

function norm(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase();
}

export function evaluateBedRegistrationRules(
  input: BedRegistrationCheckInput
): BedRegistrationCheckResult {
  const blocks: RegistrationValidationViolation[] = [];
  const warnings: RegistrationValidationViolation[] = [];

  const dept = input.departments.find((d) => d.id === input.departmentId);
  const room = input.roomId ? input.rooms.find((r) => r.id === input.roomId) : undefined;
  const bed = input.bedId ? input.beds.find((b) => b.id === input.bedId) : undefined;

  const undischargedAdmissions = input.activeAdmissions.filter(
    (a) => (a.status === 'ACTIVE' || a.status === 'PENDING_CONFIRMATION') && !a.actual_discharge_at
  );

  // 1. Check Duplicate Patient Code or Duplicate HIS Record Code already occupying an undischarged bed
  const cleanPatientCode = norm(input.patientCode);
  if (cleanPatientCode) {
    const existingByPatient = undischargedAdmissions.find(
      (a) => norm(a.patient_code) === cleanPatientCode
    );
    if (existingByPatient) {
      blocks.push({
        code: 'ALREADY_ADMITTED',
        severity: 'BLOCK',
        title: 'Bệnh nhân đang nằm giường chưa xuất viện',
        message: `Mã BN "${input.patientCode?.trim()}" (${existingByPatient.patient_name}) hiện đang nằm tại giường ${
          existingByPatient.bed_code || existingByPatient.bed_id
        } (${existingByPatient.admission_code}). Không thể cấp thêm giường thứ hai.`,
        bed_id: existingByPatient.bed_id,
        bed_code: existingByPatient.bed_code,
      });
    }
  }

  const cleanHisRecord = norm(input.hisRecordCode);
  if (cleanHisRecord) {
    const existingByHisRec = undischargedAdmissions.find(
      (a) =>
        norm(a.his_record_code) === cleanHisRecord &&
        (!cleanPatientCode || norm(a.patient_code) !== cleanPatientCode)
    );
    if (existingByHisRec) {
      blocks.push({
        code: 'DUPLICATE_HIS_RECORD_ID',
        severity: 'BLOCK',
        title: 'Trùng mã hồ sơ HIS (MA_LK) đang nội trú',
        message: `Mã HIS "${input.hisRecordCode?.trim()}" đang gắn với bệnh nhân ${existingByHisRec.patient_name} tại giường ${
          existingByHisRec.bed_code || existingByHisRec.bed_id
        } chưa xuất viện.`,
        bed_id: existingByHisRec.bed_id,
        bed_code: existingByHisRec.bed_code,
      });
    }
  }

  // 2. Check Target Bed: Duplicate Bed ID, Undischarged Occupant, HIS Mapping Conflict, and Bed Status
  if (bed) {
    const bedAdmissions = undischargedAdmissions.filter((a) => a.bed_id === bed.id);
    if (bedAdmissions.length > 0) {
      const occupant = bedAdmissions[0];
      blocks.push({
        code: 'DUPLICATE_BED_ID',
        severity: 'BLOCK',
        title: `Trùng ID giường ${bed.code} — Giường đã có bệnh nhân chưa xuất viện`,
        message: `Giường ${bed.code} (${bed.id}) hiện đang có bệnh nhân "${occupant.patient_name}" (${occupant.admission_code}) nằm điều trị và chưa có hồ sơ xuất viện.`,
        bed_id: bed.id,
        bed_code: bed.code,
      });
      blocks.push({
        code: 'BED_OCCUPIED_UNDISCHARGED',
        severity: 'BLOCK',
        title: `Giường ${bed.code} chưa xuất viện`,
        message: `Không thể cấp giường ${bed.code} khi bệnh nhân ${occupant.patient_name} chưa hoàn tất xuất viện/trả giường.`,
        bed_id: bed.id,
        bed_code: bed.code,
      });
    } else if (bed.status === 'OCCUPIED' || bed.status === 'PENDING_CONFIRMATION') {
      blocks.push({
        code: 'BED_OCCUPIED_UNDISCHARGED',
        severity: 'BLOCK',
        title: `Giường ${bed.code} đang ở trạng thái ${bed.status === 'OCCUPIED' ? 'Đang có người nằm' : 'Chờ xác nhận'}`,
        message: `Giường ${bed.code} chưa được giải phóng xuất viện. Vui lòng chọn giường trống hoặc thực hiện trả giường trước.`,
        bed_id: bed.id,
        bed_code: bed.code,
      });
    } else if (bed.status !== 'VACANT') {
      const isMatchingReservation =
        bed.status === 'RESERVED' &&
        Boolean(input.reservationId) &&
        bed.current_reservation_id === input.reservationId;
      if (!isMatchingReservation) {
        blocks.push({
          code: 'BED_NOT_VACANT_STATUS',
          severity: 'BLOCK',
          title: `Giường ${bed.code} không sẵn sàng (${bed.status})`,
          message:
            bed.status === 'RESERVED'
              ? `Giường ${bed.code} đang được giữ chỗ cho lượt đặt khác (${bed.reservation_patient_name || 'đã khóa'}).`
              : `Giường ${bed.code} hiện đang ở trạng thái ${bed.status}, không thể tiếp nhận trực tiếp.`,
          bed_id: bed.id,
          bed_code: bed.code,
        });
      }
    }

    // Check HIS mapping consistency for target bed
    if (input.hisMappings && input.hisMappings.length > 0) {
      const targetMapping = input.hisMappings.find((m) => m.bed_id === bed.id);
      const targetHisBedCode = targetMapping?.his_bed_code?.trim().toUpperCase();
      if (targetHisBedCode) {
        const duplicateHisMappings = input.hisMappings.filter(
          (m) => m.his_bed_code?.trim().toUpperCase() === targetHisBedCode
        );
        if (duplicateHisMappings.length > 1) {
          blocks.push({
            code: 'DUPLICATE_HIS_BED_MAPPING',
            severity: 'BLOCK',
            title: `Trùng mã ánh xạ HIS "${targetHisBedCode}"`,
            message: `Mã giường HIS "${targetHisBedCode}" đang bị ánh xạ trùng tới ${duplicateHisMappings.length} giường vật lý khác nhau. Vui lòng chỉnh lại trong HIS Mapping.`,
            bed_id: bed.id,
            bed_code: bed.code,
            his_bed_code: targetHisBedCode,
          });
        }

        // Check if active HIS feed already assigns a different patient to this HIS bed code
        if (input.hisAssignments && input.hisAssignments.length > 0) {
          const conflictingHisRow = input.hisAssignments.find(
            (a) =>
              a.status === 'ACTIVE' &&
              a.his_bed_code.trim().toUpperCase() === targetHisBedCode &&
              (!cleanPatientCode || norm(a.patient_code) !== cleanPatientCode) &&
              (!cleanHisRecord || norm(a.his_record_code) !== cleanHisRecord)
          );
          if (conflictingHisRow) {
            warnings.push({
              code: 'HIS_BED_OCCUPIED_CONFLICT',
              severity: 'WARNING',
              title: `Cảnh báo đối soát HIS: Mã giường ${targetHisBedCode} đang có BN trên HIS`,
              message: `Hệ thống HIS đang ghi nhận BN "${conflictingHisRow.patient_name}" (${conflictingHisRow.his_record_code}) trên mã giường ${targetHisBedCode}. Hãy kiểm tra tránh trùng thanh toán BHYT.`,
              bed_id: bed.id,
              bed_code: bed.code,
              his_bed_code: targetHisBedCode,
            });
          }
        }
      }
    }
  }

  // 3. Check Room-level Exclusive Lock / Whole-Room Constraints
  if (room) {
    const matchingResLock = Boolean(input.reservationId && room.exclusive_lock_id === input.reservationId);
    if (room.exclusive_locked && !matchingResLock) {
      blocks.push({
        code: 'EXCLUSIVE_ROOM_CONFLICT',
        severity: 'BLOCK',
        title: `Phòng ${room.name} đang khóa bao trọn riêng tư`,
        message: `Phòng ${room.name} đang được bao trọn cho hồ sơ khác, không thể cấp lẻ giường trong phòng này.`,
        bed_id: bed?.id,
        bed_code: bed?.code,
      });
    }
    if (input.isWholeRoom) {
      const roomBeds = input.beds.filter((b) => b.room_id === room.id && b.status !== 'INACTIVE');
      const blockedBed = roomBeds.find(
        (b) =>
          b.status !== 'VACANT' &&
          !(b.status === 'RESERVED' && input.reservationId && b.current_reservation_id === input.reservationId)
      );
      if (blockedBed) {
        blocks.push({
          code: 'ROOM_NOT_EMPTY_FOR_WHOLE_ROOM',
          severity: 'BLOCK',
          title: `Không thể khóa bao trọn phòng ${room.name}`,
          message: `Giường ${blockedBed.code} trong phòng ${room.name} hiện đang ở trạng thái ${blockedBed.status}, không đủ điều kiện bao trọn toàn phòng.`,
          bed_id: blockedBed.id,
          bed_code: blockedBed.code,
        });
      }
    }
  }

  // 4. Check Department Bed Quota & BHYT Planned Limit
  let departmentQuota: DepartmentQuotaSnapshot | null = null;
  if (dept) {
    const deptBeds = input.beds.filter((b) => b.department_id === dept.id && b.status !== 'INACTIVE');
    const physicalBeds = deptBeds.length;
    const deptActiveCount = undischargedAdmissions.filter((a) => a.department_id === dept.id).length;

    const addedUnits = input.isWholeRoom && room
      ? Math.max(1, deptBeds.filter((b) => b.room_id === room.id).length)
      : bed
        ? 1
        : 0;
    const projectedOccupied = deptActiveCount + addedUnits;

    const plannedBhyt =
      dept.planned_bhyt_beds && dept.planned_bhyt_beds > 0 ? dept.planned_bhyt_beds : physicalBeds;
    const maxOveragePct =
      dept.max_bhyt_overage_pct && dept.max_bhyt_overage_pct >= 100 ? dept.max_bhyt_overage_pct : 120;
    const maxAllowedBeds =
      plannedBhyt > 0 ? Math.max(plannedBhyt, Math.floor((plannedBhyt * maxOveragePct) / 100)) : physicalBeds;

    const projectedPct = plannedBhyt > 0 ? Math.round((projectedOccupied / plannedBhyt) * 100) : 0;

    let quotaStatus: DepartmentQuotaSnapshot['status'] = 'WITHIN_LIMIT';
    if (projectedOccupied > maxAllowedBeds || (physicalBeds > 0 && projectedOccupied > physicalBeds)) {
      quotaStatus = 'EXCEEDS_MAX_QUOTA';
    } else if (plannedBhyt > 0 && projectedOccupied > plannedBhyt) {
      quotaStatus = 'OVER_PLANNED_WARNING';
    }

    departmentQuota = {
      department_id: dept.id,
      department_name: dept.name,
      his_dept_code: dept.his_dept_code || '',
      active_occupied_beds: deptActiveCount,
      projected_occupied_beds: projectedOccupied,
      physical_beds: physicalBeds,
      planned_bhyt_beds: plannedBhyt,
      max_bhyt_overage_pct: maxOveragePct,
      max_allowed_beds: maxAllowedBeds,
      projected_utilization_pct: projectedPct,
      status: quotaStatus,
    };

    if (quotaStatus === 'EXCEEDS_MAX_QUOTA' && !input.overrideQuotaLimit) {
      blocks.push({
        code: 'DEPT_QUOTA_EXCEEDED',
        severity: 'BLOCK',
        title: `Vượt hạn mức giường tối đa của ${dept.name}`,
        message: `Sau khi cấp giường, ${dept.name} sẽ đạt ${projectedOccupied}/${plannedBhyt} giường quy định BHYT (${projectedPct}%, vượt trần cho phép ${maxOveragePct}% / tối đa ${maxAllowedBeds} giường).`,
        department_id: dept.id,
      });
    } else if (quotaStatus === 'OVER_PLANNED_WARNING' || (quotaStatus === 'EXCEEDS_MAX_QUOTA' && input.overrideQuotaLimit)) {
      warnings.push({
        code: 'DEPT_QUOTA_WARNING',
        severity: 'WARNING',
        title: `Cảnh báo vượt số giường kế hoạch BHYT tại ${dept.name}`,
        message: `Khoa ${dept.name} sẽ đạt ${projectedOccupied}/${plannedBhyt} giường kế hoạch (${projectedPct}%). Cần lập hồ sơ giường kê thêm/giường ghép theo Thông tư 22/2023/TT-BYT.`,
        department_id: dept.id,
      });
    }
  }

  return {
    allowed: blocks.length === 0,
    blocks,
    warnings,
    departmentQuota,
  };
}

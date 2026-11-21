import type { BedStatus } from '../types/bedcare';

export type RoomOccupancyStatus = 'AVAILABLE' | 'PARTIAL_RESERVED' | 'IN_USE' | 'EXCLUSIVE';

export interface ValidatableRoom {
  id: string;
  code: string;
  name: string;
  exclusive_locked: number | boolean;
  exclusive_lock_id?: string | null;
  occupancy_status?: string | null;
}

export interface ValidatableBed {
  id: string;
  room_id: string;
  code: string;
  status: BedStatus | string;
  current_admission_id?: string | null;
  current_reservation_id?: string | null;
}

export type ConflictCode =
  | 'OCCUPIED_ROOM_HAS_RESERVATION'
  | 'ROOM_STATUS_MISMATCH'
  | 'EXCLUSIVE_COMPANION_UNLOCKED'
  | 'STALE_EXCLUSIVE_LOCK'
  | 'DANGLING_BED_POINTER';

export interface RoomBedConflict {
  code: ConflictCode;
  bedId?: string;
  bedCode?: string;
  message: string;
}

export interface RoomValidationResult {
  roomId: string;
  roomCode: string;
  roomName: string;
  expectedOccupancyStatus: RoomOccupancyStatus;
  actualOccupancyStatus: RoomOccupancyStatus;
  hasConflict: boolean;
  conflicts: RoomBedConflict[];
  isReservationBlocked: boolean;
  blockReason: string | null;
}

export const ROOM_OCCUPANCY_LABELS: Record<RoomOccupancyStatus, { label: string; cls: string }> = {
  AVAILABLE: { label: 'Phòng sẵn sàng', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  PARTIAL_RESERVED: { label: 'Phòng có giường giữ chỗ', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  IN_USE: { label: 'Phòng đang sử dụng', cls: 'text-sky-700 bg-sky-50 border-sky-200' },
  EXCLUSIVE: { label: 'Phòng đang được bao trọn', cls: 'text-amber-800 bg-amber-50 border-amber-300' },
};

export function deriveRoomOccupancyStatus(
  room: Pick<ValidatableRoom, 'exclusive_locked'>,
  bedsInRoom: Array<Pick<ValidatableBed, 'status'>>
): RoomOccupancyStatus {
  if (Boolean(room.exclusive_locked)) {
    return 'EXCLUSIVE';
  }
  if (bedsInRoom.some((b) => b.status === 'OCCUPIED')) {
    return 'IN_USE';
  }
  if (bedsInRoom.some((b) => b.status === 'RESERVED' || b.status === 'PENDING_CONFIRMATION')) {
    return 'PARTIAL_RESERVED';
  }
  return 'AVAILABLE';
}

export function canReserveInRoom(
  room: Pick<ValidatableRoom, 'code' | 'name' | 'exclusive_locked'>,
  bedsInRoom: Array<Pick<ValidatableBed, 'code' | 'status'>>
): { allowed: boolean; reason?: string } {
  if (Boolean(room.exclusive_locked)) {
    return {
      allowed: false,
      reason: `Phòng ${room.name} đang được bao trọn, không thể giữ chỗ thêm giường.`,
    };
  }
  const occupiedBed = bedsInRoom.find((b) => b.status === 'OCCUPIED');
  if (occupiedBed) {
    return {
      allowed: false,
      reason: `Phòng ${room.name} đã tự động chuyển sang trạng thái "Đang sử dụng" vì giường ${occupiedBed.code} đã chiếm dụng. Hệ thống chặn thao tác giữ chỗ giường khác trong cùng phòng.`,
    };
  }
  return { allowed: true };
}

export function validateRoomAndBeds(
  room: ValidatableRoom,
  bedsInRoom: ValidatableBed[],
  activeWholeRoomLockIds?: Set<string>,
  activeAdmissionIds?: Set<string>
): RoomValidationResult {
  const conflicts: RoomBedConflict[] = [];
  const expectedOccupancyStatus = deriveRoomOccupancyStatus(room, bedsInRoom);
  const actualOccupancyStatus = (room.occupancy_status || expectedOccupancyStatus) as RoomOccupancyStatus;
  const isExclusive = Boolean(room.exclusive_locked);
  const occupiedBeds = bedsInRoom.filter((b) => b.status === 'OCCUPIED');
  const reservedBeds = bedsInRoom.filter((b) => b.status === 'RESERVED');

  // 1. Check stale exclusive lock
  if (isExclusive && activeWholeRoomLockIds && room.exclusive_lock_id && !activeWholeRoomLockIds.has(room.exclusive_lock_id)) {
    conflicts.push({
      code: 'STALE_EXCLUSIVE_LOCK',
      message: `Phòng ${room.code} vẫn giữ cờ bao trọn (${room.exclusive_lock_id}) nhưng giao dịch bao phòng không còn hiệu lực.`,
    });
  } else if (isExclusive && !room.exclusive_lock_id) {
    conflicts.push({
      code: 'STALE_EXCLUSIVE_LOCK',
      message: `Phòng ${room.code} bật trạng thái bao trọn nhưng thiếu mã giao dịch khóa phòng.`,
    });
  }

  // 2. Check exclusive room having VACANT bed
  if (isExclusive) {
    const unlockedVacant = bedsInRoom.filter((b) => b.status === 'VACANT');
    for (const ub of unlockedVacant) {
      conflicts.push({
        code: 'EXCLUSIVE_COMPANION_UNLOCKED',
        bedId: ub.id,
        bedCode: ub.code,
        message: `Phòng ${room.code} đang bao trọn nhưng giường ${ub.code} vẫn ở trạng thái Trống.`,
      });
    }
  }

  // 3. Check occupied non-exclusive room still having RESERVED beds (violates auto-lock reservation rule)
  if (!isExclusive && occupiedBeds.length > 0 && reservedBeds.length > 0) {
    for (const rb of reservedBeds) {
      conflicts.push({
        code: 'OCCUPIED_ROOM_HAS_RESERVATION',
        bedId: rb.id,
        bedCode: rb.code,
        message: `Phòng ${room.code} đã có giường ${occupiedBeds[0].code} đang chiếm dụng (Đang sử dụng), xung đột với giường ${rb.code} đang giữ chỗ.`,
      });
    }
  }

  // 4. Check room aggregate status mismatch against beds
  if (room.occupancy_status && room.occupancy_status !== expectedOccupancyStatus) {
    conflicts.push({
      code: 'ROOM_STATUS_MISMATCH',
      message: `Trạng thái tổng hợp của phòng ${room.code} (${room.occupancy_status}) không khớp trạng thái giường thực tế (${expectedOccupancyStatus}).`,
    });
  }

  // 5. Check dangling bed pointers
  for (const b of bedsInRoom) {
    if (b.status === 'VACANT' && (b.current_admission_id || b.current_reservation_id)) {
      conflicts.push({
        code: 'DANGLING_BED_POINTER',
        bedId: b.id,
        bedCode: b.code,
        message: `Giường ${b.code} ở trạng thái Trống nhưng còn lưu liên kết lượt nằm/giữ chỗ cũ.`,
      });
    }
    if (
      b.status === 'OCCUPIED' &&
      activeAdmissionIds &&
      (!b.current_admission_id || !activeAdmissionIds.has(b.current_admission_id))
    ) {
      conflicts.push({
        code: 'DANGLING_BED_POINTER',
        bedId: b.id,
        bedCode: b.code,
        message: `Giường ${b.code} đang Đã chiếm dụng nhưng thiếu hồ sơ tiếp nhận đang hoạt động.`,
      });
    }
  }

  const reservationCheck = canReserveInRoom(room, bedsInRoom);

  return {
    roomId: room.id,
    roomCode: room.code,
    roomName: room.name,
    expectedOccupancyStatus,
    actualOccupancyStatus,
    hasConflict: conflicts.length > 0,
    conflicts,
    isReservationBlocked: !reservationCheck.allowed,
    blockReason: reservationCheck.reason ?? null,
  };
}

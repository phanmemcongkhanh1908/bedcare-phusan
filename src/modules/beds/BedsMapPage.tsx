import { AlertTriangle, History, Plus, Printer, QrCode, RefreshCw, Wrench } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { BedQrCode } from '../../components/BedQrCode';
import { BedStatusBadge } from '../../components/BedStatusBadge';
import type { ScreenId } from '../../components/LayoutShell';
import { OfficialReportHeader, OfficialReportSignatures } from '../../components/OfficialDocumentParts';
import { PrintPreviewModal, type PrintPreviewColumn } from '../../components/PrintPreviewModal';
import { apiFetch } from '../../services/api';
import type { Bed, BedHistoryEntry, BedStatus, Department, Room, UserRole } from '../../types/bedcare';
import { BED_STATUS_META, formatDateTimeVN, formatDateVN } from '../../utils/formatters';
import {
  ROOM_OCCUPANCY_LABELS,
  validateRoomAndBeds,
  type RoomValidationResult,
} from '../../utils/roomBedValidation';

interface BedsMapPageProps {
  userRole: UserRole;
  userDeptId?: string | null;
  initialDepartmentFilter?: string;
  initialStatusFilter?: string;
  initialBedId?: string;
  onClearInitialBed?: () => void;
  globalSearch: string;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onNavigate: (id: ScreenId) => void;
}

const ALL_STATUSES: BedStatus[] = [
  'VACANT',
  'RESERVED',
  'OCCUPIED',
  'PENDING_CONFIRMATION',
  'PENDING_CLEANING',
  'CLEANING',
  'MAINTENANCE',
  'INACTIVE',
];

const ADMISSION_STATUS_LABELS: Record<BedHistoryEntry['status'], { label: string; cls: string }> = {
  ACTIVE: { label: 'Đang nằm', cls: 'text-sky-700 bg-sky-50 border-sky-200' },
  DISCHARGED: { label: 'Đã trả giường', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  TRANSFERRED: { label: 'Đã chuyển giường', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  PENDING_CONFIRMATION: { label: 'Chờ xác nhận', cls: 'text-orange-700 bg-orange-50 border-orange-200' },
};

const BED_MAP_PRINT_COLUMNS: PrintPreviewColumn[] = [
  { key: 'stt', label: 'STT', locked: true },
  { key: 'bed_code', label: 'Mã giường', locked: true },
  { key: 'room_dept', label: 'Phòng / Khoa điều trị' },
  { key: 'status', label: 'Trạng thái giường' },
  { key: 'patient', label: 'Bệnh nhân / Mã BN' },
  { key: 'diagnosis_dates', label: 'Chẩn đoán / Dự kiến trả' },
  { key: 'notes', label: 'Ghi chú điều phối' },
];

const BEDCARD_PRINT_COLUMNS: PrintPreviewColumn[] = [
  { key: 'qr', label: 'Mã QR đầu giường' },
  { key: 'patient_codes', label: 'Mã BN / Mã HS / Ngày sinh' },
  { key: 'stay_times', label: 'Thời gian nhận & dự kiến trả' },
  { key: 'diagnosis', label: 'Chẩn đoán & Lưu ý chăm sóc' },
  { key: 'care_team', label: 'Ê-kíp điều trị & Ký xác nhận' },
];

export function BedsMapPage({
  userRole,
  userDeptId,
  initialDepartmentFilter,
  initialStatusFilter,
  initialBedId,
  onClearInitialBed,
  globalSearch,
  onNotify,
  onNavigate,
}: BedsMapPageProps) {
  const isDeptScoped = userRole === 'WARD_STAFF' && Boolean(userDeptId);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [deptFilter, setDeptFilter] = useState(
    isDeptScoped ? userDeptId || '' : initialDepartmentFilter ?? ''
  );
  const [statusFilter, setStatusFilter] = useState<BedStatus | ''>((initialStatusFilter as BedStatus) ?? '');
  const [loading, setLoading] = useState(true);
  const [fixingConflicts, setFixingConflicts] = useState(false);
  const [selectedBed, setSelectedBed] = useState<Bed | null>(null);
  const [modalTab, setModalTab] = useState<'INFO' | 'HISTORY'>('INFO');
  const [historyItems, setHistoryItems] = useState<BedHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [printingBed, setPrintingBed] = useState<Bed | null>(null);
  const [mapPrintOpen, setMapPrintOpen] = useState(false);

  // Add bed modal
  const [showAddBed, setShowAddBed] = useState(false);
  const [newRoomId, setNewRoomId] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');

  const canManageStructure = userRole === 'SUPER_ADMIN' || userRole === 'ADMIN';
  const canToggleMaintenance = canManageStructure || userRole === 'WARD_STAFF';

  const load = async () => {
    setLoading(true);
    try {
      const [bData, dData, rData] = await Promise.all([
        apiFetch<Bed[]>('/beds'),
        apiFetch<Department[]>('/departments'),
        apiFetch<Room[]>('/rooms'),
      ]);
      setBeds(bData);
      setDepartments(dData);
      setRooms(rData);
      if (!newRoomId && rData.length > 0) setNewRoomId(rData[0].id);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const onClusterSync = () => load();
    window.addEventListener('bedcare-cluster-sync', onClusterSync);
    return () => window.removeEventListener('bedcare-cluster-sync', onClusterSync);
  }, []);

  useEffect(() => {
    if (isDeptScoped && userDeptId) {
      setDeptFilter(userDeptId);
    } else if (initialDepartmentFilter !== undefined) {
      setDeptFilter(initialDepartmentFilter);
    }
  }, [initialDepartmentFilter, isDeptScoped, userDeptId]);

  useEffect(() => {
    if (initialStatusFilter !== undefined) {
      setStatusFilter(initialStatusFilter as BedStatus | '');
    }
  }, [initialStatusFilter]);

  useEffect(() => {
    if (!initialBedId || beds.length === 0) return;
    const match = beds.find((b) => b.id === initialBedId || b.code.toLowerCase() === initialBedId.toLowerCase());
    if (match) {
      openBedModal(match);
      onClearInitialBed?.();
    }
  }, [initialBedId, beds]);

  const openBedModal = (bed: Bed) => {
    setSelectedBed(bed);
    setModalTab('INFO');
    setHistoryItems([]);
    setHistoryError('');
  };

  const loadBedHistory = async (bedId: string) => {
    setModalTab('HISTORY');
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const res = await apiFetch<{ bed: Bed; history: BedHistoryEntry[] }>(`/beds/${bedId}/history`);
      setHistoryItems(res.history);
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const filteredBeds = beds.filter((b) => {
    if (deptFilter && b.department_id !== deptFilter) return false;
    if (statusFilter && b.status !== statusFilter) return false;
    if (globalSearch.trim()) {
      const q = globalSearch.toLowerCase();
      const hay = `${b.code} ${b.name} ${b.room_name ?? ''} ${b.patient_name ?? ''} ${b.department_name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Validate ALL rooms against ALL beds in the facility
  const roomValidationMap = new Map<string, RoomValidationResult>();
  let totalConflictRooms = 0;
  let totalConflictIssues = 0;
  for (const rm of rooms) {
    const rmBeds = beds.filter((b) => b.room_id === rm.id);
    const v = validateRoomAndBeds(rm, rmBeds);
    roomValidationMap.set(rm.id, v);
    if (v.hasConflict) {
      totalConflictRooms++;
      totalConflictIssues += v.conflicts.length;
    }
  }

  // Group beds by department -> room
  const groupedByRoom = new Map<
    string,
    {
      roomCode: string;
      roomName: string;
      deptName: string;
      floor: string;
      exclusive: boolean;
      validation?: RoomValidationResult;
      beds: Bed[];
    }
  >();
  for (const b of filteredBeds) {
    const key = b.room_id;
    if (!groupedByRoom.has(key)) {
      const rm = rooms.find((r) => r.id === key);
      groupedByRoom.set(key, {
        roomCode: b.room_code || rm?.code || '',
        roomName: b.room_name || rm?.name || key,
        deptName: b.department_name || '',
        floor: b.floor || rm?.floor || '',
        exclusive: Boolean(rm?.exclusive_locked),
        validation: roomValidationMap.get(key),
        beds: [],
      });
    }
    groupedByRoom.get(key)!.beds.push(b);
  }

  const handleBatchFixConflicts = async () => {
    setFixingConflicts(true);
    try {
      const res = await apiFetch<{ fixedConflicts: number; remainingConflicts: number; fixedRooms: string[] }>(
        '/beds/fix-conflicts',
        { method: 'POST' }
      );
      if (res.fixedConflicts > 0) {
        onNotify(
          `Đã sửa ${res.fixedConflicts} xung đột phòng/giường tại ${res.fixedRooms.join(', ')}. Còn lại: ${res.remainingConflicts}.`
        );
      } else {
        onNotify('Đã đồng bộ và kiểm tra toàn bộ trạng thái phòng/giường (không còn xung đột).');
      }
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    } finally {
      setFixingConflicts(false);
    }
  };

  const handleStatusChange = async (bed: Bed, status: 'VACANT' | 'MAINTENANCE' | 'INACTIVE') => {
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/beds/${bed.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      if (res?.queuedOffline) {
        onNotify(`Đang mất mạng: đã xếp lệnh đổi trạng thái giường ${bed.code} vào hàng chờ đồng bộ.`);
      } else {
        onNotify(`Đã chuyển giường ${bed.code} sang trạng thái ${BED_STATUS_META[status].label}.`);
      }
      setSelectedBed(null);
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  const handleQuickCleanBed = async (bed: Bed) => {
    if (!bed.cleaning_log_id) {
      setSelectedBed(null);
      onNavigate('cleaning');
      return;
    }
    try {
      const endpoint =
        bed.status === 'PENDING_CLEANING'
          ? `/cleaning/${bed.cleaning_log_id}/start`
          : `/cleaning/${bed.cleaning_log_id}/complete`;
      const res = await apiFetch<{ queuedOffline?: boolean }>(endpoint, { method: 'POST', body: JSON.stringify({}) });
      if (res?.queuedOffline) {
        onNotify(`Đang mất mạng: đã lưu thao tác vệ sinh giường ${bed.code} vào Pending Actions.`);
      } else {
        onNotify(
          bed.status === 'PENDING_CLEANING'
            ? `Đã bắt đầu vệ sinh giường ${bed.code}.`
            : `Đã hoàn tất vệ sinh giường ${bed.code} — sẵn sàng tiếp nhận.`
        );
      }
      setSelectedBed(null);
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  const handleAddBed = async (e: FormEvent) => {
    e.preventDefault();
    const rm = rooms.find((r) => r.id === newRoomId);
    if (!rm) return;
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>('/beds', {
        method: 'POST',
        body: JSON.stringify({
          room_id: rm.id,
          department_id: rm.department_id,
          code: newCode,
          name: newName,
        }),
      });
      onNotify(res?.queuedOffline ? 'Đã xếp lệnh thêm giường vào hàng chờ ngoại tuyến.' : 'Đã thêm giường mới.');
      setShowAddBed(false);
      setNewCode('');
      setNewName('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const openBedcardPrint = (bed: Bed) => {
    setSelectedBed(null);
    setPrintingBed(bed);
  };

  return (
    <div className="space-y-6">
      <div className={`space-y-6 ${printingBed ? 'no-print-during-bedcard' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Sơ đồ Giường bệnh trực quan</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Hiển thị 8 trạng thái giường chuẩn theo từng phòng và khoa nội trú. Nhấn vào giường để xem lịch sử hoặc in phiếu đầu giường.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {isDeptScoped ? (
              <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900">
                Phạm vi khoa: {departments.find((d) => d.id === userDeptId)?.name || 'Khoa quản lý'}
              </div>
            ) : (
              <select
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                aria-label="Lọc theo khoa"
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
              >
                <option value="">Tất cả khoa</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as BedStatus | '')}
              aria-label="Lọc theo trạng thái giường"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
            >
              <option value="">Tất cả trạng thái</option>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>{BED_STATUS_META[s].label}</option>
              ))}
            </select>
            {canToggleMaintenance && (
              <button
                type="button"
                onClick={handleBatchFixConflicts}
                disabled={fixingConflicts}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
                  totalConflictIssues > 0
                    ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Wrench className="h-3.5 w-3.5" />
                <span>
                  {fixingConflicts
                    ? 'Đang sửa...'
                    : totalConflictIssues > 0
                      ? `Sửa xung đột hàng loạt (${totalConflictRooms})`
                      : 'Sửa xung đột hàng loạt'}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setMapPrintOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 whitespace-nowrap"
            >
              <Printer className="h-3.5 w-3.5" />
              <span>Xem trước &amp; In sơ đồ</span>
            </button>
            <button
              type="button"
              onClick={load}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Tải lại</span>
            </button>
            {canManageStructure && (
              <button
                type="button"
                onClick={() => setShowAddBed((v) => !v)}
                className="flex items-center gap-1.5 rounded-md bg-sky-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
              >
                <Plus className="h-4 w-4" />
                <span>Thêm giường</span>
              </button>
            )}
          </div>
        </div>

        {/* Legend Bar */}
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          {ALL_STATUSES.map((st) => {
            const cnt = beds.filter((b) => b.status === st && (!deptFilter || b.department_id === deptFilter)).length;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter((prev) => (prev === st ? '' : st))}
                className={`flex items-center gap-1.5 text-xs font-medium py-0.5 transition-opacity ${
                  statusFilter && statusFilter !== st ? 'opacity-45' : 'opacity-100'
                }`}
              >
                <BedStatusBadge status={st} compact />
                <span className="font-mono tabular-nums text-slate-500">({cnt})</span>
              </button>
            );
          })}
        </div>

        {showAddBed && canManageStructure && (
          <form onSubmit={handleAddBed} className="rounded-lg border border-slate-200 bg-white p-5 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phòng *</label>
              <select value={newRoomId} onChange={(e) => setNewRoomId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.department_name})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mã giường *</label>
              <input type="text" required value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="VD: A101-G02" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tên giường *</label>
              <input type="text" required value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="VD: Giường 02 - Phòng A101" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">Lưu giường</button>
              <button type="button" onClick={() => setShowAddBed(false)} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600">Hủy</button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="h-64 rounded-lg border border-slate-200 bg-white animate-pulse" />
        ) : groupedByRoom.size === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            Không có giường nào phù hợp bộ lọc hiện tại.
          </div>
        ) : (
          <div className="space-y-4">
            {Array.from(groupedByRoom.entries()).map(([roomId, grp]) => {
              const validation = grp.validation;
              const occMeta = validation
                ? ROOM_OCCUPANCY_LABELS[validation.expectedOccupancyStatus]
                : ROOM_OCCUPANCY_LABELS.AVAILABLE;
              const hasConflict = Boolean(validation?.hasConflict);
              return (
                <div
                  key={roomId}
                  className={`rounded-lg border bg-white p-5 ${
                    hasConflict ? 'border-rose-300 ring-1 ring-rose-100' : 'border-slate-200'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-4 border-b border-slate-100">
                    <div className="flex flex-wrap items-center gap-2">
                      {hasConflict && (
                        <AlertTriangle
                          className="h-4 w-4 text-rose-600 shrink-0"
                          aria-label={`Cảnh báo xung đột trạng thái tại ${grp.roomCode || grp.roomName}`}
                        />
                      )}
                      <span className="text-base font-semibold text-slate-900">{grp.roomName}</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-sm text-slate-600">{grp.deptName}</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-xs text-slate-500">{grp.floor}</span>
                      {hasConflict && (
                        <span className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">
                          Xung đột trạng thái (Conflicting Status)
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${occMeta.cls}`}>
                        {occMeta.label}
                      </span>
                    </div>
                  </div>

                  {hasConflict && validation && (
                    <div className="mb-3 rounded-md border border-rose-200 bg-rose-50/70 px-3.5 py-2 text-xs text-rose-900 space-y-0.5">
                      {validation.conflicts.map((c, idx) => (
                        <div key={`${c.code}-${idx}`} className="flex items-center gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                          <span>{c.message}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {grp.beds.map((b) => {
                      const meta = BED_STATUS_META[b.status];
                      const secondaryText = (() => {
                        if (b.patient_name) return { text: b.patient_name, strong: true };
                        if (b.is_exclusive_companion) {
                          return {
                            text: b.exclusive_holder_name
                              ? `Khóa bao phòng · ${b.exclusive_holder_name}`
                              : 'Khóa kèm theo phòng bao trọn',
                            strong: false,
                          };
                        }
                        if (b.status === 'RESERVED') {
                          return {
                            text: b.reservation_patient_name
                              ? `Giữ chỗ: ${b.reservation_patient_name}`
                              : b.notes || 'Đã khóa giữ chỗ',
                            strong: false,
                          };
                        }
                        if (b.status === 'PENDING_CONFIRMATION') return { text: 'Chờ xác nhận đồng thuận P2P', strong: false };
                        if (b.status === 'PENDING_CLEANING') return { text: 'Chờ vệ sinh khử khuẩn', strong: false };
                        if (b.status === 'CLEANING') return { text: 'Đang vệ sinh giường', strong: false };
                        if (b.status === 'MAINTENANCE') return { text: b.notes || 'Đang bảo trì kỹ thuật', strong: false };
                        if (b.status === 'INACTIVE') return { text: b.notes || 'Tạm ngừng hoạt động', strong: false };
                        return { text: b.notes || 'Sẵn sàng phục vụ', strong: false };
                      })();

                      return (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => openBedModal(b)}
                          className={`text-left rounded-lg border p-3.5 transition-colors hover:border-sky-500 ${meta.border} ${meta.bg}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm font-bold text-slate-900">{b.code}</span>
                            <BedStatusBadge status={b.status} compact />
                          </div>
                          <div className="mt-2 text-xs text-slate-700 truncate">
                            <span className={secondaryText.strong ? 'font-medium text-slate-900' : 'text-slate-600'}>
                              {secondaryText.text}
                            </span>
                          </div>
                          {b.expected_discharge_at ? (
                            <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-600">
                              Dự kiến trả: {formatDateVN(b.expected_discharge_at)}
                            </div>
                          ) : b.is_exclusive_companion && b.reservation_expires_at ? (
                            <div className="mt-1 text-[11px] font-mono tabular-nums text-amber-800">
                              Khóa đến: {formatDateVN(b.reservation_expires_at)}
                            </div>
                          ) : b.status === 'RESERVED' && b.reservation_expires_at ? (
                            <div className="mt-1 text-[11px] font-mono tabular-nums text-amber-800">
                              Hết giữ: {formatDateTimeVN(b.reservation_expires_at)}
                            </div>
                          ) : null}
                          {(b.bed_type_name || (b.daily_price ?? 0) > 0) && (
                            <div className="mt-1.5 pt-1.5 border-t border-slate-200/60 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                              <span className="truncate">{b.bed_type_name || 'Tiêu chuẩn'}</span>
                              {(b.daily_price ?? 0) > 0 && (
                                <span className="font-mono tabular-nums font-semibold text-slate-700 shrink-0">
                                  {Number(b.daily_price).toLocaleString('vi-VN')}đ/ngày
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected Bed Drawer / Modal */}
      {selectedBed && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/45 p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="bed-modal-title">
          <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-6 space-y-4 shadow-lg max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-mono text-slate-500">{selectedBed.department_name} · {selectedBed.room_name}</div>
                <h3 id="bed-modal-title" className="text-lg font-semibold text-slate-900 mt-0.5">Giường {selectedBed.code}</h3>
              </div>
              <BedStatusBadge status={selectedBed.status} />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setModalTab('INFO')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  modalTab === 'INFO' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Thông tin &amp; Thao tác
              </button>
              <button
                type="button"
                onClick={() => loadBedHistory(selectedBed.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  modalTab === 'HISTORY' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                <span>Xem lịch sử giường</span>
              </button>
            </div>

            {modalTab === 'INFO' ? (
              <div className="space-y-4 overflow-y-auto">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-t border-b border-slate-100 py-3">
                  <div className="text-sm text-slate-600 space-y-1.5 flex-1">
                    <div>Tên giường: <span className="font-medium text-slate-900">{selectedBed.name}</span></div>
                    {selectedBed.patient_name && (
                      <>
                        <div>
                          Bệnh nhân hiện tại: <span className="font-semibold text-slate-900">{selectedBed.patient_name}</span>
                          {selectedBed.patient_code ? <span className="font-mono text-xs text-slate-500"> ({selectedBed.patient_code})</span> : null}
                        </div>
                        {selectedBed.diagnosis_group && (
                          <div>Chẩn đoán: <span className="font-medium text-slate-800">{selectedBed.diagnosis_group}</span></div>
                        )}
                        {selectedBed.confirmed_by_name && (
                          <div>BS/ĐD phụ trách: <span className="font-medium text-slate-800">{selectedBed.confirmed_by_name}</span></div>
                        )}
                      </>
                    )}
                    {selectedBed.is_exclusive_companion && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Giường này đang bị khóa kèm do <strong>{selectedBed.room_name}</strong> đang được bao trọn
                        {selectedBed.exclusive_holder_name ? ` bởi bệnh nhân ${selectedBed.exclusive_holder_name}` : ''}. Không thể tiếp nhận bệnh nhân khác vào giường này cho tới khi kết thúc bao phòng.
                      </div>
                    )}
                    {!selectedBed.is_exclusive_companion && selectedBed.status === 'RESERVED' && selectedBed.reservation_patient_name && (
                      <div>
                        Đang giữ chỗ cho: <span className="font-semibold text-slate-900">{selectedBed.reservation_patient_name}</span>
                        {selectedBed.reservation_expires_at ? ` (đến ${formatDateTimeVN(selectedBed.reservation_expires_at)})` : ''}
                      </div>
                    )}
                    {selectedBed.expected_discharge_at && (
                      <div>Ngày trả dự kiến: <span className="font-mono">{formatDateVN(selectedBed.expected_discharge_at)}</span></div>
                    )}
                    {selectedBed.notes && <div>Ghi chú: {selectedBed.notes}</div>}
                  </div>
                  <div className="shrink-0 flex flex-col items-center rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <BedQrCode
                      bedId={selectedBed.id}
                      bedCode={selectedBed.code}
                      admissionId={selectedBed.current_admission_id}
                      size={92}
                      compact
                      caption="Quét mở hồ sơ"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {selectedBed.status === 'VACANT' && (
                    <>
                      {roomValidationMap.get(selectedBed.room_id)?.isReservationBlocked ? (
                        <div className="w-full rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          {roomValidationMap.get(selectedBed.room_id)?.blockReason}
                        </div>
                      ) : (
                        userRole !== 'EXECUTIVE' && (
                          <button
                            type="button"
                            onClick={() => { setSelectedBed(null); onNavigate('reservations'); }}
                            className="rounded-md bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700"
                          >
                            Giữ chỗ giường này
                          </button>
                        )
                      )}
                      {(userRole === 'SUPER_ADMIN' || userRole === 'ADMIN' || userRole === 'WARD_STAFF') && (
                        <button
                          type="button"
                          onClick={() => { setSelectedBed(null); onNavigate('admissions'); }}
                          className="rounded-md bg-sky-700 px-3 py-2 text-xs font-medium text-white hover:bg-sky-800"
                        >
                          Tiếp nhận bệnh nhân
                        </button>
                      )}
                      {canToggleMaintenance && (!userDeptId || userDeptId === selectedBed.department_id) && (
                        <button
                          type="button"
                          onClick={() => handleStatusChange(selectedBed, 'MAINTENANCE')}
                          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-100"
                        >
                          Chuyển bảo trì
                        </button>
                      )}
                    </>
                  )}

                  {(selectedBed.status === 'MAINTENANCE' || selectedBed.status === 'INACTIVE') && canToggleMaintenance && (!userDeptId || userDeptId === selectedBed.department_id) && (
                    <button
                      type="button"
                      onClick={() => handleStatusChange(selectedBed, 'VACANT')}
                      className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-800"
                    >
                      Khôi phục về Trống
                    </button>
                  )}

                  {(selectedBed.status === 'PENDING_CLEANING' || selectedBed.status === 'CLEANING') && (
                    <>
                      {selectedBed.cleaning_log_id && canToggleMaintenance && (
                        <button
                          type="button"
                          onClick={() => handleQuickCleanBed(selectedBed)}
                          className="rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                        >
                          {selectedBed.status === 'PENDING_CLEANING' ? 'Bắt đầu dọn vệ sinh' : 'Hoàn tất sạch ngay'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => { setSelectedBed(null); onNavigate('cleaning'); }}
                        className="rounded-md border border-teal-300 bg-teal-50 px-3 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100"
                      >
                        Mở hàng đợi vệ sinh
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => openBedcardPrint(selectedBed)}
                    className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    <span>{selectedBed.status === 'OCCUPIED' ? 'In phiếu đầu giường & QR' : 'In tem QR giường'}</span>
                  </button>

                  {selectedBed.status === 'OCCUPIED' && (
                    <button
                      type="button"
                      onClick={() => { setSelectedBed(null); onNavigate('inpatients'); }}
                      className="rounded-md bg-sky-700 px-3 py-2 text-xs font-medium text-white hover:bg-sky-800"
                    >
                      Quản lý lượt nằm
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => loadBedHistory(selectedBed.id)}
                    className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <History className="h-3.5 w-3.5" />
                    <span>Xem lịch sử giường</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto border-t border-b border-slate-100 py-3 space-y-3">
                {historyLoading ? (
                  <div className="py-8 text-center text-sm text-slate-500">Đang tải lịch sử sử dụng giường...</div>
                ) : historyError ? (
                  <div className="rounded-md border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{historyError}</div>
                ) : historyItems.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-500">
                    Giường {selectedBed.code} chưa ghi nhận lượt tiếp nhận nào trong lịch sử.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {historyItems.map((item) => {
                      const stMeta = ADMISSION_STATUS_LABELS[item.status] ?? ADMISSION_STATUS_LABELS.DISCHARGED;
                      return (
                        <div key={`${item.id}-${item.relation_type}`} className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-slate-900">
                              {item.patient_name}{' '}
                              <span className="font-mono text-xs font-normal text-slate-500">
                                ({item.patient_code} · {item.admission_code})
                              </span>
                            </div>
                            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${stMeta.cls}`}>
                              {stMeta.label}
                            </span>
                          </div>
                          <div className="text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                            <span>Chẩn đoán: <strong className="text-slate-800">{item.diagnosis_group}</strong></span>
                            <span className="font-mono tabular-nums">Nhận: {formatDateTimeVN(item.bed_assigned_at)}</span>
                            <span className="font-mono tabular-nums">
                              {item.actual_discharge_at
                                ? `Trả/Chuyển: ${formatDateTimeVN(item.actual_discharge_at)}`
                                : `Dự kiến trả: ${formatDateTimeVN(item.expected_discharge_at)}`}
                            </span>
                            <span className="font-mono tabular-nums">Số ngày: {item.days_stayed}</span>
                          </div>
                          <div className="text-xs text-slate-500">
                            BS/ĐD phụ trách: {item.confirmed_by_name || '—'} · Gia hạn: {item.extension_count} lần
                            {item.transfer_note ? ` · ${item.transfer_note}` : ''}
                            {item.notes ? ` · Ghi chú: ${item.notes}` : ''}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setSelectedBed(null)}
                className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Bed Map Inventory Modal via Unified Print Preview */}
      <PrintPreviewModal
        isOpen={mapPrintOpen}
        onClose={() => setMapPrintOpen(false)}
        title="Xem trước Bảng trạng thái Sơ đồ Giường bệnh"
        subtitle={`${
          deptFilter ? departments.find((d) => d.id === deptFilter)?.name || 'Khoa đã chọn' : 'Toàn viện'
        } · ${statusFilter ? BED_STATUS_META[statusFilter].label : 'Tất cả trạng thái'} · ${filteredBeds.length} giường`}
        defaultOrientation="landscape"
        columns={BED_MAP_PRINT_COLUMNS}
      >
        {({ isColumnVisible, visibleColumnCount }) => {
          const deptLabel = deptFilter
            ? departments.find((d) => d.id === deptFilter)?.name || 'Khoa đã chọn'
            : 'Toàn viện';
          const statusLabel = statusFilter ? BED_STATUS_META[statusFilter].label : 'Tất cả 8 trạng thái';
          const vacantCount = filteredBeds.filter((b) => b.status === 'VACANT').length;
          const occupiedCount = filteredBeds.filter((b) => b.status === 'OCCUPIED').length;
          const cleaningCount = filteredBeds.filter(
            (b) => b.status === 'PENDING_CLEANING' || b.status === 'CLEANING'
          ).length;

          return (
            <div className="space-y-4">
              <OfficialReportHeader
                title="BẢNG TỔNG HỢP TRẠNG THÁI SƠ ĐỒ GIƯỜNG BỆNH"
                scopeLabel={`${deptLabel} · Bộ lọc: ${statusLabel} · Tổng: ${filteredBeds.length} giường`}
                documentCode={`MAP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`}
              />

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                {[
                  { label: 'Tổng giường hiển thị', val: filteredBeds.length },
                  { label: 'Đang có bệnh nhân', val: occupiedCount },
                  { label: 'Giường trống sẵn sàng', val: vacantCount },
                  { label: 'Chờ / Đang vệ sinh', val: cleaningCount },
                ].map((stat) => (
                  <div key={stat.label} className="rounded border border-slate-300 bg-slate-50/50 px-2.5 py-2">
                    <div className="text-[11px] text-slate-600">{stat.label}</div>
                    <div className="text-base font-bold font-mono tabular-nums text-slate-900 mt-0.5">{stat.val}</div>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto print:overflow-visible">
                <table className="w-full text-xs border border-slate-400">
                  <thead className="bg-slate-100 text-slate-900 border-b border-slate-400">
                    <tr>
                      {isColumnVisible('stt') && (
                        <th className="border border-slate-300 px-2 py-2 text-center w-9">STT</th>
                      )}
                      {isColumnVisible('bed_code') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Mã giường</th>
                      )}
                      {isColumnVisible('room_dept') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Phòng / Khoa điều trị</th>
                      )}
                      {isColumnVisible('status') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Trạng thái</th>
                      )}
                      {isColumnVisible('patient') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Bệnh nhân / Mã BN</th>
                      )}
                      {isColumnVisible('diagnosis_dates') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Chẩn đoán / Dự kiến trả</th>
                      )}
                      {isColumnVisible('notes') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Ghi chú điều phối</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBeds.length === 0 ? (
                      <tr>
                        <td
                          colSpan={Math.max(1, visibleColumnCount)}
                          className="border border-slate-300 px-4 py-8 text-center text-slate-500"
                        >
                          Không có giường nào phù hợp bộ lọc hiện tại.
                        </td>
                      </tr>
                    ) : (
                      filteredBeds.map((b, idx) => (
                        <tr key={b.id} className="align-top">
                          {isColumnVisible('stt') && (
                            <td className="border border-slate-300 px-2 py-1.5 text-center font-mono tabular-nums">
                              {idx + 1}
                            </td>
                          )}
                          {isColumnVisible('bed_code') && (
                            <td className="border border-slate-300 px-2.5 py-1.5 font-mono font-bold text-slate-900 whitespace-nowrap">
                              {b.code}
                            </td>
                          )}
                          {isColumnVisible('room_dept') && (
                            <td className="border border-slate-300 px-2.5 py-1.5">
                              <div className="font-medium text-slate-900">{b.room_name || '—'}</div>
                              <div className="text-[11px] text-slate-600">{b.department_name || '—'}</div>
                            </td>
                          )}
                          {isColumnVisible('status') && (
                            <td className="border border-slate-300 px-2.5 py-1.5 font-medium whitespace-nowrap">
                              {BED_STATUS_META[b.status].label}
                              {Boolean(b.is_whole_room) && (
                                <div className="text-[10px] font-semibold uppercase text-slate-700">
                                  [Bao trọn phòng]
                                </div>
                              )}
                            </td>
                          )}
                          {isColumnVisible('patient') && (
                            <td className="border border-slate-300 px-2.5 py-1.5">
                              {b.patient_name ? (
                                <>
                                  <div className="font-semibold text-slate-900">{b.patient_name}</div>
                                  <div className="text-[11px] font-mono text-slate-600">{b.patient_code || '—'}</div>
                                </>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          )}
                          {isColumnVisible('diagnosis_dates') && (
                            <td className="border border-slate-300 px-2.5 py-1.5">
                              {b.diagnosis_group || b.expected_discharge_at ? (
                                <>
                                  <div>{b.diagnosis_group || 'Theo dõi nội trú'}</div>
                                  {b.expected_discharge_at && (
                                    <div className="text-[11px] font-mono text-slate-600">
                                      DK trả: {formatDateVN(b.expected_discharge_at)}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          )}
                          {isColumnVisible('notes') && (
                            <td className="border border-slate-300 px-2.5 py-1.5 text-[11px] text-slate-700">
                              {b.admission_notes || b.notes || '—'}
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <OfficialReportSignatures
                signers={['Nhân viên điều phối', 'Điều dưỡng trưởng khoa', 'Trưởng phòng KHTH']}
              />
            </div>
          );
        }}
      </PrintPreviewModal>

      {/* Printable Bedcard Modal via Unified Print Preview */}
      <PrintPreviewModal
        isOpen={Boolean(printingBed)}
        onClose={() => setPrintingBed(null)}
        title={`Xem trước Phiếu đầu giường (Bedcard) — ${printingBed?.code ?? ''}`}
        subtitle="Định dạng chuẩn A5 / A4 kèm mã QR quét mở nhanh hồ sơ bệnh nhân"
        defaultOrientation="portrait"
        maxWidthClass="max-w-2xl"
        columns={BEDCARD_PRINT_COLUMNS}
      >
        {({ isColumnVisible }) =>
          printingBed && (
            <div className="rounded-lg border-2 border-slate-900 bg-white p-6 space-y-5 text-slate-900">
              <div className="grid grid-cols-2 gap-4 text-center border-b border-slate-300 pb-2 text-[11px]">
                <div>
                  <div className="font-bold uppercase">BỆNH VIỆN ĐA KHOA</div>
                  <div className="font-bold uppercase text-sky-800">HỆ THỐNG ĐIỀU PHỐI GIƯỜNG BỆNH BEDCARE</div>
                </div>
                <div>
                  <div className="font-bold uppercase">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
                  <div className="font-bold underline underline-offset-2">Độc lập - Tự do - Hạnh phúc</div>
                </div>
              </div>
              <div className="flex items-start justify-between gap-4 border-b-2 border-slate-900 pb-3">
                <div>
                  <div className="text-xs italic text-slate-600">
                    Ngày {String(new Date().getDate()).padStart(2, '0')} tháng {String(new Date().getMonth() + 1).padStart(2, '0')} năm {new Date().getFullYear()}
                  </div>
                  <h4 className="text-xl font-bold tracking-tight mt-1">
                    PHIẾU THÔNG TIN ĐẦU GIƯỜNG (BEDCARD)
                  </h4>
                  <div className="font-mono text-2xl font-bold mt-1">{printingBed.code}</div>
                  <div className="text-xs text-slate-600">
                    {printingBed.room_name} · {printingBed.floor || 'Nội trú'}
                  </div>
                </div>
                {isColumnVisible('qr') && (
                  <div className="shrink-0">
                    <BedQrCode
                      bedId={printingBed.id}
                      bedCode={printingBed.code}
                      admissionId={printingBed.current_admission_id}
                      size={86}
                      compact
                      caption="Quét mở hồ sơ"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-slate-500">THÔNG TIN BỆNH NHÂN</div>
                  <div className="text-lg font-bold">{printingBed.patient_name || '—'}</div>
                  {isColumnVisible('patient_codes') && (
                    <>
                      <div>
                        Mã BN: <span className="font-mono font-semibold">{printingBed.patient_code || '—'}</span>
                        {printingBed.his_record_code ? (
                          <> · HIS: <span className="font-mono">{printingBed.his_record_code}</span></>
                        ) : null}
                      </div>
                      <div>
                        Mã hồ sơ: <span className="font-mono">{printingBed.admission_code || '—'}</span> · Ngày sinh:{' '}
                        <span className="font-mono">{printingBed.date_of_birth || '—'}</span>
                      </div>
                    </>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-slate-500">KHOA ĐIỀU TRỊ &amp; THỜI GIAN</div>
                  <div className="font-semibold text-base">{printingBed.department_name}</div>
                  {isColumnVisible('stay_times') && (
                    <>
                      <div>
                        Nhận giường:{' '}
                        <span className="font-mono">
                          {printingBed.bed_assigned_at ? formatDateTimeVN(printingBed.bed_assigned_at) : '—'}
                        </span>
                      </div>
                      <div>
                        Dự kiến trả:{' '}
                        <span className="font-mono font-semibold">
                          {printingBed.expected_discharge_at ? formatDateVN(printingBed.expected_discharge_at) : '—'}
                        </span>
                        {printingBed.is_whole_room ? ' · (Bao trọn phòng)' : ''}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {isColumnVisible('diagnosis') && (
                <div className="rounded-md border border-slate-300 bg-slate-50/60 p-3.5 space-y-1">
                  <div className="text-xs font-semibold text-slate-500">CHẨN ĐOÁN / NHÓM ĐIỀU TRỊ</div>
                  <div className="text-base font-bold">{printingBed.diagnosis_group || 'Theo dõi nội trú'}</div>
                  {(printingBed.admission_notes || printingBed.notes) && (
                    <div className="text-xs text-slate-700 pt-1">
                      Lưu ý chăm sóc: {printingBed.admission_notes || printingBed.notes}
                    </div>
                  )}
                </div>
              )}

              {isColumnVisible('care_team') && (
                <div className="grid grid-cols-2 gap-4 border-t border-slate-300 pt-3 text-sm">
                  <div className="space-y-1">
                    <div className="text-xs font-semibold text-slate-500">Ê-KÍP ĐIỀU TRỊ &amp; CHĂM SÓC (CARE TEAM)</div>
                    <div>
                      Phụ trách chính:{' '}
                      <span className="font-semibold">{printingBed.confirmed_by_name || 'Bác sĩ / Điều dưỡng trực khoa'}</span>
                    </div>
                    <div className="text-xs text-slate-700">
                      Nhân sự khoa:{' '}
                      {printingBed.care_team && printingBed.care_team.length > 0
                        ? printingBed.care_team.join(', ')
                        : printingBed.confirmed_by_name || 'Điều dưỡng trực'}
                    </div>
                  </div>
                  <div className="space-y-1 text-right text-xs text-slate-600">
                    <div>In lúc: <span className="font-mono">{new Date().toLocaleString('vi-VN')}</span></div>
                    <div className="pt-4 font-semibold text-slate-800">Xác nhận Điều dưỡng trưởng khoa</div>
                  </div>
                </div>
              )}
            </div>
          )
        }
      </PrintPreviewModal>
    </div>
  );
}

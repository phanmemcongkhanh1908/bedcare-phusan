import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { apiFetch } from '../../services/api';
import type { Bed, Department, Registration, Reservation, Room, UserRole } from '../../types/bedcare';
import { formatDateTimeVN } from '../../utils/formatters';
import { canReserveInRoom } from '../../utils/roomBedValidation';

interface ReservationsPageProps {
  userRole?: UserRole;
  initialRegistrationId?: string;
  onClearInitialRegistration?: () => void;
  onOpenAdmission?: (regId: string) => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function ReservationsPage({
  userRole,
  initialRegistrationId,
  onClearInitialRegistration,
  onOpenAdmission,
  onNotify,
}: ReservationsPageProps) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [waitingRegs, setWaitingRegs] = useState<Registration[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const [selectedRegId, setSelectedRegId] = useState('');
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [patientName, setPatientName] = useState('');
  const [deptId, setDeptId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [bedId, setBedId] = useState('');
  const [isWholeRoom, setIsWholeRoom] = useState(false);
  const [holdHours, setHoldHours] = useState(12);
  const [notes, setNotes] = useState('');

  const [cancelTarget, setCancelTarget] = useState<Reservation | null>(null);

  const canAdmit = userRole !== 'CASHIER' && userRole !== 'EXECUTIVE';

  const load = async () => {
    try {
      const [rsvs, regs, depts, rms, bds] = await Promise.all([
        apiFetch<Reservation[]>('/reservations'),
        apiFetch<Registration[]>('/registrations'),
        apiFetch<Department[]>('/departments'),
        apiFetch<Room[]>('/rooms'),
        apiFetch<Bed[]>('/beds'),
      ]);
      setReservations(rsvs);
      setWaitingRegs(regs.filter((r) => r.status === 'WAITING'));
      setDepartments(depts);
      setRooms(rms);
      setBeds(bds);
      if (!deptId && depts.length > 0) setDeptId(depts[0].id);
    } catch (e) {
      onNotify((e as Error).message, 'error');
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

  const applyWaitingReg = (reg: Registration) => {
    setSelectedRegId(reg.id);
    setSelectedPatientId(reg.patient_id);
    setPatientName(reg.patient_name);
    if (reg.department_id) setDeptId(reg.department_id);
    setIsWholeRoom(reg.reservation_type === 'WHOLE_ROOM');
    setRoomId(reg.room_id || '');
    setBedId(reg.reservation_type === 'WHOLE_ROOM' ? '' : reg.bed_id || '');
    setNotes(
      reg.created_by === 'customer-portal'
        ? `Duyệt giữ chỗ từ yêu cầu khách hàng (${reg.registration_code})`
        : `Giữ chỗ từ phiếu ĐK ${reg.registration_code}`
    );
  };

  useEffect(() => {
    if (!initialRegistrationId || waitingRegs.length === 0) return;
    const match = waitingRegs.find((r) => r.id === initialRegistrationId);
    if (match) {
      setShowCreate(true);
      applyWaitingReg(match);
      onClearInitialRegistration?.();
    }
  }, [initialRegistrationId, waitingRegs]);

  const deptRooms = rooms.filter((r) => r.department_id === deptId && r.status === 'ACTIVE' && !r.exclusive_locked);
  const wholeRoomReady = (rId: string) => {
    const rb = beds.filter((b) => b.room_id === rId && b.status !== 'INACTIVE');
    return rb.length > 0 && rb.every((b) => b.status === 'VACANT');
  };
  const selectedRoomObj = rooms.find((r) => r.id === roomId);
  const selectedRoomCheck = selectedRoomObj
    ? canReserveInRoom(
        selectedRoomObj,
        beds.filter((b) => b.room_id === selectedRoomObj.id)
      )
    : { allowed: true };
  const roomVacantBeds = selectedRoomCheck.allowed
    ? beds.filter((b) => b.room_id === roomId && b.status === 'VACANT')
    : [];

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedRoomCheck.allowed) {
      onNotify(selectedRoomCheck.reason || 'Phòng đang sử dụng, hệ thống chặn giữ chỗ.', 'error');
      return;
    }
    try {
      const res = await apiFetch<{ pendingConfirmation?: boolean; queuedOffline?: boolean }>('/reservations', {
        method: 'POST',
        body: JSON.stringify({
          registration_id: selectedRegId || undefined,
          patient_id: selectedPatientId || undefined,
          patient_name: patientName,
          department_id: deptId,
          room_id: roomId,
          bed_id: isWholeRoom ? null : bedId,
          is_whole_room: isWholeRoom,
          hold_hours: Number(holdHours),
          notes,
        }),
      });
      if (res?.queuedOffline) {
        onNotify('Đang mất mạng: đã lưu lệnh giữ chỗ vào Pending Actions để phát đồng bộ sau.');
      } else {
        onNotify(
          res.pendingConfirmation
            ? 'Yêu cầu giữ chỗ đang ở trạng thái Chờ xác nhận do thiếu quorum mạng P2P.'
            : isWholeRoom
            ? 'Đã khóa bao trọn phòng thành công qua đồng thuận P2P.'
            : 'Đã giữ chỗ giường thành công qua đồng thuận P2P.'
        );
      }
      setShowCreate(false);
      setSelectedRegId('');
      setSelectedPatientId('');
      setPatientName('');
      setRoomId('');
      setBedId('');
      setNotes('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleExtend = async (id: string) => {
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/reservations/${id}/extend`, {
        method: 'POST',
        body: JSON.stringify({ additional_hours: 6 }),
      });
      onNotify(res?.queuedOffline ? 'Đang mất mạng: đã xếp lệnh gia hạn giữ chỗ vào Pending Actions.' : 'Đã gia hạn giữ chỗ thêm 6 giờ.');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/reservations/${cancelTarget.id}/cancel`, { method: 'POST' });
      onNotify(
        res?.queuedOffline
          ? 'Đang mất mạng: đã xếp lệnh hủy giữ chỗ vào Pending Actions.'
          : 'Đã hủy giữ chỗ và giải phóng giường/phòng.'
      );
      setCancelTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
      setCancelTarget(null);
    }
  };

  const renderStatus = (status: Reservation['status']) => {
    if (status === 'ACTIVE') return { label: 'Đang giữ chỗ', cls: 'text-amber-700 bg-amber-50 border-amber-200' };
    if (status === 'PENDING_CONFIRMATION') return { label: 'Chờ đồng thuận', cls: 'text-orange-700 bg-orange-50 border-orange-200' };
    if (status === 'CONVERTED') return { label: 'Đã tiếp nhận', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
    return { label: 'Đã hủy', cls: 'text-slate-500 bg-slate-100 border-slate-200' };
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Giữ chỗ Giường &amp; Bao trọn phòng</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Giữ chỗ thủ công hoặc liên kết từ phiếu đăng ký chờ, kiểm soát đồng thuận P2P chống đặt trùng phòng đang nằm.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="min-h-[44px] flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>Tạo giữ chỗ / Bao phòng</span>
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-slate-900">Giữ chỗ thủ công mới</h3>
            {waitingRegs.length > 0 && (
              <div className="w-full sm:w-80">
                <select
                  value={selectedRegId}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (!id) {
                      setSelectedRegId('');
                      setSelectedPatientId('');
                      return;
                    }
                    const found = waitingRegs.find((r) => r.id === id);
                    if (found) applyWaitingReg(found);
                  }}
                  aria-label="Liên kết hồ sơ đăng ký chờ"
                  className="w-full min-h-[44px] rounded-md border border-sky-300 bg-sky-50/50 px-3 py-2 text-xs text-slate-800"
                >
                  <option value="">-- Hoặc chọn nhanh từ HS đăng ký chờ ({waitingRegs.length}) --</option>
                  {waitingRegs.map((reg) => (
                    <option key={reg.id} value={reg.id}>
                      {reg.registration_code} · {reg.patient_name} ({reg.patient_code})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Họ tên bệnh nhân *</label>
              <input type="text" required value={patientName} onChange={(e) => setPatientName(e.target.value)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Khoa *</label>
              <select value={deptId} onChange={(e) => { setDeptId(e.target.value); setRoomId(''); setBedId(''); }} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Hình thức giữ</label>
              <select value={isWholeRoom ? 'WHOLE' : 'SINGLE'} onChange={(e) => { setIsWholeRoom(e.target.value === 'WHOLE'); setRoomId(''); setBedId(''); }} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                <option value="SINGLE">Giữ 1 giường cụ thể</option>
                <option value="WHOLE">Bao trọn toàn bộ phòng</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phòng *</label>
              <select required value={roomId} onChange={(e) => { setRoomId(e.target.value); setBedId(''); }} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                <option value="">-- Chọn phòng --</option>
                {deptRooms
                  .filter((r) => (isWholeRoom ? wholeRoomReady(r.id) : true))
                  .map((r) => {
                    const chk = canReserveInRoom(
                      r,
                      beds.filter((b) => b.room_id === r.id)
                    );
                    return (
                      <option key={r.id} value={r.id} disabled={!chk.allowed}>
                        {r.name} ({r.capacity} giường){!chk.allowed ? ' · Đang sử dụng (Chặn giữ chỗ)' : ''}
                      </option>
                    );
                  })}
              </select>
            </div>
            {!isWholeRoom && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Giường trống *</label>
                <select required value={bedId} onChange={(e) => setBedId(e.target.value)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                  <option value="">-- Chọn giường --</option>
                  {roomVacantBeds.map((b) => (
                    <option key={b.id} value={b.id}>{b.code}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Thời gian giữ (giờ)</label>
              <input type="number" min={1} max={72} value={holdHours} onChange={(e) => setHoldHours(Number(e.target.value))} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums" />
            </div>
          </div>
          {!selectedRoomCheck.allowed && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {selectedRoomCheck.reason}
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Ghi chú</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowCreate(false)} className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700">Hủy</button>
            <button type="submit" disabled={!selectedRoomCheck.allowed} className="min-h-[44px] rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50">Xác nhận giữ chỗ</button>
          </div>
        </form>
      )}

      {/* Desktop Table */}
      <div className="hidden md:block rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Bệnh nhân</th>
                <th className="px-4 py-3 text-left font-medium">Khoa / Phòng / Giường</th>
                <th className="px-4 py-3 text-left font-medium">Loại giữ chỗ</th>
                <th className="px-4 py-3 text-left font-medium">Hạn giữ chỗ</th>
                <th className="px-4 py-3 text-left font-medium">Người thực hiện</th>
                <th className="px-4 py-3 text-left font-medium">Trạng thái</th>
                <th className="px-4 py-3 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reservations.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Chưa có lượt giữ chỗ nào.</td></tr>
              ) : reservations.map((r) => {
                const st = renderStatus(r.status);
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{r.patient_name}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.department_name} · {r.room_name} {r.bed_code ? `· ${r.bed_code}` : ''}
                    </td>
                    <td className="px-4 py-3 text-xs font-medium">
                      {r.is_whole_room ? (
                        <span className="text-amber-700">Bao trọn phòng ({r.locked_bed_ids.length} giường)</span>
                      ) : (
                        <span className="text-slate-700">Giữ 1 giường</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{formatDateTimeVN(r.expires_at)}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{r.created_by_name}</td>
                    <td className="px-4 py-3 text-xs font-semibold">
                      <span className={`inline-block rounded border px-2 py-0.5 ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2.5 whitespace-nowrap">
                      {r.status === 'ACTIVE' && (
                        <>
                          {r.registration_id && canAdmit && onOpenAdmission && (
                            <button type="button" onClick={() => onOpenAdmission(r.registration_id!)} className="text-xs font-semibold text-emerald-700 hover:underline">
                              Tiếp nhận
                            </button>
                          )}
                          <button type="button" onClick={() => handleExtend(r.id)} className="text-xs font-medium text-sky-700 hover:underline">
                            +6 giờ
                          </button>
                          <button type="button" onClick={() => setCancelTarget(r)} className="text-xs font-medium text-rose-600 hover:underline">
                            Hủy giữ chỗ
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-3">
        {reservations.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            Chưa có lượt giữ chỗ nào.
          </div>
        ) : reservations.map((r) => {
          const st = renderStatus(r.status);
          return (
            <div key={r.id} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-sm text-slate-900">{r.patient_name}</div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    {r.department_name} · {r.room_name} {r.bed_code ? `· ${r.bed_code}` : ''}
                  </div>
                </div>
                <span className={`rounded border px-2 py-0.5 text-xs font-semibold shrink-0 ${st.cls}`}>{st.label}</span>
              </div>
              <div className="text-xs text-slate-600 space-y-1">
                <div>
                  Loại:{' '}
                  <strong className={r.is_whole_room ? 'text-amber-700' : 'text-slate-800'}>
                    {r.is_whole_room ? `Bao trọn phòng (${r.locked_bed_ids.length} giường)` : 'Giữ 1 giường'}
                  </strong>
                </div>
                <div className="font-mono text-slate-500">Hết hạn: {formatDateTimeVN(r.expires_at)}</div>
                <div>Người giữ: {r.created_by_name}</div>
              </div>
              {r.status === 'ACTIVE' && (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                  {r.registration_id && canAdmit && onOpenAdmission && (
                    <button
                      type="button"
                      onClick={() => onOpenAdmission(r.registration_id!)}
                      className="flex-1 min-h-[44px] rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white active:scale-[0.98]"
                    >
                      Tiếp nhận
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleExtend(r.id)}
                    className="flex-1 min-h-[44px] rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 active:scale-[0.98]"
                  >
                    +6 giờ
                  </button>
                  <button
                    type="button"
                    onClick={() => setCancelTarget(r)}
                    className="min-h-[44px] rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 active:scale-[0.98]"
                  >
                    Hủy
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmModal
        open={Boolean(cancelTarget)}
        title="Hủy giữ chỗ giường/phòng"
        description={`Xác nhận hủy giữ chỗ cho ${cancelTarget?.patient_name}? Các giường bị khóa sẽ được giải phóng ngay về trạng thái Trống.`}
        danger
        confirmLabel="Hủy giữ chỗ"
        onConfirm={handleCancel}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}

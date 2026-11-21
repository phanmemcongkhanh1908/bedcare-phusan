import { Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { apiFetch } from '../../services/api';
import type { Department, Room, RoomStandard, UserRole } from '../../types/bedcare';

interface RoomsPageProps {
  userRole: UserRole;
  userDeptId?: string | null;
  initialDepartmentFilter?: string;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function RoomsPage({ userRole, userDeptId, initialDepartmentFilter = '', onNotify }: RoomsPageProps) {
  const isDeptScoped = userRole === 'WARD_STAFF' && Boolean(userDeptId);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [standards, setStandards] = useState<RoomStandard[]>([]);
  const [deptFilter, setDeptFilter] = useState(isDeptScoped ? userDeptId || '' : initialDepartmentFilter);
  const [loading, setLoading] = useState(true);

  const [showRoomForm, setShowRoomForm] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [rDeptId, setRDeptId] = useState('');
  const [rCode, setRCode] = useState('');
  const [rName, setRName] = useState('');
  const [rFloor, setRFloor] = useState('Tầng 1');
  const [rCapacity, setRCapacity] = useState(2);
  const [rToilet, setRToilet] = useState<'INTERNAL' | 'EXTERNAL'>('INTERNAL');
  const [rType, setRType] = useState<'STANDARD' | 'SERVICE' | 'VIP' | 'ISOLATION'>('STANDARD');
  const [rIsService, setRIsService] = useState(false);
  const [rStandardIds, setRStandardIds] = useState<string[]>([]);
  const [rStatus, setRStatus] = useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');

  // Dynamic Room Standard creator
  const [showStdForm, setShowStdForm] = useState(false);
  const [stdName, setStdName] = useState('');
  const [stdCode, setStdCode] = useState('');
  const [stdCat, setStdCat] = useState<'CAPACITY' | 'TOILET' | 'SERVICE' | 'CUSTOM'>('CUSTOM');

  const [deleteTarget, setDeleteTarget] = useState<Room | null>(null);

  const canEdit = userRole === 'SUPER_ADMIN' || userRole === 'ADMIN';

  const load = async () => {
    setLoading(true);
    try {
      const [rms, depts, stds] = await Promise.all([
        apiFetch<Room[]>(deptFilter ? `/rooms?departmentId=${deptFilter}` : '/rooms'),
        apiFetch<Department[]>('/departments'),
        apiFetch<RoomStandard[]>('/room-standards'),
      ]);
      setRooms(rms);
      setDepartments(depts);
      setStandards(stds);
      if (!rDeptId && depts.length > 0) setRDeptId(depts[0].id);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [deptFilter]);

  useEffect(() => {
    const onClusterSync = () => load();
    window.addEventListener('bedcare-cluster-sync', onClusterSync);
    return () => window.removeEventListener('bedcare-cluster-sync', onClusterSync);
  }, [deptFilter]);

  const openCreateRoom = () => {
    setEditingRoom(null);
    setRDeptId(deptFilter || departments[0]?.id || '');
    setRCode('');
    setRName('');
    setRFloor('Tầng 1');
    setRCapacity(2);
    setRToilet('INTERNAL');
    setRType('STANDARD');
    setRIsService(false);
    setRStandardIds([]);
    setRStatus('ACTIVE');
    setShowRoomForm(true);
  };

  const openEditRoom = (r: Room) => {
    setEditingRoom(r);
    setRDeptId(r.department_id);
    setRCode(r.code);
    setRName(r.name);
    setRFloor(r.floor);
    setRCapacity(r.capacity);
    setRToilet(r.toilet_type);
    setRType(r.room_type);
    setRIsService(Boolean(r.is_service));
    setRStandardIds(r.standard_ids || []);
    setRStatus(r.status);
    setShowRoomForm(true);
  };

  const toggleStandard = (id: string) => {
    setRStandardIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSaveRoom = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/rooms', {
        method: 'POST',
        body: JSON.stringify({
          id: editingRoom?.id,
          department_id: rDeptId,
          code: rCode,
          name: rName,
          floor: rFloor,
          capacity: Number(rCapacity),
          toilet_type: rToilet,
          room_type: rType,
          is_service: rIsService,
          standard_ids: rStandardIds,
          status: rStatus,
        }),
      });
      onNotify(editingRoom ? 'Đã cập nhật phòng bệnh.' : 'Đã thêm phòng bệnh và khởi tạo giường tự động.');
      setShowRoomForm(false);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleCreateStandard = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/room-standards', {
        method: 'POST',
        body: JSON.stringify({ name: stdName, code: stdCode, category: stdCat }),
      });
      onNotify('Đã thêm tiêu chuẩn phòng mới.');
      setStdName('');
      setStdCode('');
      setShowStdForm(false);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleDeleteRoom = async () => {
    if (!deleteTarget) return;
    try {
      await apiFetch(`/rooms/${deleteTarget.id}`, { method: 'DELETE' });
      onNotify('Đã xóa phòng bệnh.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
      setDeleteTarget(null);
    }
  };

  const stdMap = Object.fromEntries(standards.map((s) => [s.id, s.name]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Sơ đồ Phòng &amp; Tiêu chuẩn phòng</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Kết hợp linh hoạt tiêu chuẩn phòng (số giường, toilet trong/ngoài, dịch vụ) và theo dõi trạng thái bao trọn phòng.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {isDeptScoped ? (
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900">
              Phạm vi: {departments.find((d) => d.id === userDeptId)?.name || 'Khoa quản lý'}
            </div>
          ) : (
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              aria-label="Lọc theo khoa"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-sky-600 focus:outline-none"
            >
              <option value="">Tất cả khoa</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => setShowStdForm((v) => !v)}
                className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span>Tiêu chuẩn phòng</span>
              </button>
              <button
                type="button"
                onClick={openCreateRoom}
                className="flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
              >
                <Plus className="h-4 w-4" />
                <span>Thêm phòng</span>
              </button>
            </>
          )}
        </div>
      </div>

      {showStdForm && canEdit && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Danh mục tiêu chuẩn phòng động</h3>
            <button type="button" onClick={() => setShowStdForm(false)} className="text-xs text-slate-500 hover:text-slate-800">Đóng</button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-700 border-b border-slate-100 pb-4">
            {standards.map((s) => (
              <span key={s.id} className="font-medium">
                {s.name} <span className="text-xs font-mono text-slate-400">({s.code})</span>
              </span>
            ))}
          </div>
          <form onSubmit={handleCreateStandard} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tên tiêu chuẩn mới *</label>
              <input
                type="text"
                required
                value={stdName}
                onChange={(e) => setStdName(e.target.value)}
                placeholder="VD: Phòng cách ly áp lực âm"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mã tiêu chuẩn *</label>
              <input
                type="text"
                required
                value={stdCode}
                onChange={(e) => setStdCode(e.target.value)}
                placeholder="VD: ISO_NEG"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nhóm</label>
              <select
                value={stdCat}
                onChange={(e) => setStdCat(e.target.value as RoomStandard['category'])}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="CUSTOM">Tùy chỉnh</option>
                <option value="CAPACITY">Quy mô giường</option>
                <option value="TOILET">Toilet</option>
                <option value="SERVICE">Loại dịch vụ</option>
              </select>
            </div>
            <button type="submit" className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">
              Thêm tiêu chuẩn
            </button>
          </form>
        </div>
      )}

      {showRoomForm && canEdit && (
        <form onSubmit={handleSaveRoom} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <h3 className="text-base font-semibold text-slate-900">
            {editingRoom ? `Cập nhật phòng ${editingRoom.name}` : 'Khai báo phòng bệnh mới'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Khoa nội trú *</label>
              <select
                value={rDeptId}
                onChange={(e) => setRDeptId(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mã phòng *</label>
              <input
                type="text"
                required
                value={rCode}
                onChange={(e) => setRCode(e.target.value)}
                placeholder="VD: A104"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tên phòng *</label>
              <input
                type="text"
                required
                value={rName}
                onChange={(e) => setRName(e.target.value)}
                placeholder="VD: Phòng A104"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Số giường *</label>
              <input
                type="number"
                min={1}
                max={20}
                required
                value={rCapacity}
                onChange={(e) => setRCapacity(Number(e.target.value))}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tầng / Khu</label>
              <input
                type="text"
                value={rFloor}
                onChange={(e) => setRFloor(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Toilet</label>
              <select
                value={rToilet}
                onChange={(e) => setRToilet(e.target.value as 'INTERNAL' | 'EXTERNAL')}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="INTERNAL">Toilet trong</option>
                <option value="EXTERNAL">Toilet ngoài</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Loại phòng</label>
              <select
                value={rType}
                onChange={(e) => {
                  const val = e.target.value as Room['room_type'];
                  setRType(val);
                  setRIsService(val === 'SERVICE' || val === 'VIP');
                }}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="STANDARD">Phòng thường</option>
                <option value="SERVICE">Phòng dịch vụ</option>
                <option value="VIP">Phòng VIP</option>
                <option value="ISOLATION">Phòng cách ly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Trạng thái</label>
              <select
                value={rStatus}
                onChange={(e) => setRStatus(e.target.value as 'ACTIVE' | 'INACTIVE')}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="ACTIVE">Hoạt động</option>
                <option value="INACTIVE">Tạm ngừng</option>
              </select>
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-slate-700 mb-2">Kết hợp tiêu chuẩn phòng:</div>
            <div className="flex flex-wrap gap-2">
              {standards.map((s) => {
                const selected = rStandardIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleStandard(s.id)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? 'border-sky-600 bg-sky-50 text-sky-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowRoomForm(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700">
              Hủy
            </button>
            <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">
              Lưu phòng bệnh
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="h-48 rounded-lg border border-slate-200 bg-white animate-pulse" />
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Mã / Tên phòng</th>
                  <th className="px-4 py-3 text-left font-medium">Khoa</th>
                  <th className="px-4 py-3 text-left font-medium">Tiêu chuẩn kết hợp</th>
                  <th className="px-4 py-3 text-right font-medium">Số giường</th>
                  <th className="px-4 py-3 text-left font-medium">Trạng thái</th>
                  {canEdit && <th className="px-4 py-3 text-right font-medium">Thao tác</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rooms.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{r.name}</div>
                      <div className="text-xs font-mono text-slate-500">{r.code} · {r.floor}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{r.department_name}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {(r.standard_ids || []).map((id) => stdMap[id] || id).join(' · ') ||
                        `${r.capacity} giường · ${r.toilet_type === 'INTERNAL' ? 'Toilet trong' : 'Toilet ngoài'}`}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-slate-900">
                      {r.capacity}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={r.exclusive_locked ? 'font-semibold text-amber-700' : r.status === 'ACTIVE' ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                        {r.exclusive_locked ? 'Đang bao trọn phòng' : r.status === 'ACTIVE' ? 'Hoạt động' : 'Tạm ngừng'}
                      </span>
                    </td>
                    {canEdit && (
                      <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openEditRoom(r)}
                          className="text-xs font-medium text-sky-700 hover:underline"
                        >
                          Sửa
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(r)}
                          aria-label={`Xóa phòng ${r.name}`}
                          className="text-xs font-medium text-rose-600 hover:underline inline-flex items-center gap-0.5"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Xóa phòng bệnh"
        description={`Xác nhận xóa ${deleteTarget?.name}? Hệ thống chỉ cho phép xóa nếu phòng chưa có giường hoặc giao dịch lịch sử liên quan.`}
        danger
        confirmLabel="Xóa phòng"
        onConfirm={handleDeleteRoom}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

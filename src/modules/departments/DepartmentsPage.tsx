import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../services/api';
import type { Department, UserRole } from '../../types/bedcare';

interface DepartmentsPageProps {
  userRole: UserRole;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onSelectDepartment: (deptId: string) => void;
}

export function DepartmentsPage({ userRole, onNotify, onSelectDepartment }: DepartmentsPageProps) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Department | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');

  const canEdit = userRole === 'SUPER_ADMIN' || userRole === 'ADMIN';

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<Department[]>('/departments');
      setDepartments(data);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setCode('');
    setName('');
    setDescription('');
    setStatus('ACTIVE');
    setShowForm(true);
  };

  const openEdit = (d: Department) => {
    setEditing(d);
    setCode(d.code);
    setName(d.name);
    setDescription(d.description);
    setStatus(d.status);
    setShowForm(true);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/departments', {
        method: 'POST',
        body: JSON.stringify({ id: editing?.id, code, name, description, status }),
      });
      onNotify(editing ? 'Đã cập nhật khoa nội trú.' : 'Đã thêm khoa nội trú mới.');
      setShowForm(false);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Sơ đồ &amp; Quản lý Khoa nội trú</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Theo dõi số phòng, tổng giường, giường trống và công suất sử dụng theo từng khoa.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>Thêm khoa</span>
          </button>
        )}
      </div>

      {showForm && canEdit && (
        <form onSubmit={handleSave} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <h3 className="text-base font-semibold text-slate-900">
            {editing ? `Sửa khoa: ${editing.name}` : 'Thêm khoa nội trú mới'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mã khoa *</label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="VD: SANA"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tên khoa *</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: Khoa Sản A"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Trạng thái</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'INACTIVE')}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
              >
                <option value="ACTIVE">Đang hoạt động</option>
                <option value="INACTIVE">Ngừng hoạt động</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Mô tả chức năng</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800"
            >
              Lưu thông tin khoa
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="h-48 rounded-lg border border-slate-200 bg-white animate-pulse" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {departments.map((d) => (
            <div key={d.id} className="rounded-lg border border-slate-200 bg-white p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-mono text-slate-500">{d.code} · {d.status === 'ACTIVE' ? 'Hoạt động' : 'Ngừng hoạt động'}</div>
                    <h3 className="text-base font-semibold text-slate-900 mt-0.5">{d.name}</h3>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold font-mono tabular-nums text-sky-700">{d.occupancy_rate ?? 0}%</div>
                    <div className="text-[11px] text-slate-500">Công suất</div>
                  </div>
                </div>
                <p className="mt-2 text-sm text-slate-600">{d.description || 'Chưa có mô tả.'}</p>

                <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-4 gap-2 text-center">
                  <div>
                    <div className="text-xs text-slate-500">Phòng</div>
                    <div className="font-mono tabular-nums font-semibold text-slate-900">{d.total_rooms ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Tổng giường</div>
                    <div className="font-mono tabular-nums font-semibold text-slate-900">{d.total_beds ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Đang nằm</div>
                    <div className="font-mono tabular-nums font-semibold text-sky-700">{d.occupied_beds ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Còn trống</div>
                    <div className="font-mono tabular-nums font-semibold text-emerald-700">{d.vacant_beds ?? 0}</div>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => onSelectDepartment(d.id)}
                  className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Xem danh sách phòng
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => openEdit(d)}
                    className="rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
                  >
                    Chỉnh sửa
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

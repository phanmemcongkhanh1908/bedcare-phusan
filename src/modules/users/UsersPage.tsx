import { Edit3, KeyRound, Lock, Plus, Search, ShieldCheck, Trash2, Unlock, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../services/api';
import type { Department, HisPermissionLevel, UserAccount, UserRole } from '../../types/bedcare';
import { ROLE_LABELS } from '../../utils/formatters';
import { resolveEffectiveHisPermission } from '../../utils/hisAuditEngine';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_STAFF_RESET_PASSWORD,
  MIN_USER_PASSWORD_LENGTH,
  isDefaultAdminAccount,
} from '../../utils/userAccountRules';

interface UsersPageProps {
  currentUserId: string;
  currentUserRole: UserRole;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function UsersPage({ currentUserId, currentUserRole, onNotify }: UsersPageProps) {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'LOCKED'>('ALL');

  // Create / Edit form state
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<UserRole>('WARD_STAFF');
  const [deptId, setDeptId] = useState('');
  const [hisPermission, setHisPermission] = useState<HisPermissionLevel>('NONE');

  // Reset password modal state
  const [resetTarget, setResetTarget] = useState<UserAccount | null>(null);
  const [resetCustomPassword, setResetCustomPassword] = useState('');

  // Delete confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<UserAccount | null>(null);

  const load = async () => {
    try {
      const [us, depts] = await Promise.all([
        apiFetch<UserAccount[]>('/users'),
        apiFetch<Department[]>('/departments'),
      ]);
      setUsers(us);
      setDepartments(depts);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreateForm = () => {
    setEditingUser(null);
    setUsername('');
    setPassword('');
    setFullName('');
    setRole('WARD_STAFF');
    setDeptId('');
    setHisPermission('NONE');
    setShowForm(true);
  };

  const openEditForm = (u: UserAccount) => {
    setEditingUser(u);
    setUsername(u.username);
    setPassword('');
    setFullName(u.full_name);
    setRole(u.role);
    setDeptId(u.department_id || '');
    setHisPermission(resolveEffectiveHisPermission(u.role, u.his_permission));
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingUser(null);
    setUsername('');
    setPassword('');
    setFullName('');
    setDeptId('');
    setHisPermission('NONE');
  };

  const handleSaveUser = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const effectiveHisPerm: HisPermissionLevel =
        isDefaultAdminAccount(editingUser ?? { username }) || role === 'SUPER_ADMIN' || role === 'ADMIN'
          ? 'FULL'
          : hisPermission;

      if (editingUser) {
        await apiFetch(`/users/${editingUser.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            username: editingUser.username,
            full_name: fullName,
            role: isDefaultAdminAccount(editingUser) ? 'SUPER_ADMIN' : role,
            department_id: role === 'WARD_STAFF' ? deptId || null : null,
            his_permission: effectiveHisPerm,
            ...(password.trim() ? { password: password.trim() } : {}),
          }),
        });
        onNotify(`Đã cập nhật tài khoản ${editingUser.username} và đồng bộ qua P2P.`);
      } else {
        await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify({
            username: username.trim(),
            password,
            full_name: fullName.trim(),
            role,
            department_id: role === 'WARD_STAFF' ? deptId || null : null,
            his_permission: effectiveHisPerm,
          }),
        });
        onNotify(`Đã tạo tài khoản ${username.trim()} và đồng bộ tới các máy trạm.`);
      }
      closeForm();
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleStatusChange = async (u: UserAccount, status: 'ACTIVE' | 'LOCKED' | 'REVOKED') => {
    try {
      await apiFetch(`/users/${u.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      onNotify(
        status === 'LOCKED'
          ? `Đã khóa tài khoản ${u.username} và phát sự kiện đồng bộ.`
          : `Đã mở khóa tài khoản ${u.username} về trạng thái Hoạt động.`
      );
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleConfirmResetPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    try {
      const res = await apiFetch<{ ok: boolean; resetToDefault: boolean; defaultHint: string | null }>(
        `/users/${resetTarget.id}/reset-password`,
        {
          method: 'POST',
          body: JSON.stringify({
            new_password: resetCustomPassword.trim() || undefined,
          }),
        }
      );
      const hint = res.resetToDefault
        ? `mật khẩu mặc định "${res.defaultHint}"`
        : 'mật khẩu mới đã nhập';
      onNotify(`Đã reset mật khẩu cho tài khoản ${resetTarget.username} thành ${hint}.`);
      setResetTarget(null);
      setResetCustomPassword('');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiFetch(`/users/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      onNotify(`Đã xóa tài khoản ${deleteTarget.username} khỏi hệ thống.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const filteredUsers = users.filter((u) => {
    if (statusFilter !== 'ALL' && u.status !== statusFilter) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const hay = `${u.username} ${u.full_name} ${ROLE_LABELS[u.role]} ${u.department_name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const editingIsDefaultAdmin = editingUser ? isDefaultAdminAccount(editingUser) : false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Quản lý Tài khoản &amp; Phân quyền RBAC</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Tài khoản mặc định <span className="font-mono font-semibold text-slate-800">admin</span> luôn giữ quyền cao nhất (Super Admin) và được bảo vệ không thể xóa/khóa.
          </p>
        </div>
        <button
          type="button"
          onClick={() => (showForm && !editingUser ? closeForm() : openCreateForm())}
          className="flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>Tạo tài khoản</span>
        </button>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Tìm theo tên đăng nhập, họ tên hoặc khoa..."
            aria-label="Tìm kiếm tài khoản"
            className="w-full rounded-md border border-slate-300 bg-slate-50 pl-9 pr-3 py-1.5 text-sm focus:border-sky-600 focus:bg-white focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
          {[
            { id: 'ALL', label: `Tất cả (${users.length})` },
            { id: 'ACTIVE', label: `Hoạt động (${users.filter((u) => u.status === 'ACTIVE').length})` },
            { id: 'LOCKED', label: `Đã khóa (${users.filter((u) => u.status === 'LOCKED').length})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id as typeof statusFilter)}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                statusFilter === tab.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Create / Edit Form */}
      {showForm && (
        <form onSubmit={handleSaveUser} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-slate-900">
              {editingUser ? `Chỉnh sửa tài khoản: ${editingUser.username}` : 'Tạo tài khoản nhân viên mới'}
            </h3>
            <button type="button" onClick={closeForm} aria-label="Đóng biểu mẫu" className="text-slate-400 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tên đăng nhập *</label>
              <input
                type="text"
                required
                disabled={Boolean(editingUser)}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {editingUser ? `Mật khẩu mới (tùy chọn, ≥ ${MIN_USER_PASSWORD_LENGTH} ký tự)` : `Mật khẩu (tối thiểu ${MIN_USER_PASSWORD_LENGTH} ký tự) *`}
              </label>
              <input
                type="password"
                required={!editingUser}
                minLength={MIN_USER_PASSWORD_LENGTH}
                placeholder={editingUser ? 'Để trống nếu giữ nguyên' : ''}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Họ tên *</label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nhóm quyền *</label>
              <select
                value={editingIsDefaultAdmin ? 'SUPER_ADMIN' : role}
                disabled={editingIsDefaultAdmin}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500"
              >
                {(currentUserRole === 'SUPER_ADMIN' || editingIsDefaultAdmin) && (
                  <option value="SUPER_ADMIN">Super Admin</option>
                )}
                <option value="ADMIN">Admin hệ thống</option>
                <option value="CASHIER">Nhân viên thu viện phí</option>
                <option value="WARD_STAFF">Nhân viên khoa nội trú</option>
                <option value="EXECUTIVE">Lãnh đạo / Báo cáo</option>
              </select>
            </div>
            {role === 'WARD_STAFF' && !editingIsDefaultAdmin && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phạm vi khoa *</label>
                <select
                  value={deptId}
                  onChange={(e) => setDeptId(e.target.value)}
                  required
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">-- Chọn khoa --</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Quyền HIS &amp; Giám định BHYT</label>
              {editingIsDefaultAdmin || role === 'SUPER_ADMIN' || role === 'ADMIN' ? (
                <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800">
                  Toàn quyền HIS &amp; BHYT (Mặc định Admin)
                </div>
              ) : (
                <select
                  value={hisPermission}
                  onChange={(e) => setHisPermission(e.target.value as HisPermissionLevel)}
                  aria-label="Quyền HIS & Giám định BHYT"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
                >
                  <option value="NONE">Không cấp quyền (Ẩn HIS)</option>
                  <option value="VIEW">Chỉ xem đối soát HIS/BHYT</option>
                  <option value="SYNC_AND_MAP">Đồng bộ, Ánh xạ &amp; Xử lý cảnh báo</option>
                </select>
              )}
            </div>
          </div>
          {editingIsDefaultAdmin && (
            <p className="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-md px-3 py-2">
              Tài khoản <span className="font-mono font-semibold">admin</span> mặc định luôn giữ quyền cao nhất (Super Admin) và toàn quyền trên mọi khoa phòng.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeForm} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              Hủy
            </button>
            <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">
              {editingUser ? 'Cập nhật tài khoản' : 'Lưu tài khoản'}
            </button>
          </div>
        </form>
      )}

      {/* Users Table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">Tài khoản</th>
                <th className="px-3 py-2.5 text-left font-medium">Họ tên</th>
                <th className="px-3 py-2.5 text-left font-medium">Nhóm quyền</th>
                <th className="px-3 py-2.5 text-left font-medium">Phạm vi khoa</th>
                <th className="px-3 py-2.5 text-left font-medium">Quyền HIS / BHYT</th>
                <th className="px-3 py-2.5 text-left font-medium">Trạng thái</th>
                <th className="px-3 py-2.5 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Không có tài khoản nào khớp bộ lọc hiện tại.
                  </td>
                </tr>
              ) : filteredUsers.map((u) => {
                const isDefaultAdmin = Boolean(u.is_default_admin) || isDefaultAdminAccount(u);
                const isSelf = u.id === currentUserId;
                const adminCannotTouchSuper = currentUserRole === 'ADMIN' && u.role === 'SUPER_ADMIN';
                const canEdit = !adminCannotTouchSuper;
                const canReset = !adminCannotTouchSuper;
                const canToggleStatus = !isDefaultAdmin && !isSelf && !adminCannotTouchSuper;
                const canDelete = !isDefaultAdmin && !isSelf && !adminCannotTouchSuper;

                return (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs font-semibold text-slate-900">{u.username}</span>
                        {isDefaultAdmin && (
                          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-700 whitespace-nowrap">
                            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                            <span>Mặc định</span>
                          </span>
                        )}
                      </div>
                      {isSelf && (
                        <div className="text-[11px] text-slate-500 mt-0.5">Đang đăng nhập</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-900 text-xs sm:text-sm">{u.full_name}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">
                      <span>{ROLE_LABELS[u.role]}</span>
                      {isDefaultAdmin && (
                        <div className="text-[11px] font-medium text-sky-700">Quyền cao nhất</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">{u.department_name || 'Toàn viện'}</td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                      {(() => {
                        const effHis = resolveEffectiveHisPermission(u.role, u.his_permission);
                        if (effHis === 'FULL') {
                          return <span className="font-semibold text-sky-800">Toàn quyền (Admin)</span>;
                        }
                        if (effHis === 'SYNC_AND_MAP') {
                          return <span className="font-medium text-emerald-700">Đồng bộ &amp; Ánh xạ</span>;
                        }
                        if (effHis === 'VIEW') {
                          return <span className="font-medium text-slate-700">Chỉ xem đối soát</span>;
                        }
                        return <span className="text-slate-400">Không cấp quyền</span>;
                      })()}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-semibold whitespace-nowrap">
                      <span className={u.status === 'ACTIVE' ? 'text-emerald-700' : 'text-rose-700'}>
                        {u.status === 'ACTIVE' ? 'Hoạt động' : u.status === 'LOCKED' ? 'Đã khóa' : 'Thu hồi'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => openEditForm(u)}
                          aria-label={`Sửa tài khoản ${u.username}`}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Edit3 className="h-3 w-3" />
                          <span>Sửa</span>
                        </button>
                        <button
                          type="button"
                          disabled={!canReset}
                          onClick={() => {
                            setResetTarget(u);
                            setResetCustomPassword('');
                          }}
                          aria-label={`Reset mật khẩu ${u.username}`}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>Reset MK</span>
                        </button>
                        {u.status === 'ACTIVE' ? (
                          <button
                            type="button"
                            disabled={!canToggleStatus}
                            title={
                              isDefaultAdmin
                                ? 'Không thể khóa tài khoản admin mặc định'
                                : isSelf
                                  ? 'Không thể tự khóa tài khoản đang đăng nhập'
                                  : undefined
                            }
                            aria-label={`Khóa tài khoản ${u.username}`}
                            onClick={() => handleStatusChange(u, 'LOCKED')}
                            className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Lock className="h-3 w-3" />
                            <span>Khóa</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={!canToggleStatus}
                            aria-label={`Mở khóa tài khoản ${u.username}`}
                            onClick={() => handleStatusChange(u, 'ACTIVE')}
                            className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Unlock className="h-3 w-3" />
                            <span>Mở khóa</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!canDelete}
                          title={
                            isDefaultAdmin
                              ? 'Không được phép xóa tài khoản admin mặc định'
                              : isSelf
                                ? 'Không thể tự xóa tài khoản đang đăng nhập'
                                : undefined
                          }
                          aria-label={
                            isDefaultAdmin
                              ? 'Không thể xóa tài khoản admin mặc định'
                              : `Xóa tài khoản ${u.username}`
                          }
                          onClick={() => setDeleteTarget(u)}
                          className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>{isDefaultAdmin ? 'Được bảo vệ' : 'Xóa'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reset Password Modal */}
      {resetTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 no-print"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-pw-title"
        >
          <form
            onSubmit={handleConfirmResetPassword}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl p-6 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="reset-pw-title" className="text-base font-semibold text-slate-900">
                  Reset mật khẩu tài khoản {resetTarget.username}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{resetTarget.full_name}</p>
              </div>
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                aria-label="Đóng hộp thoại reset mật khẩu"
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Mật khẩu mới (để trống để reset về mặc định:{' '}
                <span className="font-mono font-semibold text-sky-700">
                  {isDefaultAdminAccount(resetTarget) ? DEFAULT_ADMIN_PASSWORD : DEFAULT_STAFF_RESET_PASSWORD}
                </span>
                )
              </label>
              <input
                type="password"
                minLength={MIN_USER_PASSWORD_LENGTH}
                value={resetCustomPassword}
                onChange={(e) => setResetCustomPassword(e.target.value)}
                placeholder={`Để trống = "${isDefaultAdminAccount(resetTarget) ? DEFAULT_ADMIN_PASSWORD : DEFAULT_STAFF_RESET_PASSWORD}"`}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800"
              >
                Xác nhận Reset mật khẩu
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 no-print"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-user-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl p-6 space-y-4">
            <h3 id="delete-user-title" className="text-base font-semibold text-slate-900">
              Xác nhận xóa tài khoản {deleteTarget.username}?
            </h3>
            <p className="text-sm text-slate-600">
              Tài khoản <span className="font-semibold text-slate-900">{deleteTarget.full_name}</span> ({ROLE_LABELS[deleteTarget.role]}) sẽ bị xóa khỏi toàn cụm máy trạm P2P. Lịch sử kiểm toán trước đó vẫn được lưu giữ.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-800"
              >
                Xóa tài khoản
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { BedDouble, Eye, EyeOff, Lock, ShieldCheck, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { PWAInstallButton } from '../../components/PWAInstallButton';
import { apiFetch, setAuthToken } from '../../services/api';
import type { HisPermissionLevel, UserRole } from '../../types/bedcare';

interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    full_name: string;
    role: UserRole;
    department_id: string | null;
    his_permission?: HisPermissionLevel;
  };
  activeNode: {
    deviceId: string;
    nodeName: string;
    isCoordinator: boolean;
  };
}

interface LoginScreenProps {
  onSuccess: (data: LoginResponse) => void;
  onOpenCustomerPortal?: () => void;
}

export function LoginScreen({ onSuccess, onOpenCustomerPortal }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setAuthToken(res.token);
      onSuccess(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-6 sm:py-12">
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-12 rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="md:col-span-5 bg-sky-900 text-white p-6 sm:p-8 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xl font-bold tracking-tight">BEDCARE</div>
              <span className="text-[11px] font-medium text-sky-200 border border-sky-700 rounded px-2 py-0.5">
                Mobile &amp; Desktop
              </span>
            </div>
            <h1 className="mt-4 sm:mt-6 text-xl sm:text-2xl font-semibold leading-snug text-balance">
              Quản lý Giường bệnh &amp; Phòng bệnh Bệnh viện
            </h1>
            <p className="mt-2.5 text-xs sm:text-sm leading-relaxed text-sky-100">
              Điều phối giường trống thời gian thực trên máy trạm và điện thoại di động, lưu trữ SQLite an toàn cùng đồng thuận P2P chống cấp trùng giường.
            </p>
          </div>
          <div className="mt-6 pt-4 sm:mt-8 sm:pt-6 border-t border-sky-800 space-y-2 text-xs text-sky-200">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-teal-300 shrink-0" />
              <span>Chữ ký số Ed25519 &amp; đồng thuận Raft Quorum</span>
            </div>
            <div>Sao lưu mã hóa AES-256-GCM · Hỗ trợ cài đặt PWA miễn phí</div>
          </div>
        </div>

        <div className="md:col-span-7 p-6 sm:p-8 flex flex-col justify-center">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Đăng nhập hệ thống</h2>
              <p className="mt-1 text-sm text-slate-500">
                Nhập tài khoản nhân viên được cấp để truy cập BEDCARE.
              </p>
            </div>
            <PWAInstallButton compact />
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {error && (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="login-username" className="block text-sm font-medium text-slate-700">
                Tên đăng nhập
              </label>
              <div className="mt-1.5 relative">
                <User className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="login-username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Nhập tên đăng nhập"
                  className="w-full min-h-[44px] rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
                Mật khẩu
              </label>
              <div className="mt-1.5 relative">
                <Lock className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Nhập mật khẩu"
                  className="w-full min-h-[44px] rounded-lg border border-slate-300 pl-9 pr-11 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-md text-slate-400 hover:text-slate-700"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[46px] rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-800 transition-colors disabled:opacity-60"
            >
              {loading ? 'Đang xác thực...' : 'Đăng nhập'}
            </button>
          </form>

          {onOpenCustomerPortal && (
            <div className="mt-5 rounded-lg border border-sky-200 bg-sky-50/70 p-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-sky-950">
                <div className="font-semibold">Dành cho Bệnh nhân &amp; Người nhà</div>
                <div className="text-sky-800 mt-0.5">Xem danh sách phòng trống &amp; gửi yêu cầu đặt giường trước</div>
              </div>
              <button
                type="button"
                onClick={onOpenCustomerPortal}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-md border border-sky-700 bg-white px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 whitespace-nowrap"
              >
                <BedDouble className="h-3.5 w-3.5" />
                <span>Cổng Đặt giường Khách hàng</span>
              </button>
            </div>
          )}

          <p className="mt-5 pt-4 border-t border-slate-100 text-xs text-slate-500">
            Bảo mật phiên làm việc theo phân quyền RBAC. Liên hệ Quản trị viên hệ thống nếu cần cấp mới hoặc khôi phục mật khẩu tài khoản.
          </p>
        </div>
      </div>
    </div>
  );
}

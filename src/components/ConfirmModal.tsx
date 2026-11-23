import { AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { matchesConfirmPhrase } from '../utils/databaseSafety';

interface ConfirmImpactItem {
  label: string;
  value: string | number;
}

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  impactItems?: ConfirmImpactItem[];
  autoBackupNote?: string;
  requireConfirmPhrase?: string;
  confirmInput?: string;
  onConfirmInputChange?: (val: string) => void;
  requirePassword?: boolean;
  passwordValue?: string;
  onPasswordChange?: (val: string) => void;
  errorMessage?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Hủy bỏ',
  danger = false,
  busy = false,
  impactItems,
  autoBackupNote,
  requireConfirmPhrase,
  confirmInput = '',
  onConfirmInputChange,
  requirePassword = false,
  passwordValue = '',
  onPasswordChange,
  errorMessage,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  const phraseSatisfied = !requireConfirmPhrase || matchesConfirmPhrase(confirmInput, requireConfirmPhrase);
  const passwordSatisfied = !requirePassword || passwordValue.trim().length > 0;
  const canConfirm = !busy && phraseSatisfied && passwordSatisfied;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle
              className={`h-5 w-5 shrink-0 ${danger ? 'text-rose-600' : 'text-amber-600'}`}
            />
            <h3 id="confirm-modal-title" className="text-base font-semibold text-slate-900">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Đóng hộp thoại"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-slate-700">{description}</p>

        {impactItems && impactItems.length > 0 && (
          <div className="mt-3.5 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold text-slate-700 mb-2">
              Phạm vi dữ liệu hiện có sẽ bị tác động:
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {impactItems.map((item) => (
                <div key={item.label} className="rounded border border-slate-200 bg-white px-2.5 py-1.5">
                  <div className="text-[11px] text-slate-500">{item.label}</div>
                  <div className="font-mono tabular-nums text-sm font-bold text-slate-900">{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {autoBackupNote && (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 flex items-start gap-2 text-xs text-emerald-900">
            <ShieldCheck className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
            <span>{autoBackupNote}</span>
          </div>
        )}

        {(requireConfirmPhrase || requirePassword) && (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-3.5">
            {requireConfirmPhrase && (
              <div>
                <label htmlFor="confirm-phrase-input" className="block text-xs font-medium text-slate-700 mb-1">
                  Nhập chính xác cụm từ xác nhận:{' '}
                  <span className="font-mono font-bold text-rose-700 select-all">{requireConfirmPhrase}</span>
                </label>
                <input
                  id="confirm-phrase-input"
                  type="text"
                  value={confirmInput}
                  onChange={(e) => onConfirmInputChange?.(e.target.value)}
                  placeholder={requireConfirmPhrase}
                  autoComplete="off"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase focus:border-sky-600 focus:outline-none"
                />
              </div>
            )}

            {requirePassword && (
              <div>
                <label htmlFor="confirm-password-input" className="block text-xs font-medium text-slate-700 mb-1">
                  Nhập mật khẩu tài khoản quản trị hiện tại để xác thực *
                </label>
                <input
                  id="confirm-password-input"
                  type="password"
                  value={passwordValue}
                  onChange={(e) => onPasswordChange?.(e.target.value)}
                  placeholder="Nhập mật khẩu đăng nhập của bạn..."
                  autoComplete="current-password"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
                />
              </div>
            )}
          </div>
        )}

        {errorMessage && (
          <div role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800">
            {errorMessage}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            data-testid="confirm-modal-submit"
            className={`rounded-md px-4 py-2 text-sm font-medium text-white whitespace-nowrap disabled:opacity-50 ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-sky-700 hover:bg-sky-800'
            }`}
          >
            {busy ? 'Đang xử lý...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

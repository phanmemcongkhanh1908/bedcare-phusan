import { Download, Smartphone, X } from 'lucide-react';
import { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export function PWAInstallButton({ compact = false }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        title="Cài ứng dụng lên màn hình chính (miễn phí)"
        className="inline-flex items-center gap-1.5 rounded-md border border-teal-200 bg-teal-50 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100 whitespace-nowrap min-h-[36px]"
      >
        <Download className="h-3.5 w-3.5 text-teal-700 shrink-0" />
        <span className={compact ? 'hidden sm:inline' : ''}>Cài lên điện thoại</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          title="Hướng dẫn cài lên iPhone / iPad"
          className="inline-flex items-center gap-1.5 rounded-md border border-teal-200 bg-teal-50 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100 whitespace-nowrap min-h-[36px]"
        >
          <Smartphone className="h-3.5 w-3.5 text-teal-700 shrink-0" />
          <span className={compact ? 'hidden sm:inline' : ''}>Cài trên iPhone</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true">
            <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-900">Cài BEDCARE lên Màn hình chính</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Đóng hướng dẫn"
                  className="text-slate-400 hover:text-slate-700"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <ol className="text-sm text-slate-600 space-y-2 list-decimal pl-4">
                <li>Mở trang web bằng trình duyệt <strong>Safari</strong>.</li>
                <li>Nhấn biểu tượng <strong>Chia sẻ (Share)</strong> ở thanh công cụ dưới cùng.</li>
                <li>Chọn <strong>Thêm vào Màn hình chính (Add to Home Screen)</strong> để mở toàn màn hình như app di động.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full rounded-md bg-sky-700 py-2.5 text-sm font-semibold text-white hover:bg-sky-800"
              >
                Đã hiểu
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}

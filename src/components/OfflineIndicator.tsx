import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="no-print fixed bottom-20 lg:bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 shadow-md"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-700 shrink-0" />
      <span>Mất kết nối mạng — Đang hiển thị dữ liệu đệm PWA</span>
    </div>
  );
}

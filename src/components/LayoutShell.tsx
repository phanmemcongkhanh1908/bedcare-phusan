import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  BedDouble,
  Bell,
  Building2,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Clock,
  DatabaseBackup,
  DoorOpen,
  HardDrive,
  HelpCircle,
  Link2,
  LogOut,
  Menu,
  Network,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { HisPermissionLevel, UserRole } from '../types/bedcare';
import { ROLE_LABELS } from '../utils/formatters';
import { canViewHisModule } from '../utils/hisAuditEngine';
import { OfflineIndicator } from './OfflineIndicator';
import { PWAInstallButton } from './PWAInstallButton';

export type RealtimeSyncStatus = 'SYNCING' | 'SYNCED' | 'OFFLINE';

export type ScreenId =
  | 'dashboard'
  | 'departments'
  | 'rooms'
  | 'beds'
  | 'registrations'
  | 'reservations'
  | 'waitlist'
  | 'inpatients'
  | 'admissions'
  | 'extensions'
  | 'transfers'
  | 'discharge'
  | 'cleaning'
  | 'alerts'
  | 'reports'
  | 'his'
  | 'users'
  | 'devices'
  | 'sync'
  | 'backup'
  | 'settings';

export interface NavItem {
  id: ScreenId;
  label: string;
  group: string;
  roles: UserRole[];
  icon: typeof Activity;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Tổng quan công suất', group: 'Điều phối Giường bệnh', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: Activity },
  { id: 'beds', label: 'Sơ đồ giường bệnh', group: 'Điều phối Giường bệnh', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: BedDouble },
  { id: 'alerts', label: 'Cảnh báo & Nhắc việc', group: 'Điều phối Giường bệnh', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: Bell },
  { id: 'cleaning', label: 'Vệ sinh giường', group: 'Điều phối Giường bệnh', roles: ['SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'], icon: Sparkles },

  { id: 'registrations', label: 'Đăng ký trước', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'], icon: ClipboardList },
  { id: 'reservations', label: 'Giữ chỗ giường/phòng', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'], icon: CalendarClock },
  { id: 'waitlist', label: 'Danh sách chờ giường', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'], icon: Clock },
  { id: 'admissions', label: 'Tiếp nhận', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'], icon: UserCheck },
  { id: 'inpatients', label: 'Bệnh nhân đang nằm', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: Users },
  { id: 'extensions', label: 'Gia hạn ngày giường', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'], icon: ClipboardCheck },
  { id: 'transfers', label: 'Điều chuyển giường', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'], icon: ArrowLeftRight },
  { id: 'discharge', label: 'Xuất viện', group: 'Theo dõi Bệnh nhân', roles: ['SUPER_ADMIN', 'ADMIN', 'WARD_STAFF'], icon: LogOut },

  { id: 'reports', label: 'Báo cáo & Thống kê', group: 'Hồ sơ Y tế & Báo cáo', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: BarChart3 },
  { id: 'his', label: 'Kết nối HIS & BHYT', group: 'Hồ sơ Y tế & Báo cáo', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: Link2 },
  { id: 'departments', label: 'Tổng hợp theo Khoa', group: 'Hồ sơ Y tế & Báo cáo', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: Building2 },
  { id: 'rooms', label: 'Tổng hợp theo Phòng', group: 'Hồ sơ Y tế & Báo cáo', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF', 'EXECUTIVE'], icon: DoorOpen },

  { id: 'settings', label: 'Danh mục Quản trị', group: 'Quản trị Hệ thống', roles: ['SUPER_ADMIN', 'ADMIN'], icon: Settings },
  { id: 'users', label: 'Tài khoản & Phân quyền', group: 'Quản trị Hệ thống', roles: ['SUPER_ADMIN', 'ADMIN'], icon: Users },
  { id: 'devices', label: 'Quản lý thiết bị P2P', group: 'Quản trị Hệ thống', roles: ['SUPER_ADMIN', 'ADMIN'], icon: HardDrive },
  { id: 'sync', label: 'Đồng bộ & Đồng thuận', group: 'Quản trị Hệ thống', roles: ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'WARD_STAFF'], icon: Network },
  { id: 'backup', label: 'Sao lưu & Phục hồi', group: 'Quản trị Hệ thống', roles: ['SUPER_ADMIN', 'ADMIN'], icon: DatabaseBackup },
];

interface LayoutShellProps {
  activeScreen: ScreenId;
  onNavigate: (id: ScreenId) => void;
  user: { full_name: string; username: string; role: UserRole; department_id?: string | null; his_permission?: HisPermissionLevel };
  activeNodeName: string;
  activeNodeId: string;
  alertCount: number;
  globalSearch: string;
  onGlobalSearchChange: (v: string) => void;
  syncStatus?: RealtimeSyncStatus;
  pendingOfflineCount?: number;
  lastSyncAt?: string | null;
  onOpenHelp?: () => void;
  onLogout: () => void;
  children: ReactNode;
}

export function LayoutShell({
  activeScreen,
  onNavigate,
  user,
  activeNodeName,
  activeNodeId,
  alertCount,
  globalSearch,
  onGlobalSearchChange,
  syncStatus = 'SYNCED',
  pendingOfflineCount = 0,
  lastSyncAt,
  onOpenHelp,
  onLogout,
  children,
}: LayoutShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const canOpenSyncScreen = allowedItemsCheck(user.role);
  function allowedItemsCheck(r: UserRole) {
    return r !== 'EXECUTIVE';
  }

  const allowedItems = NAV_ITEMS.filter((item) => {
    if (!item.roles.includes(user.role)) return false;
    if (item.id === 'his') return canViewHisModule(user.role, user.his_permission);
    return true;
  });
  const groups = Array.from(new Set(allowedItems.map((i) => i.group)));
  const currentItem = NAV_ITEMS.find((i) => i.id === activeScreen);

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    'Điều phối Giường bệnh': true,
    'Theo dõi Bệnh nhân': true,
    'Hồ sơ Y tế & Báo cáo': false,
    'Quản trị Hệ thống': true,
  });

  useEffect(() => {
    if (currentItem?.group) {
      setExpandedGroups((prev) => ({ ...prev, [currentItem.group]: true }));
    }
  }, [currentItem?.group]);

  const toggleGroup = (grp: string) => {
    setExpandedGroups((prev) => ({ ...prev, [grp]: !prev[grp] }));
  };

  // Role-aware mobile bottom quick navigation (4 or 5 high-frequency items)
  const mobileQuickItems = (
    user.role === 'CASHIER'
      ? [
          { id: 'dashboard' as ScreenId, label: 'Điều phối', icon: Activity },
          { id: 'registrations' as ScreenId, label: 'Đăng ký', icon: ClipboardList },
          { id: 'reservations' as ScreenId, label: 'Giữ chỗ', icon: CalendarClock },
          { id: 'beds' as ScreenId, label: 'Sơ đồ', icon: BedDouble },
        ]
      : user.role === 'EXECUTIVE'
        ? [
            { id: 'dashboard' as ScreenId, label: 'Điều phối', icon: Activity },
            { id: 'beds' as ScreenId, label: 'Sơ đồ', icon: BedDouble },
            { id: 'inpatients' as ScreenId, label: 'Đang nằm', icon: Users },
            { id: 'reports' as ScreenId, label: 'Báo cáo', icon: BarChart3 },
          ]
        : [
            { id: 'dashboard' as ScreenId, label: 'Điều phối', icon: Activity },
            { id: 'beds' as ScreenId, label: 'Sơ đồ', icon: BedDouble },
            { id: 'registrations' as ScreenId, label: 'Đăng ký', icon: ClipboardList },
            { id: 'inpatients' as ScreenId, label: 'Đang nằm', icon: Users },
            { id: 'transfers' as ScreenId, label: 'Chuyển', icon: ArrowLeftRight },
          ]
  ).filter((item) => allowedItems.some((a) => a.id === item.id));

  const sidebarContent = (
    <div className="flex h-full flex-col bg-white border-r border-slate-200">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
        <div>
          <span className="text-lg font-bold tracking-tight text-sky-800 whitespace-nowrap">
            BEDCARE
          </span>
          <p className="text-xs text-slate-500 mt-0.5 truncate max-w-[190px]">
            {activeNodeName}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="Đóng thanh điều hướng"
          className="lg:hidden rounded p-1.5 text-slate-500 hover:bg-slate-100"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-2.5" aria-label="Điều hướng chính">
        {groups.map((grp) => {
          const itemsInGroup = allowedItems.filter((i) => i.group === grp);
          const isOpen = expandedGroups[grp] ?? true;
          const hasActive = itemsInGroup.some((i) => i.id === activeScreen);
          return (
            <div key={grp} className="rounded-lg border border-slate-100 bg-slate-50/40 p-1">
              <button
                type="button"
                onClick={() => toggleGroup(grp)}
                aria-expanded={isOpen}
                className={`w-full flex items-center justify-between px-2.5 py-2 text-left text-xs font-semibold rounded-md transition-colors ${
                  hasActive ? 'text-sky-800' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span className="truncate">{grp}</span>
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                )}
              </button>
              {isOpen && (
                <div className="mt-0.5 space-y-0.5">
                  {itemsInGroup.map((item) => {
                    const Icon = item.icon;
                    const active = item.id === activeScreen;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          onNavigate(item.id);
                          setMobileOpen(false);
                        }}
                        className={`w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium transition-colors ${
                          active
                            ? 'bg-sky-100/80 text-sky-900'
                            : 'text-slate-700 hover:bg-white hover:text-slate-900'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <Icon
                            className={`h-4 w-4 shrink-0 ${
                              active ? 'text-sky-700' : 'text-slate-400'
                            }`}
                          />
                          <span className="truncate">{item.label}</span>
                        </span>
                        {item.id === 'alerts' && alertCount > 0 && (
                          <span className="font-mono tabular-nums text-xs font-semibold text-rose-700">
                            {alertCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-slate-200 p-4 space-y-2.5">
        <div className="text-xs text-slate-500 space-y-0.5">
          <div className="font-semibold text-slate-800 truncate">{user.full_name}</div>
          <div className="truncate">{ROLE_LABELS[user.role]}</div>
          <div className="font-mono text-[11px] text-slate-400 truncate">{activeNodeId}</div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>Đăng xuất</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-[272px] shrink-0 sticky top-0 h-screen no-print">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-[276px] max-w-[85vw] h-full z-10">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white px-4 lg:px-8 py-3 no-print">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-label="Mở menu điều hướng"
                className="lg:hidden rounded-md p-2 text-slate-600 hover:bg-slate-100 min-h-[40px] min-w-[40px] flex items-center justify-center"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-2 text-sm min-w-0">
                <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
                  {currentItem?.group}
                </span>
                <span className="text-slate-300 hidden sm:inline">/</span>
                <h1 className="text-base font-semibold text-slate-900 truncate">
                  {currentItem?.label || 'BEDCARE'}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
              <div className="relative hidden sm:block">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={globalSearch}
                  onChange={(e) => onGlobalSearchChange(e.target.value)}
                  placeholder="Tìm BN, mã giường, phòng..."
                  aria-label="Tìm kiếm nhanh toàn hệ thống"
                  className="w-48 md:w-56 lg:w-72 rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-sky-600 focus:bg-white focus:outline-none"
                />
              </div>

              <PWAInstallButton compact />

              <button
                type="button"
                onClick={() => canOpenSyncScreen && onNavigate('sync')}
                disabled={!canOpenSyncScreen}
                title={
                  lastSyncAt
                    ? `Cập nhật gần nhất: ${new Date(lastSyncAt).toLocaleTimeString('vi-VN')}${pendingOfflineCount > 0 ? ` · ${pendingOfflineCount} thao tác chờ phát` : ''}`
                    : 'Trạng thái đồng bộ thời gian thực WebSocket liên khoa'
                }
                aria-label={
                  syncStatus === 'OFFLINE'
                    ? 'Trạng thái mạng: Ngoại tuyến'
                    : syncStatus === 'SYNCING'
                      ? 'Trạng thái mạng: Đang đồng bộ'
                      : 'Trạng thái mạng: Đã đồng bộ'
                }
                data-testid="navbar-sync-indicator"
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap min-h-[40px] transition-colors ${
                  syncStatus === 'OFFLINE'
                    ? 'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100'
                    : syncStatus === 'SYNCING'
                      ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                } ${!canOpenSyncScreen ? 'cursor-default' : ''}`}
              >
                {syncStatus === 'OFFLINE' ? (
                  <WifiOff className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                ) : syncStatus === 'SYNCING' ? (
                  <RefreshCw className="h-3.5 w-3.5 text-amber-600 animate-spin shrink-0" />
                ) : (
                  <Wifi className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                )}
                <span>
                  {syncStatus === 'OFFLINE'
                    ? 'Ngoại tuyến'
                    : syncStatus === 'SYNCING'
                      ? 'Đang đồng bộ'
                      : 'Đã đồng bộ'}
                </span>
                {pendingOfflineCount > 0 && (
                  <span className="font-mono tabular-nums font-bold text-amber-800">
                    ({pendingOfflineCount})
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => onNavigate('alerts')}
                aria-label={`Xem cảnh báo (${alertCount})`}
                className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap min-h-[40px]"
              >
                <Bell className={`h-3.5 w-3.5 ${alertCount > 0 ? 'text-rose-600' : 'text-slate-500'}`} />
                <span className="hidden sm:inline">Cảnh báo</span>
                <span className="font-mono tabular-nums font-semibold text-slate-900">
                  {alertCount}
                </span>
              </button>

              {onOpenHelp && (
                <button
                  type="button"
                  onClick={onOpenHelp}
                  aria-label="Mở Trung tâm Hướng dẫn"
                  className="flex items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 sm:px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100 whitespace-nowrap min-h-[40px]"
                >
                  <HelpCircle className="h-3.5 w-3.5 text-sky-700" />
                  <span className="hidden sm:inline">Hướng dẫn</span>
                </button>
              )}
            </div>
          </div>

          {/* Mobile inline search bar */}
          <div className="mt-2 sm:hidden relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={globalSearch}
              onChange={(e) => onGlobalSearchChange(e.target.value)}
              placeholder="Tìm BN, mã giường, phòng..."
              aria-label="Tìm kiếm nhanh trên di động"
              className="w-full min-h-[40px] rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-sky-600 focus:bg-white focus:outline-none"
            />
          </div>
        </header>

        <main className="flex-1 p-3.5 sm:p-5 lg:p-8 pb-24 lg:pb-8 max-w-[1440px] w-full mx-auto">
          {children}
        </main>

        <OfflineIndicator />

        {/* Mobile & Tablet Role-Aware Quick Coordinator Bottom Bar */}
        <nav
          aria-label="Điều hướng nhanh trên di động"
          style={{
            gridTemplateColumns: `repeat(${Math.max(mobileQuickItems.length, 1)}, minmax(0, 1fr))`,
          }}
          className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur px-1.5 py-1 grid gap-1 no-print shadow-[0_-2px_10px_rgba(15,23,42,0.06)]"
        >
          {mobileQuickItems.map((item) => {
            const Icon = item.icon;
            const active = activeScreen === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`flex flex-col items-center justify-center rounded-md py-1 px-1 min-h-[48px] text-[10px] font-medium transition-colors ${
                  active ? 'bg-sky-50 text-sky-800 font-semibold' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Icon className={`h-4 w-4 mb-0.5 ${active ? 'text-sky-700' : 'text-slate-400'}`} />
                <span className="truncate max-w-full">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

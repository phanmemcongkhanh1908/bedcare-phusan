import { AlertTriangle, CheckCircle2, RefreshCw, Server, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HelpCenter } from './components/HelpCenter';
import { LayoutShell, type RealtimeSyncStatus, type ScreenId } from './components/LayoutShell';
import { AdmissionsPage } from './modules/admissions/AdmissionsPage';
import { AlertsPage } from './modules/alerts/AlertsPage';
import { LoginScreen } from './modules/auth/LoginScreen';
import { BackupRestorePage } from './modules/backup/BackupRestorePage';
import { BedsMapPage } from './modules/beds/BedsMapPage';
import { CleaningPage } from './modules/cleaning/CleaningPage';
import { DashboardPage, type DashboardOverviewData } from './modules/dashboard/DashboardPage';
import { DepartmentsPage } from './modules/departments/DepartmentsPage';
import { DevicesPage } from './modules/devices/DevicesPage';
import { DischargePage } from './modules/discharge/DischargePage';
import { ExtensionsPage } from './modules/extensions/ExtensionsPage';
import { HisIntegrationPage } from './modules/his/HisIntegrationPage';
import { InpatientsPage } from './modules/patients/InpatientsPage';
import { CustomerPortalPage } from './modules/portal/CustomerPortalPage';
import { RegistrationsPage } from './modules/registrations/RegistrationsPage';
import { ReportsPage } from './modules/reports/ReportsPage';
import { ReservationsPage } from './modules/reservations/ReservationsPage';
import { RoomsPage } from './modules/rooms/RoomsPage';
import { SettingsPage } from './modules/settings/SettingsPage';
import { SyncConsensusPage } from './modules/sync/SyncConsensusPage';
import { TransfersPage } from './modules/transfers/TransfersPage';
import { UsersPage } from './modules/users/UsersPage';
import { WaitlistPage } from './modules/waitlist/WaitlistPage';
import { apiFetch, getAuthToken, setAuthToken } from './services/api';
import type { HisPermissionLevel, UserRole } from './types/bedcare';
import { canViewHisModule } from './utils/hisAuditEngine';
import {
  clearServiceOutage,
  computeWsReconnectDelayMs,
  getServiceOutageState,
  isServiceInOutageCooldown,
  SERVICE_STATUS_EVENT,
  setActiveFailoverMode,
  type ServiceOutageState,
} from './utils/networkResilience';
import { flushOfflineQueue, getOfflineQueue, OFFLINE_QUEUE_EVENT } from './utils/offlineQueue';

interface AuthSession {
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

interface QrDeepLinkTarget {
  bedId?: string;
  admissionId?: string;
}

const HIGH_CONTRAST_STORAGE_KEY = 'bedcare_high_contrast';
export const HIGH_CONTRAST_EVENT = 'bedcare-high-contrast-changed';
export const CLUSTER_SYNC_EVENT = 'bedcare-cluster-sync';

function readInitialUrlParams(): {
  portalMode: boolean;
  qrTarget: QrDeepLinkTarget | null;
} {
  if (typeof window === 'undefined') {
    return { portalMode: false, qrTarget: null };
  }
  const params = new URLSearchParams(window.location.search);
  const portalMode = params.get('portal') === 'customer';
  const bedId = params.get('bed')?.trim() || undefined;
  const admissionId = params.get('admission')?.trim() || undefined;
  return {
    portalMode,
    qrTarget: bedId || admissionId ? { bedId, admissionId } : null,
  };
}

export default function App() {
  const [initialUrl] = useState(() => readInitialUrlParams());
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [portalMode, setPortalMode] = useState<boolean>(initialUrl.portalMode);
  const [pendingQrTarget, setPendingQrTarget] = useState<QrDeepLinkTarget | null>(initialUrl.qrTarget);
  const [qrBedId, setQrBedId] = useState<string>('');
  const [qrAdmissionId, setQrAdmissionId] = useState<string>('');

  const [activeScreen, setActiveScreen] = useState<ScreenId>('dashboard');
  const [overview, setOverview] = useState<DashboardOverviewData | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [selectedDeptFilter, setSelectedDeptFilter] = useState('');
  const [selectedBedStatusFilter, setSelectedBedStatusFilter] = useState<string>('');
  const [preselectedTransferAdmId, setPreselectedTransferAdmId] = useState<string>('');
  const [preselectedAdmissionRegId, setPreselectedAdmissionRegId] = useState<string>('');
  const [preselectedReservationRegId, setPreselectedReservationRegId] = useState<string>('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [syncStatus, setSyncStatus] = useState<RealtimeSyncStatus>(
    typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'SYNCING'
  );
  const [pendingOfflineCount, setPendingOfflineCount] = useState<number>(() => getOfflineQueue().length);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceOutageState>(() => getServiceOutageState());
  const [manualReconnectSeq, setManualReconnectSeq] = useState(0);
  const lastOverviewFetchAtRef = useRef<number>(0);

  // Boot & sync High Contrast Mode CSS class on <html>
  useEffect(() => {
    const syncContrast = () => {
      const enabled = localStorage.getItem(HIGH_CONTRAST_STORAGE_KEY) === 'true';
      document.documentElement.classList.toggle('high-contrast', enabled);
    };
    syncContrast();
    window.addEventListener(HIGH_CONTRAST_EVENT, syncContrast);
    return () => window.removeEventListener(HIGH_CONTRAST_EVENT, syncContrast);
  }, []);

  // Track Render/Server outage & failover mode reactively
  useEffect(() => {
    const onServiceStatus = () => setServiceStatus(getServiceOutageState());
    window.addEventListener(SERVICE_STATUS_EVENT, onServiceStatus);
    return () => window.removeEventListener(SERVICE_STATUS_EVENT, onServiceStatus);
  }, []);

  // Track offline pending action queue length reactively
  useEffect(() => {
    const updateCount = () => setPendingOfflineCount(getOfflineQueue().length);
    updateCount();
    window.addEventListener(OFFLINE_QUEUE_EVENT, updateCount);
    window.addEventListener('storage', updateCount);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, updateCount);
      window.removeEventListener('storage', updateCount);
    };
  }, []);

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 5000);
  }, []);

  const loadOverview = useCallback(async (force = false) => {
    setLoadingOverview(true);
    try {
      const data = await apiFetch<DashboardOverviewData>(
        '/dashboard/overview',
        force ? { bypassOutageCooldown: true } : {}
      );
      setOverview(data);
      lastOverviewFetchAtRef.current = Date.now();
      setLastSyncAt(new Date().toISOString());
    } catch {
      // Ignore if logged out or network temporarily down
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const checkAuth = useCallback(async () => {
    const token = getAuthToken();
    if (!token) {
      setCheckingAuth(false);
      return;
    }
    try {
      const me = await apiFetch<AuthSession>('/auth/me');
      setSession(me);
      await loadOverview();
    } catch {
      setAuthToken(null);
      setSession(null);
    } finally {
      setCheckingAuth(false);
    }
  }, [loadOverview]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Apply QR scan deep-link (?bed=... or ?admission=...) once session is authenticated
  useEffect(() => {
    if (!session || !pendingQrTarget) return;
    if (pendingQrTarget.admissionId) {
      setQrAdmissionId(pendingQrTarget.admissionId);
      setActiveScreen('inpatients');
    } else if (pendingQrTarget.bedId) {
      setQrBedId(pendingQrTarget.bedId);
      setActiveScreen('beds');
    }
    setPendingQrTarget(null);
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [session, pendingQrTarget]);

  const flushAndRefresh = useCallback(async (forceRefresh = false) => {
    const token = getAuthToken();
    if (!token || !navigator.onLine || isServiceInOutageCooldown()) return;
    const queuedBefore = getOfflineQueue().filter((item) => !item.permanentError).length;
    let didFlush = false;
    if (queuedBefore > 0) {
      setSyncStatus('SYNCING');
      const res = await flushOfflineQueue(token);
      if (res.flushed > 0) {
        didFlush = true;
        notify(`Đã tự động đồng bộ ${res.flushed} thao tác ngoại tuyến lên hệ thống.`);
      }
      if (res.haltedByOutage) {
        setSyncStatus('OFFLINE');
        return;
      }
    }
    const msSinceLast = Date.now() - lastOverviewFetchAtRef.current;
    if (forceRefresh || didFlush || msSinceLast > 5000) {
      await loadOverview();
      window.dispatchEvent(new CustomEvent(CLUSTER_SYNC_EVENT));
    }
  }, [loadOverview, notify]);

  // Real-time WebSocket manager with visibility pause, bounded exponential backoff, and outage circuit-breaker
  useEffect(() => {
    if (!session) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let messageDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempt = 0;

    const clearTimers = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (messageDebounceTimer) {
        clearTimeout(messageDebounceTimer);
        messageDebounceTimer = null;
      }
    };

    const connect = () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      if (!navigator.onLine || isServiceInOutageCooldown()) {
        setSyncStatus('OFFLINE');
        return;
      }
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      setSyncStatus('SYNCING');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws/p2p`);

      ws.onopen = () => {
        attempt = 0;
        setSyncStatus('SYNCED');
        setLastSyncAt(new Date().toISOString());
        flushAndRefresh(false);
      };

      ws.onmessage = (evt) => {
        setSyncStatus('SYNCED');
        setLastSyncAt(new Date().toISOString());
        try {
          const parsed = JSON.parse(evt.data) as { type?: string };
          if (parsed.type === 'WS_CONNECTED') {
            return;
          }
        } catch {
          // Non-JSON payload triggers refresh anyway
        }
        if (messageDebounceTimer) clearTimeout(messageDebounceTimer);
        messageDebounceTimer = setTimeout(() => {
          messageDebounceTimer = null;
          if (!stopped && document.visibilityState !== 'hidden' && !isServiceInOutageCooldown()) {
            loadOverview();
            window.dispatchEvent(new CustomEvent(CLUSTER_SYNC_EVENT));
          }
        }, 450);
      };

      ws.onerror = () => {
        if (!navigator.onLine || isServiceInOutageCooldown()) {
          setSyncStatus('OFFLINE');
        }
      };

      ws.onclose = () => {
        ws = null;
        if (stopped) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          return;
        }
        if (!navigator.onLine || isServiceInOutageCooldown()) {
          setSyncStatus('OFFLINE');
          return;
        }
        attempt += 1;
        const delayMs = computeWsReconnectDelayMs(attempt, {
          maxAttempts: 8,
          baseDelayMs: 3000,
          maxDelayMs: 90_000,
        });
        if (delayMs === null) {
          // Stop automatic reconnects cleanly to avoid spamming Render Free quota
          setSyncStatus('OFFLINE');
          return;
        }
        setSyncStatus('SYNCING');
        reconnectTimer = setTimeout(connect, delayMs);
      };
    };

    const handleOnline = () => {
      attempt = 0;
      clearServiceOutage();
      setSyncStatus('SYNCING');
      connect();
      flushAndRefresh(false);
    };

    const handleOffline = () => {
      clearTimers();
      setSyncStatus('OFFLINE');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimers();
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
          ws = null;
        }
      } else {
        attempt = 0;
        if (navigator.onLine && !isServiceInOutageCooldown()) {
          connect();
        }
      }
    };

    const handleServiceStatus = () => {
      if (isServiceInOutageCooldown()) {
        clearTimers();
        setSyncStatus('OFFLINE');
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
          ws = null;
        }
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener(SERVICE_STATUS_EVENT, handleServiceStatus);
    connect();

    return () => {
      stopped = true;
      clearTimers();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener(SERVICE_STATUS_EVENT, handleServiceStatus);
      if (ws) ws.close();
    };
  }, [session, loadOverview, flushAndRefresh, manualReconnectSeq]);

  const openCustomerPortal = () => {
    setPortalMode(true);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      params.set('portal', 'customer');
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    }
  };

  const closeCustomerPortalToLogin = () => {
    setPortalMode(false);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      params.delete('portal');
      const qs = params.toString();
      window.history.replaceState({}, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    }
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-600">
        Đang khởi tạo phiên làm việc BEDCARE...
      </div>
    );
  }

  if (portalMode) {
    return <CustomerPortalPage onGoToStaffLogin={closeCustomerPortalToLogin} />;
  }

  if (!session) {
    return (
      <LoginScreen
        onOpenCustomerPortal={openCustomerPortal}
        onSuccess={(res) => {
          setPortalMode(false);
          setSession({ user: res.user, activeNode: res.activeNode });
          if (pendingQrTarget?.admissionId) {
            setActiveScreen('inpatients');
          } else if (pendingQrTarget?.bedId) {
            setActiveScreen('beds');
          } else {
            setActiveScreen('dashboard');
          }
          loadOverview();
        }}
      />
    );
  }

  const handleLogout = () => {
    setAuthToken(null);
    setSession(null);
    setOverview(null);
  };

  return (
    <>
      <LayoutShell
        activeScreen={activeScreen}
        onNavigate={(id) => {
          setActiveScreen(id);
          loadOverview();
        }}
        user={session.user}
        activeNodeId={session.activeNode.deviceId}
        activeNodeName={session.activeNode.nodeName}
        alertCount={overview?.alerts.length ?? 0}
        globalSearch={globalSearch}
        onGlobalSearchChange={(val) => {
          setGlobalSearch(val);
          if (val.trim() && activeScreen === 'dashboard') {
            setActiveScreen('beds');
          }
        }}
        syncStatus={syncStatus}
        pendingOfflineCount={pendingOfflineCount}
        lastSyncAt={lastSyncAt}
        onOpenHelp={() => setHelpOpen(true)}
        onLogout={handleLogout}
      >
        {(serviceStatus.inOutage || serviceStatus.usingFailover) && (
          <div
            role="status"
            data-testid="service-resilience-banner"
            className={`no-print mb-4 rounded-lg border px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm ${
              serviceStatus.inOutage
                ? 'border-amber-300 bg-amber-50 text-amber-950'
                : 'border-sky-300 bg-sky-50 text-sky-950'
            }`}
          >
            <div className="flex items-start gap-2.5 min-w-0">
              {serviceStatus.inOutage ? (
                <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
              ) : (
                <Server className="h-4 w-4 text-sky-700 shrink-0 mt-0.5" />
              )}
              <div className="space-y-0.5 min-w-0">
                <div className="font-semibold">
                  {serviceStatus.inOutage
                    ? 'Đã tạm ngưng tự động kết nối lại để bảo vệ hạn mức máy chủ'
                    : `Đang vận hành qua Máy chủ Dự phòng: ${serviceStatus.failoverUrl}`}
                </div>
                <p className="text-xs opacity-90">
                  {serviceStatus.inOutage
                    ? `${serviceStatus.reason} Dữ liệu xem gần nhất đang được giữ trong bộ nhớ đệm và thao tác mới sẽ xếp hàng chờ đồng bộ an toàn.`
                    : 'Mọi yêu cầu API đang được định tuyến sang máy chủ dự phòng để không gián đoạn tiếp nhận & điều phối giường.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {serviceStatus.inOutage && serviceStatus.failoverUrl && !serviceStatus.usingFailover && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveFailoverMode(true);
                    setManualReconnectSeq((n) => n + 1);
                    loadOverview(true);
                    notify('Đã chuyển sang Máy chủ Dự phòng.');
                  }}
                  className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-800"
                >
                  Chuyển sang Dự phòng
                </button>
              )}
              {serviceStatus.usingFailover && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveFailoverMode(false);
                    clearServiceOutage();
                    setManualReconnectSeq((n) => n + 1);
                    loadOverview(true);
                    notify('Đã chuyển về Máy chủ Chính.');
                  }}
                  className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100"
                >
                  Quay về Máy chủ Chính
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  clearServiceOutage();
                  setManualReconnectSeq((n) => n + 1);
                  loadOverview(true);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Thử kết nối lại</span>
              </button>
              {(session.user.role === 'SUPER_ADMIN' || session.user.role === 'ADMIN') && (
                <button
                  type="button"
                  onClick={() => setActiveScreen('settings')}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cấu hình Dự phòng
                </button>
              )}
            </div>
          </div>
        )}
        {activeScreen === 'dashboard' && (
          <DashboardPage
            data={overview}
            loading={loadingOverview}
            onRefresh={loadOverview}
            onNotify={notify}
            onNavigate={setActiveScreen}
            onOpenDepartmentBeds={(deptId, statusFilter) => {
              setSelectedDeptFilter(deptId);
              setSelectedBedStatusFilter(statusFilter ?? '');
              setActiveScreen('beds');
            }}
            onOpenTransferForAdmission={(admId) => {
              setPreselectedTransferAdmId(admId);
              setActiveScreen('transfers');
            }}
          />
        )}
        {activeScreen === 'departments' && (
          <DepartmentsPage
            userRole={session.user.role}
            onNotify={notify}
            onSelectDepartment={(deptId) => {
              setSelectedDeptFilter(deptId);
              setActiveScreen('rooms');
            }}
          />
        )}
        {activeScreen === 'rooms' && (
          <RoomsPage
            userRole={session.user.role}
            userDeptId={session.user.department_id}
            initialDepartmentFilter={selectedDeptFilter}
            onNotify={notify}
          />
        )}
        {activeScreen === 'beds' && (
          <BedsMapPage
            userRole={session.user.role}
            userDeptId={session.user.department_id}
            initialDepartmentFilter={selectedDeptFilter}
            initialStatusFilter={selectedBedStatusFilter}
            initialBedId={qrBedId}
            onClearInitialBed={() => setQrBedId('')}
            globalSearch={globalSearch}
            onNotify={notify}
            onNavigate={setActiveScreen}
          />
        )}
        {activeScreen === 'registrations' && (
          <RegistrationsPage
            userRole={session.user.role}
            userDeptId={session.user.department_id}
            onNotify={notify}
            onOpenReservation={(regId) => {
              setPreselectedReservationRegId(regId);
              setActiveScreen('reservations');
            }}
            onOpenAdmission={(regId) => {
              setPreselectedAdmissionRegId(regId);
              setActiveScreen('admissions');
            }}
          />
        )}
        {activeScreen === 'reservations' && (
          <ReservationsPage
            userRole={session.user.role}
            initialRegistrationId={preselectedReservationRegId}
            onClearInitialRegistration={() => setPreselectedReservationRegId('')}
            onOpenAdmission={(regId) => {
              setPreselectedAdmissionRegId(regId);
              setActiveScreen('admissions');
            }}
            onNotify={notify}
          />
        )}
        {activeScreen === 'waitlist' && (
          <WaitlistPage
            onNotify={notify}
            onNavigate={setActiveScreen}
            onOpenAdmission={(regId) => {
              setPreselectedAdmissionRegId(regId);
              setActiveScreen('admissions');
            }}
          />
        )}
        {activeScreen === 'admissions' && (
          <AdmissionsPage
            userRole={session.user.role}
            userDeptId={session.user.department_id}
            initialRegistrationId={preselectedAdmissionRegId}
            onClearInitialRegistration={() => setPreselectedAdmissionRegId('')}
            onNotify={notify}
          />
        )}
        {activeScreen === 'inpatients' && (
          <InpatientsPage
            userRole={session.user.role}
            userDeptId={session.user.department_id}
            initialAdmissionId={qrAdmissionId}
            onClearInitialAdmission={() => setQrAdmissionId('')}
            globalSearch={globalSearch}
            onNotify={notify}
            onOpenTransfer={(admId) => {
              setPreselectedTransferAdmId(admId);
              setActiveScreen('transfers');
            }}
          />
        )}
        {activeScreen === 'extensions' && <ExtensionsPage onNotify={notify} />}
        {activeScreen === 'transfers' && (
          <TransfersPage
            initialAdmissionId={preselectedTransferAdmId}
            onNotify={notify}
          />
        )}
        {activeScreen === 'discharge' && <DischargePage onNotify={notify} />}
        {activeScreen === 'cleaning' && <CleaningPage onNotify={notify} />}
        {activeScreen === 'alerts' && (
          <AlertsPage
            alerts={overview?.alerts ?? []}
            departments={overview?.deptStats ?? []}
            onNavigate={setActiveScreen}
          />
        )}
        {activeScreen === 'reports' && <ReportsPage onNotify={notify} />}
        {activeScreen === 'his' && canViewHisModule(session.user.role, session.user.his_permission) && (
          <HisIntegrationPage
            userRole={session.user.role}
            hisPermission={session.user.his_permission}
            onNotify={notify}
            onDataChanged={loadOverview}
            onNavigateUsers={() => setActiveScreen('users')}
          />
        )}
        {activeScreen === 'users' && (
          <UsersPage
            currentUserId={session.user.id}
            currentUserRole={session.user.role}
            onNotify={notify}
          />
        )}
        {activeScreen === 'devices' && (
          <DevicesPage
            currentUserRole={session.user.role}
            onNotify={notify}
            onNodeSwitched={checkAuth}
          />
        )}
        {activeScreen === 'sync' && (
          <SyncConsensusPage userRole={session.user.role} onNotify={notify} />
        )}
        {activeScreen === 'backup' && <BackupRestorePage onNotify={notify} />}
        {activeScreen === 'settings' && (
          <SettingsPage
            userRole={session.user.role}
            onNotify={notify}
            onDataChanged={loadOverview}
          />
        )}
      </LayoutShell>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`no-print fixed bottom-20 lg:bottom-5 right-4 sm:right-5 z-50 flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg max-w-[calc(100vw-2rem)] sm:max-w-md ${
            toast.type === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}
        >
          {toast.type === 'error' ? (
            <XCircle className="h-4 w-4 text-rose-600 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
          )}
          <span className="flex-1">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Đóng thông báo"
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <HelpCenter
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        currentScreen={activeScreen}
        onNavigate={(id) => {
          setActiveScreen(id);
          loadOverview();
        }}
      />
    </>
  );
}

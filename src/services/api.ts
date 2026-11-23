import {
  clearServiceOutage,
  detectServiceOutage,
  getAutoSwitchFailover,
  getFailoverServerUrl,
  isServiceInOutageCooldown,
  isUsingFailoverServer,
  loadReadCache,
  recordServiceOutage,
  resolveApiUrl,
  saveReadCache,
  setActiveFailoverMode,
} from '../utils/networkResilience';
import { enqueueOfflineAction } from '../utils/offlineQueue';

const TOKEN_KEY = 'bedcare_auth_token';

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

function isQueueableMutation(path: string, method?: string): boolean {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return false;
  if (
    path.startsWith('/auth/') ||
    path.startsWith('/backups') ||
    path.startsWith('/import') ||
    path.startsWith('/cluster/reconcile') ||
    path.startsWith('/cluster/simulate-race') ||
    path.startsWith('/cluster/switch-node')
  ) {
    return false;
  }
  return true;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit & { skipOfflineQueue?: boolean; bypassOutageCooldown?: boolean } = {}
): Promise<T> {
  const token = getAuthToken();
  const method = (options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const shouldQueueOnOffline = !options.skipOfflineQueue && isQueueableMutation(path, method);

  if (shouldQueueOnOffline && typeof navigator !== 'undefined' && navigator.onLine === false) {
    const queued = enqueueOfflineAction({
      path,
      method,
      bodyText: typeof options.body === 'string' ? options.body : options.body ? String(options.body) : null,
      lastError: 'Thiết bị đang ngoại tuyến (Offline) — đã lưu vào Pending Actions',
    });
    return { queuedOffline: true, offlineActionId: queued.id } as T;
  }

  if (method === 'GET' && !options.bypassOutageCooldown && isServiceInOutageCooldown()) {
    const cached = loadReadCache<T>(path);
    if (cached) {
      return cached.data;
    }
    throw new Error('Máy chủ đang tạm ngưng bảo toàn lưu lượng. Vui lòng thử lại sau ít phút hoặc chuyển sang Máy chủ Dự phòng.');
  }

  const executeFetch = async (url: string) =>
    fetch(url, {
      ...options,
      headers,
    });

  let res: Response;
  try {
    res = await executeFetch(resolveApiUrl(path));
  } catch (networkErr) {
    // Auto-failover on primary network failure if configured
    const failoverUrl = getFailoverServerUrl();
    if (failoverUrl && !isUsingFailoverServer() && getAutoSwitchFailover()) {
      try {
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        const failoverRes = await executeFetch(`${failoverUrl}/api${cleanPath}`);
        if (failoverRes.ok) {
          setActiveFailoverMode(true);
          res = failoverRes;
        } else {
          res = failoverRes;
        }
      } catch {
        if (method === 'GET') {
          const cached = loadReadCache<T>(path);
          if (cached) return cached.data;
        }
        if (shouldQueueOnOffline) {
          const queued = enqueueOfflineAction({
            path,
            method,
            bodyText: typeof options.body === 'string' ? options.body : options.body ? String(options.body) : null,
            lastError: networkErr instanceof Error ? networkErr.message : 'Mất kết nối tới máy chủ',
          });
          return { queuedOffline: true, offlineActionId: queued.id } as T;
        }
        throw networkErr;
      }
    } else {
      if (method === 'GET') {
        const cached = loadReadCache<T>(path);
        if (cached) return cached.data;
      }
      if (shouldQueueOnOffline) {
        const queued = enqueueOfflineAction({
          path,
          method,
          bodyText: typeof options.body === 'string' ? options.body : options.body ? String(options.body) : null,
          lastError: networkErr instanceof Error ? networkErr.message : 'Mất kết nối tới máy chủ',
        });
        return { queuedOffline: true, offlineActionId: queued.id } as T;
      }
      throw networkErr;
    }
  }

  const rawText = await res.text().catch(() => '');
  const outage = detectServiceOutage({
    status: res.status,
    contentType: res.headers.get('content-type'),
    bodyText: rawText,
    retryAfterHeader: res.headers.get('retry-after'),
  });

  if (outage.isOutage) {
    // Try automatic switch to Failover Server if configured
    const failoverUrl = getFailoverServerUrl();
    if (failoverUrl && !isUsingFailoverServer() && getAutoSwitchFailover()) {
      try {
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        const backupRes = await executeFetch(`${failoverUrl}/api${cleanPath}`);
        const backupText = await backupRes.text().catch(() => '');
        const backupOutage = detectServiceOutage({
          status: backupRes.status,
          contentType: backupRes.headers.get('content-type'),
          bodyText: backupText,
          retryAfterHeader: backupRes.headers.get('retry-after'),
        });
        if (!backupOutage.isOutage && backupRes.ok) {
          setActiveFailoverMode(true);
          const backupData = backupText ? (JSON.parse(backupText) as T) : ({} as T);
          if (method === 'GET') saveReadCache(path, backupData);
          return backupData;
        }
      } catch {
        // Fall through to outage cooldown
      }
    }

    recordServiceOutage(outage.reason, res.status, outage.retryAfterMs);

    if (method === 'GET') {
      const cached = loadReadCache<T>(path);
      if (cached) return cached.data;
    }

    if (shouldQueueOnOffline) {
      const queued = enqueueOfflineAction({
        path,
        method,
        bodyText: typeof options.body === 'string' ? options.body : options.body ? String(options.body) : null,
        lastError: outage.reason,
      });
      return { queuedOffline: true, offlineActionId: queued.id } as T;
    }

    throw new Error(outage.reason);
  }

  let data: Record<string, unknown> = {};
  if (rawText) {
    try {
      data = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      setAuthToken(null);
    }
    const errMsg = typeof data.error === 'string' ? data.error : `Lỗi máy chủ (${res.status})`;
    throw new Error(errMsg);
  }

  clearServiceOutage();
  if (method === 'GET') {
    saveReadCache(path, data as T);
  }
  return data as T;
}

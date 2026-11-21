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
  options: RequestInit & { skipOfflineQueue?: boolean } = {}
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

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...options,
      headers,
    });
  } catch (networkErr) {
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

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      setAuthToken(null);
    }
    throw new Error(data.error || `Lỗi máy chủ (${res.status})`);
  }
  return data as T;
}

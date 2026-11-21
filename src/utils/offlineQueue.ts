export interface OfflinePendingAction {
  id: string;
  path: string;
  method: string;
  bodyText: string | null;
  actionLabel: string;
  createdAt: string;
  attempts: number;
  lastError?: string | null;
}

const QUEUE_KEY = 'bedcare_offline_pending_actions_v1';
export const OFFLINE_QUEUE_EVENT = 'bedcare-offline-queue-changed';

const ACTION_LABELS: Array<{ test: RegExp; label: string }> = [
  { test: /^\/registrations$/, label: 'Tạo hồ sơ đăng ký trước' },
  { test: /^\/registrations\/[^/]+\/cancel$/, label: 'Hủy phiếu đăng ký' },
  { test: /^\/reservations$/, label: 'Giữ chỗ giường / bao phòng' },
  { test: /^\/reservations\/[^/]+\/extend$/, label: 'Gia hạn giữ chỗ' },
  { test: /^\/reservations\/[^/]+\/cancel$/, label: 'Hủy giữ chỗ' },
  { test: /^\/admissions\/confirm$/, label: 'Xác nhận tiếp nhận bệnh nhân' },
  { test: /^\/admissions\/[^/]+\/extend$/, label: 'Gia hạn ngày nằm giường' },
  { test: /^\/admissions\/[^/]+\/transfer$/, label: 'Điều chuyển giường ngay' },
  { test: /^\/admissions\/[^/]+\/discharge$/, label: 'Trả giường / Xuất viện' },
  { test: /^\/transfer-requests$/, label: 'Tạo lệnh chờ điều chuyển' },
  { test: /^\/transfer-requests\/[^/]+\/complete$/, label: 'Hoàn tất lệnh điều chuyển' },
  { test: /^\/cleaning\/[^/]+\/start$/, label: 'Bắt đầu vệ sinh giường' },
  { test: /^\/cleaning\/[^/]+\/complete$/, label: 'Hoàn tất vệ sinh giường' },
  { test: /^\/beds\/[^/]+\/status$/, label: 'Đổi trạng thái giường' },
];

export function describeActionPath(path: string, method: string): string {
  for (const rule of ACTION_LABELS) {
    if (rule.test.test(path)) return rule.label;
  }
  return `${method.toUpperCase()} ${path}`;
}

export function getOfflineQueue(): OfflinePendingAction[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveOfflineQueue(items: OfflinePendingAction[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota errors
  }
  window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_EVENT, { detail: { count: items.length } }));
}

export function enqueueOfflineAction(input: {
  path: string;
  method: string;
  bodyText: string | null;
  actionLabel?: string;
  lastError?: string;
}): OfflinePendingAction {
  const item: OfflinePendingAction = {
    id: `off-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    path: input.path,
    method: input.method.toUpperCase(),
    bodyText: input.bodyText,
    actionLabel: input.actionLabel || describeActionPath(input.path, input.method),
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: input.lastError ?? 'Chờ kết nối mạng để phát đồng bộ',
  };
  const next = [...getOfflineQueue(), item];
  saveOfflineQueue(next);
  return item;
}

export function removeOfflineAction(id: string) {
  const next = getOfflineQueue().filter((x) => x.id !== id);
  saveOfflineQueue(next);
}

export function clearOfflineQueue() {
  saveOfflineQueue([]);
}

let inFlightFlush: Promise<{ flushed: number; failed: number; remaining: number }> | null = null;

export async function flushOfflineQueue(token: string | null): Promise<{
  flushed: number;
  failed: number;
  remaining: number;
}> {
  if (inFlightFlush) {
    return inFlightFlush;
  }

  inFlightFlush = (async () => {
    const current = getOfflineQueue();
    if (current.length === 0) {
      return { flushed: 0, failed: 0, remaining: 0 };
    }

    let flushed = 0;
    let failed = 0;
    const remainingItems: OfflinePendingAction[] = [];

    for (const item of current) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(`/api${item.path}`, {
          method: item.method,
          headers,
          body: item.bodyText ?? undefined,
        });
        if (res.ok) {
          flushed++;
        } else {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          failed++;
          remainingItems.push({
            ...item,
            attempts: item.attempts + 1,
            lastError: errBody.error || `Lỗi máy chủ (${res.status})`,
          });
        }
      } catch (err) {
        failed++;
        remainingItems.push({
          ...item,
          attempts: item.attempts + 1,
          lastError: err instanceof Error ? err.message : 'Mất kết nối mạng',
        });
      }
    }

    // Preserve any brand-new actions enqueued while this flush was in progress
    const currentIds = new Set(current.map((c) => c.id));
    const newlyQueued = getOfflineQueue().filter((x) => !currentIds.has(x.id));
    const finalQueue = [...remainingItems, ...newlyQueued];
    saveOfflineQueue(finalQueue);
    return { flushed, failed, remaining: finalQueue.length };
  })().finally(() => {
    inFlightFlush = null;
  });

  return inFlightFlush;
}

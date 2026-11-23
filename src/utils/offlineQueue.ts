import {
  detectServiceOutage,
  isServiceInOutageCooldown,
  recordServiceOutage,
  resolveApiUrl,
  shouldAutoRetryOfflineItem,
} from './networkResilience';

export interface OfflinePendingAction {
  id: string;
  path: string;
  method: string;
  bodyText: string | null;
  actionLabel: string;
  createdAt: string;
  attempts: number;
  lastError?: string | null;
  lastStatus?: number | null;
  permanentError?: boolean;
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
    lastStatus: null,
    permanentError: false,
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

let inFlightFlush: Promise<{ flushed: number; failed: number; remaining: number; haltedByOutage?: boolean }> | null = null;

export async function flushOfflineQueue(
  token: string | null,
  options: { includePermanentErrors?: boolean } = {}
): Promise<{
  flushed: number;
  failed: number;
  remaining: number;
  haltedByOutage?: boolean;
}> {
  if (inFlightFlush) {
    return inFlightFlush;
  }

  inFlightFlush = (async () => {
    const current = getOfflineQueue();
    if (current.length === 0) {
      return { flushed: 0, failed: 0, remaining: 0 };
    }

    if (!options.includePermanentErrors && isServiceInOutageCooldown()) {
      return {
        flushed: 0,
        failed: 0,
        remaining: current.length,
        haltedByOutage: true,
      };
    }

    let flushed = 0;
    let failed = 0;
    let haltedByOutage = false;
    const remainingItems: OfflinePendingAction[] = [];

    for (let i = 0; i < current.length; i++) {
      const item = current[i];
      if (!options.includePermanentErrors && item.permanentError) {
        remainingItems.push(item);
        continue;
      }

      if (haltedByOutage) {
        remainingItems.push(item);
        continue;
      }

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(resolveApiUrl(item.path), {
          method: item.method,
          headers,
          body: item.bodyText ?? undefined,
        });

        const rawText = await res.text().catch(() => '');
        const outage = detectServiceOutage({
          status: res.status,
          contentType: res.headers.get('content-type'),
          bodyText: rawText,
          retryAfterHeader: res.headers.get('retry-after'),
        });

        if (outage.isOutage) {
          recordServiceOutage(outage.reason, res.status, outage.retryAfterMs);
          failed++;
          haltedByOutage = true;
          remainingItems.push({
            ...item,
            attempts: item.attempts + 1,
            lastStatus: res.status,
            lastError: outage.reason,
          });
          continue;
        }

        if (res.ok) {
          flushed++;
        } else {
          let errMsg = `Lỗi máy chủ (${res.status})`;
          try {
            const parsed = JSON.parse(rawText) as { error?: string };
            if (parsed.error) errMsg = parsed.error;
          } catch {
            // Keep default HTTP error message
          }
          failed++;
          const nextAttempts = item.attempts + 1;
          const canRetry = shouldAutoRetryOfflineItem(nextAttempts, res.status);
          remainingItems.push({
            ...item,
            attempts: nextAttempts,
            lastStatus: res.status,
            permanentError: !canRetry,
            lastError: canRetry
              ? errMsg
              : `${errMsg} — Đã dừng tự động gửi lại để tránh lặp lỗi.`,
          });
        }
      } catch (err) {
        failed++;
        haltedByOutage = true;
        const nextAttempts = item.attempts + 1;
        const canRetry = shouldAutoRetryOfflineItem(nextAttempts, null);
        remainingItems.push({
          ...item,
          attempts: nextAttempts,
          lastStatus: null,
          permanentError: !canRetry,
          lastError: err instanceof Error ? err.message : 'Mất kết nối mạng',
        });
      }
    }

    // Preserve any brand-new actions enqueued while this flush was in progress
    const currentIds = new Set(current.map((c) => c.id));
    const newlyQueued = getOfflineQueue().filter((x) => !currentIds.has(x.id));
    const finalQueue = [...remainingItems, ...newlyQueued];
    saveOfflineQueue(finalQueue);
    return { flushed, failed, remaining: finalQueue.length, haltedByOutage };
  })().finally(() => {
    inFlightFlush = null;
  });

  return inFlightFlush;
}

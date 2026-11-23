export const SERVICE_STATUS_EVENT = 'bedcare-service-status-changed';

const FAILOVER_URL_KEY = 'bedcare_failover_server_url_v1';
const FAILOVER_ACTIVE_KEY = 'bedcare_failover_active_v1';
const FAILOVER_AUTO_KEY = 'bedcare_failover_auto_switch_v1';
const READ_CACHE_PREFIX = 'bedcare_read_cache_v1:';

export const DEFAULT_MAX_WS_RECONNECT_ATTEMPTS = 8;
export const DEFAULT_OUTAGE_COOLDOWN_MS = 60_000;
export const MAX_OFFLINE_AUTO_ATTEMPTS = 3;

export interface ServiceOutageState {
  inOutage: boolean;
  reason: string;
  statusCode: number | null;
  untilMs: number;
  usingFailover: boolean;
  failoverUrl: string;
}

export interface WsBackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  randomValue?: number;
}

/**
 * Computes bounded exponential backoff with jitter for WebSocket reconnection.
 * Returns null once `attempt` exceeds `maxAttempts` so clients stop hammering the host.
 */
export function computeWsReconnectDelayMs(
  attempt: number,
  options: WsBackoffOptions = {}
): number | null {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_WS_RECONNECT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? 3000;
  const maxDelayMs = options.maxDelayMs ?? 90_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const rand = options.randomValue ?? Math.random();

  if (!Number.isFinite(attempt) || attempt < 1) return baseDelayMs;
  if (attempt > maxAttempts) return null;

  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitterSpan = exponential * jitterRatio;
  const jitterOffset = (rand * 2 - 1) * jitterSpan;
  return Math.max(1000, Math.round(exponential + jitterOffset));
}

export interface OutageDetectionResult {
  isOutage: boolean;
  isQuotaOrRateLimit: boolean;
  reason: string;
  retryAfterMs: number;
}

export function parseRetryAfterMs(retryAfterHeader: string | null | undefined, fallbackMs = DEFAULT_OUTAGE_COOLDOWN_MS): number {
  if (!retryAfterHeader) return fallbackMs;
  const numeric = Number(retryAfterHeader.trim());
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(10 * 60_000, Math.max(5000, Math.round(numeric * 1000)));
  }
  const dateMs = Date.parse(retryAfterHeader);
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - Date.now();
    if (diff > 0) return Math.min(10 * 60_000, Math.max(5000, diff));
  }
  return fallbackMs;
}

/**
 * Detects Render Free quota exhaustion, rate limits, gateway errors, or HTML suspended pages returned on /api/* calls.
 */
export function detectServiceOutage(input: {
  status: number;
  contentType?: string | null;
  bodyText?: string | null;
  retryAfterHeader?: string | null;
}): OutageDetectionResult {
  const status = input.status;
  const contentType = (input.contentType || '').toLowerCase();
  const body = (input.bodyText || '').slice(0, 2000).toLowerCase();
  const retryAfterMs = parseRetryAfterMs(input.retryAfterHeader, DEFAULT_OUTAGE_COOLDOWN_MS);

  if (status === 429) {
    return {
      isOutage: true,
      isQuotaOrRateLimit: true,
      reason: 'Máy chủ đang giới hạn lưu lượng truy cập (HTTP 429). Hệ thống tạm ngưng đồng bộ tự động để bảo toàn hạn mức.',
      retryAfterMs,
    };
  }

  if (status === 502 || status === 503 || status === 504) {
    const mentionsQuota =
      body.includes('suspend') ||
      body.includes('quota') ||
      body.includes('bandwidth') ||
      body.includes('limit') ||
      body.includes('free instance');
    return {
      isOutage: true,
      isQuotaOrRateLimit: mentionsQuota || status === 503,
      reason: mentionsQuota
        ? 'Máy chủ Render Free tạm ngừng hoặc hết hạn mức tháng (HTTP ' + status + ').'
        : `Máy chủ chính tạm gián đoạn hoặc đang khởi động lại (HTTP ${status}).`,
      retryAfterMs,
    };
  }

  // Render sometimes serves an HTML suspension/maintenance page with 200/4xx/5xx content-type text/html on API endpoints
  if (contentType.includes('text/html') && (body.includes('<html') || body.includes('<!doctype'))) {
    const looksSuspended =
      body.includes('render') ||
      body.includes('suspend') ||
      body.includes('unavailable') ||
      body.includes('cloudflare') ||
      body.includes('rate limit');
    return {
      isOutage: true,
      isQuotaOrRateLimit: looksSuspended,
      reason: 'Máy chủ trả về trang HTML cảnh báo/bảo trì thay vì dữ liệu API JSON.',
      retryAfterMs,
    };
  }

  return {
    isOutage: false,
    isQuotaOrRateLimit: false,
    reason: '',
    retryAfterMs: 0,
  };
}

/**
 * Determines whether an offline queued action should continue auto-retrying or halt permanently.
 * Permanent 4xx errors (400/401/403/404/409/422) must NEVER loop against the server!
 */
export function shouldAutoRetryOfflineItem(attemptsAfterFailure: number, httpStatus: number | null): boolean {
  if (attemptsAfterFailure >= MAX_OFFLINE_AUTO_ATTEMPTS) {
    return false;
  }
  if (httpStatus === null) {
    // Network error: allow up to MAX_OFFLINE_AUTO_ATTEMPTS
    return true;
  }
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
    return true;
  }
  // Any other 4xx (400, 401, 403, 404, 409, 422) is deterministic/conflict -> stop auto-retry immediately
  if (httpStatus >= 400 && httpStatus < 500) {
    return false;
  }
  return false;
}

export function normalizeServerBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Địa chỉ máy chủ dự phòng không hợp lệ (cần dạng https://ten-mien.onrender.com).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chỉ hỗ trợ giao thức http:// hoặc https://.');
  }
  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`;
}

function safeStorageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function getFailoverServerUrl(): string {
  return safeStorageGet(FAILOVER_URL_KEY) || '';
}

export function setFailoverServerUrl(rawUrl: string): string {
  const normalized = rawUrl.trim() ? normalizeServerBaseUrl(rawUrl) : '';
  safeStorageSet(FAILOVER_URL_KEY, normalized || null);
  if (!normalized) {
    safeStorageSet(FAILOVER_ACTIVE_KEY, null);
  }
  emitServiceStatusChange();
  return normalized;
}

export function isUsingFailoverServer(): boolean {
  return Boolean(getFailoverServerUrl()) && safeStorageGet(FAILOVER_ACTIVE_KEY) === 'true';
}

export function setActiveFailoverMode(active: boolean) {
  if (active && !getFailoverServerUrl()) return;
  safeStorageSet(FAILOVER_ACTIVE_KEY, active ? 'true' : null);
  if (active) {
    outageUntilMs = 0;
    outageReason = '';
    outageStatusCode = null;
  }
  emitServiceStatusChange();
}

export function getAutoSwitchFailover(): boolean {
  return safeStorageGet(FAILOVER_AUTO_KEY) !== 'false';
}

export function setAutoSwitchFailover(enabled: boolean) {
  safeStorageSet(FAILOVER_AUTO_KEY, enabled ? 'true' : 'false');
  emitServiceStatusChange();
}

export function resolveApiUrl(path: string, forcePrimary = false): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (!forcePrimary && isUsingFailoverServer()) {
    const base = getFailoverServerUrl();
    if (base) return `${base}/api${cleanPath}`;
  }
  return `/api${cleanPath}`;
}

export function resolveWsUrl(): string {
  if (isUsingFailoverServer()) {
    const base = getFailoverServerUrl();
    if (base) {
      const wsBase = base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
      return `${wsBase}/ws/p2p`;
    }
  }
  if (typeof window === 'undefined') return 'ws://localhost:3000/ws/p2p';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/p2p`;
}

// --- In-memory Outage Circuit Breaker ---
let outageUntilMs = 0;
let outageReason = '';
let outageStatusCode: number | null = null;

function emitServiceStatusChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SERVICE_STATUS_EVENT, { detail: getServiceOutageState() }));
  }
}

export function getServiceOutageState(): ServiceOutageState {
  const now = Date.now();
  const active = outageUntilMs > now;
  return {
    inOutage: active,
    reason: active ? outageReason : '',
    statusCode: active ? outageStatusCode : null,
    untilMs: active ? outageUntilMs : 0,
    usingFailover: isUsingFailoverServer(),
    failoverUrl: getFailoverServerUrl(),
  };
}

export function isServiceInOutageCooldown(now = Date.now()): boolean {
  return outageUntilMs > now;
}

export function recordServiceOutage(reason: string, statusCode: number | null, cooldownMs = DEFAULT_OUTAGE_COOLDOWN_MS) {
  const clampedCooldown = Math.min(10 * 60_000, Math.max(10_000, cooldownMs));
  outageUntilMs = Date.now() + clampedCooldown;
  outageReason = reason;
  outageStatusCode = statusCode;
  emitServiceStatusChange();
}

export function clearServiceOutage() {
  if (outageUntilMs !== 0 || outageReason) {
    outageUntilMs = 0;
    outageReason = '';
    outageStatusCode = null;
    emitServiceStatusChange();
  }
}

// --- Lightweight Read-Only Snapshot Cache for Fallback Resilience ---
const CACHEABLE_GET_PREFIXES = [
  '/dashboard/overview',
  '/beds',
  '/departments',
  '/rooms',
  '/admissions/active',
  '/public/availability',
];

export function isCacheableReadPath(path: string): boolean {
  return CACHEABLE_GET_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}?`));
}

interface CachedEnvelope<T> {
  savedAt: string;
  data: T;
}

export function saveReadCache<T>(path: string, data: T) {
  if (!isCacheableReadPath(path)) return;
  const envelope: CachedEnvelope<T> = {
    savedAt: new Date().toISOString(),
    data,
  };
  safeStorageSet(`${READ_CACHE_PREFIX}${path}`, JSON.stringify(envelope));
}

export function loadReadCache<T>(path: string, maxAgeMs = 24 * 60 * 60 * 1000): { data: T; savedAt: string } | null {
  if (!isCacheableReadPath(path)) return null;
  const raw = safeStorageGet(`${READ_CACHE_PREFIX}${path}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedEnvelope<T>;
    if (!parsed || !parsed.savedAt || parsed.data === undefined) return null;
    const savedTime = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedTime) || Date.now() - savedTime > maxAgeMs) return null;
    return { data: parsed.data, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

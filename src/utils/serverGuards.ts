/**
 * Server-side traffic guards:
 * 1. Trailing-edge debounced WebSocket broadcaster to prevent commit storms from fanning out into N*clients API refetches.
 * 2. Sliding-window rate limiter to protect public unauthenticated routes on free-tier hosting (Render Free).
 */

export function createDebouncedBroadcaster(
  sendFn: () => void,
  windowMs = 300
): { trigger: () => void; cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      pending = false;
      sendFn();
    }
  };

  const trigger = () => {
    pending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) {
        pending = false;
        sendFn();
      }
    }, windowMs);
  };

  const cancel = () => {
    pending = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { trigger, cancel, flush };
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(maxRequests = 90, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): RateLimitCheckResult {
    const cutoff = now - this.windowMs;
    const prev = this.buckets.get(key) || [];
    const active = prev.filter((ts) => ts > cutoff);

    if (active.length >= this.maxRequests) {
      this.buckets.set(key, active);
      const oldest = active[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    active.push(now);
    this.buckets.set(key, active);

    // Opportunistic cleanup to keep memory bounded
    if (this.buckets.size > 2000) {
      for (const [k, timestamps] of this.buckets.entries()) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
          this.buckets.delete(k);
        }
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - active.length),
      retryAfterSeconds: 0,
    };
  }
}

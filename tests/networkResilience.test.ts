import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { BedcareCluster } from '../src/server/p2pCluster';
import { seedDemoClusterIfEmpty } from '../src/server/demoData';
import { createBedcareRouter } from '../src/server/router';
import {
  clearServiceOutage,
  computeWsReconnectDelayMs,
  detectServiceOutage,
  getFailoverServerUrl,
  isServiceInOutageCooldown,
  isUsingFailoverServer,
  loadReadCache,
  normalizeServerBaseUrl,
  recordServiceOutage,
  resolveApiUrl,
  resolveWsUrl,
  saveReadCache,
  setActiveFailoverMode,
  setFailoverServerUrl,
  shouldAutoRetryOfflineItem,
} from '../src/utils/networkResilience';
import { createDebouncedBroadcaster, SlidingWindowRateLimiter } from '../src/utils/serverGuards';

function installMockLocalStorage() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
  (globalThis as unknown as { localStorage: typeof mock }).localStorage = mock;
  return mock;
}

test('computeWsReconnectDelayMs applies bounded exponential backoff and stops after maxAttempts', () => {
  assert.equal(computeWsReconnectDelayMs(1, { baseDelayMs: 3000, maxDelayMs: 90_000, jitterRatio: 0 }), 3000);
  assert.equal(computeWsReconnectDelayMs(2, { baseDelayMs: 3000, maxDelayMs: 90_000, jitterRatio: 0 }), 6000);
  assert.equal(computeWsReconnectDelayMs(3, { baseDelayMs: 3000, maxDelayMs: 90_000, jitterRatio: 0 }), 12000);
  assert.equal(computeWsReconnectDelayMs(6, { baseDelayMs: 3000, maxDelayMs: 90_000, jitterRatio: 0 }), 90000);
  assert.equal(computeWsReconnectDelayMs(8, { maxAttempts: 8, baseDelayMs: 3000, maxDelayMs: 90_000, jitterRatio: 0 }), 90000);
  // Attempt 9 exceeds maxAttempts=8 -> returns null so auto-reconnect halts cleanly
  assert.equal(computeWsReconnectDelayMs(9, { maxAttempts: 8 }), null);
});

test('detectServiceOutage catches 429, 502/503, Retry-After, and Render HTML suspended pages', () => {
  const rateLimit = detectServiceOutage({
    status: 429,
    contentType: 'application/json',
    bodyText: '{"error":"Too many requests"}',
    retryAfterHeader: '45',
  });
  assert.equal(rateLimit.isOutage, true);
  assert.equal(rateLimit.isQuotaOrRateLimit, true);
  assert.equal(rateLimit.retryAfterMs, 45_000);

  const htmlSuspended = detectServiceOutage({
    status: 503,
    contentType: 'text/html; charset=utf-8',
    bodyText: '<!doctype html><html><body><h1>This Render service has been suspended due to free quota limit</h1></body></html>',
  });
  assert.equal(htmlSuspended.isOutage, true);
  assert.equal(htmlSuspended.isQuotaOrRateLimit, true);

  const normalClientError = detectServiceOutage({
    status: 409,
    contentType: 'application/json',
    bodyText: '{"error":"Giường đã có bệnh nhân"}',
  });
  assert.equal(normalClientError.isOutage, false);
});

test('shouldAutoRetryOfflineItem halts permanent 4xx errors immediately and caps 5xx/network retries', () => {
  assert.equal(shouldAutoRetryOfflineItem(1, 409), false);
  assert.equal(shouldAutoRetryOfflineItem(1, 400), false);
  assert.equal(shouldAutoRetryOfflineItem(1, 403), false);
  assert.equal(shouldAutoRetryOfflineItem(1, 404), false);

  assert.equal(shouldAutoRetryOfflineItem(1, 503), true);
  assert.equal(shouldAutoRetryOfflineItem(2, null), true);
  assert.equal(shouldAutoRetryOfflineItem(3, 503), false);
  assert.equal(shouldAutoRetryOfflineItem(3, null), false);
});

test('Failover server URL normalization, API/WS routing, outage cooldown, and read cache fallback', () => {
  installMockLocalStorage();
  clearServiceOutage();

  assert.equal(normalizeServerBaseUrl(' https://bedcare-backup.onrender.com/ '), 'https://bedcare-backup.onrender.com');
  assert.throws(() => normalizeServerBaseUrl('ftp://invalid-host.com'));

  setFailoverServerUrl('https://bedcare-backup.onrender.com/');
  assert.equal(getFailoverServerUrl(), 'https://bedcare-backup.onrender.com');
  assert.equal(isUsingFailoverServer(), false);
  assert.equal(resolveApiUrl('/beds'), '/api/beds');

  setActiveFailoverMode(true);
  assert.equal(isUsingFailoverServer(), true);
  assert.equal(resolveApiUrl('/beds'), 'https://bedcare-backup.onrender.com/api/beds');
  assert.equal(resolveWsUrl(), 'wss://bedcare-backup.onrender.com/ws/p2p');

  setActiveFailoverMode(false);
  recordServiceOutage('Render quota exceeded', 503, 30_000);
  assert.equal(isServiceInOutageCooldown(), true);
  clearServiceOutage();
  assert.equal(isServiceInOutageCooldown(), false);

  saveReadCache('/public/availability', { rooms: [{ id: 'r1' }] });
  const cached = loadReadCache<{ rooms: Array<{ id: string }> }>('/public/availability');
  assert.ok(cached);
  assert.equal(cached.data.rooms[0].id, 'r1');
  // Non-cacheable mutation/admin path should not be cached
  saveReadCache('/users', [{ id: 'u1' }]);
  assert.equal(loadReadCache('/users'), null);
});

test('createDebouncedBroadcaster coalesces rapid commits into a single WebSocket broadcast', async () => {
  let count = 0;
  const broadcaster = createDebouncedBroadcaster(() => {
    count += 1;
  }, 40);

  for (let i = 0; i < 15; i++) {
    broadcaster.trigger();
  }
  assert.equal(count, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(count, 1);
  broadcaster.cancel();
});

test('SlidingWindowRateLimiter enforces per-IP limits with Retry-After and router protects /api/public/*', async () => {
  const limiter = new SlidingWindowRateLimiter(3, 60_000);
  assert.equal(limiter.check('1.2.3.4', 1000).allowed, true);
  assert.equal(limiter.check('1.2.3.4', 2000).allowed, true);
  assert.equal(limiter.check('1.2.3.4', 3000).allowed, true);
  const blocked = limiter.check('1.2.3.4', 4000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedcare-resilience-'));
  const cluster = new BedcareCluster({ dataDir: tmpDir });
  seedDemoClusterIfEmpty(cluster);
  const app = express();
  app.use(express.json());
  app.use('/api', createBedcareRouter(cluster));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  try {
    const addr = server.address() as { port: number };
    const healthRes = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('cache-control'), 'no-store');
    const healthJson = (await healthRes.json()) as { ok: boolean };
    assert.equal(healthJson.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const node of cluster.nodes.values()) {
      node.db.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

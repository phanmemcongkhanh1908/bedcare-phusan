import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from '../src/server/demoData';
import { hashPassword } from '../src/server/crypto';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import {
  DEFAULT_ADMIN_ID,
  DEFAULT_ADMIN_USERNAME,
  isDefaultAdminAccount,
  validateUserDeleteRule,
  validateUserStatusRule,
  validateUserUpdateRule,
} from '../src/utils/userAccountRules';

function createTestHarness() {
  const cluster = new BedcareCluster({ inMemory: true });
  seedDemoClusterIfEmpty(cluster);
  ensureDefaultAdminAccount(cluster);
  const app = express();
  app.use(express.json());
  app.use('/api', createBedcareRouter(cluster));
  const server = http.createServer(app);
  return { cluster, server };
}

async function startHttp(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/api`;
}

test('userAccountRules strictly protects default admin/admin account from delete, lock, rename, or role downgrade', () => {
  const defaultAdmin = { id: DEFAULT_ADMIN_ID, username: DEFAULT_ADMIN_USERNAME, role: 'SUPER_ADMIN' as const };
  assert.equal(isDefaultAdminAccount(defaultAdmin), true);
  assert.equal(isDefaultAdminAccount({ id: 'usr-other', username: 'ADMIN' }), true);
  assert.equal(isDefaultAdminAccount({ id: 'usr-other', username: 'nhanvien1' }), false);

  const delCheck = validateUserDeleteRule({
    actorId: 'usr-superadmin',
    actorRole: 'SUPER_ADMIN',
    targetUser: defaultAdmin,
  });
  assert.equal(delCheck.allowed, false);
  assert.equal(delCheck.statusCode, 403);

  const lockCheck = validateUserStatusRule({
    actorId: 'usr-superadmin',
    actorRole: 'SUPER_ADMIN',
    targetUser: defaultAdmin,
    nextStatus: 'LOCKED',
  });
  assert.equal(lockCheck.allowed, false);
  assert.equal(lockCheck.statusCode, 403);

  const downgradeCheck = validateUserUpdateRule({
    actorRole: 'SUPER_ADMIN',
    targetUser: defaultAdmin,
    nextUsername: 'admin',
    nextRole: 'ADMIN',
  });
  assert.equal(downgradeCheck.allowed, false);
  assert.equal(downgradeCheck.statusCode, 403);

  const renameCheck = validateUserUpdateRule({
    actorRole: 'SUPER_ADMIN',
    targetUser: defaultAdmin,
    nextUsername: 'admin2',
    nextRole: 'SUPER_ADMIN',
  });
  assert.equal(renameCheck.allowed, false);
  assert.equal(renameCheck.statusCode, 403);
});

test('API guarantees admin/admin highest privilege, full CRUD, reset, lock/unlock, and 24h vitals in /admissions', async () => {
  const { cluster, server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);

    // 1. Default admin/admin can log in and has SUPER_ADMIN role
    const loginAdminRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(loginAdminRes.status, 200);
    const adminSession = (await loginAdminRes.json()) as {
      token: string;
      user: { id: string; username: string; role: string };
    };
    assert.equal(adminSession.user.username, 'admin');
    assert.equal(adminSession.user.role, 'SUPER_ADMIN');

    // 2. Verify GET /admissions works cleanly without 24h clinical vitals bloat
    const admRes = await fetch(`${baseUrl}/admissions`, {
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.equal(admRes.status, 200);
    const admissions = (await admRes.json()) as Array<Record<string, unknown>>;
    assert.ok(admissions.length > 0);
    assert.equal('vitals_24h' in admissions[0], false);

    // 3. Cannot delete, lock, or downgrade default admin account
    const delAdminRes = await fetch(`${baseUrl}/users/${adminSession.user.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.equal(delAdminRes.status, 403);

    const lockAdminRes = await fetch(`${baseUrl}/users/${adminSession.user.id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({ status: 'LOCKED' }),
    });
    assert.equal(lockAdminRes.status, 403);

    const downgradeAdminRes = await fetch(`${baseUrl}/users/${adminSession.user.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({ full_name: 'Admin Test', role: 'WARD_STAFF' }),
    });
    assert.equal(downgradeAdminRes.status, 403);

    // 4. Full CRUD + Reset Password + Lock/Unlock + Delete lifecycle for a staff user
    const createRes = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({
        username: 'dieuduong_test',
        password: 'pass1234',
        full_name: 'ĐD. Nguyễn Kiểm Thử',
        role: 'WARD_STAFF',
        department_id: 'dept-san-a',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { id: string };

    // Edit user full name and role
    const editRes = await fetch(`${baseUrl}/users/${created.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({
        username: 'dieuduong_test',
        full_name: 'ĐD. Nguyễn Kiểm Thử (Đã sửa)',
        role: 'CASHIER',
      }),
    });
    assert.equal(editRes.status, 200);

    // Reset password to default ('123456') and verify login with '123456'
    const resetRes = await fetch(`${baseUrl}/users/${created.id}/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(resetRes.status, 200);

    const loginNewRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dieuduong_test', password: '123456' }),
    });
    assert.equal(loginNewRes.status, 200);

    // Lock -> login rejected (403) -> Unlock -> login works (200)
    const lockUserRes = await fetch(`${baseUrl}/users/${created.id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({ status: 'LOCKED' }),
    });
    assert.equal(lockUserRes.status, 200);

    const lockedLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dieuduong_test', password: '123456' }),
    });
    assert.equal(lockedLoginRes.status, 403);

    const unlockUserRes = await fetch(`${baseUrl}/users/${created.id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(unlockUserRes.status, 200);

    // Delete non-admin user -> succeeds (200), then user disappears from list
    const delUserRes = await fetch(`${baseUrl}/users/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    assert.equal(delUserRes.status, 200);

    const listAfterRes = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${adminSession.token}` },
    });
    const listAfter = (await listAfterRes.json()) as Array<{ id: string }>;
    assert.equal(listAfter.some((u) => u.id === created.id), false);
    assert.equal(listAfter.some((u) => u.id === adminSession.user.id), true);

    // 5. Verify ensureDefaultAdminAccount auto-restores legacy Admin@2026 / ADMIN role to admin/admin SUPER_ADMIN
    const activeDb = cluster.getActiveNode().db;
    activeDb
      .prepare("UPDATE users SET role = 'ADMIN', status = 'LOCKED', password_hash = ? WHERE id = ?")
      .run(hashPassword('Admin@2026'), DEFAULT_ADMIN_ID);
    ensureDefaultAdminAccount(cluster);
    const restoredAdmin = activeDb.prepare('SELECT role, status FROM users WHERE id = ?').get(DEFAULT_ADMIN_ID) as {
      role: string;
      status: string;
    };
    assert.equal(restoredAdmin.role, 'SUPER_ADMIN');
    assert.equal(restoredAdmin.status, 'ACTIVE');
  } finally {
    server.close();
  }
});

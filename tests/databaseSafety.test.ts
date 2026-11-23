import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import {
  CLEAR_DEMO_CONFIRM_PHRASE,
  PURGE_DB_CONFIRM_PHRASE,
  describeBackupOrigin,
  isAutoSafetyBackupName,
  matchesConfirmPhrase,
  normalizeConfirmPhrase,
} from '../src/utils/databaseSafety';

function createTestHarness() {
  const cluster = new BedcareCluster({ inMemory: true });
  seedDemoClusterIfEmpty(cluster);
  ensureDefaultAdminAccount(cluster);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', createBedcareRouter(cluster));
  const server = http.createServer(app);
  return { cluster, server };
}

async function startHttp(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/api`;
}

async function loginAdmin(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { token: string };
  return json.token;
}

test('databaseSafety helpers normalize Vietnamese confirmation phrases and classify backup origins', () => {
  assert.equal(normalizeConfirmPhrase('  xác   nhận xóa demo  '), 'XAC NHAN XOA DEMO');
  assert.equal(matchesConfirmPhrase('Xác nhận xóa demo', CLEAR_DEMO_CONFIRM_PHRASE), true);
  assert.equal(matchesConfirmPhrase('XÓA DỮ LIỆU CSDL', PURGE_DB_CONFIRM_PHRASE), true);
  assert.equal(matchesConfirmPhrase('SAI CUM TU', CLEAR_DEMO_CONFIRM_PHRASE), false);

  assert.equal(isAutoSafetyBackupName('auto-pre-clear-demo-NODE-1.bcare'), true);
  assert.equal(isAutoSafetyBackupName('bedcare-backup-NODE-1.bcare'), false);
  assert.equal(describeBackupOrigin('auto-pre-clear-demo-NODE-1.bcare').code, 'PRE_CLEAR_DEMO');
  assert.equal(describeBackupOrigin('auto-pre-purge-db-NODE-1.bcare').code, 'PRE_PURGE_DB');
  assert.equal(describeBackupOrigin('auto-pre-restore-NODE-1.bcare').code, 'PRE_RESTORE');
  assert.equal(describeBackupOrigin('bedcare-backup-NODE-1.bcare').code, 'MANUAL');
});

test('clear-demo-data enforces password & confirmation phrase, saves auto-backup, and supports full cluster rollback', async () => {
  const { cluster, server } = createTestHarness();
  const baseUrl = await startHttp(server);
  try {
    const token = await loginAdmin(baseUrl);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const summaryBeforeRes = await fetch(`${baseUrl}/settings/database-safety-summary`, { headers });
    assert.equal(summaryBeforeRes.status, 200);
    const summaryBefore = (await summaryBeforeRes.json()) as {
      counts: { patients: number; activeAdmissions: number; departments: number };
    };
    assert.ok(summaryBefore.counts.patients > 0);
    assert.ok(summaryBefore.counts.activeAdmissions > 0);

    // 1. Reject wrong password
    const badPassRes = await fetch(`${baseUrl}/settings/clear-demo-data`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: 'wrong-password', confirmPhrase: CLEAR_DEMO_CONFIRM_PHRASE }),
    });
    assert.equal(badPassRes.status, 403);

    // 2. Reject wrong confirmation phrase
    const badPhraseRes = await fetch(`${baseUrl}/settings/clear-demo-data`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: 'admin', confirmPhrase: 'WRONG' }),
    });
    assert.equal(badPhraseRes.status, 400);

    // Ensure zero records were lost from rejected calls
    const db = cluster.getActiveNode().db;
    assert.equal(
      (db.prepare('SELECT COUNT(*) as c FROM patients').get() as { c: number }).c,
      summaryBefore.counts.patients
    );

    // 3. Valid clear-demo-data -> auto-creates pre-wipe backup & wipes operational rows while keeping catalogs/users
    const clearRes = await fetch(`${baseUrl}/settings/clear-demo-data`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: 'admin', confirmPhrase: 'Xác nhận xóa demo' }),
    });
    assert.equal(clearRes.status, 200);
    const clearJson = (await clearRes.json()) as {
      ok: boolean;
      safetyBackup: { id: string; backup_name: string; record_count: number };
    };
    assert.equal(clearJson.ok, true);
    assert.ok(clearJson.safetyBackup.backup_name.startsWith('auto-pre-clear-demo-'));

    assert.equal((db.prepare('SELECT COUNT(*) as c FROM patients').get() as { c: number }).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM admissions').get() as { c: number }).c, 0);
    assert.ok((db.prepare('SELECT COUNT(*) as c FROM departments').get() as { c: number }).c > 0);
    assert.ok((db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c > 0);

    // 4. Accidental wipe recovery -> restore-snapshot & /backups/:id/restore reject invalid/omitted passwords, then roll back across cluster & save pre-restore snapshot
    const noPassBackupRestore = await fetch(`${baseUrl}/backups/${clearJson.safetyBackup.id}/restore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(noPassBackupRestore.status, 403);

    const badRestorePass = await fetch(`${baseUrl}/settings/restore-snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ backupId: clearJson.safetyBackup.id, password: 'bad' }),
    });
    assert.equal(badRestorePass.status, 403);

    const restoreRes = await fetch(`${baseUrl}/settings/restore-snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ backupId: clearJson.safetyBackup.id, password: 'admin' }),
    });
    assert.equal(restoreRes.status, 200);
    const restoreJson = (await restoreRes.json()) as {
      ok: boolean;
      checksumVerified: boolean;
      preRestoreBackup: { id: string; backup_name: string };
    };
    assert.equal(restoreJson.ok, true);
    assert.equal(restoreJson.checksumVerified, true);
    assert.ok(restoreJson.preRestoreBackup.backup_name.startsWith('auto-pre-restore-'));

    for (const node of cluster.nodes.values()) {
      assert.equal(
        (node.db.prepare('SELECT COUNT(*) as c FROM patients').get() as { c: number }).c,
        summaryBefore.counts.patients
      );
      assert.equal(
        (node.db.prepare("SELECT COUNT(*) as c FROM admissions WHERE status = 'ACTIVE'").get() as { c: number }).c,
        summaryBefore.counts.activeAdmissions
      );
    }
  } finally {
    server.close();
  }
});

test('purge-database validates scope, preserves users/backups/catalogs, and restores cleanly', async () => {
  const { cluster, server } = createTestHarness();
  const baseUrl = await startHttp(server);
  try {
    const token = await loginAdmin(baseUrl);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const db = cluster.getActiveNode().db;
    db.prepare(
      `INSERT INTO his_bed_assignments
       (id, batch_id, his_assignment_id, his_record_code, patient_code, patient_name, date_of_birth, bhyt_card_no, his_dept_code, his_room_code, his_bed_code, his_bed_type_code, bed_ratio, bed_days_billed, admitted_at, status, synced_at)
       VALUES ('his-1', 'batch-1', 'ha-1', 'HS-1', 'BN-HIS-1', 'Bệnh nhân HIS', '1992-01-01', '', 'SAN', 'P101', 'S101-G01', 'H2', 1.0, 1.0, '2026-11-22T08:00:00.000Z', 'ACTIVE', '2026-11-22T08:00:00.000Z')`
    ).run();

    // 1. Purge OPERATIONAL_ONLY keeps HIS assignment intact
    const purgeOpsRes = await fetch(`${baseUrl}/settings/purge-database`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        password: 'admin',
        confirmPhrase: PURGE_DB_CONFIRM_PHRASE,
        scope: 'OPERATIONAL_ONLY',
      }),
    });
    assert.equal(purgeOpsRes.status, 200);
    const purgeOpsJson = (await purgeOpsRes.json()) as {
      safetyBackup: { id: string; backup_name: string };
    };
    assert.ok(purgeOpsJson.safetyBackup.backup_name.startsWith('auto-pre-purge-db-'));
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM patients').get() as { c: number }).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM his_bed_assignments').get() as { c: number }).c, 1);

    // 2. Purge OPERATIONAL_AND_HIS wipes HIS assignment as well, keeps users & backups
    const purgeAllRes = await fetch(`${baseUrl}/settings/purge-database`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        password: 'admin',
        confirmPhrase: 'xóa dữ liệu csdl',
        scope: 'OPERATIONAL_AND_HIS',
      }),
    });
    assert.equal(purgeAllRes.status, 200);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM his_bed_assignments').get() as { c: number }).c, 0);
    assert.ok((db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c >= 1);
    assert.ok((db.prepare('SELECT COUNT(*) as c FROM backups').get() as { c: number }).c >= 2);

    // 3. Roll back to pre-purge snapshot -> brings back BOTH operational patients & his_bed_assignments!
    const undoRes = await fetch(`${baseUrl}/settings/restore-snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ backupId: purgeOpsJson.safetyBackup.id, password: 'admin' }),
    });
    assert.equal(undoRes.status, 200);
    assert.ok((db.prepare('SELECT COUNT(*) as c FROM patients').get() as { c: number }).c > 0);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM his_bed_assignments').get() as { c: number }).c, 1);
  } finally {
    server.close();
  }
});

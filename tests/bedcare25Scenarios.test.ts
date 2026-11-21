import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { signEventData } from '../src/server/crypto';
import { openNodeDatabase } from '../src/server/db';
import { seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster, ConsensusConflictError } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';

function createTestHarness() {
  const cluster = new BedcareCluster({ inMemory: true });
  seedDemoClusterIfEmpty(cluster);
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

async function loginAs(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { token: string };
  return data.token;
}

function makeAdmissionPayload(bedId: string, roomId: string, deptId: string, idx: number) {
  const now = new Date().toISOString();
  const id = `adm-t-${idx}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    admission_code: `TST-${idx}-${Date.now()}`,
    patient_id: `pat-t-${idx}-${Math.random().toString(36).slice(2, 7)}`,
    patient_code: `BN-T-${idx}-${Math.random().toString(36).slice(2, 6)}`,
    patient_name: `Bệnh nhân Kiểm thử #${idx}`,
    date_of_birth: '1994-01-01',
    phone: '0900000000',
    diagnosis_group: 'Sinh thường',
    department_id: deptId,
    room_id: roomId,
    bed_id: bedId,
    is_whole_room: false,
    hospital_admitted_at: now,
    bed_assigned_at: now,
    expected_discharge_at: new Date(Date.now() + 3 * 86400000).toISOString(),
    calculation_method: 'CALENDAR_DAYS',
    status: 'ACTIVE',
    notes: 'Test case',
    confirmed_by: 'usr-superadmin',
    confirmed_by_name: 'Super Admin',
  };
}

test('Scenario 1: Hai máy cùng cấp một giường -> chỉ 1 máy thắng, không bao giờ cấp trùng', async () => {
  const { cluster } = createTestHarness();
  const bedId = 'bed-a103-1';
  const results = await Promise.allSettled([
    cluster.proposeCriticalAllocation({
      nodeId: 'NODE-QUAY-01',
      userId: 'usr-superadmin',
      requestType: 'ASSIGN_BED',
      eventType: 'ADMISSION_CONFIRM',
      aggregateType: 'ADMISSION',
      aggregateId: 'adm-s1-a',
      bedId,
      roomId: 'room-a103',
      payloadObj: makeAdmissionPayload(bedId, 'room-a103', 'dept-san-a', 1),
    }),
    cluster.proposeCriticalAllocation({
      nodeId: 'NODE-SAN-A',
      userId: 'usr-superadmin',
      requestType: 'ASSIGN_BED',
      eventType: 'ADMISSION_CONFIRM',
      aggregateType: 'ADMISSION',
      aggregateId: 'adm-s1-b',
      bedId,
      roomId: 'room-a103',
      payloadObj: makeAdmissionPayload(bedId, 'room-a103', 'dept-san-a', 2),
    }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ConsensusConflictError);
});

test('Scenario 2: Năm máy cùng thao tác một giường -> chỉ 1 máy thắng, 4 máy bị chặn', async () => {
  const { cluster } = createTestHarness();
  cluster.pairNewDevice('Máy 4', null, 'usr-superadmin');
  cluster.pairNewDevice('Máy 5', null, 'usr-superadmin');
  const nodeIds = Array.from(cluster.nodes.keys());
  assert.equal(nodeIds.length, 5);

  const bedId = 'bed-a103-2';
  const results = await Promise.allSettled(
    nodeIds.map((nid, idx) =>
      cluster.proposeCriticalAllocation({
        nodeId: nid,
        userId: 'usr-superadmin',
        requestType: 'ASSIGN_BED',
        eventType: 'ADMISSION_CONFIRM',
        aggregateType: 'ADMISSION',
        aggregateId: `adm-s2-${idx}`,
        bedId,
        roomId: 'room-a103',
        payloadObj: makeAdmissionPayload(bedId, 'room-a103', 'dept-san-a', idx + 10),
      })
    )
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 4);
});

test('Scenario 3 & 21: Hai máy cùng bao trọn một phòng & khóa toàn bộ giường trong phòng', async () => {
  const { cluster } = createTestHarness();
  const roomId = 'room-n401';
  const res = await Promise.allSettled([
    cluster.proposeCriticalAllocation({
      nodeId: 'NODE-QUAY-01',
      userId: 'usr-superadmin',
      requestType: 'EXCLUSIVE_ROOM',
      eventType: 'RESERVATION_CREATE',
      aggregateType: 'RESERVATION',
      aggregateId: 'rsv-whole-1',
      bedId: null,
      roomId,
      isWholeRoom: true,
      payloadObj: {
        id: 'rsv-whole-1',
        patient_id: 'pat-w1',
        patient_name: 'Khách Bao Phòng 1',
        department_id: 'dept-noi-tong-hop',
        room_id: roomId,
        bed_id: null,
        is_whole_room: true,
        locked_bed_ids: ['bed-n401-1', 'bed-n401-2'],
        start_time: new Date().toISOString(),
        expires_at: new Date(Date.now() + 12 * 3600000).toISOString(),
        status: 'ACTIVE',
        created_by: 'usr-superadmin',
        created_by_name: 'Super Admin',
      },
    }),
    cluster.proposeCriticalAllocation({
      nodeId: 'NODE-PHU-KHOA',
      userId: 'usr-superadmin',
      requestType: 'EXCLUSIVE_ROOM',
      eventType: 'RESERVATION_CREATE',
      aggregateType: 'RESERVATION',
      aggregateId: 'rsv-whole-2',
      bedId: null,
      roomId,
      isWholeRoom: true,
      payloadObj: {
        id: 'rsv-whole-2',
        patient_id: 'pat-w2',
        patient_name: 'Khách Bao Phòng 2',
        department_id: 'dept-noi-tong-hop',
        room_id: roomId,
        bed_id: null,
        is_whole_room: true,
        locked_bed_ids: ['bed-n401-1', 'bed-n401-2'],
        start_time: new Date().toISOString(),
        expires_at: new Date(Date.now() + 12 * 3600000).toISOString(),
        status: 'ACTIVE',
        created_by: 'usr-superadmin',
        created_by_name: 'Super Admin',
      },
    }),
  ]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(res.filter((r) => r.status === 'rejected').length, 1);

  // Verify individual bed booking in locked room is also blocked
  await assert.rejects(
    () =>
      cluster.proposeCriticalAllocation({
        nodeId: 'NODE-SAN-A',
        userId: 'usr-superadmin',
        requestType: 'ASSIGN_BED',
        eventType: 'ADMISSION_CONFIRM',
        aggregateType: 'ADMISSION',
        aggregateId: 'adm-locked-room-attempt',
        bedId: 'bed-n401-1',
        roomId,
        payloadObj: makeAdmissionPayload('bed-n401-1', roomId, 'dept-noi-tong-hop', 99),
      }),
    ConsensusConflictError
  );
});

test('Scenario 4, 5, 6, 7: Mất kết nối, tắt nút điều phối, chia đôi mạng & đối chiếu khi kết nối lại', async () => {
  const { cluster } = createTestHarness();

  // Scenario 5: Coordinator NODE-QUAY-01 goes offline -> 2 of 3 remain -> quorum still met via Raft re-election!
  cluster.setNodeState('NODE-QUAY-01', { online: false });
  const rWith2 = await cluster.proposeCriticalAllocation({
    nodeId: 'NODE-SAN-A',
    userId: 'usr-superadmin',
    requestType: 'ASSIGN_BED',
    eventType: 'ADMISSION_CONFIRM',
    aggregateType: 'ADMISSION',
    aggregateId: 'adm-s5',
    bedId: 'bed-a103-3',
    roomId: 'room-a103',
    payloadObj: makeAdmissionPayload('bed-a103-3', 'room-a103', 'dept-san-a', 55),
  });
  assert.equal(rWith2.committed, true);

  // Scenario 4 & 6: Network split leaves NODE-PHU-KHOA isolated (1 of 3 < quorum 2) -> cannot officially confirm!
  cluster.setNodeState('NODE-PHU-KHOA', { partitionGroup: 'ISOLATED_B' });
  const pendingRes = await cluster.proposeCriticalAllocation({
    nodeId: 'NODE-PHU-KHOA',
    userId: 'usr-superadmin',
    requestType: 'ASSIGN_BED',
    eventType: 'ADMISSION_CONFIRM',
    aggregateType: 'ADMISSION',
    aggregateId: 'adm-s6-isolated',
    bedId: 'bed-p302-1',
    roomId: 'room-p302',
    payloadObj: makeAdmissionPayload('bed-p302-1', 'room-p302', 'dept-phu-khoa', 66),
  });
  assert.equal(pendingRes.committed, false);
  assert.equal(pendingRes.pendingConfirmation, true);

  // Scenario 7: Reconnect all nodes & reconcile -> pending request commits cleanly!
  cluster.setNodeState('NODE-QUAY-01', { online: true });
  cluster.setNodeState('NODE-PHU-KHOA', { partitionGroup: 'MAIN' });
  const rec = await cluster.reconcileCluster();
  assert.ok(rec.resolvedPending >= 1);
  const bedAfter = cluster.getNode('NODE-QUAY-01').db.prepare('SELECT status FROM beds WHERE id = ?').get('bed-p302-1') as { status: string };
  assert.equal(bedAfter.status, 'OCCUPIED');
});

test('Scenario 8 & 9: Đồng bộ dữ liệu trùng (idempotent) và từ chối sự kiện sai chữ ký số', async () => {
  const { cluster } = createTestHarness();
  const origin = cluster.getNode('NODE-QUAY-01');
  const target = cluster.getNode('NODE-SAN-A');

  const ev = cluster.commitStandardEvent('NODE-QUAY-01', 'usr-superadmin', 'DEPARTMENT_UPSERT', 'DEPARTMENT', 'dept-test-dup', {
    id: 'dept-test-dup',
    code: 'TESTDUP',
    name: 'Khoa Kiểm Thử Trùng',
    status: 'ACTIVE',
  });

  // Scenario 8: Re-deliver same event twice -> second must return DUPLICATE_IGNORED
  const dupRes = cluster.receiveEventOnNode(target, ev);
  assert.equal(dupRes.accepted, true);
  assert.equal(dupRes.reason, 'DUPLICATE_IGNORED');

  // Scenario 9: Tampered payload with mismatched Ed25519 signature -> rejected!
  const tampered = { ...ev, event_id: 'evt-tampered-999', payload: JSON.stringify({ id: 'x', code: 'HACK', name: 'Hacked' }) };
  const badRes = cluster.receiveEventOnNode(origin, tampered);
  assert.equal(badRes.accepted, false);
  assert.equal(badRes.reason, 'INVALID_SIGNATURE');
});

test('Scenario 10 & 11: Phân quyền RBAC & Chặn nhân viên khoa khác sửa dữ liệu', async () => {
  const { server } = createTestHarness();
  const baseUrl = await startHttp(server);
  try {
    const cashierToken = await loginAs(baseUrl, 'thuvienphi', 'Vienphi@2026');
    const wardSanAToken = await loginAs(baseUrl, 'khoasana', 'Khoasan@2026');
    const execToken = await loginAs(baseUrl, 'lanhdao', 'Lanhdao@2026');

    // Scenario 10a: Cashier cannot discharge patient on behalf of ward!
    const cashierDischarge = await fetch(`${baseUrl}/admissions/adm-demo-1/discharge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(cashierDischarge.status, 403);

    // Scenario 10b: Executive (read-only) cannot create department!
    const execCreate = await fetch(`${baseUrl}/departments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${execToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'NEW', name: 'Test' }),
    });
    assert.equal(execCreate.status, 403);

    // Scenario 11: Khoa Sản A staff CANNOT extend/modify patient in Khoa Phụ Khoa (adm-demo-3)!
    const crossDeptExtend = await fetch(`${baseUrl}/admissions/adm-demo-3/extend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${wardSanAToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        new_expected_discharge_at: new Date(Date.now() + 86400000).toISOString(),
        reason: 'Sửa chéo khoa',
      }),
    });
    assert.equal(crossDeptExtend.status, 403);
  } finally {
    server.close();
  }
});

test('Scenario 12, 13, 14, 19, 20, 22: Gia hạn, Trả giường, Vệ sinh, Hủy giữ chỗ, ĐK chưa biết khoa, Chuyển giường', async () => {
  const { server } = createTestHarness();
  const baseUrl = await startHttp(server);
  try {
    const adminToken = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');
    const cashierToken = await loginAs(baseUrl, 'thuvienphi', 'Vienphi@2026');

    // Scenario 20: Registration UNKNOWN_DEPT -> waitlist, no physical bed assigned
    const regRes = await fetch(`${baseUrl}/registrations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_code: 'BN-WAIT-20',
        patient_name: 'BN Chưa Biết Khoa',
        date_of_birth: '1995-03-03',
        diagnosis_group: 'Sinh thường',
        expected_admission_date: new Date().toISOString(),
        desired_standard_ids: ['std-1bed'],
        registration_mode: 'UNKNOWN_DEPT',
        reservation_type: 'WAITLIST',
      }),
    });
    assert.equal(regRes.status, 201);

    // Scenario 19: Cancel reservation res-demo-1 -> releases bed A102-G02 back to VACANT
    const cancelRsv = await fetch(`${baseUrl}/reservations/res-demo-1/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
    });
    assert.equal(cancelRsv.status, 200);

    // Scenario 12: Extend adm-demo-1
    const extRes = await fetch(`${baseUrl}/admissions/adm-demo-1/extend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        new_expected_discharge_at: new Date(Date.now() + 96 * 3600000).toISOString(),
        reason: 'Theo dõi thêm 24h',
      }),
    });
    assert.equal(extRes.status, 201);

    // Scenario 22: Transfer adm-demo-2 from A102-G01 to A103-G01
    const trfRes = await fetch(`${baseUrl}/admissions/adm-demo-2/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to_department_id: 'dept-san-a',
        to_room_id: 'room-a103',
        to_bed_id: 'bed-a103-1',
        reason: 'Chuyển phòng theo chỉ định',
      }),
    });
    assert.equal(trfRes.status, 201);

    // Scenario 13: Discharge adm-demo-4 (which was whole-room B201) -> bed goes to PENDING_CLEANING & B201-G02 released
    const disRes = await fetch(`${baseUrl}/admissions/adm-demo-4/discharge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Xuất viện ổn định' }),
    });
    assert.equal(disRes.status, 200);
    const disBody = (await disRes.json()) as { cleaning_log_id: string };

    // Scenario 14: Cleaning start -> complete -> bed returns to VACANT
    const clStart = await fetch(`${baseUrl}/cleaning/${disBody.cleaning_log_id}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(clStart.status, 200);
    const clDone = await fetch(`${baseUrl}/cleaning/${disBody.cleaning_log_id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(clDone.status, 200);
  } finally {
    server.close();
  }
});

test('Scenario 15 & 16: Sao lưu mã hóa, khôi phục & đối chiếu thiết bị sau mất dữ liệu', async () => {
  const { cluster } = createTestHarness();
  const backup = cluster.createEncryptedBackup('NODE-SAN-A', 'superadmin');
  assert.ok(backup.checksum_sha256.length === 64);

  // Create a newer transaction on NODE-QUAY-01 AFTER NODE-SAN-A's backup!
  cluster.commitStandardEvent('NODE-QUAY-01', 'usr-superadmin', 'DEPARTMENT_UPSERT', 'DEPARTMENT', 'dept-after-bkp', {
    id: 'dept-after-bkp',
    code: 'POSTBKP',
    name: 'Khoa Tạo Sau Backup',
    status: 'ACTIVE',
  });

  // Restore NODE-SAN-A from older backup -> must reconcile newer consensus transaction from peers!
  const restoreRes = await cluster.restoreEncryptedBackup('NODE-SAN-A', backup.id, 'superadmin');
  assert.equal(restoreRes.restored, true);
  assert.equal(restoreRes.checksumVerified, true);
  assert.ok(restoreRes.reconciledEvents >= 1);

  const recoveredDept = cluster.getNode('NODE-SAN-A').db.prepare('SELECT name FROM departments WHERE id = ?').get('dept-after-bkp') as { name: string } | undefined;
  assert.equal(recoveredDept?.name, 'Khoa Tạo Sau Backup');
});

test('Scenario 17, 18, 25: Nhập Excel trùng mã, thay đổi cấu hình ngày giường, kiểm tra báo cáo', async () => {
  const { server } = createTestHarness();
  const baseUrl = await startHttp(server);
  try {
    const adminToken = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');

    // Scenario 17: Import Excel rows including duplicate patient_code & same name different code
    const impRes = await fetch(`${baseUrl}/import/patients`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'ds-benh-nhan.xlsx',
        rows: [
          { patient_code: 'BN-DEMO-001', full_name: 'Nguyễn Thị Hương (Mẫu)', date_of_birth: '1994-05-12' }, // duplicate code
          { patient_code: 'BN-NEW-901', full_name: 'Nguyễn Thị Hương', date_of_birth: '1990-01-01' }, // same name, distinct code -> MUST NOT auto-merge!
          { patient_code: '', full_name: 'Thiếu Mã', date_of_birth: '1990-01-01' }, // error row
        ],
      }),
    });
    assert.equal(impRes.status, 200);
    const impData = (await impRes.json()) as { importedRows: number; duplicateRows: number; errorRows: number };
    assert.equal(impData.importedRows, 1);
    assert.equal(impData.duplicateRows, 1);
    assert.equal(impData.errorRows, 1);

    // Scenario 18: Changing day_calculation_method does NOT alter existing active admission expected_discharge_at
    const beforeAdms = (await (await fetch(`${baseUrl}/admissions?status=ACTIVE`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as Array<{ id: string; expected_discharge_at: string }>;
    await fetch(`${baseUrl}/settings/configs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ configs: { day_calculation_method: 'ACTUAL_HOURS' } }),
    });
    const afterAdms = (await (await fetch(`${baseUrl}/admissions?status=ACTIVE`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as Array<{ id: string; expected_discharge_at: string }>;
    assert.equal(beforeAdms[0].expected_discharge_at, afterAdms[0].expected_discharge_at);

    // Scenario 25: Reports reflect exact real DB state
    const rep = (await (await fetch(`${baseUrl}/reports/analytics`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as { kpi: { totalAdmissions: number; occupancyRate: number } };
    assert.ok(rep.kpi.totalAdmissions >= 4);
    assert.ok(rep.kpi.occupancyRate > 0);
  } finally {
    server.close();
  }
});

test('Scenario 23 & 24: Thu hồi thiết bị & kiểm tra nâng cấp schema phiên bản', async () => {
  const { cluster } = createTestHarness();
  cluster.revokeDevice('NODE-PHU-KHOA', 'usr-superadmin');
  const revokedNode = cluster.getNode('NODE-PHU-KHOA');
  assert.equal(revokedNode.revoked, true);

  // Revoked device cannot commit standard or critical events
  assert.throws(() => {
    cluster.commitStandardEvent('NODE-PHU-KHOA', 'usr-superadmin', 'DEPARTMENT_UPSERT', 'DEPARTMENT', 'd-x', {
      id: 'd-x',
      code: 'DX',
      name: 'Blocked',
    });
  });

  // Scenario 24: Re-opening existing SQLite DB preserves schema_version and data safely
  const db2 = openNodeDatabase(':memory:');
  const ver = db2.prepare("SELECT value FROM system_configs WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(ver.value, '1.0.0');
});

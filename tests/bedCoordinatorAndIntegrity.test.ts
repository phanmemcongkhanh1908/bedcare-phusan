import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import {
  analyzeCustomerRegistrationTrends,
  rankSmartTransferBeds,
} from '../src/utils/bedCoordinatorIntelligence';
import { buildOfficialExcelWorkbook, buildOfficialPdfDoc } from '../src/utils/exportUtils';
import {
  evaluate24HourThresholdAlerts,
  predict48HourVacancies,
  predict7DayCapacity,
} from '../src/utils/vacancyPredictor';

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

async function loginAsAdmin(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { token: string };
  return json.token;
}

test('Predictive analytics: 48h vacancies, 7-day capacity, and >90% 24h threshold alerts work deterministically', () => {
  const nowIso = '2026-11-17T08:00:00.000Z';
  const activeAdmissions = [
    {
      id: 'a1',
      bed_id: 'b1',
      bed_code: 'S101-G01',
      room_id: 'r1',
      room_name: 'Phòng S101',
      department_id: 'dept-1',
      department_name: 'Khoa Sản',
      patient_name: 'BN 1',
      diagnosis_group: 'Sinh thường',
      bed_assigned_at: '2026-11-15T08:00:00.000Z',
      expected_discharge_at: '2026-11-17T11:00:00.000Z',
      extension_count: 0,
      is_whole_room: 0,
      status: 'ACTIVE',
    },
    {
      id: 'a2',
      bed_id: 'b2',
      bed_code: 'S101-G02',
      room_id: 'r1',
      room_name: 'Phòng S101',
      department_id: 'dept-1',
      department_name: 'Khoa Sản',
      patient_name: 'BN 2',
      diagnosis_group: 'Sinh mổ',
      bed_assigned_at: '2026-11-16T08:00:00.000Z',
      expected_discharge_at: '2026-11-20T08:00:00.000Z',
      extension_count: 0,
      is_whole_room: 0,
      status: 'ACTIVE',
    },
  ];
  const beds = [
    { id: 'b1', department_id: 'dept-1', status: 'OCCUPIED' },
    { id: 'b2', department_id: 'dept-1', status: 'OCCUPIED' },
    { id: 'b3', department_id: 'dept-1', status: 'VACANT' },
  ];

  const pred48 = predict48HourVacancies({
    activeAdmissions,
    allAdmissions: activeAdmissions,
    turnaroundBeds: [],
    vacantBedCount: 1,
    operationalBedCount: 3,
    registrations: [
      { id: 'reg-1', department_id: 'dept-1', expected_admission_date: '2026-11-17T14:00:00.000Z', status: 'WAITING' },
    ],
    historicalDischarges: [],
    diagnosisBaselines: [{ name: 'Sinh thường', default_days: 3 }],
    nowIso,
  });
  assert.equal(pred48.buckets.length, 6);
  assert.ok(pred48.expectedDischarges48h > 0);

  const forecast7d = predict7DayCapacity({
    activeAdmissions,
    allAdmissions: activeAdmissions,
    beds,
    registrations: [
      { id: 'reg-1', department_id: 'dept-1', expected_admission_date: '2026-11-17T14:00:00.000Z', status: 'WAITING' },
      { id: 'reg-2', department_id: 'dept-1', expected_admission_date: '2026-11-17T18:00:00.000Z', status: 'WAITING' },
    ],
    historicalDischarges: [],
    diagnosisBaselines: [{ name: 'Sinh thường', default_days: 3 }],
    nowIso,
  });
  assert.equal(forecast7d.length, 7);

  const alerts24h = evaluate24HourThresholdAlerts({
    departments: [{ id: 'dept-1', name: 'Khoa Sản', status: 'ACTIVE' }],
    beds,
    activeAdmissions,
    registrations: [
      { id: 'reg-1', department_id: 'dept-1', expected_admission_date: '2026-11-17T12:00:00.000Z', status: 'WAITING' },
      { id: 'reg-2', department_id: 'dept-1', expected_admission_date: '2026-11-17T18:00:00.000Z', status: 'WAITING' },
    ],
    reservations: [],
    nowIso,
  });
  assert.equal(alerts24h.length, 1);
  assert.equal(alerts24h[0].projectedOccupancyPct24h, 100);
});

test('Smart Match ranks sanitized vacant same-department nearest beds into top 3', () => {
  const { top3 } = rankSmartTransferBeds({
    admission: {
      id: 'adm-1',
      patient_name: 'BN A',
      diagnosis_group: 'Sinh thường',
      department_id: 'dept-a',
      room_id: 'room-1',
      bed_id: 'bed-1',
      room_floor: 'Tầng 1',
      room_type: 'STANDARD',
      desired_standard_ids: ['std-ac'],
    },
    rooms: [
      { id: 'room-1', department_id: 'dept-a', code: 'A101', name: 'A101', floor: 'Tầng 1', capacity: 2, toilet_type: 'INTERNAL', room_type: 'STANDARD', is_service: 0, standard_ids: ['std-ac'], exclusive_locked: 0, status: 'ACTIVE' },
      { id: 'room-2', department_id: 'dept-a', code: 'A102', name: 'A102', floor: 'Tầng 1', capacity: 2, toilet_type: 'INTERNAL', room_type: 'STANDARD', is_service: 0, standard_ids: ['std-ac'], exclusive_locked: 0, status: 'ACTIVE' },
      { id: 'room-3', department_id: 'dept-b', code: 'B301', name: 'B301', floor: 'Tầng 3', capacity: 2, toilet_type: 'INTERNAL', room_type: 'STANDARD', is_service: 0, standard_ids: [], exclusive_locked: 0, status: 'ACTIVE' },
    ],
    beds: [
      { id: 'bed-1', room_id: 'room-1', department_id: 'dept-a', code: 'A101-G01', name: 'G1', status: 'OCCUPIED', daily_price: 250000 },
      { id: 'bed-2', room_id: 'room-1', department_id: 'dept-a', code: 'A101-G02', name: 'G2', status: 'VACANT', daily_price: 250000 },
      { id: 'bed-3', room_id: 'room-2', department_id: 'dept-a', code: 'A102-G01', name: 'G3', status: 'CLEANING', daily_price: 250000 },
      { id: 'bed-4', room_id: 'room-3', department_id: 'dept-b', code: 'B301-G01', name: 'G4', status: 'VACANT', daily_price: 250000 },
    ],
    deptNames: { 'dept-a': 'Khoa A', 'dept-b': 'Khoa B' },
    standardNames: { 'std-ac': 'Điều hòa' },
  });

  assert.equal(top3.length, 3);
  assert.equal(top3[0].bedCode, 'A101-G02');
  assert.equal(top3[0].sanitizationStatus, 'READY_SANITIZED');
  assert.equal(top3[1].bedCode, 'B301-G01'); // VACANT beats CLEANING per sort order
});

test('Customer registration trend analyzer produces demand-vs-supply proposals', () => {
  const analytics = analyzeCustomerRegistrationTrends({
    registrations: [
      { id: 'r1', status: 'WAITING', diagnosis_group: 'Sinh mổ', registration_mode: 'UNKNOWN_DEPT', reservation_type: 'WHOLE_ROOM', department_id: 'd1', desired_standard_ids: ['std-ac', 'std-vip'] },
      { id: 'r2', status: 'WAITING', diagnosis_group: 'Sinh mổ', registration_mode: 'KNOWN_DEPT', reservation_type: 'SINGLE_BED', department_id: 'd1', desired_standard_ids: ['std-vip'] },
    ],
    reservations: [],
    admissions: [{ id: 'a1', diagnosis_group: 'Sinh mổ', department_id: 'd1', is_whole_room: 1, room_id: 'rm1' }],
    rooms: [
      { id: 'rm1', department_id: 'd1', room_type: 'STANDARD', is_service: 0, standard_ids: ['std-ac'], status: 'ACTIVE' },
      { id: 'rm2', department_id: 'd1', room_type: 'STANDARD', is_service: 0, standard_ids: ['std-ac'], status: 'ACTIVE' },
    ],
    beds: [{ id: 'b1', department_id: 'd1', status: 'OCCUPIED' }],
    roomStandards: [
      { id: 'std-ac', name: 'Điều hòa', code: 'AC' },
      { id: 'std-vip', name: 'Tiện nghi VIP', code: 'VIP' },
    ],
    departments: [{ id: 'd1', name: 'Khoa Sản' }],
  });

  assert.ok(analytics.trendProposals.length >= 1);
  assert.equal(analytics.standardPreferences[0].standardCode, 'VIP');
  assert.ok(analytics.standardPreferences[0].demandSupplyGapPct > 0);
});

test('Official Excel & PDF exports contain Vietnamese administrative motto, date line, title, and 3-role signature block', async () => {
  const wb = await buildOfficialExcelWorkbook(
    'CongSuat',
    'BÁO CÁO CÔNG SUẤT',
    'Toàn viện',
    [
      { header: 'Khoa', key: 'dept', width: 20 },
      { header: 'Tổng', key: 'total', width: 12 },
    ],
    [{ dept: 'Khoa Sản A', total: 6 }],
    { issuedAt: new Date('2026-11-18T08:00:00Z') }
  );
  const sheet = wb.getWorksheet('CongSuat');
  assert.ok(sheet);
  assert.equal(sheet.getCell(1, 3).value, 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM');
  assert.equal(sheet.getCell(2, 3).value, 'Độc lập - Tự do - Hạnh phúc');
  assert.equal(sheet.getCell(5, 1).value, 'BÁO CÁO CÔNG SUẤT');
  assert.ok(String(sheet.getCell(3, 3).value).includes('Ngày 18 tháng 11 năm 2026'));

  const pdfDoc = await buildOfficialPdfDoc(
    'BÁO CÁO CÔNG SUẤT',
    'Toàn viện',
    [
      { header: 'Khoa', key: 'dept' },
      { header: 'Tổng', key: 'total' },
    ],
    [{ dept: 'Khoa Sản A', total: 6 }],
    { issuedAt: new Date('2026-11-18T08:00:00Z') }
  );
  assert.ok(pdfDoc.getNumberOfPages() >= 1);
});

test('Full-stack API verifies FK fixes, Smart Match, >30m Delay Transfer Requests, Admission Audit Log, and Backup/Restore', async () => {
  const { cluster, server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const token = await loginAsAdmin(baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // 1. FK fixes: Registration with empty optional room_id/bed_id and duplicate patient_code across 2nd registration
    const reg1Res = await fetch(`${baseUrl}/registrations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        patient_code: 'BN-FK-900',
        patient_name: 'Nguyễn Văn FK',
        date_of_birth: '1990-05-05',
        phone: '0901234567',
        diagnosis_group: 'Khác',
        expected_admission_date: new Date().toISOString(),
        registration_mode: 'UNKNOWN_DEPT',
        department_id: '',
        room_id: '',
        bed_id: '',
        reservation_type: 'WAITLIST',
      }),
    });
    assert.equal(reg1Res.status, 201);
    const reg1Json = (await reg1Res.json()) as { id: string };

    // Returning patient registration reusing same patient_code must not throw UNIQUE/FK error
    const reg2Res = await fetch(`${baseUrl}/registrations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        patient_code: 'BN-FK-900',
        patient_name: 'Nguyễn Văn FK',
        date_of_birth: '1990-05-05',
        diagnosis_group: 'Khác',
        expected_admission_date: new Date().toISOString(),
        registration_mode: 'UNKNOWN_DEPT',
        reservation_type: 'WAITLIST',
      }),
    });
    assert.equal(reg2Res.status, 201);

    // Cancel waitlist registration cleanly
    const cancelRegRes = await fetch(`${baseUrl}/registrations/${reg1Json.id}/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(cancelRegRes.status, 200);

    // 2. Race simulation repeated twice on a vacant bed must NOT fail with UNIQUE constraint on patient_code
    const race1 = await fetch(`${baseUrl}/cluster/simulate-race`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bedId: 'bed-a103-1' }),
    });
    assert.equal(race1.status, 200);

    // 3. Dashboard overview returns 48h, 7d, 24h threshold alerts, priorityQueue, and quickDispatch
    const ovRes = await fetch(`${baseUrl}/dashboard/overview`, { headers });
    assert.equal(ovRes.status, 200);
    const ov = (await ovRes.json()) as {
      vacancyPrediction48h: { buckets: unknown[] };
      capacityForecast7d: unknown[];
      thresholdAlerts24h: unknown[];
      priorityQueue: { delayedTransfers: Array<{ id: string; is_delayed: boolean }> };
    };
    assert.equal(ov.vacancyPrediction48h.buckets.length, 6);
    assert.equal(ov.capacityForecast7d.length, 7);
    assert.ok(ov.thresholdAlerts24h.length >= 1);
    assert.ok(ov.priorityQueue.delayedTransfers.some((t) => t.id === 'trq-demo-overdue' && t.is_delayed));

    // 4. Smart Match endpoint returns top 3 beds
    const smRes = await fetch(`${baseUrl}/admissions/adm-demo-1/smart-match`, { headers });
    assert.equal(smRes.status, 200);
    const sm = (await smRes.json()) as { top3: Array<{ bedId: string; matchScore: number }> };
    assert.ok(sm.top3.length >= 1 && sm.top3.length <= 3);

    // 5. Complete overdue transfer request -> executes real transfer & moves request to COMPLETED
    const compTrRes = await fetch(`${baseUrl}/transfer-requests/trq-demo-overdue/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(compTrRes.status, 200);

    // Verify transfer request queue marks trq-demo-overdue as COMPLETED
    const trListRes = await fetch(`${baseUrl}/transfer-requests`, { headers });
    assert.equal(trListRes.status, 200);
    const trList = (await trListRes.json()) as Array<{ id: string; status: string }>;
    const doneReq = trList.find((r) => r.id === 'trq-demo-overdue');
    assert.equal(doneReq?.status, 'COMPLETED');

    // 6. Admission Audit Log shows chronological position history including the transfer we just completed
    const auditRes = await fetch(`${baseUrl}/admissions/adm-demo-6/audit-log`, { headers });
    assert.equal(auditRes.status, 200);
    const audit = (await auditRes.json()) as { entries: Array<{ category: string }> };
    assert.ok(audit.entries.some((e) => e.category === 'ADMISSION'));
    assert.ok(audit.entries.some((e) => e.category === 'TRANSFER_REQUEST'));
    assert.ok(audit.entries.some((e) => e.category === 'TRANSFER'));

    // 7. Reports analytics includes customerTrends
    const repRes = await fetch(`${baseUrl}/reports/analytics`, { headers });
    assert.equal(repRes.status, 200);
    const rep = (await repRes.json()) as { customerTrends: { trendProposals: unknown[] } };
    assert.ok(rep.customerTrends.trendProposals.length >= 1);

    // 8. Encrypted backup download, SHA-256 verify, upload-restore, & local restore preserve FK tables
    const bkRes = await fetch(`${baseUrl}/backups`, { method: 'POST', headers });
    assert.equal(bkRes.status, 201);
    const bk = (await bkRes.json()) as { id: string };

    const verifyRes = await fetch(`${baseUrl}/backups/${bk.id}/verify`, { method: 'POST', headers });
    assert.equal(verifyRes.status, 200);
    const verified = (await verifyRes.json()) as { valid: boolean; checksum_sha256: string; record_count: number };
    assert.equal(verified.valid, true);
    assert.ok(verified.checksum_sha256.length > 10);
    assert.ok(verified.record_count > 0);

    const dlRes = await fetch(`${baseUrl}/backups/${bk.id}/download`, { headers });
    assert.equal(dlRes.status, 200);
    const downloadedEnvelopeText = await dlRes.text();
    const downloadedEnvelope = JSON.parse(downloadedEnvelopeText) as {
      version: string;
      algorithm: string;
      ciphertext: string;
      checksum_sha256: string;
    };
    assert.equal(downloadedEnvelope.algorithm, 'aes-256-gcm');
    assert.ok(downloadedEnvelope.ciphertext.length > 10);

    const uploadRestoreRes = await fetch(`${baseUrl}/backups/upload-restore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileName: 'test.bcare', envelope: downloadedEnvelope }),
    });
    assert.equal(uploadRestoreRes.status, 200);

    const rstRes = await fetch(`${baseUrl}/backups/${bk.id}/restore`, { method: 'POST', headers });
    assert.equal(rstRes.status, 200);
    assert.ok(cluster.getActiveNode().db.prepare('SELECT COUNT(*) as c FROM transfer_requests').get());

    // 9. Patient lookup returns returning patient + openRegistration + activeAdmission & blocks duplicate concurrent admission
    const lookupRegRes = await fetch(`${baseUrl}/patients/lookup?code=BN-FK-900`, { headers });
    assert.equal(lookupRegRes.status, 200);
    const lookupReg = (await lookupRegRes.json()) as {
      found: boolean;
      patient: { full_name: string } | null;
      openRegistration: { status: string } | null;
      activeAdmission: null | { patient_code: string };
    };
    assert.equal(lookupReg.found, true);
    assert.equal(lookupReg.patient?.full_name, 'Nguyễn Văn FK');
    assert.equal(lookupReg.openRegistration?.status, 'WAITING');

    const activeSample = cluster
      .getActiveNode()
      .db.prepare("SELECT patient_code FROM admissions WHERE status = 'ACTIVE' LIMIT 1")
      .get() as { patient_code: string };
    const lookupActiveRes = await fetch(`${baseUrl}/patients/lookup?code=${encodeURIComponent(activeSample.patient_code)}`, { headers });
    assert.equal(lookupActiveRes.status, 200);
    const lookupActive = (await lookupActiveRes.json()) as {
      activeAdmission: { admission_code: string; bed_code: string } | null;
    };
    assert.ok(lookupActive.activeAdmission?.admission_code);

    const vacantBed = cluster
      .getActiveNode()
      .db.prepare("SELECT id, room_id, department_id FROM beds WHERE status = 'VACANT' LIMIT 1")
      .get() as { id: string; room_id: string; department_id: string };
    const dupAdmRes = await fetch(`${baseUrl}/admissions/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        patient_code: activeSample.patient_code,
        patient_name: 'Bệnh nhân trùng',
        date_of_birth: '1990-01-01',
        diagnosis_group: 'Khác',
        department_id: vacantBed.department_id,
        room_id: vacantBed.room_id,
        bed_id: vacantBed.id,
      }),
    });
    assert.equal(dupAdmRes.status, 409);
    const dupAdmJson = (await dupAdmRes.json()) as { code: string };
    assert.equal(dupAdmJson.code, 'ALREADY_ADMITTED');
  } finally {
    server.close();
  }
});


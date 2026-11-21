import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import type { Admission, Bed, Department, HisBedAssignment, HisBedMapping, Room } from '../src/types/bedcare';
import { evaluateHisAndBhytCompliance, parseHisPayloadInput } from '../src/utils/hisAuditEngine';

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

async function loginAs(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    token: string;
    user: { id: string; username: string; role: string; his_permission?: string };
  };
}

test('parseHisPayloadInput parses standard JSON, XML-130 Vietnamese CSV keys, and semicolon CSV', () => {
  const csv = [
    'MA_LK;MA_BN;HO_TEN;MA_THE;MA_KHOA;MA_PHONG;MA_GIUONG;MA_LOAI_GIUONG;TY_LE_GIUONG;SO_NGAY_GIUONG;TRANG_THAI',
    'LK-001;BN-001;Nguyễn Thị An;DN4792211001122;K15;A101;HIS-K15-A101-G01;H2;0.5;2;ACTIVE',
    'LK-002;BN-002;Trần Văn Bình;TE1792400110001;K15;A101;HIS-K15-A101-G01;G_GH;0.5;1;ACTIVE',
  ].join('\n');

  const parsed = parseHisPayloadInput(csv, '2026-06-01T08:00:00.000Z');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].his_record_code, 'LK-001');
  assert.equal(parsed[0].patient_name, 'Nguyễn Thị An');
  assert.equal(parsed[0].his_bed_code, 'HIS-K15-A101-G01');
  assert.equal(parsed[0].bed_ratio, 0.5);
  assert.equal(parsed[1].his_bed_type_code, 'G_GH');
  assert.equal(parsed[1].bed_days_billed, 1);

  const jsonWrapped = parseHisPayloadInput({
    records: [
      {
        his_record_code: 'LK-003',
        patient_name: 'Lê Hoàng',
        his_dept_code: 'K01',
        his_bed_code: 'HIS-K01-C101-G01',
        his_bed_type_code: 'H1',
      },
    ],
  });
  assert.equal(jsonWrapped.length, 1);
  assert.equal(jsonWrapped[0].his_bed_type_code, 'H1');
});

test('evaluateHisAndBhytCompliance flags duplicate beds, irrational assignments, and planned BHYT quota overage', () => {
  const nowIso = '2026-06-05T10:00:00.000Z';
  const departments: Department[] = [
    {
      id: 'dept-1',
      code: 'SAN_A',
      name: 'Khoa Sản A',
      description: '',
      status: 'ACTIVE',
      created_at: nowIso,
      updated_at: nowIso,
      his_dept_code: 'K15',
      planned_bhyt_beds: 2,
      max_bhyt_overage_pct: 120,
    },
    {
      id: 'dept-other',
      code: 'NGOAI',
      name: 'Khoa Ngoại',
      description: '',
      status: 'ACTIVE',
      created_at: nowIso,
      updated_at: nowIso,
      his_dept_code: 'K02',
      planned_bhyt_beds: 4,
      max_bhyt_overage_pct: 120,
    },
  ];

  const rooms: Room[] = [
    {
      id: 'room-std',
      department_id: 'dept-1',
      code: 'A101',
      name: 'Phòng A101',
      floor: 'Tầng 1',
      capacity: 2,
      toilet_type: 'INTERNAL',
      room_type: 'STANDARD',
      is_service: 0,
      standard_ids: [],
      exclusive_locked: 0,
      status: 'ACTIVE',
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: 'room-vip',
      department_id: 'dept-1',
      code: 'A102',
      name: 'Phòng VIP A102',
      floor: 'Tầng 1',
      capacity: 1,
      toilet_type: 'INTERNAL',
      room_type: 'VIP',
      is_service: 1,
      standard_ids: [],
      exclusive_locked: 1,
      status: 'ACTIVE',
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  const beds: Bed[] = [
    {
      id: 'b-1',
      room_id: 'room-std',
      department_id: 'dept-1',
      code: 'A101-G01',
      name: 'Giường 1',
      status: 'OCCUPIED',
      daily_price: 250000,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: 'b-2',
      room_id: 'room-std',
      department_id: 'dept-1',
      code: 'A101-G02',
      name: 'Giường 2',
      status: 'MAINTENANCE',
      daily_price: 250000,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: 'b-3',
      room_id: 'room-vip',
      department_id: 'dept-1',
      code: 'A102-G01',
      name: 'Giường VIP',
      status: 'VACANT',
      exclusive_holder_name: 'Nguyễn VIP',
      daily_price: 1500000,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  const activeAdmissions: Admission[] = [
    {
      id: 'adm-1',
      admission_code: 'HS-01',
      patient_id: 'p-1',
      patient_code: 'BN-01',
      his_record_code: 'HIS-01',
      patient_name: 'Trần Thị Thực Tế',
      date_of_birth: '1990-01-01',
      phone: '',
      diagnosis_group: 'Theo dõi',
      department_id: 'dept-1',
      room_id: 'room-std',
      bed_id: 'b-1',
      is_whole_room: 0,
      hospital_admitted_at: '2026-06-04T08:00:00.000Z',
      bed_assigned_at: '2026-06-04T08:00:00.000Z',
      expected_discharge_at: '2026-06-08T08:00:00.000Z',
      calculation_method: 'CALENDAR_DAYS',
      extension_count: 0,
      status: 'ACTIVE',
      notes: '',
      confirmed_by: 'usr-admin',
      confirmed_by_name: 'Admin',
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  const mappings: HisBedMapping[] = [
    {
      bed_id: 'b-1',
      bed_code: 'A101-G01',
      bed_name: 'Giường 1',
      bed_status: 'OCCUPIED',
      room_id: 'room-std',
      room_code: 'A101',
      room_name: 'Phòng A101',
      room_type: 'STANDARD',
      room_capacity: 2,
      department_id: 'dept-1',
      department_code: 'SAN_A',
      department_name: 'Khoa Sản A',
      daily_price: 250000,
      his_dept_code: 'K15',
      his_room_code: 'A101',
      his_bed_code: 'HIS-A101-G01',
      his_bed_type_code: 'H2',
      bhyt_max_daily_price: 250000,
      allow_shared_bed: 0,
      notes: '',
      updated_by: 'admin',
      updated_at: nowIso,
    },
    {
      bed_id: 'b-2',
      bed_code: 'A101-G02',
      bed_name: 'Giường 2',
      bed_status: 'MAINTENANCE',
      room_id: 'room-std',
      room_code: 'A101',
      room_name: 'Phòng A101',
      room_type: 'STANDARD',
      room_capacity: 2,
      department_id: 'dept-1',
      department_code: 'SAN_A',
      department_name: 'Khoa Sản A',
      daily_price: 250000,
      his_dept_code: 'K15',
      his_room_code: 'A101',
      his_bed_code: 'HIS-A101-G02',
      his_bed_type_code: 'H2',
      bhyt_max_daily_price: 250000,
      allow_shared_bed: 0,
      notes: '',
      updated_by: 'admin',
      updated_at: nowIso,
    },
    {
      bed_id: 'b-3',
      bed_code: 'A102-G01',
      bed_name: 'Giường VIP',
      bed_status: 'VACANT',
      room_id: 'room-vip',
      room_code: 'A102',
      room_name: 'Phòng VIP A102',
      room_type: 'VIP',
      room_capacity: 1,
      department_id: 'dept-1',
      department_code: 'SAN_A',
      department_name: 'Khoa Sản A',
      daily_price: 1500000,
      his_dept_code: 'K15',
      his_room_code: 'A102',
      his_bed_code: 'HIS-A102-G01',
      his_bed_type_code: 'DV',
      bhyt_max_daily_price: 1500000,
      allow_shared_bed: 0,
      notes: '',
      updated_by: 'admin',
      updated_at: nowIso,
    },
  ];

  const assignments: HisBedAssignment[] = [
    // Two different patients on HIS-A101-G01 -> HIS_DOUBLE_OCCUPANCY + HIS_BEDCARE_OCCUPANT_MISMATCH + DV in STANDARD
    {
      id: 'h-1',
      batch_id: 'b1',
      his_assignment_id: 'a1',
      his_record_code: 'HIS-01',
      patient_code: 'BN-01',
      patient_name: 'Trần Thị Thực Tế',
      date_of_birth: '1990-01-01',
      bhyt_card_no: 'DN001',
      his_dept_code: 'K15',
      his_room_code: 'A101',
      his_bed_code: 'HIS-A101-G01',
      his_bed_type_code: 'DV',
      bed_ratio: 1.0,
      bed_days_billed: 8, // Over billed vs 2 days elapsed -> BED_DAYS_DISCREPANCY
      admitted_at: '2026-06-04T08:00:00.000Z',
      discharged_at: null,
      status: 'ACTIVE',
      source_system: 'TEST',
      synced_at: nowIso,
    },
    {
      id: 'h-2',
      batch_id: 'b1',
      his_assignment_id: 'a2',
      his_record_code: 'HIS-02',
      patient_code: 'BN-02',
      patient_name: 'Phạm Trùng Giường',
      date_of_birth: '1991-01-01',
      bhyt_card_no: 'DN002',
      his_dept_code: 'K02', // Department mismatch with dept-1
      his_room_code: 'A101',
      his_bed_code: 'HIS-A101-G01',
      his_bed_type_code: 'H1', // H1 ICU billed outside ICU
      bed_ratio: 1.0,
      bed_days_billed: 1,
      admitted_at: '2026-06-05T01:00:00.000Z',
      discharged_at: null,
      status: 'ACTIVE',
      source_system: 'TEST',
      synced_at: nowIso,
    },
    // Maintenance bed + same patient HIS-02 occupying 2 beds -> PATIENT_MULTI_BED_HIS + ASSIGNED_MAINTENANCE_OR_INACTIVE
    {
      id: 'h-3',
      batch_id: 'b1',
      his_assignment_id: 'a3',
      his_record_code: 'HIS-02',
      patient_code: 'BN-02',
      patient_name: 'Phạm Trùng Giường',
      date_of_birth: '1991-01-01',
      bhyt_card_no: 'DN002',
      his_dept_code: 'K15',
      his_room_code: 'A101',
      his_bed_code: 'HIS-A101-G02',
      his_bed_type_code: 'H2',
      bed_ratio: 1.0,
      bed_days_billed: 1,
      admitted_at: '2026-06-05T02:00:00.000Z',
      discharged_at: null,
      status: 'ACTIVE',
      source_system: 'TEST',
      synced_at: nowIso,
    },
    // Ghost bed + VIP exclusive breach + H2 in VIP room -> GHOST_BED_STATE_CONFLICT + EXCLUSIVE_ROOM_BREACH + BHYT_TIER_MISMATCH
    {
      id: 'h-4',
      batch_id: 'b1',
      his_assignment_id: 'a4',
      his_record_code: 'HIS-04',
      patient_code: 'BN-04',
      patient_name: 'Khách Lạ',
      date_of_birth: '1992-01-01',
      bhyt_card_no: 'DN004',
      his_dept_code: 'K15',
      his_room_code: 'A102',
      his_bed_code: 'HIS-A102-G01',
      his_bed_type_code: 'H2',
      bed_ratio: 1.0,
      bed_days_billed: 1,
      admitted_at: '2026-06-05T03:00:00.000Z',
      discharged_at: null,
      status: 'ACTIVE',
      source_system: 'TEST',
      synced_at: nowIso,
    },
    // Unmapped HIS bed
    {
      id: 'h-5',
      batch_id: 'b1',
      his_assignment_id: 'a5',
      his_record_code: 'HIS-05',
      patient_code: 'BN-05',
      patient_name: 'Nguyễn Chưa Ánh Xạ',
      date_of_birth: '1993-01-01',
      bhyt_card_no: 'DN005',
      his_dept_code: 'K15',
      his_room_code: 'A999',
      his_bed_code: 'HIS-UNMAPPED-99',
      his_bed_type_code: 'H2',
      bed_ratio: 1.0,
      bed_days_billed: 1,
      admitted_at: '2026-06-05T04:00:00.000Z',
      discharged_at: null,
      status: 'ACTIVE',
      source_system: 'TEST',
      synced_at: nowIso,
    },
  ];

  const report = evaluateHisAndBhytCompliance({
    departments,
    rooms,
    beds,
    activeAdmissions,
    mappings,
    assignments,
    resolutions: [],
    importLogs: [],
    nowIso,
  });

  const ruleCodes = new Set(report.issues.map((i) => i.rule_code));
  assert.ok(ruleCodes.has('HIS_DOUBLE_OCCUPANCY'));
  assert.ok(ruleCodes.has('PATIENT_MULTI_BED_HIS'));
  assert.ok(ruleCodes.has('HIS_BEDCARE_OCCUPANT_MISMATCH'));
  assert.ok(ruleCodes.has('GHOST_BED_STATE_CONFLICT'));
  assert.ok(ruleCodes.has('UNMAPPED_HIS_BED'));
  assert.ok(ruleCodes.has('ASSIGNED_MAINTENANCE_OR_INACTIVE'));
  assert.ok(ruleCodes.has('DEPARTMENT_MISMATCH'));
  assert.ok(ruleCodes.has('BHYT_TIER_MISMATCH'));
  assert.ok(ruleCodes.has('EXCLUSIVE_ROOM_BREACH'));
  assert.ok(ruleCodes.has('BED_DAYS_DISCREPANCY'));
  assert.ok(ruleCodes.has('ROOM_CAPACITY_EXCEEDED'));
  assert.ok(ruleCodes.has('DEPT_EXCEEDS_PLANNED_BHYT_QUOTA'));

  assert.ok(report.summary.duplicate_count >= 3);
  assert.ok(report.summary.irrational_count >= 5);
  assert.ok(report.summary.quota_exceeded_count >= 2);
});

test('HIS & BHYT API strictly enforces Admin full privileges, staff RBAC permissions, unique mapping, and audit workflows', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);

    const admin = await loginAs(baseUrl, 'admin', 'admin');
    const cashier = await loginAs(baseUrl, 'thuvienphi', 'Vienphi@2026'); // seeded SYNC_AND_MAP
    const exec = await loginAs(baseUrl, 'lanhdao', 'Lanhdao@2026'); // seeded VIEW
    const wardNoPerm = await loginAs(baseUrl, 'khoasana', 'Khoasan@2026'); // seeded NONE

    // 1. WARD_STAFF with NONE permission is blocked from ALL HIS endpoints
    assert.equal(
      (await fetch(`${baseUrl}/his/overview`, { headers: { Authorization: `Bearer ${wardNoPerm.token}` } })).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/his/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wardNoPerm.token}` },
          body: JSON.stringify({ mode: 'SAMPLE_BHYT_AUDIT' }),
        })
      ).status,
      403
    );

    // 2. EXECUTIVE with VIEW can read overview (200) but cannot sync, map, or configure (403)
    assert.equal(
      (await fetch(`${baseUrl}/his/overview`, { headers: { Authorization: `Bearer ${exec.token}` } })).status,
      200
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/his/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${exec.token}` },
          body: JSON.stringify({ mode: 'SAMPLE_BHYT_AUDIT' }),
        })
      ).status,
      403
    );

    // 3. CASHIER with SYNC_AND_MAP can run SAMPLE_BHYT_AUDIT sync & map, but cannot change Admin-only config or dept quotas (403)
    const syncRes = await fetch(`${baseUrl}/his/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashier.token}` },
      body: JSON.stringify({ mode: 'SAMPLE_BHYT_AUDIT' }),
    });
    assert.equal(syncRes.status, 200);
    const syncBody = (await syncRes.json()) as {
      ok: boolean;
      importedCount: number;
      auditSummary: { duplicate_count: number; irrational_count: number; quota_exceeded_count: number };
    };
    assert.equal(syncBody.ok, true);
    assert.ok(syncBody.importedCount >= 7);
    assert.ok(syncBody.auditSummary.duplicate_count >= 1);
    assert.ok(syncBody.auditSummary.irrational_count >= 2);
    assert.ok(syncBody.auditSummary.quota_exceeded_count >= 1);

    assert.equal(
      (
        await fetch(`${baseUrl}/his/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashier.token}` },
          body: JSON.stringify({ his_api_url: 'http://10.0.0.10/his', his_api_enabled: true }),
        })
      ).status,
      403
    );

    // 4. Duplicate mapping conflict check (cannot assign same his_bed_code to 2 different beds)
    const overviewRes = await fetch(`${baseUrl}/his/overview`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.equal(overviewRes.status, 200);
    const overview = (await overviewRes.json()) as {
      mappings: Array<{ bed_id: string; his_bed_code: string }>;
      issues: Array<{ issue_key: string; rule_code: string; resolved: boolean }>;
    };
    const mappedBed = overview.mappings.find((m) => m.his_bed_code === 'HIS-K15-A101-G01');
    const unmappedBed = overview.mappings.find((m) => !m.his_bed_code);
    assert.ok(mappedBed && unmappedBed);

    const dupMapRes = await fetch(`${baseUrl}/his/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashier.token}` },
      body: JSON.stringify({
        bed_id: unmappedBed.bed_id,
        his_dept_code: 'K01',
        his_bed_code: 'HIS-K15-A101-G01',
      }),
    });
    assert.equal(dupMapRes.status, 409);

    // 5. Admin has FULL access: update HIS config, dept BHYT quota, and grant VIEW permission to khoasana
    assert.equal(
      (
        await fetch(`${baseUrl}/his/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
          body: JSON.stringify({ his_api_url: 'http://10.0.10.25:8080/his', his_api_enabled: true, his_sync_mode: 'HYBRID' }),
        })
      ).status,
      200
    );

    assert.equal(
      (
        await fetch(`${baseUrl}/his/departments/dept-san-a/quota`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
          body: JSON.stringify({ his_dept_code: 'K15', planned_bhyt_beds: 8, max_bhyt_overage_pct: 120 }),
        })
      ).status,
      200
    );

    const usersList = (await (
      await fetch(`${baseUrl}/users`, { headers: { Authorization: `Bearer ${admin.token}` } })
    ).json()) as Array<{ id: string; username: string; full_name: string; role: string; department_id: string | null }>;
    const khoaSanUser = usersList.find((u) => u.username === 'khoasana');
    assert.ok(khoaSanUser);

    assert.equal(
      (
        await fetch(`${baseUrl}/users/${khoaSanUser.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
          body: JSON.stringify({
            username: khoaSanUser.username,
            full_name: khoaSanUser.full_name,
            role: khoaSanUser.role,
            department_id: khoaSanUser.department_id,
            his_permission: 'VIEW',
          }),
        })
      ).status,
      200
    );

    // Now khoasana can view /api/his/overview (200)
    assert.equal(
      (await fetch(`${baseUrl}/his/overview`, { headers: { Authorization: `Bearer ${wardNoPerm.token}` } })).status,
      200
    );

    // 6. Resolving an issue persists in audit overview
    const firstOpenIssue = overview.issues.find((i) => !i.resolved);
    assert.ok(firstOpenIssue);
    assert.equal(
      (
        await fetch(`${baseUrl}/his/audit/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashier.token}` },
          body: JSON.stringify({
            issue_key: firstOpenIssue.issue_key,
            resolution_note: 'Đã kiểm tra điều chỉnh trên HIS',
          }),
        })
      ).status,
      200
    );
    const updatedOverview = (await (
      await fetch(`${baseUrl}/his/overview`, { headers: { Authorization: `Bearer ${admin.token}` } })
    ).json()) as { issues: Array<{ issue_key: string; resolved: boolean }> };
    const resolvedMatch = updatedOverview.issues.find((i) => i.issue_key === firstOpenIssue.issue_key);
    assert.equal(resolvedMatch?.resolved, true);
  } finally {
    server.close();
  }
});

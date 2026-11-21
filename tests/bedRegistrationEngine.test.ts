import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import type { Admission, Bed, Department, Room } from '../src/types/bedcare';
import { evaluateBedRegistrationRules } from '../src/utils/bedRegistrationEngine';

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
    user: { id: string; username: string; role: string; department_id?: string | null };
  };
}

test('evaluateBedRegistrationRules blocks duplicate bed ID, undischarged bed, duplicate patient/HIS ID, and enforces quota rules', () => {
  const nowIso = '2026-06-10T08:00:00.000Z';
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
      max_bhyt_overage_pct: 150, // ceiling = 3
    },
  ];
  const rooms: Room[] = [
    {
      id: 'room-1',
      department_id: 'dept-1',
      code: 'A101',
      name: 'Phòng A101',
      floor: 'Tầng 1',
      capacity: 4,
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
  ];
  const beds: Bed[] = [
    {
      id: 'bed-1',
      room_id: 'room-1',
      department_id: 'dept-1',
      code: 'A101-G01',
      name: 'Giường 01',
      status: 'OCCUPIED',
      current_admission_id: 'adm-1',
      current_reservation_id: null,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: 'bed-2',
      room_id: 'room-1',
      department_id: 'dept-1',
      code: 'A101-G02',
      name: 'Giường 02',
      status: 'OCCUPIED',
      current_admission_id: 'adm-2',
      current_reservation_id: null,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: 'bed-3',
      room_id: 'room-1',
      department_id: 'dept-1',
      code: 'A101-G03',
      name: 'Giường 03',
      status: 'VACANT',
      current_admission_id: null,
      current_reservation_id: null,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: 'bed-4',
      room_id: 'room-1',
      department_id: 'dept-1',
      code: 'A101-G04',
      name: 'Giường 04',
      status: 'VACANT',
      current_admission_id: null,
      current_reservation_id: null,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];
  const activeAdmissions: Admission[] = [
    {
      id: 'adm-1',
      admission_code: 'HS-001',
      patient_id: 'pat-1',
      patient_code: 'BN-001',
      his_record_code: 'HIS-001',
      patient_name: 'Nguyễn Thị A',
      date_of_birth: '1992-01-01',
      phone: '',
      diagnosis_group: 'Sinh thường',
      department_id: 'dept-1',
      room_id: 'room-1',
      bed_id: 'bed-1',
      is_whole_room: 0,
      hospital_admitted_at: nowIso,
      bed_assigned_at: nowIso,
      expected_discharge_at: '2026-06-13T08:00:00.000Z',
      actual_discharge_at: null,
      calculation_method: 'CALENDAR_DAYS',
      extension_count: 0,
      status: 'ACTIVE',
      notes: '',
      confirmed_by: 'u1',
      confirmed_by_name: 'Admin',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      id: 'adm-2',
      admission_code: 'HS-002',
      patient_id: 'pat-2',
      patient_code: 'BN-002',
      his_record_code: 'HIS-002',
      patient_name: 'Trần Thị B',
      date_of_birth: '1991-01-01',
      phone: '',
      diagnosis_group: 'Sinh thường',
      department_id: 'dept-1',
      room_id: 'room-1',
      bed_id: 'bed-2',
      is_whole_room: 0,
      hospital_admitted_at: nowIso,
      bed_assigned_at: nowIso,
      expected_discharge_at: '2026-06-13T08:00:00.000Z',
      actual_discharge_at: null,
      calculation_method: 'CALENDAR_DAYS',
      extension_count: 0,
      status: 'ACTIVE',
      notes: '',
      confirmed_by: 'u1',
      confirmed_by_name: 'Admin',
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  // 1. Undischarged bed + duplicate bed ID
  const occupiedCheck = evaluateBedRegistrationRules({
    departmentId: 'dept-1',
    roomId: 'room-1',
    bedId: 'bed-1',
    patientCode: 'BN-999',
    departments,
    rooms,
    beds,
    activeAdmissions,
  });
  assert.equal(occupiedCheck.allowed, false);
  assert.ok(occupiedCheck.blocks.some((b) => b.code === 'DUPLICATE_BED_ID'));
  assert.ok(occupiedCheck.blocks.some((b) => b.code === 'BED_OCCUPIED_UNDISCHARGED'));

  // 2. Duplicate patient code + duplicate HIS code on vacant bed
  const dupPatientCheck = evaluateBedRegistrationRules({
    departmentId: 'dept-1',
    roomId: 'room-1',
    bedId: 'bed-3',
    patientCode: 'BN-001',
    hisRecordCode: 'HIS-002',
    departments,
    rooms,
    beds,
    activeAdmissions,
  });
  assert.equal(dupPatientCheck.allowed, false);
  assert.ok(dupPatientCheck.blocks.some((b) => b.code === 'ALREADY_ADMITTED'));
  assert.ok(dupPatientCheck.blocks.some((b) => b.code === 'DUPLICATE_HIS_RECORD_ID'));

  // 3. Vacant bed 3 puts department at 3/2 (150%, within 150% ceiling) -> allowed with DEPT_QUOTA_WARNING + HIS conflict warning
  const warnCheck = evaluateBedRegistrationRules({
    departmentId: 'dept-1',
    roomId: 'room-1',
    bedId: 'bed-3',
    patientCode: 'BN-NEW-3',
    hisRecordCode: 'HIS-NEW-3',
    departments,
    rooms,
    beds,
    activeAdmissions,
    hisMappings: [{ bed_id: 'bed-3', his_bed_code: 'HIS-K15-A101-G03' }],
    hisAssignments: [
      {
        his_record_code: 'HIS-OTHER',
        patient_code: 'BN-OTHER',
        patient_name: 'BN trên HIS',
        his_bed_code: 'HIS-K15-A101-G03',
        status: 'ACTIVE',
      },
    ],
  });
  assert.equal(warnCheck.allowed, true);
  assert.ok(warnCheck.warnings.some((w) => w.code === 'DEPT_QUOTA_WARNING'));
  assert.ok(warnCheck.warnings.some((w) => w.code === 'HIS_BED_OCCUPIED_CONFLICT'));

  // 4. Adding a 4th admission exceeds ceiling (4 > 3) -> blocked unless overrideQuotaLimit
  const adm3: Admission = { ...activeAdmissions[0], id: 'adm-3', bed_id: 'bed-3', patient_code: 'BN-003', his_record_code: 'HIS-003' };
  const overQuotaCheck = evaluateBedRegistrationRules({
    departmentId: 'dept-1',
    roomId: 'room-1',
    bedId: 'bed-4',
    patientCode: 'BN-NEW-4',
    departments,
    rooms,
    beds: beds.map((b) => (b.id === 'bed-3' ? { ...b, status: 'OCCUPIED', current_admission_id: 'adm-3' } : b)),
    activeAdmissions: [...activeAdmissions, adm3],
  });
  assert.equal(overQuotaCheck.allowed, false);
  assert.ok(overQuotaCheck.blocks.some((b) => b.code === 'DEPT_QUOTA_EXCEEDED'));

  const overrideCheck = evaluateBedRegistrationRules({
    departmentId: 'dept-1',
    roomId: 'room-1',
    bedId: 'bed-4',
    patientCode: 'BN-NEW-4',
    overrideQuotaLimit: true,
    departments,
    rooms,
    beds: beds.map((b) => (b.id === 'bed-3' ? { ...b, status: 'OCCUPIED', current_admission_id: 'adm-3' } : b)),
    activeAdmissions: [...activeAdmissions, adm3],
  });
  assert.equal(overrideCheck.allowed, true);
  assert.ok(overrideCheck.warnings.some((w) => w.code === 'DEPT_QUOTA_WARNING'));
});

test('Admission API precheck, confirm blocking/override, and HIS batch mapping validation work end-to-end', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const admin = await loginAs(baseUrl, 'admin', 'admin');
    const wardStaff = await loginAs(baseUrl, 'khoasana', 'Khoasan@2026');

    // Fetch current beds & active admissions
    const [beds, activeAdms] = (await Promise.all([
      fetch(`${baseUrl}/beds`, { headers: { Authorization: `Bearer ${admin.token}` } }).then((r) => r.json()),
      fetch(`${baseUrl}/admissions?status=ACTIVE`, { headers: { Authorization: `Bearer ${admin.token}` } }).then((r) =>
        r.json()
      ),
    ])) as [Bed[], Admission[]];

    const occupiedSanBed = beds.find((b) => b.department_id === 'dept-san-a' && b.status === 'OCCUPIED');
    const vacantSanBeds = beds.filter((b) => b.department_id === 'dept-san-a' && b.status === 'VACANT');
    assert.ok(occupiedSanBed && vacantSanBeds.length >= 2);
    assert.ok(activeAdms.length >= 1);

    // 1. Precheck on occupied undischarged bed returns allowed: false with DUPLICATE_BED_ID & BED_OCCUPIED_UNDISCHARGED
    const preOccupied = (await (
      await fetch(`${baseUrl}/admissions/precheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wardStaff.token}` },
        body: JSON.stringify({
          department_id: 'dept-san-a',
          room_id: occupiedSanBed.room_id,
          bed_id: occupiedSanBed.id,
          patient_code: 'BN-TEST-001',
        }),
      })
    ).json()) as { allowed: boolean; blocks: Array<{ code: string }> };
    assert.equal(preOccupied.allowed, false);
    assert.ok(preOccupied.blocks.some((b) => b.code === 'DUPLICATE_BED_ID'));
    assert.ok(preOccupied.blocks.some((b) => b.code === 'BED_OCCUPIED_UNDISCHARGED'));

    // 2. Attempting to confirm admission into occupied undischarged bed is rejected with HTTP 409
    const confirmOccupied = await fetch(`${baseUrl}/admissions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wardStaff.token}` },
      body: JSON.stringify({
        patient_code: 'BN-TEST-001',
        patient_name: 'Bệnh nhân test trùng',
        date_of_birth: '1993-01-01',
        diagnosis_group: 'Sinh thường',
        department_id: 'dept-san-a',
        room_id: occupiedSanBed.room_id,
        bed_id: occupiedSanBed.id,
      }),
    });
    assert.equal(confirmOccupied.status, 409);

    // 3. Lower dept-san-a quota to 2 beds max 100% so next vacant bed hits DEPT_QUOTA_EXCEEDED
    assert.equal(
      (
        await fetch(`${baseUrl}/his/departments/dept-san-a/quota`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
          body: JSON.stringify({ his_dept_code: 'K15', planned_bhyt_beds: 2, max_bhyt_overage_pct: 100 }),
        })
      ).status,
      200
    );

    // Ward staff tries to admit into vacantSanBeds[0] even with override_quota_limit: true -> blocked 409 DEPT_QUOTA_EXCEEDED
    const wardQuotaRes = await fetch(`${baseUrl}/admissions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wardStaff.token}` },
      body: JSON.stringify({
        patient_code: 'BN-QUOTA-WARD',
        patient_name: 'BN Vượt hạn mức',
        date_of_birth: '1994-05-05',
        diagnosis_group: 'Sinh thường',
        department_id: 'dept-san-a',
        room_id: vacantSanBeds[0].room_id,
        bed_id: vacantSanBeds[0].id,
        override_quota_limit: true,
      }),
    });
    assert.equal(wardQuotaRes.status, 409);
    const wardQuotaBody = (await wardQuotaRes.json()) as { code: string };
    assert.equal(wardQuotaBody.code, 'DEPT_QUOTA_EXCEEDED');

    // Admin with override_quota_limit: true succeeds (201) with DEPT_QUOTA_WARNING
    const adminOverrideRes = await fetch(`${baseUrl}/admissions/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({
        patient_code: 'BN-QUOTA-ADMIN',
        patient_name: 'BN Admin duyệt vượt',
        date_of_birth: '1994-05-05',
        diagnosis_group: 'Sinh thường',
        department_id: 'dept-san-a',
        room_id: vacantSanBeds[0].room_id,
        bed_id: vacantSanBeds[0].id,
        override_quota_limit: true,
      }),
    });
    assert.equal(adminOverrideRes.status, 201);
    const adminOverrideBody = (await adminOverrideRes.json()) as {
      warnings?: Array<{ code: string }>;
    };
    assert.ok(adminOverrideBody.warnings?.some((w) => w.code === 'DEPT_QUOTA_WARNING'));

    // 4. Batch HIS Mapping: intra-batch duplicate rejected (409), valid batch saved (200)
    const dupBatchRes = await fetch(`${baseUrl}/his/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({
        mappings: [
          {
            bed_id: vacantSanBeds[0].id,
            his_dept_code: 'K15',
            his_room_code: 'P101',
            his_bed_code: 'HIS-BATCH-DUP-01',
            his_bed_type_code: 'H2',
          },
          {
            bed_id: vacantSanBeds[1].id,
            his_dept_code: 'K15',
            his_room_code: 'P101',
            his_bed_code: 'HIS-BATCH-DUP-01',
            his_bed_type_code: 'H2',
          },
        ],
      }),
    });
    assert.equal(dupBatchRes.status, 409);

    const validBatchRes = await fetch(`${baseUrl}/his/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({
        mappings: [
          {
            bed_id: vacantSanBeds[0].id,
            his_dept_code: 'K15',
            his_room_code: 'P101',
            his_bed_code: 'HIS-BATCH-UNIQ-01',
            his_bed_type_code: 'H2',
          },
          {
            bed_id: vacantSanBeds[1].id,
            his_dept_code: 'K15',
            his_room_code: 'P102',
            his_bed_code: 'HIS-BATCH-UNIQ-02',
            his_bed_type_code: 'DV',
          },
        ],
      }),
    });
    assert.equal(validBatchRes.status, 200);
  } finally {
    server.close();
  }
});

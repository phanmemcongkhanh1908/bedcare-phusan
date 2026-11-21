import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import { toLocalDateTimeInputValue } from '../src/utils/formatters';

function createHarness() {
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

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { token: string };
  return json.token;
}

test('toLocalDateTimeInputValue formats valid dates into YYYY-MM-DDTHH:mm local format safely', () => {
  const sample = new Date(2026, 4, 15, 9, 30, 0);
  assert.equal(toLocalDateTimeInputValue(sample), '2026-05-15T09:30');
  const fallback = toLocalDateTimeInputValue('not-a-date');
  assert.match(fallback, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('Public Customer Portal enforces phone digits, valid dates, room-in-use reservation blocks, and whole-room vacancy', async () => {
  const { server } = createHarness();
  const baseUrl = await startHttp(server);

  try {
    const availRes = await fetch(`${baseUrl}/public/availability`);
    assert.equal(availRes.status, 200);
    const avail = (await availRes.json()) as {
      rooms: Array<{
        id: string;
        code: string;
        department_id: string;
        can_reserve_single_bed: boolean;
        can_book_whole_room: boolean;
        vacant_beds: Array<{ id: string; code: string }>;
      }>;
    };

    const p301 = avail.rooms.find((r) => r.code === 'P301');
    assert.ok(p301);
    assert.equal(p301.can_reserve_single_bed, false);
    assert.ok(p301.vacant_beds.length > 0);

    // 1. Reject non-numeric/short phone
    const badPhoneRes = await fetch(`${baseUrl}/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Nguyễn Thị Thử Nghiệm',
        phone: 'abcdefgh',
        diagnosis_group: 'Sinh thường',
        booking_type: 'WAITLIST',
      }),
    });
    assert.equal(badPhoneRes.status, 400);

    // 2. Reject invalid expected admission date
    const badDateRes = await fetch(`${baseUrl}/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Nguyễn Thị Thử Nghiệm',
        phone: '0909123456',
        expected_admission_date: 'invalid-date',
        booking_type: 'WAITLIST',
      }),
    });
    assert.equal(badDateRes.status, 400);

    // 3. Block single-bed booking on IN_USE room (P301 already has an admitted inpatient)
    const inUseBedRes = await fetch(`${baseUrl}/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Lê Thị Sản Phụ',
        phone: '0909123456',
        department_id: p301.department_id,
        room_id: p301.id,
        bed_id: p301.vacant_beds[0].id,
        booking_type: 'SINGLE_BED',
      }),
    });
    assert.equal(inUseBedRes.status, 409);

    // 4. Block WHOLE_ROOM booking when room has non-vacant bed (A103 has PENDING_CLEANING bed)
    const a103 = avail.rooms.find((r) => r.code === 'A103');
    assert.ok(a103);
    assert.equal(a103.can_book_whole_room, false);
    const wholeBlockedRes = await fetch(`${baseUrl}/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Trần Thị Bao Phòng',
        phone: '0909123457',
        department_id: a103.department_id,
        room_id: a103.id,
        booking_type: 'WHOLE_ROOM',
      }),
    });
    assert.equal(wholeBlockedRes.status, 409);

    // 5. Allow WHOLE_ROOM booking on completely vacant room (N401)
    const n401 = avail.rooms.find((r) => r.code === 'N401');
    assert.ok(n401 && n401.can_book_whole_room);
    const wholeOkRes = await fetch(`${baseUrl}/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Phạm Thị Bao Trọn',
        phone: '0909123458',
        department_id: n401.department_id,
        room_id: n401.id,
        booking_type: 'WHOLE_ROOM',
      }),
    });
    assert.equal(wholeOkRes.status, 201);
  } finally {
    server.close();
  }
});

test('POST /registrations blocks ALREADY_ADMITTED and WHOLE_ROOM non-empty room without bed_id, and /extensions scopes WARD_STAFF', async () => {
  const { server } = createHarness();
  const baseUrl = await startHttp(server);

  try {
    const adminToken = await login(baseUrl, 'admin', 'admin');
    const wardPhukhoaToken = await login(baseUrl, 'khoaphukhoa', 'Phukhoa@2026');
    const wardSanAToken = await login(baseUrl, 'khoasana', 'Khoasan@2026');

    // 1. ALREADY_ADMITTED block even without selecting a specific bed
    const dupPatRes = await fetch(`${baseUrl}/registrations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        patient_code: 'BN-DEMO-001',
        patient_name: 'Nguyễn Thị Hương (Mẫu)',
        date_of_birth: '1994-05-12',
        diagnosis_group: 'Sinh mổ',
        registration_mode: 'KNOWN_DEPT',
        department_id: 'dept-san-a',
        reservation_type: 'WAITLIST',
      }),
    });
    assert.equal(dupPatRes.status, 409);
    const dupPatJson = (await dupPatRes.json()) as { code: string };
    assert.equal(dupPatJson.code, 'ALREADY_ADMITTED');

    // 2. WHOLE_ROOM block without bed_id on room-a103 (has PENDING_CLEANING bed)
    const wholeRoomBlockRes = await fetch(`${baseUrl}/registrations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        patient_code: 'BN-TEST-WHOLE-01',
        patient_name: 'Đỗ Thị Minh Thư',
        date_of_birth: '1995-03-20',
        diagnosis_group: 'Sinh thường',
        registration_mode: 'KNOWN_DEPT',
        department_id: 'dept-san-a',
        room_id: 'room-a103',
        reservation_type: 'WHOLE_ROOM',
      }),
    });
    assert.equal(wholeRoomBlockRes.status, 409);
    const wholeRoomBlockJson = (await wholeRoomBlockRes.json()) as { code: string };
    assert.equal(wholeRoomBlockJson.code, 'ROOM_NOT_EMPTY_FOR_WHOLE_ROOM');

    // 3. GET /extensions scopes WARD_STAFF to own department only
    const [sanAExtRes, phukhoaExtRes] = await Promise.all([
      fetch(`${baseUrl}/extensions`, { headers: { Authorization: `Bearer ${wardSanAToken}` } }),
      fetch(`${baseUrl}/extensions`, { headers: { Authorization: `Bearer ${wardPhukhoaToken}` } }),
    ]);
    assert.equal(sanAExtRes.status, 200);
    assert.equal(phukhoaExtRes.status, 200);
    const sanAExts = (await sanAExtRes.json()) as Array<{ admission_id: string }>;
    const phukhoaExts = (await phukhoaExtRes.json()) as Array<{ admission_id: string }>;
    assert.ok(sanAExts.some((e) => e.admission_id === 'adm-demo-1'));
    assert.equal(phukhoaExts.some((e) => e.admission_id === 'adm-demo-1'), false);

    // 4. Reject backward discharge date on /admissions/:id/extend
    const badExtendRes = await fetch(`${baseUrl}/admissions/adm-demo-1/extend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wardSanAToken}`,
      },
      body: JSON.stringify({
        new_expected_discharge_at: '2020-01-01T08:00:00.000Z',
        reason: 'Kiểm thử ngày không hợp lệ',
      }),
    });
    assert.equal(badExtendRes.status, 400);
  } finally {
    server.close();
  }
});

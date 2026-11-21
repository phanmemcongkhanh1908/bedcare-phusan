import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import {
  canReserveInRoom,
  deriveRoomOccupancyStatus,
  validateRoomAndBeds,
} from '../src/utils/roomBedValidation';

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

test('deriveRoomOccupancyStatus & canReserveInRoom enforce IN_USE lock when any bed is OCCUPIED', () => {
  const room = { id: 'r1', code: 'A103', name: 'Phòng A103', exclusive_locked: 0 };

  assert.equal(
    deriveRoomOccupancyStatus(room, [{ status: 'VACANT' }, { status: 'VACANT' }]),
    'AVAILABLE'
  );
  assert.equal(
    deriveRoomOccupancyStatus(room, [{ status: 'RESERVED' }, { status: 'VACANT' }]),
    'PARTIAL_RESERVED'
  );
  assert.equal(
    deriveRoomOccupancyStatus(room, [{ status: 'OCCUPIED' }, { status: 'VACANT' }]),
    'IN_USE'
  );
  assert.equal(
    deriveRoomOccupancyStatus({ ...room, exclusive_locked: 1 }, [{ status: 'OCCUPIED' }, { status: 'RESERVED' }]),
    'EXCLUSIVE'
  );

  const checkVacantRoom = canReserveInRoom(room, [
    { code: 'A103-G01', status: 'VACANT' },
    { code: 'A103-G02', status: 'VACANT' },
  ]);
  assert.equal(checkVacantRoom.allowed, true);

  const checkOccupiedRoom = canReserveInRoom(room, [
    { code: 'A103-G01', status: 'OCCUPIED' },
    { code: 'A103-G02', status: 'VACANT' },
  ]);
  assert.equal(checkOccupiedRoom.allowed, false);
  assert.match(checkOccupiedRoom.reason || '', /Đang sử dụng/);
});

test('validateRoomAndBeds flags conflicting reservation inside an occupied non-exclusive room and stale exclusive locks', () => {
  const conflictResult = validateRoomAndBeds(
    {
      id: 'room-a102',
      code: 'A102',
      name: 'Phòng A102',
      exclusive_locked: 0,
      occupancy_status: 'IN_USE',
    },
    [
      { id: 'b1', room_id: 'room-a102', code: 'A102-G01', status: 'OCCUPIED', current_admission_id: 'adm-1' },
      { id: 'b2', room_id: 'room-a102', code: 'A102-G02', status: 'RESERVED', current_reservation_id: 'res-1' },
    ]
  );
  assert.equal(conflictResult.hasConflict, true);
  assert.equal(conflictResult.conflicts[0].code, 'OCCUPIED_ROOM_HAS_RESERVATION');
  assert.equal(conflictResult.isReservationBlocked, true);

  const staleExcl = validateRoomAndBeds(
    {
      id: 'room-b201',
      code: 'B201',
      name: 'Phòng B201',
      exclusive_locked: 1,
      exclusive_lock_id: null,
      occupancy_status: 'AVAILABLE',
    },
    [
      { id: 'b3', room_id: 'room-b201', code: 'B201-G01', status: 'VACANT' },
    ]
  );
  assert.equal(staleExcl.hasConflict, true);
  assert.ok(staleExcl.conflicts.some((c) => c.code === 'STALE_EXCLUSIVE_LOCK'));
  assert.ok(staleExcl.conflicts.some((c) => c.code === 'EXCLUSIVE_COMPANION_UNLOCKED'));
  assert.ok(staleExcl.conflicts.some((c) => c.code === 'ROOM_STATUS_MISMATCH'));
});

test('POST /api/reservations blocks reserving a vacant bed in an IN_USE room (CONFLICT_ROOM_IN_USE)', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const token = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');

    // P301 has P301-G01 OCCUPIED, so reserving vacant P301-G02 must be rejected with 409 CONFLICT_ROOM_IN_USE
    const res = await fetch(`${baseUrl}/reservations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        patient_name: 'BN Test Conflict',
        department_id: 'dept-phu-khoa',
        room_id: 'room-p301',
        bed_id: 'bed-p301-2',
        is_whole_room: false,
        hold_hours: 6,
      }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, 'CONFLICT_ROOM_IN_USE');
    assert.match(body.error, /Đang sử dụng|đã có giường đang chiếm dụng/i);
  } finally {
    server.close();
  }
});

test('POST /api/beds/fix-conflicts repairs conflicting room-bed states and prevents re-reservation in A102', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const token = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');

    const fixRes = await fetch(`${baseUrl}/beds/fix-conflicts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(fixRes.status, 200);
    const fixBody = (await fixRes.json()) as {
      ok: boolean;
      fixedConflicts: number;
      remainingConflicts: number;
      fixedRooms: string[];
    };
    assert.equal(fixBody.ok, true);
    assert.ok(fixBody.fixedConflicts >= 1);
    assert.equal(fixBody.remainingConflicts, 0);
    assert.ok(fixBody.fixedRooms.includes('A102'));

    // Verify A102-G02 was reset to VACANT and room A102 stays IN_USE
    const bedsRes = await fetch(`${baseUrl}/beds`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const beds = (await bedsRes.json()) as Array<{ code: string; status: string; room_occupancy_status: string }>;
    const a102g2 = beds.find((b) => b.code === 'A102-G02');
    assert.ok(a102g2);
    assert.equal(a102g2.status, 'VACANT');
    assert.equal(a102g2.room_occupancy_status, 'IN_USE');

    // Trying to reserve A102-G02 now must be blocked because A102-G01 is OCCUPIED
    const rsvRes = await fetch(`${baseUrl}/reservations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        patient_name: 'BN Test Sau Fix',
        department_id: 'dept-san-a',
        room_id: 'room-a102',
        bed_id: 'bed-a102-2',
        is_whole_room: false,
      }),
    });
    assert.equal(rsvRes.status, 409);
  } finally {
    server.close();
  }
});

test('Bed Types, Room Standards attributes, Triage Priority & Critical Capacity (>90%) endpoints work end-to-end', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const token = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');

    // 1. Create a new Bed Type & verify list
    const btRes = await fetch(`${baseUrl}/bed-types`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        code: 'GHCV',
        name: 'Giường hồi sức dịch vụ',
        daily_price: 950000,
        hourly_price: 150000,
        description: 'Giường chăm sóc tích cực dịch vụ',
      }),
    });
    assert.equal(btRes.status, 201);

    const listBtRes = await fetch(`${baseUrl}/bed-types`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listBtRes.status, 200);
    const bedTypes = (await listBtRes.json()) as Array<{ code: string; daily_price: number }>;
    assert.ok(bedTypes.some((bt) => bt.code === 'GHCV' && bt.daily_price === 950000));

    // 2. Create a Room Standard with structured amenities (AC, TV, Fan, Guest Chair, Toilet)
    const stdRes = await fetch(`${baseUrl}/room-standards`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        code: 'VIP_FULL',
        name: 'Phòng VIP Đủ Tiện Nghi',
        category: 'SERVICE',
        description: 'Máy lạnh, TV, Quạt, Ghế bố, Toilet trong',
        attributes: {
          has_ac: true,
          has_tv: true,
          has_fan: true,
          has_guest_chair: true,
          toilet_type: 'INTERNAL',
        },
      }),
    });
    assert.equal(stdRes.status, 201);

    const listStdRes = await fetch(`${baseUrl}/room-standards`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const stds = (await listStdRes.json()) as Array<{
      code: string;
      attributes?: { has_ac?: boolean; has_tv?: boolean; has_guest_chair?: boolean; toilet_type?: string };
    }>;
    const vipFull = stds.find((s) => s.code === 'VIP_FULL');
    assert.ok(vipFull);
    assert.equal(vipFull.attributes?.has_ac, true);
    assert.equal(vipFull.attributes?.has_tv, true);
    assert.equal(vipFull.attributes?.has_guest_chair, true);
    assert.equal(vipFull.attributes?.toilet_type, 'INTERNAL');

    // 3. Dashboard overview returns triagePatients & criticalCapacityDepartments
    const ovRes = await fetch(`${baseUrl}/dashboard/overview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ovRes.status, 200);
    const ov = (await ovRes.json()) as {
      triagePatients?: Array<{ priority: string; patient_name: string }>;
      criticalCapacityDepartments?: Array<{ department_name: string; occupancy_rate: number }>;
    };
    assert.ok(Array.isArray(ov.triagePatients) && ov.triagePatients.length > 0);
    assert.ok(ov.triagePatients.some((p) => p.priority === 'CRITICAL'));
    assert.ok(Array.isArray(ov.criticalCapacityDepartments));
    assert.ok(ov.criticalCapacityDepartments.some((d) => d.occupancy_rate > 90));
  } finally {
    server.close();
  }
});

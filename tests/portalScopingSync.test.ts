import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';

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

test('Customer Portal: /public/availability hides PII and /public/bookings syncs into staff registrations', async () => {
  const { server } = createHarness();
  const baseUrl = await startHttp(server);

  try {
    const availRes = await fetch(`${baseUrl}/public/availability`);
    assert.equal(availRes.status, 200);
    const availJson = (await availRes.json()) as {
      departments: Array<{ id: string; vacant_beds: number }>;
      rooms: Array<{
        id: string;
        department_id: string;
        vacant_beds: Array<{ id: string; code: string; daily_price: number }>;
      }>;
    };
    assert.ok(availJson.departments.length >= 2);
    assert.ok(availJson.rooms.length > 0);

    // Ensure zero patient PII leaks in public availability response
    const rawText = JSON.stringify(availJson);
    assert.equal(rawText.includes('patient_name'), false);
    assert.equal(rawText.includes('patient_code'), false);
    assert.equal(rawText.includes('date_of_birth'), false);

    const targetRoom = availJson.rooms.find((r) => r.vacant_beds.length > 0);
    assert.ok(targetRoom, 'Expected at least one room with vacant beds');
    const targetBed = targetRoom.vacant_beds[0];

    const bookRes = await fetch(`${baseUrl}/public/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Trần Thị Khách Hàng',
        phone: '0912345678',
        date_of_birth: '1996-05-12',
        diagnosis_group: 'Sinh thường',
        department_id: targetRoom.department_id,
        room_id: targetRoom.id,
        bed_id: targetBed.id,
        booking_type: 'SINGLE_BED',
        notes: 'Cần phòng yên tĩnh gần cửa sổ',
      }),
    });
    assert.equal(bookRes.status, 201);
    const created = (await bookRes.json()) as {
      id: string;
      registration_code: string;
      status: string;
      bed_code: string;
    };
    assert.ok(created.registration_code.startsWith('DK-KH-'));
    assert.equal(created.status, 'WAITING');
    assert.equal(created.bed_code, targetBed.code);

    // Public booking lookup by registration code
    const lookupRes = await fetch(`${baseUrl}/public/bookings/${encodeURIComponent(created.registration_code)}`);
    assert.equal(lookupRes.status, 200);
    const lookupJson = (await lookupRes.json()) as { registration_code: string; status: string };
    assert.equal(lookupJson.registration_code, created.registration_code);
    assert.equal(lookupJson.status, 'WAITING');

    // Thu vien phi (CASHIER) sees the customer booking immediately in staff /registrations
    const cashierToken = await login(baseUrl, 'thuvienphi', 'Vienphi@2026');
    const staffRegsRes = await fetch(`${baseUrl}/registrations`, {
      headers: { Authorization: `Bearer ${cashierToken}` },
    });
    assert.equal(staffRegsRes.status, 200);
    const staffRegs = (await staffRegsRes.json()) as Array<{
      id: string;
      registration_code: string;
      created_by: string;
      patient_name: string;
    }>;
    const foundInStaff = staffRegs.find((r) => r.id === created.id);
    assert.ok(foundInStaff);
    assert.equal(foundInStaff.created_by, 'customer-portal');
    assert.equal(foundInStaff.patient_name, 'Trần Thị Khách Hàng');
  } finally {
    server.close();
  }
});

test('RBAC department_id scoping: WARD_STAFF only receives own department data while CASHIER/ADMIN see all', async () => {
  const { server } = createHarness();
  const baseUrl = await startHttp(server);

  try {
    const wardToken = await login(baseUrl, 'khoasana', 'Khoasan@2026');
    const cashierToken = await login(baseUrl, 'thuvienphi', 'Vienphi@2026');

    const [wardBedsRes, cashierBedsRes, wardRoomsRes, wardOvRes] = await Promise.all([
      fetch(`${baseUrl}/beds`, { headers: { Authorization: `Bearer ${wardToken}` } }),
      fetch(`${baseUrl}/beds`, { headers: { Authorization: `Bearer ${cashierToken}` } }),
      fetch(`${baseUrl}/rooms`, { headers: { Authorization: `Bearer ${wardToken}` } }),
      fetch(`${baseUrl}/dashboard/overview`, { headers: { Authorization: `Bearer ${wardToken}` } }),
    ]);

    assert.equal(wardBedsRes.status, 200);
    assert.equal(cashierBedsRes.status, 200);
    assert.equal(wardRoomsRes.status, 200);
    assert.equal(wardOvRes.status, 200);

    const wardBeds = (await wardBedsRes.json()) as Array<{ department_id: string }>;
    const cashierBeds = (await cashierBedsRes.json()) as Array<{ department_id: string }>;
    const wardRooms = (await wardRoomsRes.json()) as Array<{ department_id: string }>;
    const wardOv = (await wardOvRes.json()) as {
      scopedDepartmentId?: string | null;
      deptStats: Array<{ id: string }>;
    };

    assert.ok(wardBeds.length > 0);
    assert.ok(wardBeds.every((b) => b.department_id === 'dept-san-a'));
    assert.ok(wardRooms.every((r) => r.department_id === 'dept-san-a'));
    assert.equal(wardOv.scopedDepartmentId, 'dept-san-a');
    assert.equal(wardOv.deptStats.length, 1);
    assert.equal(wardOv.deptStats[0].id, 'dept-san-a');

    // Cashier sees beds across multiple departments
    const distinctDepts = new Set(cashierBeds.map((b) => b.department_id));
    assert.ok(distinctDepts.size > 1);
    assert.ok(cashierBeds.length > wardBeds.length);
  } finally {
    server.close();
  }
});

test('Cluster status includes parsed payloads for operation details inspection', async () => {
  const { server } = createHarness();
  const baseUrl = await startHttp(server);

  try {
    const adminToken = await login(baseUrl, 'admin', 'admin');
    const clRes = await fetch(`${baseUrl}/cluster/status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(clRes.status, 200);
    const cl = (await clRes.json()) as {
      events: Array<{ payload_parsed?: unknown }>;
    };
    assert.ok(cl.events.length > 0);
    assert.notEqual(cl.events[0].payload_parsed, undefined);
  } finally {
    server.close();
  }
});

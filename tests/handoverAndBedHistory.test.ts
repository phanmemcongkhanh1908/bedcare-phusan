import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import { buildCsvString, escapeCsvCell } from '../src/utils/exportUtils';

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

test('buildCsvString formats UTF-8 BOM, Vietnamese text, and RFC-4180 escaping for nursing handovers', () => {
  assert.equal(escapeCsvCell('Bình thường'), 'Bình thường');
  assert.equal(escapeCsvCell('Sinh mổ, "theo dõi"'), '"Sinh mổ, ""theo dõi"""');

  const csv = buildCsvString(
    [
      { header: 'Mã BN', key: 'patient_code' },
      { header: 'Họ tên', key: 'patient_name' },
      { header: 'Ghi chú', key: 'notes' },
    ],
    [
      {
        patient_code: 'BN-DEMO-001',
        patient_name: 'Nguyễn Thị Hương (Mẫu)',
        notes: 'Theo dõi vết mổ, bàn giao ca đêm',
      },
    ]
  );

  assert.ok(csv.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Mã BN,Họ tên,Ghi chú');
  assert.equal(lines[1], 'BN-DEMO-001,Nguyễn Thị Hương (Mẫu),"Theo dõi vết mổ, bàn giao ca đêm"');
});

test('GET /api/beds enriches occupied beds with diagnosis and care_team for Print Bedcard', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const token = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');

    const res = await fetch(`${baseUrl}/beds`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const beds = (await res.json()) as Array<{
      code: string;
      status: string;
      patient_name?: string;
      diagnosis_group?: string;
      confirmed_by_name?: string;
      care_team?: string[];
    }>;

    const a101 = beds.find((b) => b.code === 'A101-G01');
    assert.ok(a101);
    assert.equal(a101.status, 'OCCUPIED');
    assert.equal(a101.patient_name, 'Nguyễn Thị Hương (Mẫu)');
    assert.equal(a101.diagnosis_group, 'Sinh mổ');
    assert.equal(a101.confirmed_by_name, 'BS. Phạm Thị Lan Anh');
    assert.ok(Array.isArray(a101.care_team) && a101.care_team.includes('BS. Phạm Thị Lan Anh'));
  } finally {
    server.close();
  }
});

test('GET /api/beds/:id/history returns chronological past & active admissions and bed transfers', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const token = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');

    // 1. Discharged admission history on bed A103-G04
    const bedsRes = await fetch(`${baseUrl}/beds`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const beds = (await bedsRes.json()) as Array<{ id: string; code: string; department_id: string; room_id: string }>;
    const a103g4 = beds.find((b) => b.code === 'A103-G04')!;
    const p301g1 = beds.find((b) => b.code === 'P301-G01')!;
    const p301g2 = beds.find((b) => b.code === 'P301-G02')!;

    const hist1Res = await fetch(`${baseUrl}/beds/${a103g4.id}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(hist1Res.status, 200);
    const hist1 = (await hist1Res.json()) as {
      history: Array<{ patient_name: string; status: string; actual_discharge_at?: string | null }>;
    };
    assert.equal(hist1.history.length, 1);
    assert.equal(hist1.history[0].patient_name, 'Đỗ Thị Kim Anh (Mẫu)');
    assert.equal(hist1.history[0].status, 'DISCHARGED');
    assert.ok(hist1.history[0].actual_discharge_at);

    // 2. Transfer patient from P301-G01 -> P301-G02 and verify history on both beds
    const admsRes = await fetch(`${baseUrl}/admissions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const adms = (await admsRes.json()) as Array<{ id: string; bed_id: string }>;
    const p301Adm = adms.find((a) => a.bed_id === p301g1.id)!;

    const trRes = await fetch(`${baseUrl}/admissions/${p301Adm.id}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to_department_id: p301g2.department_id,
        to_room_id: p301g2.room_id,
        to_bed_id: p301g2.id,
        reason: 'Chuyển giường gần cửa sổ theo yêu cầu',
      }),
    });
    assert.equal(trRes.status, 201);

    const histSourceRes = await fetch(`${baseUrl}/beds/${p301g1.id}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const histSource = (await histSourceRes.json()) as {
      history: Array<{ relation_type: string; transfer_note?: string; status: string }>;
    };
    assert.equal(histSource.history.length, 1);
    assert.equal(histSource.history[0].relation_type, 'TRANSFERRED_OUT');
    assert.equal(histSource.history[0].status, 'TRANSFERRED');
    assert.ok(histSource.history[0].transfer_note?.includes('P301-G02'));

    const histTargetRes = await fetch(`${baseUrl}/beds/${p301g2.id}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const histTarget = (await histTargetRes.json()) as {
      history: Array<{ relation_type: string; transfer_note?: string; status: string }>;
    };
    assert.equal(histTarget.history.length, 1);
    assert.equal(histTarget.history[0].relation_type, 'TRANSFERRED_IN');
    assert.equal(histTarget.history[0].status, 'ACTIVE');
    assert.ok(histTarget.history[0].transfer_note?.includes('P301-G01'));
  } finally {
    server.close();
  }
});

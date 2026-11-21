import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { seedDemoClusterIfEmpty } from '../src/server/demoData';
import { BedcareCluster } from '../src/server/p2pCluster';
import { createBedcareRouter } from '../src/server/router';
import { computeDiagnosisAlosMap, predict4HourBedVacancies } from '../src/utils/vacancyPredictor';

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

test('computeDiagnosisAlosMap blends empirical discharges with clinical priors using Bayesian shrinkage', () => {
  const { byDiagnosis, globalAlos } = computeDiagnosisAlosMap(
    [
      {
        diagnosis_group: 'Sinh thường',
        bed_assigned_at: '2026-11-10T00:00:00.000Z',
        actual_discharge_at: '2026-11-12T00:00:00.000Z', // 2 days
      },
      {
        diagnosis_group: 'Sinh thường',
        bed_assigned_at: '2026-11-10T00:00:00.000Z',
        actual_discharge_at: '2026-11-12T00:00:00.000Z', // 2 days
      },
      {
        diagnosis_group: 'Sinh thường',
        bed_assigned_at: '2026-11-10T00:00:00.000Z',
        actual_discharge_at: '2026-11-12T00:00:00.000Z', // 2 days
      },
    ],
    [
      { name: 'Sinh thường', default_days: 3 },
      { name: 'Sinh mổ', default_days: 7 },
    ]
  );

  // (2*3 + 3*3) / (3 + 3) = 2.5
  assert.equal(byDiagnosis['Sinh thường'], 2.5);
  assert.equal(byDiagnosis['Sinh mổ'], 7);
  assert.ok(globalAlos > 2 && globalAlos < 5);
});

test('predict4HourBedVacancies scores cleaning turnaround & due/overdue stays higher than extended/new stays', () => {
  const nowIso = '2026-11-16T12:00:00.000Z';
  const summary = predict4HourBedVacancies({
    nowIso,
    diagnosisBaselines: [
      { name: 'Sinh thường', default_days: 3 },
      { name: 'Sinh mổ', default_days: 7 },
    ],
    historicalDischarges: [
      {
        diagnosis_group: 'Sinh thường',
        bed_assigned_at: '2026-11-01T08:00:00.000Z',
        actual_discharge_at: '2026-11-04T08:00:00.000Z',
      },
    ],
    activeAdmissions: [
      {
        id: 'adm-due-soon',
        bed_id: 'b1',
        bed_code: 'A102-G01',
        room_id: 'r1',
        room_name: 'Phòng A102',
        department_id: 'dept-1',
        department_name: 'Khoa Sản A',
        patient_name: 'Bệnh nhân Sắp Trả',
        diagnosis_group: 'Sinh thường',
        bed_assigned_at: '2026-11-13T10:00:00.000Z', // 3.08d stayed
        expected_discharge_at: '2026-11-16T14:00:00.000Z', // due in 2h
        extension_count: 0,
        is_whole_room: 0,
        status: 'ACTIVE',
      },
      {
        id: 'adm-new-extended',
        bed_id: 'b2',
        bed_code: 'A101-G01',
        room_id: 'r2',
        room_name: 'Phòng A101',
        department_id: 'dept-1',
        department_name: 'Khoa Sản A',
        patient_name: 'Bệnh nhân Mới & Gia Hạn',
        diagnosis_group: 'Sinh mổ',
        bed_assigned_at: '2026-11-15T12:00:00.000Z', // 1d stayed
        expected_discharge_at: '2026-11-22T12:00:00.000Z', // 144h away
        extension_count: 2,
        is_whole_room: 0,
        status: 'ACTIVE',
      },
    ],
    turnaroundBeds: [
      {
        id: 'b3',
        code: 'A103-G01',
        room_id: 'r3',
        room_name: 'Phòng A103',
        department_id: 'dept-2',
        department_name: 'Khoa Phụ Khoa',
        status: 'CLEANING',
      },
    ],
  });

  assert.equal(summary.horizonHours, 4);
  assert.equal(summary.upcomingDischarges4hCount, 1);
  assert.equal(summary.cleaningTurnaroundCount, 1);
  assert.equal(summary.historicalSampleCount, 1);
  assert.equal(summary.topCandidates.length, 3);
  assert.equal(summary.topCandidates[0].bedCode, 'A103-G01');
  assert.equal(summary.topCandidates[0].probabilityPct, 94);

  const dueSoon = summary.topCandidates.find((c) => c.bedCode === 'A102-G01')!;
  const newExtended = summary.topCandidates.find((c) => c.bedCode === 'A101-G01')!;
  assert.ok(dueSoon.probabilityPct > 65, `Expected due-soon prob > 65, got ${dueSoon.probabilityPct}`);
  assert.ok(newExtended.probabilityPct < 10, `Expected new/extended prob < 10, got ${newExtended.probabilityPct}`);
  assert.ok(summary.anyVacancyProbabilityPct >= 95);
  assert.ok(summary.expectedVacanciesNext4h > 1.5);
});

test('GET /api/beds exposes exclusive-room companion lock owner so B201-G02 never displays ready-to-serve', async () => {
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
      patient_name?: string | null;
      exclusive_locked?: boolean;
      exclusive_holder_name?: string | null;
      is_exclusive_companion?: boolean;
      reservation_expires_at?: string | null;
    }>;

    const b201g1 = beds.find((b) => b.code === 'B201-G01');
    const b201g2 = beds.find((b) => b.code === 'B201-G02');
    assert.ok(b201g1);
    assert.ok(b201g2);

    assert.equal(b201g1.status, 'OCCUPIED');
    assert.equal(b201g1.patient_name, 'Lê Bảo Ngọc (Mẫu)');
    assert.equal(b201g1.exclusive_locked, true);
    assert.equal(b201g1.is_exclusive_companion, false);

    assert.equal(b201g2.status, 'RESERVED');
    assert.equal(b201g2.exclusive_locked, true);
    assert.equal(b201g2.is_exclusive_companion, true);
    assert.equal(b201g2.exclusive_holder_name, 'Lê Bảo Ngọc (Mẫu)');
    assert.ok(b201g2.reservation_expires_at);
  } finally {
    server.close();
  }
});

test('GET /api/dashboard/overview includes real ML 4-hour vacancyPrediction metrics from SQLite', async () => {
  const { server } = createTestHarness();
  try {
    const baseUrl = await startHttp(server);
    const token = await loginAs(baseUrl, 'superadmin', 'Bedcare@2026');

    const res = await fetch(`${baseUrl}/dashboard/overview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const overview = (await res.json()) as {
      vacancyPrediction?: {
        horizonHours: number;
        anyVacancyProbabilityPct: number;
        expectedVacanciesNext4h: number;
        avgLengthOfStayDays: number;
        historicalSampleCount: number;
        topCandidates: Array<{ bedCode: string; probabilityPct: number }>;
      };
    };

    assert.ok(overview.vacancyPrediction);
    assert.equal(overview.vacancyPrediction.horizonHours, 4);
    assert.ok(overview.vacancyPrediction.avgLengthOfStayDays > 0);
    assert.ok(overview.vacancyPrediction.historicalSampleCount >= 1);
    assert.ok(overview.vacancyPrediction.topCandidates.length > 0);
    assert.ok(overview.vacancyPrediction.anyVacancyProbabilityPct >= 0 && overview.vacancyPrediction.anyVacancyProbabilityPct <= 100);
  } finally {
    server.close();
  }
});

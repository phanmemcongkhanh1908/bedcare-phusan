import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSystemAlerts } from '../src/utils/alertsEngine';
import {
  calculateBedOccupancyRate,
  calculateStayMetrics,
  computeExpectedDischargeAt,
  DEFAULT_BED_DAY_CONFIG,
} from '../src/utils/bedDays';

test('computeExpectedDischargeAt respects CALENDAR_DAYS and ACTUAL_HOURS', () => {
  const start = '2026-11-16T08:00:00.000Z';
  const cal = computeExpectedDischargeAt(start, 3, DEFAULT_BED_DAY_CONFIG);
  assert.equal(cal.slice(0, 10), '2026-11-18');

  const hrs = computeExpectedDischargeAt(start, 3, {
    ...DEFAULT_BED_DAY_CONFIG,
    method: 'ACTUAL_HOURS',
  });
  assert.equal(hrs, '2026-11-19T08:00:00.000Z');
});

test('calculateStayMetrics detects OVERDUE, DUE_TODAY, DUE_SOON, ON_TIME', () => {
  const now = '2026-11-16T10:00:00.000Z';
  const overdue = calculateStayMetrics(
    '2026-11-10T08:00:00.000Z',
    '2026-11-15T10:00:00.000Z',
    null,
    'CALENDAR_DAYS',
    DEFAULT_BED_DAY_CONFIG,
    now
  );
  assert.equal(overdue.dueState, 'OVERDUE');
  assert.ok(overdue.daysRemaining < 0);

  const dueToday = calculateStayMetrics(
    '2026-11-13T08:00:00.000Z',
    '2026-11-16T18:00:00.000Z',
    null,
    'CALENDAR_DAYS',
    DEFAULT_BED_DAY_CONFIG,
    now
  );
  assert.equal(dueToday.dueState, 'DUE_TODAY');

  const onTime = calculateStayMetrics(
    '2026-11-15T08:00:00.000Z',
    '2026-11-20T18:00:00.000Z',
    null,
    'CALENDAR_DAYS',
    DEFAULT_BED_DAY_CONFIG,
    now
  );
  assert.equal(onTime.dueState, 'ON_TIME');
});

test('calculateBedOccupancyRate calculates exact percentage from operational beds', () => {
  assert.equal(calculateBedOccupancyRate(5, 10), 50);
  assert.equal(calculateBedOccupancyRate(0, 0), 0);
  assert.equal(calculateBedOccupancyRate(3, 7), 42.9);
});

test('evaluateSystemAlerts generates all expected priority alerts', () => {
  const now = '2026-11-16T10:00:00.000Z';
  const alerts = evaluateSystemAlerts({
    admissions: [
      {
        id: 'a1',
        admission_code: 'HS-1',
        patient_id: 'p1',
        patient_code: 'BN-1',
        his_record_code: '',
        patient_name: 'BN Quá Hạn',
        date_of_birth: '1995-01-01',
        phone: '',
        diagnosis_group: 'Sinh thường',
        department_id: 'd1',
        room_id: 'r1',
        bed_id: 'b1',
        bed_code: 'A101-G01',
        is_whole_room: 0,
        hospital_admitted_at: '2026-11-10T08:00:00.000Z',
        bed_assigned_at: '2026-11-10T08:00:00.000Z',
        expected_discharge_at: '2026-11-15T08:00:00.000Z',
        calculation_method: 'CALENDAR_DAYS',
        extension_count: 0,
        status: 'ACTIVE',
        notes: '',
        confirmed_by: 'u1',
        confirmed_by_name: 'BS A',
        created_at: '2026-11-10T08:00:00.000Z',
        updated_at: '2026-11-10T08:00:00.000Z',
      },
    ],
    reservations: [],
    registrations: [],
    beds: [
      {
        id: 'b2',
        room_id: 'r1',
        department_id: 'd1',
        code: 'A101-G02',
        name: 'G02',
        status: 'PENDING_CLEANING',
        notes: '',
        created_at: now,
        updated_at: now,
      },
    ],
    devices: [
      {
        device_id: 'NODE-X',
        node_name: 'Node X',
        public_key: 'pub',
        status: 'OFFLINE',
        is_coordinator: 0,
        last_seen_at: now,
        paired_at: now,
      },
    ],
    pendingSyncCount: 2,
    openConflictCount: 1,
    failedBackupCount: 1,
    pendingRequestCount: 1,
    deptNames: { d1: 'Khoa Sản A' },
    dayConfig: DEFAULT_BED_DAY_CONFIG,
    reservationWarnMinutes: 120,
    nowIso: now,
  });

  const types = new Set(alerts.map((a) => a.type));
  assert.ok(types.has('BED_OVERDUE'));
  assert.ok(types.has('BED_PENDING_CLEANING'));
  assert.ok(types.has('DEVICE_OFFLINE'));
  assert.ok(types.has('SYNC_PENDING'));
  assert.ok(types.has('DATA_CONFLICT'));
  assert.ok(types.has('BACKUP_FAILED'));
  assert.ok(types.has('PENDING_CONFIRMATION'));
});

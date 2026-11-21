import type { DayCalculationMethod, RoundingRule } from '../types/bedcare';

export interface BedDayConfig {
  method: DayCalculationMethod;
  dayStartHour: number; // 0-23
  includeAdmissionDay: boolean;
  roundingRule: RoundingRule;
  dueSoonHours: number;
}

export const DEFAULT_BED_DAY_CONFIG: BedDayConfig = {
  method: 'CALENDAR_DAYS',
  dayStartHour: 0,
  includeAdmissionDay: true,
  roundingRule: 'CEIL',
  dueSoonHours: 24,
};

export function computeExpectedDischargeAt(
  bedAssignedAtIso: string,
  expectedDays: number,
  config: BedDayConfig
): string {
  const start = new Date(bedAssignedAtIso);
  if (Number.isNaN(start.getTime())) {
    throw new Error('Invalid bedAssignedAtIso timestamp');
  }
  const days = Math.max(1, Math.floor(expectedDays));

  if (config.method === 'ACTUAL_HOURS') {
    const ms = start.getTime() + days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  // CALENDAR_DAYS: if includeAdmissionDay is true, day 1 ends on admission day,
  // so 3 calendar days starting 2026-11-16 means discharge on 2026-11-18 at dayStartHour (or end of day)
  const deltaDays = config.includeAdmissionDay ? Math.max(0, days - 1) : days;
  const target = new Date(start.getTime());
  target.setUTCDate(target.getUTCDate() + deltaDays);
  target.setUTCHours(config.dayStartHour === 0 ? 17 : config.dayStartHour, 0, 0, 0);
  // If target ended up before start when deltaDays === 0, push to end of day or +24h
  if (target.getTime() <= start.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString();
}

export function applyRounding(value: number, rule: RoundingRule): number {
  if (rule === 'FLOOR') return Math.floor(value);
  if (rule === 'ROUND') return Math.round(value);
  return Math.ceil(value);
}

export interface StayMetrics {
  daysStayed: number;
  daysRemaining: number;
  hoursRemaining: number;
  dueState: 'ON_TIME' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE';
}

export function calculateStayMetrics(
  bedAssignedAtIso: string,
  expectedDischargeAtIso: string,
  actualDischargeAtIso: string | null | undefined,
  method: DayCalculationMethod,
  config: BedDayConfig,
  nowIso: string = new Date().toISOString()
): StayMetrics {
  const start = new Date(bedAssignedAtIso).getTime();
  const expectedEnd = new Date(expectedDischargeAtIso).getTime();
  const referenceNow = actualDischargeAtIso ? new Date(actualDischargeAtIso).getTime() : new Date(nowIso).getTime();

  let daysStayed = 0;
  if (method === 'ACTUAL_HOURS') {
    const diffHours = Math.max(0, (referenceNow - start) / (1000 * 60 * 60));
    daysStayed = Math.max(1, applyRounding(diffHours / 24, config.roundingRule));
  } else {
    const startDay = new Date(bedAssignedAtIso);
    startDay.setUTCHours(0, 0, 0, 0);
    const nowDay = new Date(referenceNow);
    nowDay.setUTCHours(0, 0, 0, 0);
    const diffDays = Math.max(0, Math.round((nowDay.getTime() - startDay.getTime()) / (24 * 60 * 60 * 1000)));
    daysStayed = config.includeAdmissionDay ? diffDays + 1 : Math.max(0, diffDays);
  }

  const hoursRemaining = (expectedEnd - referenceNow) / (1000 * 60 * 60);
  const daysRemaining = hoursRemaining >= 0
    ? applyRounding(hoursRemaining / 24, config.roundingRule)
    : -applyRounding(Math.abs(hoursRemaining) / 24, config.roundingRule);

  let dueState: StayMetrics['dueState'] = 'ON_TIME';
  if (hoursRemaining < 0) {
    dueState = 'OVERDUE';
  } else {
    const expectedDayStr = new Date(expectedEnd).toISOString().slice(0, 10);
    const nowDayStr = new Date(referenceNow).toISOString().slice(0, 10);
    if (expectedDayStr === nowDayStr) {
      dueState = 'DUE_TODAY';
    } else if (hoursRemaining <= config.dueSoonHours) {
      dueState = 'DUE_SOON';
    }
  }

  return {
    daysStayed,
    daysRemaining,
    hoursRemaining: Math.round(hoursRemaining * 10) / 10,
    dueState,
  };
}

/**
 * Bed occupancy rate formula (explicit denominator):
 * Numerator = count of beds with status 'OCCUPIED'
 * Denominator = total operational beds (all beds excluding 'INACTIVE' and 'MAINTENANCE')
 * Returns percentage rounded to 1 decimal place (0 - 100).
 */
export function calculateBedOccupancyRate(
  occupiedCount: number,
  operationalBedCount: number
): number {
  if (operationalBedCount <= 0) return 0;
  return Math.round((occupiedCount / operationalBedCount) * 1000) / 10;
}

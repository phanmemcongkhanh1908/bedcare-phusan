export interface HistoricalDischargeInput {
  diagnosis_group: string;
  bed_assigned_at: string;
  actual_discharge_at: string;
}

export interface DiagnosisBaselineInput {
  name: string;
  default_days: number;
}

export interface ActiveStayInput {
  id: string;
  bed_id: string;
  bed_code: string;
  room_id: string;
  room_name: string;
  department_id: string;
  department_name: string;
  patient_name: string;
  diagnosis_group: string;
  bed_assigned_at: string;
  expected_discharge_at: string;
  extension_count: number;
  is_whole_room: number | boolean;
  status: string;
}

export interface TurnaroundBedInput {
  id: string;
  code: string;
  room_id: string;
  room_name: string;
  department_id: string;
  department_name: string;
  status: string;
  updated_at?: string;
}

export interface VacancyCandidate {
  bedId: string;
  bedCode: string;
  roomName: string;
  departmentId: string;
  departmentName: string;
  sourceType: 'ADMISSION_DISCHARGE' | 'CLEANING_TURNAROUND';
  patientName?: string;
  diagnosisGroup?: string;
  probabilityPct: number;
  hoursToExpected: number;
  alosDays: number;
  daysStayed: number;
  reasonSummary: string;
}

export interface DepartmentVacancyForecast {
  departmentId: string;
  departmentName: string;
  expectedVacancies4h: number;
  anyVacancyProbabilityPct: number;
  candidateCount: number;
}

export interface VacancyPredictionSummary {
  modelType: string;
  horizonHours: number;
  anyVacancyProbabilityPct: number;
  expectedVacanciesNext4h: number;
  avgLengthOfStayDays: number;
  historicalSampleCount: number;
  upcomingDischarges4hCount: number;
  cleaningTurnaroundCount: number;
  topCandidates: VacancyCandidate[];
  departmentForecasts: DepartmentVacancyForecast[];
  generatedAt: string;
}

function sigmoid(z: number): number {
  if (z > 20) return 0.9999;
  if (z < -20) return 0.0001;
  return 1 / (1 + Math.exp(-z));
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function computeDiagnosisAlosMap(
  historicalDischarges: HistoricalDischargeInput[],
  diagnosisBaselines: DiagnosisBaselineInput[]
): { byDiagnosis: Record<string, number>; globalAlos: number } {
  const baselineMap: Record<string, number> = {};
  for (const d of diagnosisBaselines) {
    baselineMap[d.name] = Math.max(0.5, Number(d.default_days) || 3);
  }

  const samplesByDiag = new Map<string, number[]>();
  const allDurations: number[] = [];

  for (const h of historicalDischarges) {
    const startMs = new Date(h.bed_assigned_at).getTime();
    const endMs = new Date(h.actual_discharge_at).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const days = clamp((endMs - startMs) / 86400000, 0.25, 60);
    allDurations.push(days);
    const arr = samplesByDiag.get(h.diagnosis_group) ?? [];
    arr.push(days);
    samplesByDiag.set(h.diagnosis_group, arr);
  }

  const byDiagnosis: Record<string, number> = { ...baselineMap };
  for (const [diag, samples] of samplesByDiag.entries()) {
    const empMean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const prior = baselineMap[diag] ?? 3;
    // Bayesian shrinkage: blend empirical discharges with clinical diagnosis prior (weight=3)
    const blended = (empMean * samples.length + prior * 3) / (samples.length + 3);
    byDiagnosis[diag] = Number(blended.toFixed(2));
  }

  const baselineValues = Object.values(baselineMap);
  const priorGlobal = baselineValues.length > 0
    ? baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length
    : 3;

  const globalAlos =
    allDurations.length > 0
      ? Number(
          (
            (allDurations.reduce((a, b) => a + b, 0) + priorGlobal * 3) /
            (allDurations.length + 3)
          ).toFixed(2)
        )
      : Number(priorGlobal.toFixed(2));

  return { byDiagnosis, globalAlos };
}

export function predict4HourBedVacancies(params: {
  activeAdmissions: ActiveStayInput[];
  turnaroundBeds: TurnaroundBedInput[];
  historicalDischarges: HistoricalDischargeInput[];
  diagnosisBaselines: DiagnosisBaselineInput[];
  nowIso?: string;
}): VacancyPredictionSummary {
  const nowMs = new Date(params.nowIso ?? new Date().toISOString()).getTime();
  const { byDiagnosis, globalAlos } = computeDiagnosisAlosMap(
    params.historicalDischarges,
    params.diagnosisBaselines
  );

  const candidates: VacancyCandidate[] = [];
  let upcomingDischarges4hCount = 0;

  for (const adm of params.activeAdmissions) {
    if (adm.status !== 'ACTIVE') continue;
    const assignedMs = new Date(adm.bed_assigned_at).getTime();
    const expectedMs = new Date(adm.expected_discharge_at).getTime();
    const daysStayed = Math.max(0, (nowMs - assignedMs) / 86400000);
    const hoursToExpected = (expectedMs - nowMs) / 3600000;
    const alosDays = byDiagnosis[adm.diagnosis_group] ?? globalAlos;
    const alosRatio = clamp(daysStayed / Math.max(0.5, alosDays), 0, 2.5);

    if (hoursToExpected <= 4) {
      upcomingDischarges4hCount++;
    }

    // Calibrated Logistic Regression log-odds for 4h vacancy likelihood:
    // Positive drivers: schedule <= 4h, overdue, high ALOS progress ratio
    // Negative drivers: far future schedule, multiple active extensions
    const scheduleSignal =
      hoursToExpected <= 0
        ? 2.2 // Already overdue / discharge imminent
        : hoursToExpected <= 4
          ? 1.9 - (hoursToExpected / 4) * 0.6 // Scheduled within next 4 hours
          : hoursToExpected <= 12
            ? -0.9 - ((hoursToExpected - 4) / 8) * 1.1
            : -3.2;

    const alosSignal = (alosRatio - 0.75) * 1.35;
    const extensionPenalty = -0.35 * Math.min(3, Number(adm.extension_count) || 0);
    const intercept = -0.15;

    const prob = clamp(sigmoid(intercept + scheduleSignal + alosSignal + extensionPenalty), 0.01, 0.96);
    const probabilityPct = Math.round(prob * 100);

    let reasonSummary = '';
    if (hoursToExpected <= 0) {
      reasonSummary = `Quá hạn dự kiến trả ${Math.abs(hoursToExpected).toFixed(1)}h · Đã nằm ${daysStayed.toFixed(1)}/${alosDays.toFixed(1)} ngày ALOS`;
    } else if (hoursToExpected <= 4) {
      reasonSummary = `Đến hạn trả sau ${hoursToExpected.toFixed(1)}h · Đã nằm ${daysStayed.toFixed(1)}/${alosDays.toFixed(1)} ngày ALOS`;
    } else if (alosRatio >= 0.9) {
      reasonSummary = `Tiệm cận ALOS (${daysStayed.toFixed(1)}/${alosDays.toFixed(1)} ngày) · Còn ${hoursToExpected.toFixed(0)}h theo lịch`;
    } else {
      reasonSummary = `Còn ${hoursToExpected.toFixed(0)}h theo lịch · ALOS chuẩn ${alosDays.toFixed(1)} ngày`;
    }

    candidates.push({
      bedId: adm.bed_id,
      bedCode: adm.bed_code,
      roomName: adm.room_name,
      departmentId: adm.department_id,
      departmentName: adm.department_name,
      sourceType: 'ADMISSION_DISCHARGE',
      patientName: adm.patient_name,
      diagnosisGroup: adm.diagnosis_group,
      probabilityPct,
      hoursToExpected: Number(hoursToExpected.toFixed(1)),
      alosDays: Number(alosDays.toFixed(1)),
      daysStayed: Number(daysStayed.toFixed(1)),
      reasonSummary,
    });
  }

  let cleaningTurnaroundCount = 0;
  for (const bed of params.turnaroundBeds) {
    if (bed.status !== 'CLEANING' && bed.status !== 'PENDING_CLEANING') continue;
    cleaningTurnaroundCount++;
    const prob = bed.status === 'CLEANING' ? 0.94 : 0.85;
    candidates.push({
      bedId: bed.id,
      bedCode: bed.code,
      roomName: bed.room_name,
      departmentId: bed.department_id,
      departmentName: bed.department_name,
      sourceType: 'CLEANING_TURNAROUND',
      probabilityPct: Math.round(prob * 100),
      hoursToExpected: bed.status === 'CLEANING' ? 0.5 : 1.5,
      alosDays: 0,
      daysStayed: 0,
      reasonSummary:
        bed.status === 'CLEANING'
          ? 'Đang vệ sinh khử khuẩn · Dự kiến sẵn sàng trong ~30 phút'
          : 'Đang chờ vệ sinh sau trả giường · Chu kỳ hoàn tất < 2 giờ',
    });
  }

  candidates.sort((a, b) => b.probabilityPct - a.probabilityPct);

  const probs = candidates.map((c) => c.probabilityPct / 100);
  const expectedVacanciesNext4h = Number(probs.reduce((sum, p) => sum + p, 0).toFixed(1));
  const noneVacantProb = probs.reduce((acc, p) => acc * (1 - p), 1);
  const anyVacancyProbabilityPct = probs.length > 0 ? Math.round((1 - noneVacantProb) * 100) : 0;

  const deptMap = new Map<string, { name: string; probs: number[] }>();
  for (const c of candidates) {
    const entry = deptMap.get(c.departmentId) ?? { name: c.departmentName, probs: [] };
    entry.probs.push(c.probabilityPct / 100);
    deptMap.set(c.departmentId, entry);
  }

  const departmentForecasts: DepartmentVacancyForecast[] = Array.from(deptMap.entries())
    .map(([departmentId, info]) => {
      const exp = info.probs.reduce((s, p) => s + p, 0);
      const anyProb = 1 - info.probs.reduce((a, p) => a * (1 - p), 1);
      return {
        departmentId,
        departmentName: info.name,
        expectedVacancies4h: Number(exp.toFixed(1)),
        anyVacancyProbabilityPct: Math.round(anyProb * 100),
        candidateCount: info.probs.length,
      };
    })
    .sort((a, b) => b.anyVacancyProbabilityPct - a.anyVacancyProbabilityPct);

  return {
    modelType: 'Logistic Hazard (ALOS + Lịch trả giường + Vệ sinh)',
    horizonHours: 4,
    anyVacancyProbabilityPct,
    expectedVacanciesNext4h,
    avgLengthOfStayDays: globalAlos,
    historicalSampleCount: params.historicalDischarges.length,
    upcomingDischarges4hCount,
    cleaningTurnaroundCount,
    topCandidates: candidates.slice(0, 5),
    departmentForecasts,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

export interface Forecast48hBucket {
  windowLabel: string;
  fromHours: number;
  toHours: number;
  expectedReleases: number;
  cumulativeAvailableBeds: number;
  expectedRegistrations: number;
  netProjectedVacant: number;
}

export interface VacancyPrediction48hSummary {
  horizonHours: 48;
  currentVacantBeds: number;
  cleaningTurnaroundBeds: number;
  expectedDischarges48h: number;
  expectedIncomingRegistrations48h: number;
  projectedVacantAt24h: number;
  projectedVacantAt48h: number;
  historicalDischargesPerDay: number;
  historicalAdmissionsPerDay: number;
  buckets: Forecast48hBucket[];
  generatedAt: string;
}

export interface CapacityForecast7dDay {
  dayIndex: number;
  dateIso: string;
  dateLabel: string;
  operationalBeds: number;
  expectedAdmissions: number;
  expectedDischarges: number;
  projectedOccupied: number;
  projectedVacant: number;
  projectedOccupancyPct: number;
  isOverThreshold90: boolean;
}

export interface DepartmentThresholdAlert24h {
  departmentId: string;
  departmentName: string;
  operationalBeds: number;
  currentOccupied: number;
  currentOccupancyPct: number;
  scheduledAdmissions24h: number;
  expectedDischarges24h: number;
  projectedOccupied24h: number;
  projectedOccupancyPct24h: number;
  severity: 'CRITICAL' | 'WARNING';
  reasonSummary: string;
  recommendedAction: string;
}

export interface PredictiveAdmissionInput {
  id: string;
  department_id: string;
  bed_assigned_at: string;
  expected_discharge_at: string;
  actual_discharge_at?: string | null;
  status: string;
  diagnosis_group: string;
}

export interface PredictiveRegistrationInput {
  id: string;
  department_id?: string | null;
  expected_admission_date: string;
  status: string;
}

export interface PredictiveBedInput {
  id: string;
  department_id: string;
  status: string;
}

function estimateHistoricalDailyRates(params: {
  allAdmissions: PredictiveAdmissionInput[];
  historicalDischarges: HistoricalDischargeInput[];
  nowMs: number;
}): { admissionsPerDay: number; dischargesPerDay: number } {
  const lookbackDays = 7;
  const windowStart = params.nowMs - lookbackDays * 86400000;

  const recentAdms = params.allAdmissions.filter((a) => {
    const t = new Date(a.bed_assigned_at).getTime();
    return Number.isFinite(t) && t >= windowStart && t <= params.nowMs;
  }).length;

  const recentDischarges = params.historicalDischarges.filter((d) => {
    const t = new Date(d.actual_discharge_at).getTime();
    return Number.isFinite(t) && t >= windowStart && t <= params.nowMs;
  }).length;

  const activeFallbackRate = Math.max(0.4, Number((params.allAdmissions.filter((a) => a.status === 'ACTIVE').length / 4).toFixed(2)));
  const admissionsPerDay = recentAdms > 0 ? Number((recentAdms / lookbackDays).toFixed(2)) : activeFallbackRate;
  const dischargesPerDay = recentDischarges > 0 ? Number((recentDischarges / lookbackDays).toFixed(2)) : Number((activeFallbackRate * 0.85).toFixed(2));
  return { admissionsPerDay, dischargesPerDay };
}

export function predict48HourVacancies(params: {
  activeAdmissions: ActiveStayInput[];
  allAdmissions: PredictiveAdmissionInput[];
  turnaroundBeds: TurnaroundBedInput[];
  vacantBedCount: number;
  operationalBedCount: number;
  registrations: PredictiveRegistrationInput[];
  historicalDischarges: HistoricalDischargeInput[];
  diagnosisBaselines: DiagnosisBaselineInput[];
  nowIso?: string;
}): VacancyPrediction48hSummary {
  const nowMs = new Date(params.nowIso ?? new Date().toISOString()).getTime();
  const { byDiagnosis, globalAlos } = computeDiagnosisAlosMap(params.historicalDischarges, params.diagnosisBaselines);
  const rates = estimateHistoricalDailyRates({
    allAdmissions: params.allAdmissions,
    historicalDischarges: params.historicalDischarges,
    nowMs,
  });

  const windowDefs = [
    { windowLabel: '0–4h', fromHours: 0, toHours: 4 },
    { windowLabel: '4–8h', fromHours: 4, toHours: 8 },
    { windowLabel: '8–12h', fromHours: 8, toHours: 12 },
    { windowLabel: '12–24h', fromHours: 12, toHours: 24 },
    { windowLabel: '24–36h', fromHours: 24, toHours: 36 },
    { windowLabel: '36–48h', fromHours: 36, toHours: 48 },
  ];

  const cleaningTurnaroundBeds = params.turnaroundBeds.filter(
    (b) => b.status === 'CLEANING' || b.status === 'PENDING_CLEANING'
  ).length;

  let cumulativeAvailable = params.vacantBedCount;
  let cumulativeNet = params.vacantBedCount;
  let totalDischarges48h = 0;
  let totalRegistrations48h = 0;

  const buckets: Forecast48hBucket[] = windowDefs.map((w) => {
    const durationHrs = w.toHours - w.fromHours;
    let bucketReleases = 0;

    // Cleaning beds become ready in 0-4h
    if (w.fromHours === 0) {
      bucketReleases += cleaningTurnaroundBeds;
    }

    // Scheduled / ALOS-calibrated discharges falling into this window
    for (const adm of params.activeAdmissions) {
      if (adm.status !== 'ACTIVE') continue;
      const expectedMs = new Date(adm.expected_discharge_at).getTime();
      const assignedMs = new Date(adm.bed_assigned_at).getTime();
      const alosDays = byDiagnosis[adm.diagnosis_group] ?? globalAlos;
      const alosExitMs = assignedMs + alosDays * 86400000;
      const blendedExitHours = ((expectedMs * 0.7 + alosExitMs * 0.3) - nowMs) / 3600000;

      if (blendedExitHours <= 0 && w.fromHours === 0) {
        bucketReleases += 0.85;
        totalDischarges48h += 0.85;
      } else if (blendedExitHours > w.fromHours && blendedExitHours <= w.toHours) {
        bucketReleases += 0.9;
        totalDischarges48h += 0.9;
      }
    }

    // Incoming demand from scheduled registrations + historical inflow baseline
    let scheduledInWindow = 0;
    for (const reg of params.registrations) {
      if (reg.status !== 'WAITING' && reg.status !== 'RESERVED') continue;
      const admHrs = (new Date(reg.expected_admission_date).getTime() - nowMs) / 3600000;
      if ((admHrs <= 0 && w.fromHours === 0) || (admHrs > w.fromHours && admHrs <= w.toHours)) {
        scheduledInWindow += 1;
      }
    }
    const baselineInflow = Number(((rates.admissionsPerDay / 24) * durationHrs * 0.45).toFixed(1));
    const expectedRegs = Number((scheduledInWindow + baselineInflow).toFixed(1));

    const roundedReleases = Number(bucketReleases.toFixed(1));
    cumulativeAvailable = Math.min(params.operationalBedCount, Number((cumulativeAvailable + roundedReleases).toFixed(1)));
    cumulativeNet = clamp(Number((cumulativeNet + roundedReleases - expectedRegs).toFixed(1)), 0, params.operationalBedCount);
    totalRegistrations48h += expectedRegs;

    return {
      windowLabel: w.windowLabel,
      fromHours: w.fromHours,
      toHours: w.toHours,
      expectedReleases: roundedReleases,
      cumulativeAvailableBeds: cumulativeAvailable,
      expectedRegistrations: expectedRegs,
      netProjectedVacant: cumulativeNet,
    };
  });

  const bucket24 = buckets.find((b) => b.toHours === 24);
  const bucket48 = buckets.find((b) => b.toHours === 48);

  return {
    horizonHours: 48,
    currentVacantBeds: params.vacantBedCount,
    cleaningTurnaroundBeds,
    expectedDischarges48h: Number(totalDischarges48h.toFixed(1)),
    expectedIncomingRegistrations48h: Number(totalRegistrations48h.toFixed(1)),
    projectedVacantAt24h: Math.round(bucket24?.netProjectedVacant ?? params.vacantBedCount),
    projectedVacantAt48h: Math.round(bucket48?.netProjectedVacant ?? params.vacantBedCount),
    historicalDischargesPerDay: rates.dischargesPerDay,
    historicalAdmissionsPerDay: rates.admissionsPerDay,
    buckets,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

export function predict7DayCapacity(params: {
  activeAdmissions: ActiveStayInput[];
  allAdmissions: PredictiveAdmissionInput[];
  beds: PredictiveBedInput[];
  registrations: PredictiveRegistrationInput[];
  historicalDischarges: HistoricalDischargeInput[];
  diagnosisBaselines: DiagnosisBaselineInput[];
  nowIso?: string;
}): CapacityForecast7dDay[] {
  const nowMs = new Date(params.nowIso ?? new Date().toISOString()).getTime();
  const operationalBeds = params.beds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length;
  const currentOccupied = params.beds.filter((b) => b.status === 'OCCUPIED').length;

  const rates = estimateHistoricalDailyRates({
    allAdmissions: params.allAdmissions,
    historicalDischarges: params.historicalDischarges,
    nowMs,
  });

  const days: CapacityForecast7dDay[] = [];
  let rollingOccupied = currentOccupied;

  for (let i = 1; i <= 7; i++) {
    const dayStartMs = nowMs + (i - 1) * 86400000;
    const dayEndMs = nowMs + i * 86400000;
    const dObj = new Date(dayEndMs);
    const dateIso = dObj.toISOString().slice(0, 10);
    const dateLabel = `${String(dObj.getDate()).padStart(2, '0')}/${String(dObj.getMonth() + 1).padStart(2, '0')}`;

    const scheduledDischarges = params.activeAdmissions.filter((a) => {
      if (a.status !== 'ACTIVE') return false;
      const t = new Date(a.expected_discharge_at).getTime();
      if (i === 1 && t <= dayEndMs) return true;
      return t > dayStartMs && t <= dayEndMs;
    }).length;

    const scheduledAdmissions = params.registrations.filter((r) => {
      if (r.status !== 'WAITING' && r.status !== 'RESERVED') return false;
      const t = new Date(r.expected_admission_date).getTime();
      if (i === 1 && t <= dayEndMs) return true;
      return t > dayStartMs && t <= dayEndMs;
    }).length;

    // Blend scheduled pipeline with historical daily turnover velocity
    const expectedDischarges = Number((scheduledDischarges + rates.dischargesPerDay * (i <= 2 ? 0.35 : 0.75)).toFixed(1));
    const expectedAdmissions = Number((scheduledAdmissions + rates.admissionsPerDay * (i <= 2 ? 0.5 : 0.8)).toFixed(1));

    rollingOccupied = clamp(rollingOccupied + expectedAdmissions - expectedDischarges, 0, Math.max(1, operationalBeds));
    const projectedOccupied = Math.round(rollingOccupied);
    const projectedVacant = Math.max(0, operationalBeds - projectedOccupied);
    const projectedOccupancyPct = operationalBeds > 0 ? Math.round((projectedOccupied / operationalBeds) * 1000) / 10 : 0;

    days.push({
      dayIndex: i,
      dateIso,
      dateLabel,
      operationalBeds,
      expectedAdmissions,
      expectedDischarges,
      projectedOccupied,
      projectedVacant,
      projectedOccupancyPct,
      isOverThreshold90: projectedOccupancyPct > 90,
    });
  }

  return days;
}

export function evaluate24HourThresholdAlerts(params: {
  departments: Array<{ id: string; name: string; status: string }>;
  beds: PredictiveBedInput[];
  activeAdmissions: ActiveStayInput[];
  registrations: PredictiveRegistrationInput[];
  reservations: Array<{ id: string; department_id: string; status: string; is_whole_room: number }>;
  nowIso?: string;
}): DepartmentThresholdAlert24h[] {
  const nowMs = new Date(params.nowIso ?? new Date().toISOString()).getTime();
  const next24hMs = nowMs + 86400000;
  const alerts: DepartmentThresholdAlert24h[] = [];

  for (const dept of params.departments) {
    if (dept.status !== 'ACTIVE') continue;
    const dBeds = params.beds.filter((b) => b.department_id === dept.id);
    const operationalBeds = dBeds.filter((b) => b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE').length;
    if (operationalBeds === 0) continue;

    const currentOccupied = dBeds.filter((b) => b.status === 'OCCUPIED').length;
    const currentOccupancyPct = Math.round((currentOccupied / operationalBeds) * 1000) / 10;

    const activeReservations = params.reservations.filter(
      (r) => r.department_id === dept.id && r.status === 'ACTIVE'
    ).length;

    const waitingRegs24h = params.registrations.filter((r) => {
      if (r.department_id !== dept.id) return false;
      if (r.status !== 'WAITING') return false;
      const admMs = new Date(r.expected_admission_date).getTime();
      return !Number.isFinite(admMs) || admMs <= next24hMs;
    }).length;

    const scheduledAdmissions24h = activeReservations + waitingRegs24h;

    const expectedDischarges24h = params.activeAdmissions.filter((a) => {
      if (a.department_id !== dept.id || a.status !== 'ACTIVE') return false;
      const expMs = new Date(a.expected_discharge_at).getTime();
      return Number.isFinite(expMs) && expMs <= next24hMs;
    }).length;

    const projectedOccupied24h = clamp(
      currentOccupied + scheduledAdmissions24h - expectedDischarges24h,
      0,
      operationalBeds
    );
    const projectedOccupancyPct24h = Math.round((projectedOccupied24h / operationalBeds) * 1000) / 10;

    if (projectedOccupancyPct24h > 90 || currentOccupancyPct > 90) {
      const peakPct = Math.max(currentOccupancyPct, projectedOccupancyPct24h);
      alerts.push({
        departmentId: dept.id,
        departmentName: dept.name,
        operationalBeds,
        currentOccupied,
        currentOccupancyPct,
        scheduledAdmissions24h,
        expectedDischarges24h,
        projectedOccupied24h,
        projectedOccupancyPct24h,
        severity: currentOccupancyPct > 90 || peakPct >= 98 ? 'CRITICAL' : 'WARNING',
        reasonSummary:
          currentOccupancyPct > 90
            ? `Hiện đạt ${currentOccupancyPct}% (${currentOccupied}/${operationalBeds} giường) · Dự kiến 24h: ${projectedOccupancyPct24h}%`
            : `Hiện tại ${currentOccupancyPct}% nhưng có ${scheduledAdmissions24h} ca chờ nhập/giữ chỗ vs ${expectedDischarges24h} ca dự kiến ra -> dự báo 24h đạt ${projectedOccupancyPct24h}%`,
        recommendedAction:
          dBeds.some((b) => b.status === 'PENDING_CLEANING' || b.status === 'CLEANING')
            ? 'Ưu tiên đẩy nhanh vệ sinh giường trống và chuẩn bị điều chuyển liên khoa khi có ca mới.'
            : 'Rà soát ca sắp đến hạn trả giường hoặc chủ động điều phối liên khoa sang khoa còn trống.',
      });
    }
  }

  return alerts.sort((a, b) => Math.max(b.projectedOccupancyPct24h, b.currentOccupancyPct) - Math.max(a.projectedOccupancyPct24h, a.currentOccupancyPct));
}

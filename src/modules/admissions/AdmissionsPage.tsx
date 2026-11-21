import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiFetch } from '../../services/api';
import type {
  Admission,
  Bed,
  Department,
  DiagnosisConfig,
  Registration,
  Reservation,
  Room,
  RoomStandard,
  UserRole,
} from '../../types/bedcare';
import {
  evaluateBedRegistrationRules,
  type BedRegistrationCheckResult,
} from '../../utils/bedRegistrationEngine';

interface AdmissionsPageProps {
  userRole?: UserRole;
  userDeptId?: string | null;
  initialRegistrationId?: string;
  onClearInitialRegistration?: () => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

function getBedSelectLabel(
  bed: Bed,
  occupant: Admission | undefined,
  selectedResId: string
): string {
  if (occupant) {
    return `${bed.code} — Đang có BN: ${occupant.patient_name} (${occupant.patient_code} · Chưa xuất viện)`;
  }
  if (bed.status === 'OCCUPIED') {
    return `${bed.code} — Đang có người nằm (Chưa xuất viện)`;
  }
  if (bed.status === 'PENDING_CONFIRMATION') {
    return `${bed.code} — Chờ xác nhận đồng thuận`;
  }
  if (bed.status === 'RESERVED') {
    if (selectedResId && bed.current_reservation_id === selectedResId) {
      return `${bed.code} — Đã giữ chỗ cho hồ sơ này`;
    }
    return `${bed.code} — Đã giữ chỗ (${bed.reservation_patient_name || 'lượt khác'})`;
  }
  if (bed.status === 'PENDING_CLEANING' || bed.status === 'CLEANING') {
    return `${bed.code} — Đang vệ sinh / chờ làm sạch`;
  }
  if (bed.status === 'MAINTENANCE') {
    return `${bed.code} — Đang bảo trì`;
  }
  if (bed.status === 'INACTIVE') {
    return `${bed.code} — Ngừng hoạt động`;
  }
  return `${bed.code} — Trống sẵn sàng`;
}

export function AdmissionsPage({
  userRole,
  userDeptId,
  initialRegistrationId,
  onClearInitialRegistration,
  onNotify,
}: AdmissionsPageProps) {
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [activeAdmissions, setActiveAdmissions] = useState<Admission[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [standards, setStandards] = useState<RoomStandard[]>([]);
  const [diagnoses, setDiagnoses] = useState<DiagnosisConfig[]>([]);

  const [selectedRegId, setSelectedRegId] = useState('');
  const [selectedResId, setSelectedResId] = useState('');
  const [patientCode, setPatientCode] = useState('');
  const [hisCode, setHisCode] = useState('');
  const [patientName, setPatientName] = useState('');
  const [dob, setDob] = useState('1994-01-01');
  const [phone, setPhone] = useState('');
  const [diagGroup, setDiagGroup] = useState('Sinh thường');
  const [deptId, setDeptId] = useState(userDeptId || '');
  const [roomId, setRoomId] = useState('');
  const [bedId, setBedId] = useState('');
  const [isWholeRoom, setIsWholeRoom] = useState(false);
  const [overrideQuotaLimit, setOverrideQuotaLimit] = useState(false);
  const [expectedDischarge, setExpectedDischarge] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverPrecheck, setServerPrecheck] = useState<BedRegistrationCheckResult | null>(null);

  const isAdminUser = userRole === 'SUPER_ADMIN' || userRole === 'ADMIN';

  const load = async () => {
    try {
      const [regs, rsvs, adms, depts, rms, bds, stds, cfg] = await Promise.all([
        apiFetch<Registration[]>('/registrations'),
        apiFetch<Reservation[]>('/reservations'),
        apiFetch<Admission[]>('/admissions?status=ACTIVE'),
        apiFetch<Department[]>('/departments'),
        apiFetch<Room[]>('/rooms'),
        apiFetch<Bed[]>('/beds'),
        apiFetch<RoomStandard[]>('/room-standards'),
        apiFetch<{ diagnoses: DiagnosisConfig[] }>('/settings'),
      ]);
      setRegistrations(regs.filter((r) => r.status === 'WAITING' || r.status === 'RESERVED'));
      setReservations(rsvs.filter((r) => r.status === 'ACTIVE'));
      setActiveAdmissions(adms);
      setDepartments(depts);
      setRooms(rms);
      setBeds(bds);
      setStandards(stds);
      setDiagnoses(cfg.diagnoses);
      if (!deptId && depts.length > 0) setDeptId(userDeptId || depts[0].id);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const onClusterSync = () => load();
    window.addEventListener('bedcare-cluster-sync', onClusterSync);
    return () => window.removeEventListener('bedcare-cluster-sync', onClusterSync);
  }, []);

  const pickRegistration = (reg: Registration) => {
    setSelectedRegId(reg.id);
    setPatientCode(reg.patient_code);
    setHisCode(reg.his_record_code || '');
    setPatientName(reg.patient_name);
    setDob(reg.date_of_birth);
    setPhone(reg.phone || '');
    setDiagGroup(reg.diagnosis_group);
    setOverrideQuotaLimit(false);
    if (reg.department_id && (!userDeptId || reg.department_id === userDeptId)) {
      setDeptId(reg.department_id);
    }
    if (reg.room_id && (!userDeptId || reg.department_id === userDeptId)) {
      setRoomId(reg.room_id);
    } else {
      setRoomId('');
    }
    if (reg.bed_id && (!userDeptId || reg.department_id === userDeptId)) {
      setBedId(reg.bed_id);
    } else {
      setBedId('');
    }
    const matchedRes = reservations.find((r) => r.registration_id === reg.id);
    if (matchedRes) {
      setSelectedResId(matchedRes.id);
      setIsWholeRoom(Boolean(matchedRes.is_whole_room));
      if (matchedRes.is_whole_room && matchedRes.locked_bed_ids.length > 0) {
        setBedId(matchedRes.locked_bed_ids[0]);
      } else if (matchedRes.bed_id) {
        setBedId(matchedRes.bed_id);
      }
      if (!userDeptId || matchedRes.department_id === userDeptId) {
        setDeptId(matchedRes.department_id);
        setRoomId(matchedRes.room_id);
      }
    } else {
      setSelectedResId('');
      setIsWholeRoom(false);
    }
  };

  useEffect(() => {
    if (!initialRegistrationId || registrations.length === 0) return;
    const match = registrations.find((r) => r.id === initialRegistrationId);
    if (match) {
      pickRegistration(match);
      onClearInitialRegistration?.();
    }
  }, [initialRegistrationId, registrations, reservations]);

  // Synchronous instant client-side validation check
  const localCheck = useMemo(
    () =>
      evaluateBedRegistrationRules({
        departmentId: deptId,
        roomId: roomId || undefined,
        bedId: bedId || undefined,
        patientCode: patientCode || undefined,
        hisRecordCode: hisCode || undefined,
        reservationId: selectedResId || undefined,
        isWholeRoom,
        overrideQuotaLimit: isAdminUser && overrideQuotaLimit,
        departments,
        rooms,
        beds,
        activeAdmissions,
      }),
    [
      deptId,
      roomId,
      bedId,
      patientCode,
      hisCode,
      selectedResId,
      isWholeRoom,
      isAdminUser,
      overrideQuotaLimit,
      departments,
      rooms,
      beds,
      activeAdmissions,
    ]
  );

  // Authoritative server-side precheck (includes HIS bed mappings & HIS active assignments)
  useEffect(() => {
    if (!deptId) {
      setServerPrecheck(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<BedRegistrationCheckResult>('/admissions/precheck', {
          method: 'POST',
          body: JSON.stringify({
            department_id: deptId,
            room_id: roomId || undefined,
            bed_id: bedId || undefined,
            patient_code: patientCode.trim() || undefined,
            his_record_code: hisCode.trim() || undefined,
            reservation_id: selectedResId || undefined,
            is_whole_room: isWholeRoom,
            override_quota_limit: isAdminUser && overrideQuotaLimit,
          }),
        });
        if (!cancelled) setServerPrecheck(res);
      } catch {
        if (!cancelled) setServerPrecheck(null);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    deptId,
    roomId,
    bedId,
    patientCode,
    hisCode,
    selectedResId,
    isWholeRoom,
    isAdminUser,
    overrideQuotaLimit,
    activeAdmissions.length,
    beds.length,
  ]);

  const activeCheck = serverPrecheck ?? localCheck;

  const allowedDepts = userDeptId ? departments.filter((d) => d.id === userDeptId) : departments;
  const deptRooms = rooms.filter((r) => r.department_id === deptId && r.status === 'ACTIVE');

  // Show ALL beds in the room sorted with available beds first so occupied/undischarged beds can be inspected & caught cleanly
  const roomBedsSorted = useMemo(() => {
    const inRoom = beds.filter((b) => b.room_id === roomId);
    const rank = (b: Bed) => {
      if (b.status === 'RESERVED' && selectedResId && b.current_reservation_id === selectedResId) return 0;
      if (b.status === 'VACANT') return 1;
      if (b.status === 'RESERVED') return 2;
      if (b.status === 'PENDING_CLEANING' || b.status === 'CLEANING') return 3;
      if (b.status === 'OCCUPIED' || b.status === 'PENDING_CONFIRMATION') return 4;
      return 5;
    };
    return [...inRoom].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
  }, [beds, roomId, selectedResId]);

  const occupantByBedId = useMemo(() => {
    const map = new Map<string, Admission>();
    for (const adm of activeAdmissions) {
      if (!adm.actual_discharge_at && (adm.status === 'ACTIVE' || adm.status === 'PENDING_CONFIRMATION')) {
        map.set(adm.bed_id, adm);
      }
    }
    return map;
  }, [activeAdmissions]);

  // Desired standards mismatch check
  const selectedReg = registrations.find((r) => r.id === selectedRegId);
  const desiredStdIds = selectedReg?.desired_standard_ids || [];
  const selectedRoomObj = rooms.find((r) => r.id === roomId);
  const missingStandards =
    selectedRoomObj && desiredStdIds.length > 0
      ? desiredStdIds
          .filter((sid) => !(selectedRoomObj.standard_ids || []).includes(sid))
          .map((sid) => standards.find((s) => s.id === sid)?.name || sid)
      : [];

  // Smart Bed Suggestions (top 3 suitable vacant or matching-reserved beds)
  const smartSuggestions = (() => {
    const candidateDepts = userDeptId ? [userDeptId] : deptId ? [deptId] : allowedDepts.map((d) => d.id);
    const candidates: Array<{
      score: number;
      deptId: string;
      deptName: string;
      roomId: string;
      roomName: string;
      bedId: string;
      bedCode: string;
      reason: string;
    }> = [];

    for (const rm of rooms) {
      if (rm.status !== 'ACTIVE' || !candidateDepts.includes(rm.department_id)) continue;
      if (rm.exclusive_locked && !(selectedResId && rm.exclusive_lock_id === selectedResId)) continue;

      const rmBeds = beds.filter((b) => b.room_id === rm.id);
      const hasOccupied = rmBeds.some((b) => b.status === 'OCCUPIED');
      if (
        isWholeRoom &&
        !rmBeds.every((b) => b.status === 'VACANT' || (selectedResId && b.current_reservation_id === selectedResId))
      ) {
        continue;
      }

      const matchedStdCount = desiredStdIds.filter((sid) => (rm.standard_ids || []).includes(sid)).length;
      const allStdsMet = desiredStdIds.length === 0 || matchedStdCount === desiredStdIds.length;

      for (const b of rmBeds) {
        const isReservedForPatient = Boolean(
          selectedResId && b.status === 'RESERVED' && b.current_reservation_id === selectedResId
        );
        if (b.status !== 'VACANT' && !isReservedForPatient) continue;

        let score = 0;
        const reasons: string[] = [];
        if (isReservedForPatient) {
          score += 100;
          reasons.push('Đã giữ chỗ riêng');
        }
        if (allStdsMet && desiredStdIds.length > 0) {
          score += 40;
          reasons.push('Đạt đủ tiêu chuẩn ĐK');
        } else {
          score += matchedStdCount * 10;
        }
        if (!hasOccupied) {
          score += 15;
          reasons.push('Phòng trống hoàn toàn');
        }
        if (rm.department_id === deptId) score += 10;

        const deptName = departments.find((d) => d.id === rm.department_id)?.name || rm.department_name || '';
        candidates.push({
          score,
          deptId: rm.department_id,
          deptName,
          roomId: rm.id,
          roomName: rm.name,
          bedId: b.id,
          bedCode: b.code,
          reason: reasons.length > 0 ? reasons.join(' · ') : 'Giường trống sẵn sàng',
        });
      }
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
  })();

  const hasQuotaExceededBlock = activeCheck.blocks.some((b) => b.code === 'DEPT_QUOTA_EXCEEDED');

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeCheck.allowed && activeCheck.blocks.length > 0) {
      onNotify(activeCheck.blocks[0].message, 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{
        admission_code?: string;
        pendingConfirmation?: boolean;
        queuedOffline?: boolean;
        warnings?: Array<{ title: string }>;
      }>('/admissions/confirm', {
        method: 'POST',
        body: JSON.stringify({
          registration_id: selectedRegId || undefined,
          reservation_id: selectedResId || undefined,
          patient_code: patientCode,
          his_record_code: hisCode,
          patient_name: patientName,
          date_of_birth: dob,
          phone,
          diagnosis_group: diagGroup,
          department_id: deptId,
          room_id: roomId,
          bed_id: bedId,
          is_whole_room: isWholeRoom,
          override_quota_limit: isAdminUser && overrideQuotaLimit,
          expected_discharge_at: expectedDischarge ? new Date(expectedDischarge).toISOString() : undefined,
          notes,
        }),
      });
      if (res?.queuedOffline) {
        onNotify(`Đang mất mạng: đã lưu hồ sơ tiếp nhận ${patientName} vào Pending Actions để phát đồng bộ sau.`);
      } else {
        const warnSuffix =
          res.warnings && res.warnings.length > 0
            ? ` (Lưu ý: ${res.warnings.map((w) => w.title).join('; ')})`
            : '';
        onNotify(
          res.pendingConfirmation
            ? `Hồ sơ ${res.admission_code} đang Chờ xác nhận đồng thuận do mạng phân vùng.`
            : `Đã tiếp nhận bệnh nhân (${res.admission_code}) vào giường thành công.${warnSuffix}`
        );
      }
      setSelectedRegId('');
      setSelectedResId('');
      setPatientCode('');
      setHisCode('');
      setPatientName('');
      setPhone('');
      setRoomId('');
      setBedId('');
      setNotes('');
      setOverrideQuotaLimit(false);
      setServerPrecheck(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const quota = activeCheck.departmentQuota;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Tiếp nhận vào khoa &amp; Cấp giường</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Tích hợp Engine kiểm tra logic đăng ký giường: tự động chặn trùng giường, giường chưa xuất viện, trùng mã BN/HIS và cảnh báo vượt hạn mức BHYT khoa.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 font-semibold text-sm text-slate-900">
            Hồ sơ đăng ký chờ tiếp nhận ({registrations.length})
          </div>
          <div className="divide-y divide-slate-100 max-h-[260px] lg:max-h-[640px] overflow-y-auto">
            {registrations.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">Chưa có hồ sơ đăng ký trước đang chờ.</div>
            ) : (
              registrations.map((reg) => (
                <button
                  key={reg.id}
                  type="button"
                  onClick={() => pickRegistration(reg)}
                  className={`w-full min-h-[44px] text-left px-4 py-3 hover:bg-sky-50/50 transition-colors ${
                    selectedRegId === reg.id ? 'bg-sky-50 ring-1 ring-inset ring-sky-200' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm text-slate-900">{reg.patient_name}</span>
                    <span
                      className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
                        reg.status === 'RESERVED'
                          ? 'bg-amber-50 text-amber-800 border border-amber-200'
                          : 'bg-sky-50 text-sky-700'
                      }`}
                    >
                      {reg.status === 'RESERVED' ? 'Đã giữ chỗ' : reg.registration_code}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {reg.patient_code} · {reg.diagnosis_group}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    {reg.department_name || 'Chưa chọn khoa'} {reg.bed_code ? `· Đã giữ ${reg.bed_code}` : ''}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <form
          onSubmit={handleConfirm}
          className="lg:col-span-7 rounded-lg border border-slate-200 bg-white p-4 sm:p-6 space-y-4"
        >
          <h3 className="text-base font-semibold text-slate-900">Thông tin xác nhận nhập khoa &amp; cấp giường</h3>

          {/* Department Bed Quota & Logic Validation Engine Panel */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                {activeCheck.blocks.length > 0 ? (
                  <ShieldAlert className="h-4 w-4 text-rose-600" />
                ) : activeCheck.warnings.length > 0 ? (
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-700" />
                )}
                <span>Engine Kiểm tra Logic &amp; Hạn mức Giường Khoa</span>
              </div>
              {quota && (
                <div className="text-xs font-mono tabular-nums text-slate-700">
                  Công suất khoa: <strong>{quota.active_occupied_beds}</strong>
                  {quota.projected_occupied_beds !== quota.active_occupied_beds && (
                    <span> → <strong>{quota.projected_occupied_beds}</strong></span>
                  )}
                  /{quota.planned_bhyt_beds} KH BHYT ({quota.projected_utilization_pct}% · trần tối đa {quota.max_allowed_beds}/
                  {quota.physical_beds} vật lý)
                </div>
              )}
            </div>

            {quota && quota.planned_bhyt_beds > 0 && (
              <div className="h-1.5 w-full rounded bg-slate-200 overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    quota.status === 'EXCEEDS_MAX_QUOTA'
                      ? 'bg-rose-600'
                      : quota.status === 'OVER_PLANNED_WARNING'
                        ? 'bg-amber-500'
                        : 'bg-emerald-600'
                  }`}
                  style={{ width: `${Math.min(100, quota.projected_utilization_pct)}%` }}
                />
              </div>
            )}

            {activeCheck.blocks.length > 0 && (
              <div className="space-y-2">
                {activeCheck.blocks.map((blk, idx) => (
                  <div
                    key={`${blk.code}-${idx}`}
                    className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 space-y-0.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-700 shrink-0" />
                      <span className="font-mono text-[11px] text-rose-700">[{blk.code}]</span>
                      <span>CHẶN: {blk.title}</span>
                    </div>
                    <div className="text-rose-800 pl-5">{blk.message}</div>
                  </div>
                ))}
              </div>
            )}

            {activeCheck.warnings.length > 0 && (
              <div className="space-y-2">
                {activeCheck.warnings.map((wrn, idx) => (
                  <div
                    key={`${wrn.code}-${idx}`}
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-0.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-700 shrink-0" />
                      <span className="font-mono text-[11px] text-amber-700">[{wrn.code}]</span>
                      <span>CẢNH BÁO: {wrn.title}</span>
                    </div>
                    <div className="text-amber-800 pl-5">{wrn.message}</div>
                  </div>
                ))}
              </div>
            )}

            {activeCheck.blocks.length === 0 && activeCheck.warnings.length === 0 && bedId && (
              <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>Hợp lệ: Không trùng ID giường, không có bệnh nhân chưa xuất viện và nằm trong hạn mức khoa.</span>
              </div>
            )}

            {(hasQuotaExceededBlock || overrideQuotaLimit) && isAdminUser && (
              <label className="flex items-center gap-2 rounded border border-rose-200 bg-white px-3 py-2 text-xs font-medium text-rose-900 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideQuotaLimit}
                  onChange={(e) => setOverrideQuotaLimit(e.target.checked)}
                  className="h-4 w-4 rounded border-rose-300"
                />
                <span>Admin xác nhận vượt hạn mức giường BHYT khẩn cấp (chỉ áp dụng nếu còn giường vật lý)</span>
              </label>
            )}
          </div>

          {smartSuggestions.length > 0 && (
            <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-900">
                <Sparkles className="h-3.5 w-3.5 text-sky-700" />
                <span>Gợi ý giường tối ưu (1 chạm chọn nhanh):</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {smartSuggestions.map((sg) => (
                  <button
                    key={sg.bedId}
                    type="button"
                    onClick={() => {
                      setDeptId(sg.deptId);
                      setRoomId(sg.roomId);
                      setBedId(sg.bedId);
                    }}
                    className={`text-left rounded-md border p-2.5 min-h-[44px] transition-colors ${
                      bedId === sg.bedId
                        ? 'border-sky-700 bg-sky-700 text-white'
                        : 'border-sky-200 bg-white text-slate-800 hover:bg-sky-50'
                    }`}
                  >
                    <div className="font-mono text-xs font-bold">
                      {sg.bedCode} · {sg.roomName}
                    </div>
                    <div
                      className={`text-[11px] mt-0.5 truncate ${
                        bedId === sg.bedId ? 'text-sky-100' : 'text-slate-500'
                      }`}
                    >
                      {sg.reason}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mã bệnh nhân *</label>
              <input
                type="text"
                required
                value={patientCode}
                onChange={(e) => setPatientCode(e.target.value)}
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mã HIS (MA_LK)</label>
              <input
                type="text"
                value={hisCode}
                onChange={(e) => setHisCode(e.target.value)}
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Họ tên bệnh nhân *</label>
              <input
                type="text"
                required
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Ngày sinh *</label>
              <input
                type="date"
                required
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Chẩn đoán *</label>
              <select
                value={diagGroup}
                onChange={(e) => setDiagGroup(e.target.value)}
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                {diagnoses.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name} ({d.default_days} ngày)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Khoa tiếp nhận *</label>
              <select
                value={deptId}
                onChange={(e) => {
                  setDeptId(e.target.value);
                  setRoomId('');
                  setBedId('');
                  setOverrideQuotaLimit(false);
                }}
                required
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                {allowedDepts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phòng *</label>
              <select
                value={roomId}
                onChange={(e) => {
                  setRoomId(e.target.value);
                  setBedId('');
                }}
                required
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="">-- Chọn phòng --</option>
                {deptRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.capacity} giường)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Giường cấp *</label>
              <select
                value={bedId}
                onChange={(e) => setBedId(e.target.value)}
                required
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="">-- Chọn giường trong phòng --</option>
                {roomBedsSorted.map((b) => (
                  <option key={b.id} value={b.id}>
                    {getBedSelectLabel(b, occupantByBedId.get(b.id), selectedResId)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Điều chỉnh ngày trả dự kiến (tùy chọn)</label>
              <input
                type="datetime-local"
                value={expectedDischarge}
                onChange={(e) => setExpectedDischarge(e.target.value)}
                className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-center pb-2 pt-2">
              <label className="inline-flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer min-h-[44px]">
                <input
                  type="checkbox"
                  checked={isWholeRoom}
                  onChange={(e) => setIsWholeRoom(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>Khóa bao trọn phòng này</span>
              </label>
            </div>
          </div>

          {missingStandards.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
              Lưu ý: Phòng đang chọn chưa đáp ứng tiêu chuẩn mong muốn khi đăng ký ({missingStandards.join(', ')}).
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Ghi chú tiếp nhận</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={submitting || !activeCheck.allowed}
              className="w-full sm:w-auto min-h-[44px] rounded-md bg-sky-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
            >
              {submitting ? 'Đang xác nhận đồng thuận...' : 'Xác nhận tiếp nhận & Cấp giường'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

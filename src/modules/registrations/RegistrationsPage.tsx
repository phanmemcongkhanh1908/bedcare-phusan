import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Search, Sparkles, Upload } from 'lucide-react';
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { apiFetch } from '../../services/api';
import type { Bed, Department, DiagnosisConfig, Registration, Room, RoomStandard, UserRole } from '../../types/bedcare';
import { exportPatientImportTemplate, parseSpreadsheetFile } from '../../utils/exportUtils';
import { formatDateTimeVN, formatDateVN, toLocalDateTimeInputValue } from '../../utils/formatters';
import { canReserveInRoom } from '../../utils/roomBedValidation';

interface RegistrationsPageProps {
  userRole?: UserRole;
  userDeptId?: string | null;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onOpenReservation?: (regId: string) => void;
  onOpenAdmission?: (regId: string) => void;
}

interface PatientLookupResult {
  found: boolean;
  patient: {
    id: string;
    patient_code: string;
    his_record_code: string;
    full_name: string;
    date_of_birth: string;
    phone: string;
  } | null;
  activeAdmission: {
    id: string;
    admission_code: string;
    bed_code: string;
    department_name: string;
  } | null;
  openRegistration: {
    id: string;
    registration_code: string;
    status: string;
    department_name: string | null;
    bed_code: string | null;
  } | null;
}

export function RegistrationsPage({ userRole, userDeptId, onNotify, onOpenReservation, onOpenAdmission }: RegistrationsPageProps) {
  const [tab, setTab] = useState<'form' | 'import' | 'list'>('form');
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [standards, setStandards] = useState<RoomStandard[]>([]);
  const [diagnoses, setDiagnoses] = useState<DiagnosisConfig[]>([]);

  // Registration Form
  const [patientCode, setPatientCode] = useState('');
  const [hisCode, setHisCode] = useState('');
  const [patientName, setPatientName] = useState('');
  const [dob, setDob] = useState('1995-01-01');
  const [phone, setPhone] = useState('');
  const [diagGroup, setDiagGroup] = useState('Sinh thường');
  const [expectedAdmit, setExpectedAdmit] = useState(() => toLocalDateTimeInputValue());
  const [desiredStds, setDesiredStds] = useState<string[]>([]);
  const [mode, setMode] = useState<'UNKNOWN_DEPT' | 'KNOWN_DEPT'>('UNKNOWN_DEPT');
  const [deptId, setDeptId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [bedId, setBedId] = useState('');
  const [holdType, setHoldType] = useState<'NONE' | 'WAITLIST' | 'SINGLE_BED' | 'WHOLE_ROOM'>('WAITLIST');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Patient Lookup State
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResult, setLookupResult] = useState<PatientLookupResult | null>(null);

  // List tab filtering & cancellation
  const [listSearch, setListSearch] = useState('');
  const [listStatusFilter, setListStatusFilter] = useState<string>('');
  const [cancelTarget, setCancelTarget] = useState<Registration | null>(null);

  // Excel/CSV Import Wizard
  const [importFileName, setImportFileName] = useState('');
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Array<Record<string, string>>>([]);
  const [colMap, setColMap] = useState({
    patient_code: '',
    his_record_code: '',
    full_name: '',
    date_of_birth: '',
    phone: '',
    diagnosis_group: '',
  });
  const [importResult, setImportResult] = useState<{
    totalRows: number;
    importedRows: number;
    duplicateRows: number;
    errorRows: number;
  } | null>(null);
  const [importLogs, setImportLogs] = useState<Array<Record<string, unknown>>>([]);

  const canAdmitDirectly = userRole !== 'CASHIER' && userRole !== 'EXECUTIVE';

  const load = async () => {
    try {
      const [regs, depts, rms, bds, stds, settingsRes, logs] = await Promise.all([
        apiFetch<Registration[]>('/registrations'),
        apiFetch<Department[]>('/departments'),
        apiFetch<Room[]>('/rooms'),
        apiFetch<Bed[]>('/beds'),
        apiFetch<RoomStandard[]>('/room-standards'),
        apiFetch<{ diagnoses: DiagnosisConfig[] }>('/settings'),
        apiFetch<Array<Record<string, unknown>>>('/import/logs'),
      ]);
      setRegistrations(regs);
      setDepartments(depts);
      setRooms(rms);
      setBeds(bds);
      setStandards(stds);
      setDiagnoses(settingsRes.diagnoses);
      setImportLogs(logs);
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

  const handleLookupPatient = async (codeOverride?: string) => {
    const code = (codeOverride ?? patientCode).trim();
    if (!code) {
      setLookupResult(null);
      return;
    }
    setLookingUp(true);
    try {
      const res = await apiFetch<PatientLookupResult>(`/patients/lookup?code=${encodeURIComponent(code)}`);
      setLookupResult(res);
      if (res.found && res.patient) {
        if (!patientName.trim()) setPatientName(res.patient.full_name);
        if (!hisCode.trim() && res.patient.his_record_code) setHisCode(res.patient.his_record_code);
        if (res.patient.date_of_birth) setDob(res.patient.date_of_birth);
        if (!phone.trim() && res.patient.phone) setPhone(res.patient.phone);
      }
    } catch {
      // Ignore lookup network errors silently
    } finally {
      setLookingUp(false);
    }
  };

  const deptRooms = rooms.filter((r) => {
    if (r.department_id !== deptId || r.status !== 'ACTIVE' || r.exclusive_locked) return false;
    if (desiredStds.length > 0) {
      return desiredStds.every((s) => (r.standard_ids || []).includes(s));
    }
    return true;
  });

  const wholeRoomEligible = (rId: string) => {
    const rBeds = beds.filter((b) => b.room_id === rId && b.status !== 'INACTIVE');
    return rBeds.length > 0 && rBeds.every((b) => b.status === 'VACANT');
  };

  const selectedRoomObj = rooms.find((r) => r.id === roomId);
  const selectedRoomCheck = selectedRoomObj
    ? canReserveInRoom(
        selectedRoomObj,
        beds.filter((b) => b.room_id === selectedRoomObj.id)
      )
    : { allowed: true };

  const matchingVacantBeds = selectedRoomCheck.allowed
    ? beds.filter((b) => b.room_id === roomId && b.status === 'VACANT')
    : [];

  // Suggested ready beds in selected dept matching desired standards
  const quickSuggestedBeds = deptRooms
    .flatMap((rm) => {
      const rmBeds = beds.filter((b) => b.room_id === rm.id);
      const chk = canReserveInRoom(rm, rmBeds);
      if (!chk.allowed) return [];
      const vacants = rmBeds.filter((b) => b.status === 'VACANT');
      return vacants.map((b) => ({ room: rm, bed: b }));
    })
    .slice(0, 4);

  const handleSubmitReg = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'KNOWN_DEPT' && (holdType === 'SINGLE_BED' || holdType === 'WHOLE_ROOM') && !selectedRoomCheck.allowed) {
      onNotify(selectedRoomCheck.reason || 'Phòng đang sử dụng, hệ thống chặn giữ chỗ.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ registration_code?: string; pendingConfirmation?: boolean; queuedOffline?: boolean }>('/registrations', {
        method: 'POST',
        body: JSON.stringify({
          patient_code: patientCode,
          his_record_code: hisCode,
          patient_name: patientName,
          date_of_birth: dob,
          phone,
          diagnosis_group: diagGroup,
          expected_admission_date: new Date(expectedAdmit).toISOString(),
          desired_standard_ids: desiredStds,
          registration_mode: mode,
          department_id: mode === 'KNOWN_DEPT' ? deptId : null,
          room_id: mode === 'KNOWN_DEPT' && (holdType === 'SINGLE_BED' || holdType === 'WHOLE_ROOM') ? roomId || null : null,
          bed_id: mode === 'KNOWN_DEPT' && holdType === 'SINGLE_BED' ? bedId || null : null,
          reservation_type: mode === 'UNKNOWN_DEPT' ? 'WAITLIST' : holdType,
          notes,
        }),
      });
      if (res?.queuedOffline) {
        onNotify(`Đang mất mạng: đã lưu hồ sơ đăng ký của ${patientName} vào Pending Actions để tự đồng bộ khi có mạng.`);
      } else {
        onNotify(
          res.pendingConfirmation
            ? `Đã tạo hồ sơ ${res.registration_code} ở trạng thái Chờ xác nhận do mạng P2P chưa đủ quorum.`
            : `Đã tạo hồ sơ đăng ký trước ${res.registration_code}.`
        );
      }
      setPatientCode('');
      setHisCode('');
      setPatientName('');
      setPhone('');
      setNotes('');
      setRoomId('');
      setBedId('');
      setLookupResult(null);
      await load();
      setTab('list');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelRegistration = async () => {
    if (!cancelTarget) return;
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/registrations/${cancelTarget.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Hủy phiếu từ danh sách đăng ký' }),
      });
      onNotify(
        res?.queuedOffline
          ? `Đang mất mạng: đã xếp lệnh hủy ${cancelTarget.registration_code} vào Pending Actions.`
          : `Đã hủy phiếu đăng ký ${cancelTarget.registration_code}.`
      );
      setCancelTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
      setCancelTarget(null);
    }
  };

  const handleFilePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { headers, rows } = await parseSpreadsheetFile(file);
      setImportFileName(file.name);
      setRawHeaders(headers);
      setRawRows(rows);
      setImportResult(null);
      const guess = (keywords: string[]) =>
        headers.find((h) => keywords.some((k) => h.toLowerCase().includes(k))) || '';
      setColMap({
        patient_code: guess(['mã bn', 'patient_code', 'mabn', 'mã bệnh nhân']),
        his_record_code: guess(['his', 'hồ sơ']),
        full_name: guess(['họ tên', 'tên', 'full_name', 'hoten']),
        date_of_birth: guess(['ngày sinh', 'dob', 'ngaysinh']),
        phone: guess(['điện thoại', 'sđt', 'phone', 'sdt']),
        diagnosis_group: guess(['chẩn đoán', 'diagnosis', 'nhóm']),
      });
    } catch (err) {
      onNotify('Không đọc được file Excel/CSV: ' + (err as Error).message, 'error');
    }
  };

  const handleConfirmImport = async () => {
    if (!colMap.patient_code || !colMap.full_name || !colMap.date_of_birth) {
      onNotify('Vui lòng ghép tối thiểu 3 cột: Mã BN, Họ tên và Ngày sinh.', 'error');
      return;
    }
    const mapped = rawRows.map((r) => ({
      patient_code: r[colMap.patient_code] || '',
      his_record_code: colMap.his_record_code ? r[colMap.his_record_code] || '' : '',
      full_name: r[colMap.full_name] || '',
      date_of_birth: r[colMap.date_of_birth] || '',
      phone: colMap.phone ? r[colMap.phone] || '' : '',
      diagnosis_group: colMap.diagnosis_group ? r[colMap.diagnosis_group] || 'Khác' : 'Khác',
    }));

    try {
      const res = await apiFetch<{
        totalRows: number;
        importedRows: number;
        duplicateRows: number;
        errorRows: number;
      }>('/import/patients', {
        method: 'POST',
        body: JSON.stringify({ fileName: importFileName, rows: mapped }),
      });
      setImportResult(res);
      onNotify(`Đã nhập ${res.importedRows}/${res.totalRows} bệnh nhân (trùng mã: ${res.duplicateRows}, lỗi: ${res.errorRows}).`);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const filteredRegistrations = registrations.filter((r) => {
    if (listStatusFilter === 'PORTAL') {
      if (r.created_by !== 'customer-portal') return false;
    } else if (listStatusFilter && r.status !== listStatusFilter) {
      return false;
    }
    if (listSearch.trim()) {
      const q = listSearch.toLowerCase();
      const hay = `${r.registration_code} ${r.patient_code} ${r.patient_name} ${r.diagnosis_group} ${r.department_name || ''} ${r.bed_code || ''} ${r.created_by_name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const statusLabel = (status: Registration['status']) => {
    if (status === 'WAITING') return { text: 'Đang chờ', cls: 'bg-slate-100 text-slate-700' };
    if (status === 'RESERVED') return { text: 'Đã giữ chỗ', cls: 'bg-amber-50 text-amber-800 border border-amber-200' };
    if (status === 'ADMITTED') return { text: 'Đã nhập khoa', cls: 'bg-sky-50 text-sky-800 border border-sky-200' };
    if (status === 'CANCELLED') return { text: 'Đã hủy', cls: 'bg-rose-50 text-rose-700 border border-rose-200' };
    return { text: status, cls: 'bg-slate-100 text-slate-700' };
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Đăng ký trước giường &amp; Nhận diện HIS</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Tự động tra cứu bệnh nhân cũ theo Mã BN, chống đặt trùng phòng đang sử dụng và liên kết thẳng sang Giữ chỗ / Tiếp nhận.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {[
            { id: 'form', label: 'Tạo đăng ký mới' },
            { id: 'import', label: 'Nhập Excel / CSV' },
            { id: 'list', label: `Danh sách (${registrations.length})` },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id as typeof tab)}
              className={`min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'form' && (
        <form onSubmit={handleSubmitReg} className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6 space-y-6">
          <div>
            <h3 className="text-base font-semibold text-slate-900 mb-3">1. Thông tin bệnh nhân</h3>

            {/* Lookup warnings */}
            {lookupResult?.activeAdmission && (
              <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 flex items-start gap-2.5 text-xs text-rose-900">
                <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Cảnh báo trùng lượt nằm: Bệnh nhân đang nằm nội trú</div>
                  <div className="mt-0.5">
                    Mã BN <strong>{patientCode}</strong> đang nằm tại <strong>{lookupResult.activeAdmission.department_name}</strong> — giường{' '}
                    <strong className="font-mono">{lookupResult.activeAdmission.bed_code}</strong> (HS {lookupResult.activeAdmission.admission_code}). Không nên cấp thêm giường mới nếu chưa làm thủ tục xuất viện.
                  </div>
                </div>
              </div>
            )}

            {lookupResult?.openRegistration && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2.5 text-xs text-amber-900">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Bệnh nhân đã có phiếu đăng ký trước đang mở: </span>
                  <span className="font-mono font-semibold">{lookupResult.openRegistration.registration_code}</span> (
                  {lookupResult.openRegistration.status === 'RESERVED' ? 'Đã giữ chỗ' : 'Đang chờ'}
                  {lookupResult.openRegistration.department_name ? ` · ${lookupResult.openRegistration.department_name}` : ''}
                  {lookupResult.openRegistration.bed_code ? ` · ${lookupResult.openRegistration.bed_code}` : ''}).
                </div>
              </div>
            )}

            {lookupResult?.found && lookupResult.patient && !lookupResult.activeAdmission && (
              <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 flex items-center gap-2 text-xs text-emerald-900">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>
                  Đã nhận diện bệnh nhân cũ <strong>{lookupResult.patient.full_name}</strong> — tự động điền thông tin hành chính.
                </span>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã bệnh nhân *</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={patientCode}
                    onChange={(e) => {
                      setPatientCode(e.target.value);
                      if (!e.target.value.trim()) setLookupResult(null);
                    }}
                    onBlur={() => handleLookupPatient()}
                    placeholder="VD: BN-2026-101"
                    className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => handleLookupPatient()}
                    disabled={lookingUp || !patientCode.trim()}
                    className="min-h-[44px] shrink-0 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    {lookingUp ? 'Đang tra...' : 'Kiểm tra'}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã hồ sơ HIS (nếu có)</label>
                <input type="text" value={hisCode} onChange={(e) => setHisCode(e.target.value)} placeholder="VD: HIS-88123" className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Họ và tên *</label>
                <input type="text" required value={patientName} onChange={(e) => setPatientName(e.target.value)} placeholder="Nguyễn Thị B" className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ngày sinh *</label>
                <input type="date" required value={dob} onChange={(e) => setDob(e.target.value)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Số điện thoại</label>
                <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="090xxxxxxx" className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Nhóm chẩn đoán dự kiến *</label>
                <select value={diagGroup} onChange={(e) => setDiagGroup(e.target.value)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                  {diagnoses.map((d) => (
                    <option key={d.id} value={d.name}>{d.name} (dự kiến {d.default_days} ngày)</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ngày giờ dự kiến nhập viện *</label>
                <input type="datetime-local" required value={expectedAdmit} onChange={(e) => setExpectedAdmit(e.target.value)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Ghi chú chuyên môn / hành chính</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100">
            <h3 className="text-base font-semibold text-slate-900 mb-2">2. Tiêu chuẩn phòng mong muốn</h3>
            <div className="flex flex-wrap gap-2">
              {standards.map((s) => {
                const active = desiredStds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setDesiredStds((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                    className={`min-h-[40px] rounded-md border px-3 py-1.5 text-xs font-medium ${
                      active ? 'border-sky-600 bg-sky-50 text-sky-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">3. Hình thức đăng ký &amp; Giữ chỗ thủ công</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { setMode('UNKNOWN_DEPT'); setHoldType('WAITLIST'); }}
                className={`text-left rounded-lg border p-4 min-h-[44px] ${
                  mode === 'UNKNOWN_DEPT' ? 'border-sky-600 bg-sky-50/70' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900">Hình thức A: Chưa biết khoa</div>
                <div className="text-xs text-slate-600 mt-1">
                  Chỉ ghi nhận nhu cầu tiêu chuẩn phòng và đưa vào danh sách chờ phân bổ (không tự động cấp giường vật lý).
                </div>
              </button>

              <button
                type="button"
                onClick={() => { setMode('KNOWN_DEPT'); setHoldType('NONE'); }}
                className={`text-left rounded-lg border p-4 min-h-[44px] ${
                  mode === 'KNOWN_DEPT' ? 'border-sky-600 bg-sky-50/70' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900">Hình thức B: Đã biết khoa</div>
                <div className="text-xs text-slate-600 mt-1">
                  Hiển thị các phòng &amp; giường phù hợp đang trống; tự động chặn phòng Đang sử dụng để tránh đặt nhầm.
                </div>
              </button>
            </div>

            {mode === 'KNOWN_DEPT' && (
              <div className="space-y-4 pt-2">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Khoa mong muốn</label>
                    <select value={deptId} onChange={(e) => { setDeptId(e.target.value); setRoomId(''); setBedId(''); }} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Thao tác giữ chỗ thủ công</label>
                    <select value={holdType} onChange={(e) => setHoldType(e.target.value as typeof holdType)} className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                      <option value="NONE">Không giữ chỗ</option>
                      <option value="WAITLIST">Đưa vào danh sách chờ</option>
                      <option value="SINGLE_BED">Giữ một giường cụ thể</option>
                      <option value="WHOLE_ROOM">Giữ trọn phòng (Bao phòng)</option>
                    </select>
                  </div>
                  {(holdType === 'SINGLE_BED' || holdType === 'WHOLE_ROOM') && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Chọn phòng phù hợp</label>
                      <select value={roomId} onChange={(e) => { setRoomId(e.target.value); setBedId(''); }} required className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                        <option value="">-- Chọn phòng ({deptRooms.length}) --</option>
                        {deptRooms
                          .filter((r) => (holdType === 'WHOLE_ROOM' ? wholeRoomEligible(r.id) : true))
                          .map((r) => {
                            const chk = canReserveInRoom(r, beds.filter((b) => b.room_id === r.id));
                            return (
                              <option key={r.id} value={r.id} disabled={!chk.allowed}>
                                {r.name} ({r.capacity} giường){!chk.allowed ? ' · Đang sử dụng (Chặn giữ chỗ)' : ''}
                              </option>
                            );
                          })}
                      </select>
                    </div>
                  )}
                  {holdType === 'SINGLE_BED' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Chọn giường trống</label>
                      <select value={bedId} onChange={(e) => setBedId(e.target.value)} required className="w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm bg-white">
                        <option value="">-- Chọn giường ({matchingVacantBeds.length}) --</option>
                        {matchingVacantBeds.map((b) => (
                          <option key={b.id} value={b.id}>{b.code}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {!selectedRoomCheck.allowed && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
                    {selectedRoomCheck.reason}
                  </div>
                )}

                {quickSuggestedBeds.length > 0 && (
                  <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3.5 space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-900">
                      <Sparkles className="h-3.5 w-3.5 text-sky-700" />
                      <span>Gợi ý giường trống sẵn sàng giữ chỗ trong khoa:</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {quickSuggestedBeds.map(({ room, bed }) => (
                        <button
                          key={bed.id}
                          type="button"
                          onClick={() => {
                            setHoldType('SINGLE_BED');
                            setRoomId(room.id);
                            setBedId(bed.id);
                          }}
                          className={`min-h-[40px] rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                            bedId === bed.id && holdType === 'SINGLE_BED'
                              ? 'border-sky-700 bg-sky-700 text-white'
                              : 'border-sky-200 bg-white text-sky-900 hover:bg-sky-50'
                          }`}
                        >
                          {bed.code} · {room.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end pt-3 border-t border-slate-100">
            <button
              type="submit"
              disabled={submitting || (mode === 'KNOWN_DEPT' && (holdType === 'SINGLE_BED' || holdType === 'WHOLE_ROOM') && !selectedRoomCheck.allowed)}
              className="w-full sm:w-auto min-h-[44px] rounded-md bg-sky-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60"
            >
              {submitting ? 'Đang xử lý đồng thuận...' : 'Lưu hồ sơ đăng ký trước'}
            </button>
          </div>
        </form>
      )}

      {tab === 'import' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Nhập danh sách bệnh nhân từ Excel / CSV</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Tải file mẫu chuẩn để điền dữ liệu, sau đó tải lên. Hệ thống tự kiểm tra lỗi từng dòng, phát hiện trùng mã bệnh nhân / mã HIS và lưu nhật ký nhập.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    await exportPatientImportTemplate('xlsx');
                    onNotify('Đã tải file mẫu Excel (.xlsx): mau_nhap_benh_nhan_BEDCARE.xlsx');
                  }}
                  className="min-h-[44px] inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-xs sm:text-sm font-medium text-emerald-800 hover:bg-emerald-100 whitespace-nowrap"
                >
                  <Download className="h-4 w-4" />
                  <span>Tải mẫu Excel (.xlsx)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    exportPatientImportTemplate('csv');
                    onNotify('Đã tải file mẫu CSV: mau_nhap_benh_nhan_BEDCARE.csv');
                  }}
                  className="min-h-[44px] inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  <Download className="h-4 w-4" />
                  <span>Tải mẫu CSV</span>
                </button>
                <label className="cursor-pointer min-h-[44px] inline-flex items-center gap-2 rounded-md bg-sky-700 px-4 py-2 text-xs sm:text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap">
                  <Upload className="h-4 w-4" />
                  <span>Chọn file .xlsx / .csv</span>
                  <input type="file" accept=".xlsx,.csv" onChange={handleFilePick} className="hidden" />
                </label>
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold text-slate-800">Cấu trúc cột chuẩn trong file mẫu:</span>
              <span>
                <strong className="text-slate-900">Mã BN *</strong> (bắt buộc) ·{' '}
                <strong className="text-slate-900">Họ tên *</strong> ·{' '}
                <strong className="text-slate-900">Ngày sinh *</strong> (<span className="font-mono">YYYY-MM-DD</span>)
              </span>
              <span>
                Tùy chọn: <strong className="text-slate-700">Mã hồ sơ HIS</strong>,{' '}
                <strong className="text-slate-700">Số điện thoại</strong>,{' '}
                <strong className="text-slate-700">Chẩn đoán</strong>
              </span>
            </div>

            {rawHeaders.length > 0 && (
              <div className="space-y-4 pt-4 border-t border-slate-100">
                <div className="text-sm font-medium text-slate-800 flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
                  <span>File: {importFileName} ({rawRows.length} dòng dữ liệu)</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    { key: 'patient_code', label: 'Mã bệnh nhân *' },
                    { key: 'his_record_code', label: 'Mã hồ sơ HIS' },
                    { key: 'full_name', label: 'Họ tên *' },
                    { key: 'date_of_birth', label: 'Ngày sinh *' },
                    { key: 'phone', label: 'Số điện thoại' },
                    { key: 'diagnosis_group', label: 'Chẩn đoán' },
                  ].map((field) => (
                    <div key={field.key}>
                      <label className="block text-xs font-medium text-slate-600 mb-1">{field.label}</label>
                      <select
                        value={colMap[field.key as keyof typeof colMap]}
                        onChange={(e) => setColMap({ ...colMap, [field.key]: e.target.value })}
                        className="w-full min-h-[44px] rounded-md border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                      >
                        <option value="">-- Không ghép --</option>
                        {rawHeaders.map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                <div className="overflow-x-auto border border-slate-200 rounded-md">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">#</th>
                        {rawHeaders.map((h) => (
                          <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rawRows.slice(0, 8).map((r, idx) => (
                        <tr key={idx}>
                          <td className="px-3 py-2 font-mono text-slate-400">{idx + 1}</td>
                          {rawHeaders.map((h) => (
                            <td key={h} className="px-3 py-2 text-slate-700">{r[h]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  {importResult ? (
                    <div className="text-sm text-slate-700">
                      Kết quả: <span className="font-semibold text-emerald-700">{importResult.importedRows} thành công</span> ·{' '}
                      <span className="font-semibold text-amber-700">{importResult.duplicateRows} trùng mã</span> ·{' '}
                      <span className="font-semibold text-rose-700">{importResult.errorRows} dòng lỗi</span>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-500">Xem trước tối đa 8 dòng đầu trước khi xác nhận nhập.</span>
                  )}
                  <button
                    type="button"
                    onClick={handleConfirmImport}
                    className="min-h-[44px] rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
                  >
                    Xác nhận nhập dữ liệu
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 font-semibold text-sm text-slate-900">
              Nhật ký nhập file Excel / CSV
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Tên file</th>
                    <th className="px-4 py-2.5 text-right">Tổng dòng</th>
                    <th className="px-4 py-2.5 text-right">Đã nhập</th>
                    <th className="px-4 py-2.5 text-right">Trùng mã</th>
                    <th className="px-4 py-2.5 text-right">Lỗi</th>
                    <th className="px-4 py-2.5 text-left">Người nhập</th>
                    <th className="px-4 py-2.5 text-left">Thời gian</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {importLogs.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-500">Chưa có lần nhập file nào.</td></tr>
                  ) : importLogs.map((l) => (
                    <tr key={String(l.id)}>
                      <td className="px-4 py-2.5 font-medium text-slate-900">{String(l.file_name)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{String(l.total_rows)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-700">{String(l.imported_rows)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-amber-700">{String(l.duplicate_rows)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-rose-700">{String(l.error_rows)}</td>
                      <td className="px-4 py-2.5 text-slate-600">{String(l.performed_by)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{formatDateTimeVN(String(l.created_at))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'list' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="rounded-lg border border-slate-200 bg-white p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                placeholder="Tìm mã ĐK, mã BN, họ tên, khoa..."
                className="w-full min-h-[44px] rounded-md border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { id: '', label: 'Tất cả' },
                { id: 'PORTAL', label: `Khách hàng đặt (${registrations.filter((x) => x.created_by === 'customer-portal').length})` },
                { id: 'WAITING', label: 'Đang chờ' },
                { id: 'RESERVED', label: 'Đã giữ chỗ' },
                { id: 'ADMITTED', label: 'Đã nhập khoa' },
                { id: 'CANCELLED', label: 'Đã hủy' },
              ].map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setListStatusFilter(st.id)}
                  className={`min-h-[38px] rounded-md border px-3 py-1.5 text-xs font-medium ${
                    listStatusFilter === st.id
                      ? 'border-sky-600 bg-sky-50 text-sky-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Mã ĐK / BN</th>
                    <th className="px-4 py-3 text-left font-medium">Họ tên</th>
                    <th className="px-4 py-3 text-left font-medium">Chẩn đoán</th>
                    <th className="px-4 py-3 text-left font-medium">Khoa / Giường</th>
                    <th className="px-4 py-3 text-left font-medium">Trạng thái</th>
                    <th className="px-4 py-3 text-left font-medium">Dự kiến nhập</th>
                    <th className="px-4 py-3 text-right font-medium">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRegistrations.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Không có hồ sơ phù hợp bộ lọc.</td></tr>
                  ) : filteredRegistrations.map((reg) => {
                    const st = statusLabel(reg.status);
                    const isCustomerPortal = reg.created_by === 'customer-portal';
                    return (
                      <tr key={reg.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs font-semibold text-slate-900">{reg.registration_code}</div>
                          <div className="font-mono text-xs text-slate-500">{reg.patient_code}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">{reg.patient_name}</div>
                          {isCustomerPortal && (
                            <div className="text-[11px] font-semibold text-sky-700 mt-0.5">
                              Khách hàng đặt trực tuyến
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{reg.diagnosis_group}</td>
                        <td className="px-4 py-3 text-xs text-slate-700">
                          {reg.department_name || 'Chưa chọn khoa'} {reg.bed_code ? `· ${reg.bed_code}` : reg.room_name ? `· ${reg.room_name}` : ''}
                        </td>
                        <td className="px-4 py-3 text-xs font-semibold">
                          <span className={`inline-block rounded px-2 py-0.5 ${st.cls}`}>{st.text}</span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{formatDateVN(reg.expected_admission_date)}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                          {reg.status === 'WAITING' && onOpenReservation && (
                            <button
                              type="button"
                              onClick={() => onOpenReservation(reg.id)}
                              className="text-xs font-semibold text-amber-700 hover:underline"
                            >
                              Giữ chỗ
                            </button>
                          )}
                          {(reg.status === 'WAITING' || reg.status === 'RESERVED') && canAdmitDirectly && onOpenAdmission && (
                            <button
                              type="button"
                              onClick={() => onOpenAdmission(reg.id)}
                              className="text-xs font-semibold text-sky-700 hover:underline"
                            >
                              Tiếp nhận
                            </button>
                          )}
                          {(reg.status === 'WAITING' || reg.status === 'PENDING_CONFIRMATION') && (
                            <button
                              type="button"
                              onClick={() => setCancelTarget(reg)}
                              className="text-xs font-medium text-rose-600 hover:underline"
                            >
                              Hủy ĐK
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile Cards */}
          <div className="md:hidden space-y-3">
            {filteredRegistrations.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                Không có hồ sơ phù hợp bộ lọc.
              </div>
            ) : filteredRegistrations.map((reg) => {
              const st = statusLabel(reg.status);
              return (
                <div key={reg.id} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-sm text-slate-900">{reg.patient_name}</div>
                      <div className="font-mono text-xs text-slate-500 mt-0.5">
                        {reg.registration_code} · {reg.patient_code}
                      </div>
                    </div>
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold shrink-0 ${st.cls}`}>{st.text}</span>
                  </div>
                  <div className="text-xs text-slate-600 space-y-1">
                    <div>Chẩn đoán: <strong className="text-slate-800">{reg.diagnosis_group}</strong></div>
                    <div>
                      Khoa/Giường:{' '}
                      <span className="font-medium text-slate-800">
                        {reg.department_name || 'Chưa chọn khoa'}
                        {reg.bed_code ? ` · ${reg.bed_code}` : reg.room_name ? ` · ${reg.room_name}` : ''}
                      </span>
                    </div>
                    <div className="font-mono text-slate-500">Dự kiến nhập: {formatDateVN(reg.expected_admission_date)}</div>
                  </div>
                  {(reg.status === 'WAITING' || reg.status === 'RESERVED' || reg.status === 'PENDING_CONFIRMATION') && (
                    <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                      {reg.status === 'WAITING' && onOpenReservation && (
                        <button
                          type="button"
                          onClick={() => onOpenReservation(reg.id)}
                          className="flex-1 min-h-[44px] rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 active:scale-[0.98]"
                        >
                          Giữ chỗ
                        </button>
                      )}
                      {(reg.status === 'WAITING' || reg.status === 'RESERVED') && canAdmitDirectly && onOpenAdmission && (
                        <button
                          type="button"
                          onClick={() => onOpenAdmission(reg.id)}
                          className="flex-1 min-h-[44px] rounded-md bg-sky-700 px-3 py-2 text-xs font-semibold text-white active:scale-[0.98]"
                        >
                          Tiếp nhận
                        </button>
                      )}
                      {(reg.status === 'WAITING' || reg.status === 'PENDING_CONFIRMATION') && (
                        <button
                          type="button"
                          onClick={() => setCancelTarget(reg)}
                          className="min-h-[44px] rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 active:scale-[0.98]"
                        >
                          Hủy ĐK
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmModal
        open={Boolean(cancelTarget)}
        title="Hủy phiếu đăng ký trước"
        description={`Xác nhận hủy phiếu đăng ký ${cancelTarget?.registration_code} của bệnh nhân ${cancelTarget?.patient_name}?`}
        danger
        confirmLabel="Xác nhận hủy"
        onConfirm={handleCancelRegistration}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}

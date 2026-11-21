import { ArrowLeftRight, CalendarPlus, FileSpreadsheet, FileText, History, LogOut, Printer, QrCode, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { BedQrCode, buildBedQrUrl } from '../../components/BedQrCode';
import { OfficialReportHeader, OfficialReportSignatures } from '../../components/OfficialDocumentParts';
import { PrintPreviewModal, type PrintPreviewColumn } from '../../components/PrintPreviewModal';
import { apiFetch } from '../../services/api';
import type { Admission, AdmissionAuditEntry, Department, UserRole } from '../../types/bedcare';
import { exportBedSummaryPdf, exportHandoverPdf, exportToCsv, type ExportColumn } from '../../utils/exportUtils';
import { formatDateTimeVN, formatDateVN, toLocalDateTimeInputValue } from '../../utils/formatters';

interface EnrichedAdmission extends Admission {
  stay_metrics: {
    daysStayed: number;
    daysRemaining: number;
    hoursRemaining: number;
    dueState: 'ON_TIME' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE';
  };
}

interface InpatientsPageProps {
  userRole?: UserRole;
  userDeptId?: string | null;
  initialAdmissionId?: string;
  onClearInitialAdmission?: () => void;
  globalSearch: string;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onOpenTransfer?: (admissionId: string) => void;
}

const HANDOVER_COLUMNS: ExportColumn[] = [
  { header: 'Mã BN', key: 'patient_code', width: 14 },
  { header: 'Mã HS', key: 'admission_code', width: 16 },
  { header: 'Họ tên bệnh nhân', key: 'patient_name', width: 24 },
  { header: 'Khoa / Phòng / Giường', key: 'department_bed', width: 26 },
  { header: 'Nhóm lưu trú', key: 'diagnosis_group', width: 18 },
  { header: 'Nhận giường', key: 'bed_assigned_at', width: 18 },
  { header: 'Dự kiến trả', key: 'expected_discharge_at', width: 18 },
  { header: 'Số ngày / Còn lại', key: 'stay_summary', width: 20 },
  { header: 'Tiến độ giường', key: 'due_label', width: 16 },
  { header: 'Điều phối / Tiếp nhận', key: 'confirmed_by_name', width: 20 },
  { header: 'Ghi chú điều phối', key: 'notes', width: 26 },
];

const AUDIT_CATEGORY_LABEL: Record<AdmissionAuditEntry['category'], { label: string; cls: string }> = {
  ADMISSION: { label: 'Tiếp nhận giường', cls: 'border-sky-200 bg-sky-50 text-sky-800' },
  EXTENSION: { label: 'Gia hạn giường', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  TRANSFER_REQUEST: { label: 'Lệnh chuyển', cls: 'border-indigo-200 bg-indigo-50 text-indigo-800' },
  TRANSFER: { label: 'Chuyển vị trí', cls: 'border-violet-200 bg-violet-50 text-violet-800' },
  CLEANING: { label: 'Vệ sinh giường', cls: 'border-teal-200 bg-teal-50 text-teal-800' },
  DISCHARGE: { label: 'Trả giường', cls: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  SYSTEM: { label: 'Hệ thống', cls: 'border-slate-200 bg-slate-50 text-slate-700' },
};

const BED_SUMMARY_PRINT_COLUMNS: PrintPreviewColumn[] = [
  { key: 'census_strip', label: 'Dải thống kê nhanh giao ban' },
  { key: 'stt', label: 'STT', locked: true },
  { key: 'location', label: 'Giường / Phòng / Khoa', locked: true },
  { key: 'codes', label: 'Mã BN / Mã HS' },
  { key: 'patient', label: 'Họ tên bệnh nhân', locked: true },
  { key: 'diagnosis', label: 'Chẩn đoán điều trị' },
  { key: 'dates', label: 'Ngày vào / Dự kiến trả' },
  { key: 'duration', label: 'Đã nằm / Còn lại' },
  { key: 'status', label: 'Tình trạng giao ban' },
  { key: 'notes', label: 'Ghi chú / Y lệnh trực sáng' },
];

const AUDIT_LOG_PRINT_COLUMNS: PrintPreviewColumn[] = [
  { key: 'stt', label: 'STT', locked: true },
  { key: 'timestamp', label: 'Thời gian' },
  { key: 'category', label: 'Loại sự kiện' },
  { key: 'location', label: 'Vị trí / Giường', locked: true },
  { key: 'detail', label: 'Chi tiết thay đổi' },
  { key: 'actor', label: 'Người thực hiện' },
];

const QR_CARD_PRINT_COLUMNS: PrintPreviewColumn[] = [
  { key: 'patient_meta', label: 'Mã BN / Hồ sơ / Khoa' },
  { key: 'qr_url', label: 'Đường dẫn quét nhanh QR' },
];

export function InpatientsPage({
  userRole,
  userDeptId,
  initialAdmissionId,
  onClearInitialAdmission,
  globalSearch,
  onNotify,
  onOpenTransfer,
}: InpatientsPageProps) {
  const isDeptScoped = userRole === 'WARD_STAFF' && Boolean(userDeptId);
  const [admissions, setAdmissions] = useState<EnrichedAdmission[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [deptFilter, setDeptFilter] = useState(isDeptScoped ? userDeptId || '' : '');
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | 'DISCHARGED' | 'ALL'>('ACTIVE');
  const [exportingPdf, setExportingPdf] = useState(false);

  // Audit Log Modal State
  const [auditTarget, setAuditTarget] = useState<EnrichedAdmission | null>(null);
  const [auditEntries, setAuditEntries] = useState<AdmissionAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditPrintPreviewOpen, setAuditPrintPreviewOpen] = useState(false);

  // Morning Rounds Bed Summary Print Preview State
  const [bedSummaryOpen, setBedSummaryOpen] = useState(false);

  // QR Bed Label Modal State
  const [qrTarget, setQrTarget] = useState<EnrichedAdmission | null>(null);

  // Inline Quick Extend Modal
  const [extendTarget, setExtendTarget] = useState<EnrichedAdmission | null>(null);
  const [extendDate, setExtendDate] = useState('');
  const [extendReason, setExtendReason] = useState('');
  const [submittingAction, setSubmittingAction] = useState(false);

  // Inline Quick Discharge Confirm Modal
  const [dischargeTarget, setDischargeTarget] = useState<EnrichedAdmission | null>(null);
  const [dischargeNotes, setDischargeNotes] = useState('Hoàn tất điều trị, chuyển giường sang Chờ vệ sinh');

  const load = async () => {
    try {
      const [adms, depts] = await Promise.all([
        apiFetch<EnrichedAdmission[]>('/admissions'),
        apiFetch<Department[]>('/departments'),
      ]);
      setAdmissions(adms);
      setDepartments(depts);
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

  useEffect(() => {
    if (isDeptScoped && userDeptId) {
      setDeptFilter(userDeptId);
    }
  }, [isDeptScoped, userDeptId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (auditPrintPreviewOpen) {
          setAuditPrintPreviewOpen(false);
          return;
        }
        setBedSummaryOpen(false);
        setAuditTarget(null);
        setExtendTarget(null);
        setDischargeTarget(null);
        setQrTarget(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [auditPrintPreviewOpen]);

  const openAuditLog = async (adm: EnrichedAdmission) => {
    setAuditTarget(adm);
    setAuditLoading(true);
    setAuditEntries([]);
    try {
      const res = await apiFetch<{ admission: EnrichedAdmission; entries: AdmissionAuditEntry[] }>(
        `/admissions/${adm.id}/audit-log`
      );
      setAuditEntries(res.entries);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (!initialAdmissionId || admissions.length === 0) return;
    const match = admissions.find(
      (a) => a.id === initialAdmissionId || a.admission_code.toLowerCase() === initialAdmissionId.toLowerCase()
    );
    if (match) {
      if (match.status === 'DISCHARGED') setStatusFilter('ALL');
      openAuditLog(match);
      onClearInitialAdmission?.();
    }
  }, [initialAdmissionId, admissions]);

  const openQuickExtend = (adm: EnrichedAdmission) => {
    setExtendTarget(adm);
    const curExp = new Date(adm.expected_discharge_at);
    const plus2Days = new Date(curExp.getTime() + 2 * 86400000);
    setExtendDate(toLocalDateTimeInputValue(plus2Days));
    setExtendReason('Gia hạn thời gian lưu trú theo kế hoạch điều phối');
  };

  const handleConfirmExtend = async (e: FormEvent) => {
    e.preventDefault();
    if (!extendTarget) return;
    const parsedExtend = new Date(extendDate);
    if (!extendDate || Number.isNaN(parsedExtend.getTime())) {
      onNotify('Ngày trả dự kiến mới không hợp lệ.', 'error');
      return;
    }
    setSubmittingAction(true);
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/admissions/${extendTarget.id}/extend`, {
        method: 'POST',
        body: JSON.stringify({
          new_expected_discharge_at: parsedExtend.toISOString(),
          reason: extendReason,
        }),
      });
      onNotify(
        res?.queuedOffline
          ? `Đang mất mạng: đã lưu yêu cầu gia hạn giường của ${extendTarget.patient_name} vào Pending Actions.`
          : `Đã gia hạn ngày giường cho ${extendTarget.patient_name}.`
      );
      setExtendTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleConfirmDischarge = async (e: FormEvent) => {
    e.preventDefault();
    if (!dischargeTarget) return;
    setSubmittingAction(true);
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/admissions/${dischargeTarget.id}/discharge`, {
        method: 'POST',
        body: JSON.stringify({ notes: dischargeNotes }),
      });
      onNotify(
        res?.queuedOffline
          ? `Đang mất mạng: đã lưu yêu cầu trả giường ${dischargeTarget.bed_code} vào Pending Actions.`
          : `Đã trả giường ${dischargeTarget.bed_code}. Giường đã chuyển sang Chờ vệ sinh.`
      );
      setDischargeTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSubmittingAction(false);
    }
  };

  const filtered = admissions.filter((a) => {
    if (statusFilter !== 'ALL' && a.status !== statusFilter) return false;
    if (deptFilter && a.department_id !== deptFilter) return false;
    if (globalSearch.trim()) {
      const q = globalSearch.toLowerCase();
      const hay = `${a.admission_code} ${a.patient_code} ${a.patient_name} ${a.bed_code ?? ''} ${a.diagnosis_group}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const getDueStatusText = (a: EnrichedAdmission): string => {
    if (a.status === 'DISCHARGED') {
      return `Đã trả (${a.actual_discharge_at ? formatDateTimeVN(a.actual_discharge_at) : '—'})`;
    }
    switch (a.stay_metrics.dueState) {
      case 'OVERDUE':
        return 'Quá ngày trả';
      case 'DUE_TODAY':
        return 'Đến hạn hôm nay';
      case 'DUE_SOON':
        return 'Sắp trả giường';
      default:
        return 'Đúng tiến độ';
    }
  };

  const buildHandoverRows = () =>
    filtered.map((a) => {
      const m = a.stay_metrics;
      const remainText =
        a.status === 'DISCHARGED'
          ? 'Đã trả'
          : m.daysRemaining < 0
            ? `Quá ${Math.abs(m.daysRemaining)} ngày`
            : `Còn ${m.daysRemaining} ngày`;
      return {
        patient_code: a.patient_code,
        admission_code: a.admission_code,
        patient_name: a.patient_name,
        department_bed: `${a.department_name ?? ''} / ${a.bed_code ?? ''}${a.is_whole_room ? ' (Bao phòng)' : ''}`,
        diagnosis_group: a.diagnosis_group,
        bed_assigned_at: formatDateTimeVN(a.bed_assigned_at),
        expected_discharge_at: formatDateTimeVN(a.expected_discharge_at),
        stay_summary: `${m.daysStayed} ngày · ${remainText} (GH: ${a.extension_count})`,
        due_label: getDueStatusText(a),
        confirmed_by_name: a.confirmed_by_name || '—',
        notes: a.notes || '—',
      };
    });

  const getFilterSummary = () => {
    const deptName = deptFilter
      ? departments.find((d) => d.id === deptFilter)?.name || 'Khoa đã chọn'
      : 'Toàn viện';
    const statusName =
      statusFilter === 'ACTIVE' ? 'Đang nằm' : statusFilter === 'DISCHARGED' ? 'Đã trả giường' : 'Tất cả trạng thái';
    const searchPart = globalSearch.trim() ? ` · Từ khóa: "${globalSearch.trim()}"` : '';
    return `${deptName} · ${statusName}${searchPart} · Tổng: ${filtered.length} bệnh nhân`;
  };

  const handleExportCsv = () => {
    if (filtered.length === 0) {
      onNotify('Không có bệnh nhân trong danh sách lọc hiện tại để xuất.', 'error');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    exportToCsv(`bedcare-ban-giao-ca-${stamp}.csv`, HANDOVER_COLUMNS, buildHandoverRows());
    onNotify(`Đã xuất CSV bàn giao ca (${filtered.length} bệnh nhân).`);
  };

  const handleExportPdf = async () => {
    if (filtered.length === 0) {
      onNotify('Không có bệnh nhân trong danh sách lọc hiện tại để xuất.', 'error');
      return;
    }
    setExportingPdf(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await exportHandoverPdf(
        `bedcare-ban-giao-ca-${stamp}.pdf`,
        getFilterSummary(),
        HANDOVER_COLUMNS,
        buildHandoverRows()
      );
      onNotify(`Đã xuất PDF bàn giao ca chuẩn văn bản (${filtered.length} bệnh nhân).`);
    } catch (e) {
      onNotify(`Lỗi xuất PDF: ${(e as Error).message}`, 'error');
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportBedSummaryPdf = async (visibleColumns?: Record<string, boolean>) => {
    if (filtered.length === 0) {
      onNotify('Không có bệnh nhân trong danh sách lọc hiện tại để xuất.', 'error');
      return;
    }
    const isVisible = (key: string) => (visibleColumns ? visibleColumns[key] !== false : true);
    setExportingPdf(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const summaryCols: ExportColumn[] = [
        ...(isVisible('stt') ? [{ header: 'STT', key: 'stt', width: 6 }] : []),
        ...(isVisible('location') ? [{ header: 'Giường / Phòng / Khoa', key: 'department_bed', width: 26 }] : []),
        ...(isVisible('codes') ? [{ header: 'Mã BN / Mã HS', key: 'codes', width: 20 }] : []),
        ...(isVisible('patient') ? [{ header: 'Họ tên BN', key: 'patient_name', width: 24 }] : []),
        ...(isVisible('diagnosis') ? [{ header: 'Chẩn đoán điều trị', key: 'diagnosis_group', width: 20 }] : []),
        ...(isVisible('dates') ? [{ header: 'Ngày vào / Dự kiến trả', key: 'dates', width: 24 }] : []),
        ...(isVisible('duration') ? [{ header: 'Đã nằm / Còn lại', key: 'stay_summary', width: 18 }] : []),
        ...(isVisible('status') ? [{ header: 'Tình trạng giao ban', key: 'due_label', width: 16 }] : []),
        ...(isVisible('notes') ? [{ header: 'Ghi chú / Y lệnh trực sáng', key: 'round_note', width: 26 }] : []),
      ];
      const summaryRows = filtered.map((a, idx) => {
        const m = a.stay_metrics;
        const remainText =
          a.status === 'DISCHARGED'
            ? 'Đã trả'
            : m.daysRemaining < 0
              ? `Quá ${Math.abs(m.daysRemaining)} ng`
              : `Còn ${m.daysRemaining} ng`;
        return {
          stt: idx + 1,
          department_bed: `${a.bed_code ?? '—'} · ${a.room_name ?? ''} (${a.department_name ?? ''})${a.is_whole_room ? ' [Bao phòng]' : ''}`,
          codes: `${a.patient_code} / ${a.admission_code}`,
          patient_name: a.patient_name,
          diagnosis_group: a.diagnosis_group,
          dates: `Vào: ${formatDateVN(a.bed_assigned_at)} | Trả: ${formatDateVN(a.expected_discharge_at)}`,
          stay_summary: `${m.daysStayed} ng (${remainText})`,
          due_label: getDueStatusText(a),
          round_note: a.notes || '',
        };
      });
      await exportBedSummaryPdf(
        `bedcare-bed-summary-giao-ban-sang-${stamp}.pdf`,
        getFilterSummary(),
        summaryCols,
        summaryRows
      );
      onNotify(`Đã xuất PDF Tổng hợp giường giao ban sáng (${filtered.length} bệnh nhân).`);
    } catch (e) {
      onNotify(`Lỗi xuất PDF Bed Summary: ${(e as Error).message}`, 'error');
    } finally {
      setExportingPdf(false);
    }
  };

  const morningRoundStats = {
    total: filtered.length,
    onTime: filtered.filter((a) => a.status === 'ACTIVE' && a.stay_metrics.dueState === 'ON_TIME').length,
    dueSoonOrToday: filtered.filter(
      (a) => a.status === 'ACTIVE' && (a.stay_metrics.dueState === 'DUE_SOON' || a.stay_metrics.dueState === 'DUE_TODAY')
    ).length,
    overdue: filtered.filter((a) => a.status === 'ACTIVE' && a.stay_metrics.dueState === 'OVERDUE').length,
    wholeRoom: filtered.filter((a) => a.is_whole_room).length,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3 no-print">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Bệnh nhân đang nằm &amp; Lịch sử vị trí giường</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Theo dõi ngày giường, gia hạn, điều chuyển, truy xuất nguồn gốc thay đổi vị trí giường và xuất phiếu bàn giao ca.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {isDeptScoped ? (
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900">
              Phạm vi: {departments.find((d) => d.id === userDeptId)?.name || 'Khoa quản lý'}
            </div>
          ) : (
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              aria-label="Lọc theo khoa"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Tất cả khoa</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            {[
              { id: 'ACTIVE', label: 'Đang nằm' },
              { id: 'DISCHARGED', label: 'Đã trả giường' },
              { id: 'ALL', label: 'Tất cả' },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStatusFilter(s.id as typeof statusFilter)}
                className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                  statusFilter === s.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            <span>Xuất CSV bàn giao</span>
          </button>
          <button
            type="button"
            onClick={handleExportPdf}
            disabled={filtered.length === 0 || exportingPdf}
            className="flex items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50 whitespace-nowrap"
          >
            <FileText className="h-3.5 w-3.5" />
            <span>{exportingPdf ? 'Đang tạo PDF...' : 'Xuất PDF bàn giao'}</span>
          </button>
          <button
            type="button"
            onClick={() => setBedSummaryOpen(true)}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>In tổng hợp giao ban (Bed Summary)</span>
          </button>
        </div>
      </div>

      {/* Desktop / Wide Tablet Table */}
      <div className="hidden md:block rounded-lg border border-slate-200 bg-white overflow-hidden no-print">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-3 py-3 text-left font-medium min-w-[185px]">Bệnh nhân</th>
                <th className="px-3 py-3 text-left font-medium min-w-[130px]">Khoa / Giường</th>
                <th className="px-3 py-3 text-left font-medium whitespace-nowrap">Nhận / Dự kiến trả</th>
                <th className="px-3 py-3 text-right font-medium whitespace-nowrap">Đã nằm / Còn lại</th>
                <th className="px-3 py-3 text-left font-medium whitespace-nowrap">Tiến độ</th>
                <th className="px-3 py-3 text-right font-medium whitespace-nowrap">Thao tác điều phối</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    Không có hồ sơ bệnh nhân phù hợp.
                  </td>
                </tr>
              ) : (
                filtered.map((a) => {
                  const m = a.stay_metrics;
                  return (
                    <tr key={a.id} className="hover:bg-slate-50 align-middle">
                      <td className="px-3 py-3">
                        <div className="font-semibold text-slate-900 leading-snug">{a.patient_name}</div>
                        <div className="font-mono text-xs text-slate-500">
                          {a.patient_code} · {a.diagnosis_group}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="text-slate-800 whitespace-nowrap">{a.department_name}</div>
                        <div className="font-mono text-xs text-sky-700 font-semibold whitespace-nowrap">
                          {a.bed_code} {a.is_whole_room ? '(Bao phòng)' : ''}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs whitespace-nowrap space-y-0.5">
                        <div className="text-slate-500">NV: {formatDateTimeVN(a.bed_assigned_at)}</div>
                        <div className="text-slate-800 font-medium">DK: {formatDateTimeVN(a.expected_discharge_at)}</div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <div className="font-medium text-slate-900">{m.daysStayed} ngày (GH: {a.extension_count})</div>
                        <div className="text-xs font-semibold">
                          {a.status === 'DISCHARGED' ? (
                            <span className="text-slate-400">Đã trả</span>
                          ) : m.daysRemaining < 0 ? (
                            <span className="text-rose-700">Quá {Math.abs(m.daysRemaining)} ngày</span>
                          ) : (
                            <span className={m.dueState === 'DUE_SOON' || m.dueState === 'DUE_TODAY' ? 'text-amber-700' : 'text-emerald-700'}>
                              Còn {m.daysRemaining} ngày
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs whitespace-nowrap">
                        {a.actual_discharge_at ? (
                          <span className="font-mono text-slate-600">{formatDateTimeVN(a.actual_discharge_at)}</span>
                        ) : m.dueState === 'OVERDUE' ? (
                          <span className="font-semibold text-rose-700">Quá ngày trả</span>
                        ) : m.dueState === 'DUE_TODAY' ? (
                          <span className="font-semibold text-amber-700">Đến hạn hôm nay</span>
                        ) : m.dueState === 'DUE_SOON' ? (
                          <span className="font-semibold text-amber-600">Sắp trả giường</span>
                        ) : (
                          <span className="text-emerald-700 font-medium">Đúng tiến độ</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="inline-flex flex-wrap justify-end items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setQrTarget(a)}
                            title="Tạo & in mã QR giường bệnh"
                            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 whitespace-nowrap"
                          >
                            <QrCode className="h-3.5 w-3.5 text-slate-700" />
                            <span>QR</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => openAuditLog(a)}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                          >
                            <History className="h-3.5 w-3.5 text-sky-700" />
                            <span>Lịch sử vị trí</span>
                          </button>
                          {a.status === 'ACTIVE' && (
                            <>
                              <button
                                type="button"
                                onClick={() => openQuickExtend(a)}
                                title="Gia hạn giường"
                                className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 whitespace-nowrap"
                              >
                                <CalendarPlus className="h-3.5 w-3.5" />
                                <span>Gia hạn</span>
                              </button>
                              {onOpenTransfer && (
                                <button
                                  type="button"
                                  onClick={() => onOpenTransfer(a.id)}
                                  title="Điều chuyển giường"
                                  className="inline-flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 whitespace-nowrap"
                                >
                                  <ArrowLeftRight className="h-3.5 w-3.5" />
                                  <span>Chuyển</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setDischargeTarget(a)}
                                title="Trả giường / Xuất viện"
                                className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 whitespace-nowrap"
                              >
                                <LogOut className="h-3.5 w-3.5" />
                                <span>Trả giường</span>
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card View (< md) */}
      <div className="md:hidden space-y-3 no-print">
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            Không có hồ sơ bệnh nhân phù hợp.
          </div>
        ) : (
          filtered.map((a) => {
            const m = a.stay_metrics;
            return (
              <div key={a.id} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">{a.patient_name}</div>
                    <div className="font-mono text-xs text-slate-500">{a.patient_code} · {a.diagnosis_group}</div>
                  </div>
                  <span className="font-mono text-xs font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded px-2 py-0.5 shrink-0">
                    {a.bed_code}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                  <div>Khoa: <strong className="text-slate-800">{a.department_name}</strong></div>
                  <div className="text-right font-mono tabular-nums">
                    {m.daysStayed} ngày ·{' '}
                    <span className={m.daysRemaining < 0 ? 'text-rose-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                      {a.status === 'DISCHARGED' ? 'Đã trả' : m.daysRemaining < 0 ? `Quá ${Math.abs(m.daysRemaining)}d` : `Còn ${m.daysRemaining}d`}
                    </span>
                  </div>
                  <div className="font-mono">Nhận: {formatDateTimeVN(a.bed_assigned_at)}</div>
                  <div className="text-right font-mono">Trả DK: {formatDateTimeVN(a.expected_discharge_at)}</div>
                </div>
                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setQrTarget(a)}
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    <span>QR</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openAuditLog(a)}
                    className="flex-1 min-w-[110px] inline-flex items-center justify-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
                  >
                    <History className="h-3.5 w-3.5 text-sky-700" />
                    <span>Lịch sử vị trí</span>
                  </button>
                  {a.status === 'ACTIVE' && (
                    <>
                      <button
                        type="button"
                        onClick={() => openQuickExtend(a)}
                        className="inline-flex items-center justify-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800"
                      >
                        <CalendarPlus className="h-3.5 w-3.5" />
                        <span>Gia hạn</span>
                      </button>
                      {onOpenTransfer && (
                        <button
                          type="button"
                          onClick={() => onOpenTransfer(a.id)}
                          className="inline-flex items-center justify-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800"
                        >
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                          <span>Chuyển</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDischargeTarget(a)}
                        className="inline-flex items-center justify-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        <span>Trả</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Patient Bed Position Audit Log Modal */}
      {auditTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 print:static print:bg-white print:p-0"
          role="dialog"
          aria-modal="true"
          aria-labelledby="audit-log-modal-title"
        >
          <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden print:shadow-none print:border-0 print:max-h-none">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4 bg-slate-50/70 no-print">
              <div>
                <h3 id="audit-log-modal-title" className="text-lg font-semibold text-slate-900">
                  Lịch sử thay đổi vị trí giường (Audit Log) — {auditTarget.patient_name}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">
                  {auditTarget.patient_code} · HS: {auditTarget.admission_code} · Giường hiện tại: {auditTarget.bed_code} ({auditTarget.department_name})
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setAuditPrintPreviewOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  <Printer className="h-3.5 w-3.5" />
                  <span>Xem trước &amp; In biên bản</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAuditTarget(null)}
                  aria-label="Đóng lịch sử vị trí"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              {auditLoading ? (
                <div className="py-10 text-center text-sm text-slate-500">Đang truy xuất lịch sử vị trí giường...</div>
              ) : auditEntries.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-500">Chưa có bản ghi thay đổi vị trí nào.</div>
              ) : (
                <div className="space-y-3">
                  {auditEntries.map((entry) => {
                    const meta = AUDIT_CATEGORY_LABEL[entry.category] ?? AUDIT_CATEGORY_LABEL.SYSTEM;
                    return (
                      <div key={entry.id} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
                              {meta.label}
                            </span>
                            <span className="text-sm font-semibold text-slate-900">{entry.title}</span>
                          </div>
                          <span className="font-mono text-xs text-slate-500">{formatDateTimeVN(entry.timestamp)}</span>
                        </div>
                        <div className="text-xs font-medium text-sky-900">{entry.locationLabel}</div>
                        <div className="text-xs text-slate-700">{entry.detail}</div>
                        <div className="text-[11px] text-slate-500">Người thực hiện: {entry.actorName}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Print Preview Modal for Patient Audit Log */}
      <PrintPreviewModal
        isOpen={Boolean(auditTarget && auditPrintPreviewOpen)}
        onClose={() => setAuditPrintPreviewOpen(false)}
        title={`Xem trước Biên bản Truy xuất Vị trí Giường — ${auditTarget?.patient_name ?? ''}`}
        subtitle={
          auditTarget
            ? `${auditTarget.patient_code} · HS ${auditTarget.admission_code} · ${auditTarget.department_name}`
            : ''
        }
        defaultOrientation="portrait"
        columns={AUDIT_LOG_PRINT_COLUMNS}
      >
        {({ isColumnVisible }) =>
          auditTarget && (
            <div className="space-y-5">
              <OfficialReportHeader
                title={`BIÊN BẢN TRUY XUẤT LỊCH SỬ VỊ TRÍ GIƯỜNG BỆNH - ${auditTarget.patient_name}`}
                scopeLabel={`${auditTarget.patient_code} · Hồ sơ ${auditTarget.admission_code} · ${auditTarget.department_name} · Giường ${auditTarget.bed_code ?? '—'}`}
                documentCode={`AUDIT-${auditTarget.admission_code}`}
              />

              {auditEntries.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-500 border border-slate-300 rounded">
                  Chưa có bản ghi thay đổi vị trí nào.
                </div>
              ) : (
                <div className="overflow-x-auto print:overflow-visible">
                  <table className="w-full text-xs border border-slate-400">
                    <thead className="bg-slate-100 text-slate-800 border-b border-slate-400">
                      <tr>
                        {isColumnVisible('stt') && <th className="border border-slate-300 px-2.5 py-2 text-left">STT</th>}
                        {isColumnVisible('timestamp') && <th className="border border-slate-300 px-2.5 py-2 text-left">Thời gian</th>}
                        {isColumnVisible('category') && <th className="border border-slate-300 px-2.5 py-2 text-left">Loại sự kiện</th>}
                        {isColumnVisible('location') && <th className="border border-slate-300 px-2.5 py-2 text-left">Vị trí / Giường</th>}
                        {isColumnVisible('detail') && <th className="border border-slate-300 px-2.5 py-2 text-left">Chi tiết thay đổi</th>}
                        {isColumnVisible('actor') && <th className="border border-slate-300 px-2.5 py-2 text-left">Người thực hiện</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {auditEntries.map((entry, idx) => {
                        const meta = AUDIT_CATEGORY_LABEL[entry.category] ?? AUDIT_CATEGORY_LABEL.SYSTEM;
                        return (
                          <tr key={entry.id}>
                            {isColumnVisible('stt') && (
                              <td className="border border-slate-300 px-2.5 py-1.5 font-mono tabular-nums">{idx + 1}</td>
                            )}
                            {isColumnVisible('timestamp') && (
                              <td className="border border-slate-300 px-2.5 py-1.5 font-mono whitespace-nowrap">
                                {formatDateTimeVN(entry.timestamp)}
                              </td>
                            )}
                            {isColumnVisible('category') && (
                              <td className="border border-slate-300 px-2.5 py-1.5 font-semibold">{meta.label}</td>
                            )}
                            {isColumnVisible('location') && (
                              <td className="border border-slate-300 px-2.5 py-1.5">{entry.locationLabel}</td>
                            )}
                            {isColumnVisible('detail') && (
                              <td className="border border-slate-300 px-2.5 py-1.5">
                                <div className="font-medium text-slate-900">{entry.title}</div>
                                <div className="text-slate-600">{entry.detail}</div>
                              </td>
                            )}
                            {isColumnVisible('actor') && (
                              <td className="border border-slate-300 px-2.5 py-1.5">{entry.actorName}</td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <OfficialReportSignatures
                signers={['Điều phối viên giường bệnh', 'Điều dưỡng trưởng khoa', 'Trưởng khoa điều trị']}
              />
            </div>
          )
        }
      </PrintPreviewModal>

      {/* Inline Quick Extend Modal */}
      {extendTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 no-print" role="dialog" aria-modal="true">
          <form onSubmit={handleConfirmExtend} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Gia hạn ngày giường</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {extendTarget.patient_name} · Giường {extendTarget.bed_code}
                </p>
              </div>
              <button type="button" onClick={() => setExtendTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Ngày trả dự kiến mới *</label>
              <input
                type="datetime-local"
                required
                value={extendDate}
                onChange={(e) => setExtendDate(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Lý do gia hạn *</label>
              <input
                type="text"
                required
                value={extendReason}
                onChange={(e) => setExtendReason(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setExtendTarget(null)} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                Hủy
              </button>
              <button
                type="submit"
                disabled={submittingAction}
                className="rounded-md bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {submittingAction ? 'Đang lưu...' : 'Xác nhận gia hạn'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Inline Quick Discharge Confirm Modal */}
      {dischargeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 no-print" role="dialog" aria-modal="true">
          <form onSubmit={handleConfirmDischarge} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Xác nhận Trả giường / Xuất viện</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {dischargeTarget.patient_name} · Giường {dischargeTarget.bed_code}
                </p>
              </div>
              <button type="button" onClick={() => setDischargeTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-xs text-slate-600 rounded-md border border-amber-200 bg-amber-50 p-3">
              Sau khi trả giường, giường <strong>{dischargeTarget.bed_code}</strong> sẽ tự động chuyển sang hàng đợi <strong>Chờ vệ sinh khử khuẩn</strong> trước khi đón bệnh nhân mới.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Ghi chú trả giường</label>
              <input
                type="text"
                value={dischargeNotes}
                onChange={(e) => setDischargeNotes(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setDischargeTarget(null)} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                Hủy
              </button>
              <button
                type="submit"
                disabled={submittingAction}
                className="rounded-md bg-rose-700 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-800 disabled:opacity-50"
              >
                {submittingAction ? 'Đang xử lý...' : 'Xác nhận trả giường'}
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Morning Rounds Bed Summary Print Preview Modal */}
      <PrintPreviewModal
        isOpen={bedSummaryOpen}
        onClose={() => setBedSummaryOpen(false)}
        title="Xem trước Bảng tổng hợp giường bệnh giao ban sáng (Bed Summary)"
        subtitle={getFilterSummary()}
        defaultOrientation="landscape"
        columns={BED_SUMMARY_PRINT_COLUMNS}
        onExportPdf={(ctx) => handleExportBedSummaryPdf(ctx.visibleColumns)}
        exportingPdf={exportingPdf}
      >
        {({ isColumnVisible, visibleColumnCount }) => {
          const tableColCount = Math.max(1, visibleColumnCount - (isColumnVisible('census_strip') ? 1 : 0));
          return (
            <div className="space-y-4">
              <OfficialReportHeader
                title="BẢNG TỔNG HỢP GIƯỜNG BỆNH GIAO BAN BUỔI SÁNG (BED SUMMARY)"
                scopeLabel={getFilterSummary()}
                documentCode={`BED-SUM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`}
              />

              {/* Morning Rounds Quick Census Strip */}
              {isColumnVisible('census_strip') && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                  {[
                    { label: 'Tổng BN theo dõi', val: morningRoundStats.total },
                    { label: 'Đúng tiến độ', val: morningRoundStats.onTime },
                    { label: 'Sắp trả / Đến hạn hôm nay', val: morningRoundStats.dueSoonOrToday },
                    { label: 'Quá ngày trả giường', val: morningRoundStats.overdue },
                    { label: 'Bao trọn phòng', val: morningRoundStats.wholeRoom },
                  ].map((item) => (
                    <div key={item.label} className="rounded border border-slate-300 bg-slate-50/50 px-2.5 py-2">
                      <div className="text-[11px] text-slate-600">{item.label}</div>
                      <div className="text-base font-bold font-mono tabular-nums text-slate-900 mt-0.5">{item.val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Printer-Ready Morning Rounds Bed Summary Table */}
              <div className="overflow-x-auto print:overflow-visible">
                <table className="w-full text-xs border border-slate-400">
                  <thead className="bg-slate-100 text-slate-900 border-b border-slate-400">
                    <tr>
                      {isColumnVisible('stt') && (
                        <th className="border border-slate-300 px-2 py-2 text-center w-9">STT</th>
                      )}
                      {isColumnVisible('location') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Giường / Phòng / Khoa</th>
                      )}
                      {isColumnVisible('codes') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Mã BN / Mã HS</th>
                      )}
                      {isColumnVisible('patient') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Họ tên bệnh nhân</th>
                      )}
                      {isColumnVisible('diagnosis') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Chẩn đoán điều trị</th>
                      )}
                      {isColumnVisible('dates') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Ngày vào / Dự kiến trả</th>
                      )}
                      {isColumnVisible('duration') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-right">Đã nằm / Còn lại</th>
                      )}
                      {isColumnVisible('status') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left">Tình trạng giao ban</th>
                      )}
                      {isColumnVisible('notes') && (
                        <th className="border border-slate-300 px-2.5 py-2 text-left min-w-[150px]">
                          Ghi chú / Y lệnh trực sáng
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td
                          colSpan={tableColCount}
                          className="border border-slate-300 px-4 py-8 text-center text-slate-500"
                        >
                          Không có bệnh nhân trong bộ lọc hiện tại.
                        </td>
                      </tr>
                    ) : (
                      filtered.map((a, idx) => {
                        const m = a.stay_metrics;
                        const remainLabel =
                          a.status === 'DISCHARGED'
                            ? 'Đã trả'
                            : m.daysRemaining < 0
                              ? `Quá ${Math.abs(m.daysRemaining)} ng`
                              : `Còn ${m.daysRemaining} ng`;
                        return (
                          <tr key={a.id} className="align-top">
                            {isColumnVisible('stt') && (
                              <td className="border border-slate-300 px-2 py-2 text-center font-mono tabular-nums">
                                {idx + 1}
                              </td>
                            )}
                            {isColumnVisible('location') && (
                              <td className="border border-slate-300 px-2.5 py-2">
                                <div className="font-mono font-bold text-slate-900">{a.bed_code || '—'}</div>
                                <div className="text-[11px] text-slate-700">
                                  {a.room_name} · {a.department_name}
                                </div>
                                {Boolean(a.is_whole_room) && (
                                  <div className="text-[10px] font-semibold uppercase text-slate-800">
                                    [Bao trọn phòng]
                                  </div>
                                )}
                              </td>
                            )}
                            {isColumnVisible('codes') && (
                              <td className="border border-slate-300 px-2.5 py-2 font-mono text-[11px]">
                                <div className="font-semibold text-slate-900">{a.patient_code}</div>
                                <div className="text-slate-600">{a.admission_code}</div>
                              </td>
                            )}
                            {isColumnVisible('patient') && (
                              <td className="border border-slate-300 px-2.5 py-2">
                                <div className="font-semibold text-slate-900">{a.patient_name}</div>
                                <div className="text-[11px] text-slate-600">
                                  ĐPV: {a.confirmed_by_name || '—'}
                                </div>
                              </td>
                            )}
                            {isColumnVisible('diagnosis') && (
                              <td className="border border-slate-300 px-2.5 py-2 text-slate-800">
                                {a.diagnosis_group || '—'}
                              </td>
                            )}
                            {isColumnVisible('dates') && (
                              <td className="border border-slate-300 px-2.5 py-2 font-mono text-[11px] whitespace-nowrap">
                                <div>Vào: {formatDateVN(a.bed_assigned_at)}</div>
                                <div className="font-semibold">Trả: {formatDateVN(a.expected_discharge_at)}</div>
                              </td>
                            )}
                            {isColumnVisible('duration') && (
                              <td className="border border-slate-300 px-2.5 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                                <div className="font-semibold">{m.daysStayed} ng</div>
                                <div className={m.daysRemaining < 0 ? 'font-bold text-slate-900 underline' : 'text-slate-600'}>
                                  {remainLabel}
                                </div>
                              </td>
                            )}
                            {isColumnVisible('status') && (
                              <td className="border border-slate-300 px-2.5 py-2 font-medium whitespace-nowrap">
                                {getDueStatusText(a)}
                                {a.extension_count > 0 && (
                                  <div className="text-[10px] font-mono text-slate-600">
                                    Đã GH: {a.extension_count} lần
                                  </div>
                                )}
                              </td>
                            )}
                            {isColumnVisible('notes') && (
                              <td className="border border-slate-300 px-2.5 py-2 text-[11px] text-slate-700">
                                {a.notes ? (
                                  <span>{a.notes}</span>
                                ) : (
                                  <span className="inline-block w-full border-b border-dotted border-slate-400 h-4" />
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="text-[11px] text-slate-600 flex flex-wrap items-center justify-between gap-2">
                <span>Tổng cộng: {filtered.length} bệnh nhân đang theo dõi trong danh sách giao ban.</span>
                <span>Ghi chú ký hiệu: ĐPV = Điều phối viên · GH = Gia hạn giường.</span>
              </div>

              <OfficialReportSignatures
                signers={['Điều dưỡng giao ca đêm', 'Điều dưỡng trưởng khoa', 'Bác sĩ trực / Trưởng khoa']}
              />
            </div>
          );
        }}
      </PrintPreviewModal>

      {/* Printable Patient Bed QR Code Modal via Unified Print Preview */}
      <PrintPreviewModal
        isOpen={Boolean(qrTarget)}
        onClose={() => setQrTarget(null)}
        title={`Xem trước & In thẻ QR Giường bệnh — ${qrTarget?.bed_code ?? ''}`}
        subtitle="Quét mã QR bằng điện thoại nhân viên y tế để mở nhanh hồ sơ bệnh nhân."
        defaultOrientation="portrait"
        maxWidthClass="max-w-lg"
        columns={QR_CARD_PRINT_COLUMNS}
      >
        {({ isColumnVisible }) =>
          qrTarget && (
            <div className="rounded-lg border-2 border-slate-900 bg-white p-6 text-center space-y-3 text-slate-900">
              <div className="text-[11px] font-bold uppercase tracking-wider text-sky-800 border-b border-slate-300 pb-2">
                HỆ THỐNG BEDCARE · THẺ QR GIƯỜNG BỆNH
              </div>
              <div className="font-mono text-2xl font-bold text-slate-900">{qrTarget.bed_code}</div>
              <div className="text-base font-bold text-slate-900">{qrTarget.patient_name}</div>
              {isColumnVisible('patient_meta') && (
                <div className="text-xs text-slate-600 font-mono">
                  {qrTarget.patient_code} · HS {qrTarget.admission_code} · {qrTarget.department_name}
                </div>
              )}
              <div className="py-2 flex justify-center">
                <BedQrCode
                  bedId={qrTarget.bed_id}
                  bedCode={qrTarget.bed_code || ''}
                  admissionId={qrTarget.id}
                  size={164}
                  caption="Quét mở ngay hồ sơ bệnh nhân"
                />
              </div>
              {isColumnVisible('qr_url') && (
                <div className="text-[10px] font-mono text-slate-500 break-all bg-slate-50 rounded px-2 py-1 border border-slate-200">
                  {buildBedQrUrl(qrTarget.bed_id, qrTarget.id)}
                </div>
              )}
            </div>
          )
        }
      </PrintPreviewModal>
    </div>
  );
}

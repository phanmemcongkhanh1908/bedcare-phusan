import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  Link2,
  Lock,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { apiFetch } from '../../services/api';
import { downloadTextFile } from '../../utils/exportUtils';
import type {
  HisAuditIssue,
  HisAuditReport,
  HisBedMapping,
  HisDepartmentQuotaRow,
  HisPermissionLevel,
  UserRole,
} from '../../types/bedcare';
import {
  BHYT_BED_TYPE_LABELS,
  canManageHisConfigAndQuotas,
  canSyncAndMapHis,
  resolveEffectiveHisPermission,
} from '../../utils/hisAuditEngine';
import { formatDateTimeVN } from '../../utils/formatters';

interface HisOverviewResponse extends HisAuditReport {
  myPermission: HisPermissionLevel;
  isAdminFull: boolean;
  config: {
    his_api_url: string;
    his_api_enabled: boolean;
    his_sync_mode: string;
    has_token: boolean;
  };
}

interface HisIntegrationPageProps {
  userRole: UserRole;
  hisPermission?: HisPermissionLevel;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onDataChanged?: () => void;
  onNavigateUsers?: () => void;
}

type HisTabId = 'audit' | 'mapping' | 'feed' | 'config';
type AuditFilterId = 'ALL' | 'DUPLICATE_BED' | 'IRRATIONAL_ASSIGNMENT' | 'QUOTA_EXCEEDED' | 'RESOLVED';

const SAMPLE_CSV_TEMPLATE = `his_record_code,patient_code,patient_name,bhyt_card_no,his_dept_code,his_room_code,his_bed_code,his_bed_type_code,bed_ratio,bed_days_billed,status
HIS-99001,BN-99001,Trần Văn Minh,DN4792211005501,K15,A102,HIS-K15-A102-G01,H2,1.0,2,ACTIVE
HIS-99002,BN-99002,Lê Thị Hương,TE1792400112200,K01,C101,HIS-K01-C101-G02,H2,1.0,1,ACTIVE`;

export function HisIntegrationPage({
  userRole,
  hisPermission,
  onNotify,
  onDataChanged,
  onNavigateUsers,
}: HisIntegrationPageProps) {
  const [report, setReport] = useState<HisOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<HisTabId>('audit');

  // Audit tab filters & inline resolution / quick map
  const [auditFilter, setAuditFilter] = useState<AuditFilterId>('ALL');
  const [auditSearch, setAuditSearch] = useState('');
  const [resolveNoteByKey, setResolveNoteByKey] = useState<Record<string, string>>({});
  const [quickMapTargetIssue, setQuickMapTargetIssue] = useState<HisAuditIssue | null>(null);
  const [quickMapBedId, setQuickMapBedId] = useState('');

  // Mapping tab drafts
  const [mappingFilterDept, setMappingFilterDept] = useState('');
  const [mappingStatusFilter, setMappingStatusFilter] = useState<'ALL' | 'UNMAPPED' | 'MAPPED'>('ALL');
  const [mappingSearch, setMappingSearch] = useState('');
  const [batchSavingMappings, setBatchSavingMappings] = useState(false);
  const [mappingDrafts, setMappingDrafts] = useState<
    Record<
      string,
      {
        his_dept_code: string;
        his_room_code: string;
        his_bed_code: string;
        his_bed_type_code: string;
        allow_shared_bed: number;
      }
    >
  >({});
  const [quotaDrafts, setQuotaDrafts] = useState<
    Record<
      string,
      {
        his_dept_code: string;
        planned_bhyt_beds: number;
        max_bhyt_overage_pct: number;
      }
    >
  >({});

  // Feed tab search
  const [feedSearch, setFeedSearch] = useState('');

  // Config & CSV/JSON import tab
  const [apiUrl, setApiUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [apiEnabled, setApiEnabled] = useState(false);
  const [syncMode, setSyncMode] = useState('MANUAL_IMPORT');
  const [payloadText, setPayloadText] = useState('');
  const [payloadSourceLabel, setPayloadSourceLabel] = useState('HIS_CSV_UPLOAD');

  const effectivePermission = resolveEffectiveHisPermission(
    userRole,
    report?.myPermission ?? hisPermission
  );
  const canWriteSyncMap = canSyncAndMapHis(userRole, effectivePermission);
  const isAdminFull = canManageHisConfigAndQuotas(userRole);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<HisOverviewResponse>('/his/overview');
      setReport(data);
      setApiUrl(data.config.his_api_url || '');
      setApiEnabled(Boolean(data.config.his_api_enabled));
      setSyncMode(data.config.his_sync_mode || 'MANUAL_IMPORT');

      const nextMapDrafts: typeof mappingDrafts = {};
      for (const m of data.mappings) {
        nextMapDrafts[m.bed_id] = {
          his_dept_code: m.his_dept_code || '',
          his_room_code: m.his_room_code || '',
          his_bed_code: m.his_bed_code || '',
          his_bed_type_code: m.his_bed_type_code || 'H2',
          allow_shared_bed: m.allow_shared_bed ? 1 : 0,
        };
      }
      setMappingDrafts(nextMapDrafts);

      const nextQuotaDrafts: typeof quotaDrafts = {};
      for (const dq of data.departmentQuotas) {
        nextQuotaDrafts[dq.department_id] = {
          his_dept_code: dq.his_dept_code || '',
          planned_bhyt_beds: dq.planned_bhyt_beds,
          max_bhyt_overage_pct: dq.max_bhyt_overage_pct,
        };
      }
      setQuotaDrafts(nextQuotaDrafts);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRunSync = async (mode: 'LIVE_API' | 'SAMPLE_BHYT_AUDIT' | 'PAYLOAD') => {
    if (!canWriteSyncMap) return;
    setSyncing(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        importedCount: number;
        auditSummary: HisAuditReport['summary'];
      }>('/his/sync', {
        method: 'POST',
        body: JSON.stringify(
          mode === 'PAYLOAD'
            ? { mode: 'PAYLOAD', payload: payloadText, source_label: payloadSourceLabel || 'HIS_CSV_UPLOAD' }
            : mode === 'LIVE_API'
              ? { mode: 'LIVE_API', api_url: apiUrl.trim() || undefined }
              : { mode: 'SAMPLE_BHYT_AUDIT' }
        ),
      });
      onNotify(
        `Đã đồng bộ ${res.importedCount} hồ sơ HIS · Phát hiện ${res.auditSummary.open_issues_count} cảnh báo đối soát BHYT.`
      );
      setActiveTab('audit');
      await load();
      onDataChanged?.();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveMappingRow = async (m: HisBedMapping) => {
    const draft = mappingDrafts[m.bed_id];
    if (!draft) return;
    try {
      await apiFetch('/his/mappings', {
        method: 'POST',
        body: JSON.stringify({
          bed_id: m.bed_id,
          his_dept_code: draft.his_dept_code,
          his_room_code: draft.his_room_code,
          his_bed_code: draft.his_bed_code,
          his_bed_type_code: draft.his_bed_type_code,
          bhyt_max_daily_price: m.daily_price,
          allow_shared_bed: draft.allow_shared_bed,
        }),
      });
      onNotify(`Đã lưu ánh xạ giường ${m.bed_code} ↔ ${draft.his_bed_code || '(chưa gắn mã HIS)'}.`);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleSaveAllChangedMappings = async () => {
    if (!report || changedMappingRows.length === 0) return;
    if (draftDuplicateHisCodes.size > 0) {
      onNotify(
        `Không thể lưu hàng loạt: đang có mã giường HIS bị trùng (${Array.from(draftDuplicateHisCodes).join(', ')}).`,
        'error'
      );
      return;
    }
    setBatchSavingMappings(true);
    try {
      const payloadMappings = changedMappingRows.map((m) => {
        const draft = mappingDrafts[m.bed_id];
        return {
          bed_id: m.bed_id,
          his_dept_code: draft.his_dept_code,
          his_room_code: draft.his_room_code,
          his_bed_code: draft.his_bed_code,
          his_bed_type_code: draft.his_bed_type_code,
          bhyt_max_daily_price: m.daily_price,
          allow_shared_bed: draft.allow_shared_bed,
        };
      });
      await apiFetch('/his/mappings', {
        method: 'POST',
        body: JSON.stringify({ mappings: payloadMappings }),
      });
      onNotify(`Đã lưu đồng loạt ${payloadMappings.length} cấu hình ánh xạ HIS ↔ BEDCARE.`);
      await load();
      onDataChanged?.();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setBatchSavingMappings(false);
    }
  };

  const handleAutoSuggestMappings = async () => {
    try {
      const res = await apiFetch<{ ok: boolean; mappedCount: number }>('/his/mappings/auto-suggest', {
        method: 'POST',
      });
      onNotify(
        res.mappedCount > 0
          ? `Đã tự động gợi ý ánh xạ cho ${res.mappedCount} giường chưa có mã HIS.`
          : 'Tất cả giường hiện tại đều đã được gắn mã ánh xạ HIS.'
      );
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleSaveQuota = async (dq: HisDepartmentQuotaRow) => {
    const draft = quotaDrafts[dq.department_id];
    if (!draft) return;
    try {
      await apiFetch(`/his/departments/${dq.department_id}/quota`, {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      onNotify(`Đã cập nhật chỉ tiêu giường BHYT cho ${dq.department_name}.`);
      await load();
      onDataChanged?.();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleResolveIssue = async (issue: HisAuditIssue, unresolve = false) => {
    try {
      await apiFetch('/his/audit/resolve', {
        method: 'POST',
        body: JSON.stringify({
          issue_key: issue.issue_key,
          category: issue.category,
          severity: issue.severity,
          resolution_note:
            resolveNoteByKey[issue.issue_key] ||
            'Đã kiểm tra đối soát hồ sơ HIS và xác nhận xử lý chênh lệch',
          unresolve,
        }),
      });
      onNotify(unresolve ? 'Đã mở lại cảnh báo đối soát.' : 'Đã đánh dấu đã xử lý cảnh báo HIS/BHYT.');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleAutoAdmitFromHis = async (issue: HisAuditIssue) => {
    if (!issue.bed_id || !issue.his_record_code) return;
    try {
      const res = await apiFetch<{ ok: boolean; admission_code: string }>('/his/audit/auto-admit', {
        method: 'POST',
        body: JSON.stringify({
          bed_id: issue.bed_id,
          his_record_code: issue.his_record_code,
          issue_key: issue.issue_key,
        }),
      });
      onNotify(`Đã tiếp nhận BN ${issue.patient_name} vào giường ${issue.bed_code} (${res.admission_code}).`);
      await load();
      onDataChanged?.();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleQuickMapSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!quickMapTargetIssue || !quickMapBedId || !report) return;
    const targetBed = report.mappings.find((m) => m.bed_id === quickMapBedId);
    if (!targetBed) return;
    try {
      await apiFetch('/his/mappings', {
        method: 'POST',
        body: JSON.stringify({
          bed_id: targetBed.bed_id,
          his_dept_code: quickMapTargetIssue.his_dept_code || targetBed.his_dept_code,
          his_room_code: targetBed.room_code,
          his_bed_code: quickMapTargetIssue.his_bed_code || '',
          his_bed_type_code: targetBed.his_bed_type_code || 'H2',
          bhyt_max_daily_price: targetBed.daily_price,
          allow_shared_bed: targetBed.allow_shared_bed,
        }),
      });
      onNotify(
        `Đã ánh xạ mã HIS ${quickMapTargetIssue.his_bed_code} -> giường ${targetBed.bed_code}.`
      );
      setQuickMapTargetIssue(null);
      setQuickMapBedId('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleSaveHisConfig = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/his/config', {
        method: 'POST',
        body: JSON.stringify({
          his_api_url: apiUrl,
          his_api_enabled: apiEnabled,
          his_sync_mode: syncMode,
          ...(apiToken.trim() ? { his_api_token: apiToken.trim() } : {}),
        }),
      });
      setApiToken('');
      onNotify('Đã lưu cấu hình kết nối Endpoint HIS & đồng bộ P2P.');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleUploadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPayloadText(text);
    setPayloadSourceLabel(file.name);
    onNotify(`Đã nạp nội dung từ tệp ${file.name} (${text.split(/\r?\n/).length} dòng). Nhấn "Nạp & Đối soát ngay" để chạy kiểm định.`);
    e.target.value = '';
  };

  const filteredIssues = useMemo(() => {
    if (!report) return [];
    return report.issues.filter((issue) => {
      if (auditFilter === 'RESOLVED') {
        if (!issue.resolved) return false;
      } else {
        if (issue.resolved) return false;
        if (auditFilter !== 'ALL' && issue.category !== auditFilter) return false;
      }
      if (auditSearch.trim()) {
        const q = auditSearch.toLowerCase();
        const hay = `${issue.title} ${issue.description} ${issue.patient_name ?? ''} ${issue.his_bed_code ?? ''} ${issue.bed_code ?? ''} ${issue.department_name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [report, auditFilter, auditSearch]);

  const draftDuplicateHisCodes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const draft of Object.values(mappingDrafts)) {
      const code = (draft.his_bed_code || '').trim().toUpperCase();
      if (!code) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const dups = new Set<string>();
    for (const [code, cnt] of counts.entries()) {
      if (cnt > 1) dups.add(code);
    }
    return dups;
  }, [mappingDrafts]);

  const changedMappingRows = useMemo(() => {
    if (!report) return [];
    return report.mappings.filter((m) => {
      const d = mappingDrafts[m.bed_id];
      if (!d) return false;
      return (
        (d.his_dept_code || '').trim() !== (m.his_dept_code || '').trim() ||
        (d.his_room_code || '').trim() !== (m.his_room_code || '').trim() ||
        (d.his_bed_code || '').trim() !== (m.his_bed_code || '').trim() ||
        (d.his_bed_type_code || 'H2') !== (m.his_bed_type_code || 'H2') ||
        Boolean(d.allow_shared_bed) !== Boolean(m.allow_shared_bed)
      );
    });
  }, [report, mappingDrafts]);

  const filteredMappings = useMemo(() => {
    if (!report) return [];
    return report.mappings.filter((m) => {
      if (mappingFilterDept && m.department_id !== mappingFilterDept) return false;
      const draftCode = (mappingDrafts[m.bed_id]?.his_bed_code ?? m.his_bed_code ?? '').trim();
      if (mappingStatusFilter === 'UNMAPPED' && draftCode) return false;
      if (mappingStatusFilter === 'MAPPED' && !draftCode) return false;
      if (mappingSearch.trim()) {
        const q = mappingSearch.toLowerCase();
        const draftRoom = mappingDrafts[m.bed_id]?.his_room_code ?? m.his_room_code ?? '';
        const hay = `${m.bed_code} ${m.room_name} ${m.room_code} ${m.department_name} ${draftCode} ${draftRoom} ${m.his_dept_code}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [report, mappingFilterDept, mappingStatusFilter, mappingSearch, mappingDrafts]);

  const filteredAssignments = useMemo(() => {
    if (!report) return [];
    if (!feedSearch.trim()) return report.assignments;
    const q = feedSearch.toLowerCase();
    return report.assignments.filter((a) =>
      `${a.his_record_code} ${a.patient_name} ${a.bhyt_card_no} ${a.his_dept_code} ${a.his_bed_code}`.toLowerCase().includes(q)
    );
  }, [report, feedSearch]);

  const permissionLabel = isAdminFull
    ? 'Admin · Toàn quyền cấu hình HIS, BHYT & Ánh xạ'
    : effectivePermission === 'SYNC_AND_MAP'
      ? 'Nhân viên được cấp quyền · Đồng bộ, Ánh xạ & Xử lý cảnh báo'
      : 'Nhân viên được cấp quyền · Chỉ xem đối soát HIS/BHYT';

  if (loading && !report) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        Đang tải dữ liệu liên thông HIS &amp; kiểm định BHYT...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Top Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold text-slate-900">
              Kết nối HIS &amp; Giám định Giường BHYT
            </h2>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-800 bg-sky-50 border border-sky-200 rounded px-2 py-0.5">
              <ShieldCheck className="h-3.5 w-3.5 text-sky-700" />
              <span>{permissionLabel}</span>
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Ánh xạ mã khoa/phòng/giường HIS với BEDCARE, phát hiện tự động trùng giường, cấp sai phân hạng BHYT và vượt trần giường kế hoạch.
          </p>
        </div>

        {canWriteSyncMap && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={syncing}
              onClick={() => handleRunSync('SAMPLE_BHYT_AUDIT')}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4 text-sky-700" />
              <span>{syncing ? 'Đang kiểm định...' : 'Chạy mẫu kiểm định HIS/BHYT'}</span>
            </button>
            <button
              type="button"
              disabled={syncing || !report?.config.his_api_url}
              title={
                report?.config.his_api_url
                  ? `Kéo dữ liệu trực tiếp từ ${report.config.his_api_url}`
                  : 'Chưa cấu hình URL Endpoint HIS trong tab Cấu hình'
              }
              onClick={() => handleRunSync('LIVE_API')}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-3.5 py-2 text-xs sm:text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-45"
            >
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              <span>Đồng bộ từ Endpoint HIS</span>
            </button>
          </div>
        )}
      </div>

      {/* 4 Summary KPI Strip */}
      {report && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium text-slate-500">Hồ sơ đang nằm HIS / BEDCARE</div>
            <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-2xl font-bold text-slate-900">{report.summary.total_his_active}</span>
              <span className="text-sm text-slate-400">/</span>
              <span className="text-lg font-semibold text-sky-700">{report.summary.total_bedcare_occupied}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
              Đã ánh xạ {report.summary.mapped_beds_count}/{report.summary.total_beds_count} giường
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium text-slate-500">Cảnh báo Trùng giường</div>
            <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
              <span
                className={`text-2xl font-bold ${
                  report.summary.duplicate_count > 0 ? 'text-rose-700' : 'text-emerald-700'
                }`}
              >
                {report.summary.duplicate_count}
              </span>
              <span className="text-xs text-slate-500">vụ đang mở</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Trùng mã HIS, 1 BN ≥2 giường, lệch người nằm
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium text-slate-500">Cấp giường bất hợp lý</div>
            <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
              <span
                className={`text-2xl font-bold ${
                  report.summary.irrational_count > 0 ? 'text-amber-700' : 'text-emerald-700'
                }`}
              >
                {report.summary.irrational_count}
              </span>
              <span className="text-xs text-slate-500">lỗi phân hạng / trạng thái</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Sai loại H1/H2/DV, giường bảo trì, chưa ánh xạ
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium text-slate-500">Vượt trần giường quy định BHYT</div>
            <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
              <span
                className={`text-2xl font-bold ${
                  report.summary.quota_exceeded_count > 0 ? 'text-rose-700' : 'text-emerald-700'
                }`}
              >
                {report.summary.quota_exceeded_count}
              </span>
              <span className="text-xs text-slate-500">cảnh báo công suất</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {report.summary.last_synced_at
                ? `Đồng bộ gần nhất: ${formatDateTimeVN(report.summary.last_synced_at)}`
                : 'Chưa có phiên đồng bộ HIS nào'}
            </div>
          </div>
        </div>
      )}

      {/* Sub-Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200">
        {[
          {
            id: 'audit' as HisTabId,
            label: `Cảnh báo & Đối soát BHYT (${report?.summary.open_issues_count ?? 0})`,
            icon: ShieldAlert,
          },
          {
            id: 'mapping' as HisTabId,
            label: `HIS Mapping · Ánh xạ Giường (${report?.summary.mapped_beds_count ?? 0}/${report?.summary.total_beds_count ?? 0})`,
            icon: ArrowRightLeft,
          },
          {
            id: 'feed' as HisTabId,
            label: `Dữ liệu HIS đã đồng bộ (${report?.assignments.length ?? 0})`,
            icon: Database,
          },
          {
            id: 'config' as HisTabId,
            label: 'Cấu hình HIS & Nạp CSV/JSON',
            icon: Server,
          },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                active
                  ? 'border-sky-700 text-sky-800 bg-white'
                  : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: AUDIT & BHYT COMPLIANCE */}
      {activeTab === 'audit' && report && (
        <div className="space-y-6">
          {/* Filter & Search Bar */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { id: 'ALL' as AuditFilterId, label: `Đang mở (${report.summary.open_issues_count})` },
                { id: 'DUPLICATE_BED' as AuditFilterId, label: `Trùng giường (${report.summary.duplicate_count})` },
                { id: 'IRRATIONAL_ASSIGNMENT' as AuditFilterId, label: `Không hợp lý (${report.summary.irrational_count})` },
                { id: 'QUOTA_EXCEEDED' as AuditFilterId, label: `Vượt giường QĐ (${report.summary.quota_exceeded_count})` },
                { id: 'RESOLVED' as AuditFilterId, label: `Đã xử lý (${report.summary.resolved_count})` },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setAuditFilter(f.id)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border whitespace-nowrap ${
                    auditFilter === f.id
                      ? 'border-sky-700 bg-sky-50 text-sky-900'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative w-full lg:w-72">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Lọc theo BN, mã giường, khoa..."
                className="w-full rounded-md border border-slate-300 bg-slate-50 pl-9 pr-3 py-1.5 text-sm focus:border-sky-600 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {/* Issues List */}
          <div className="space-y-3">
            {filteredIssues.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white p-8 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto" />
                <p className="mt-2 text-sm font-medium text-slate-800">
                  {report.assignments.length === 0
                    ? 'Chưa có dữ liệu HIS được đồng bộ để đối soát.'
                    : 'Không có cảnh báo sai lệch HIS / BHYT nào trong bộ lọc này.'}
                </p>
                {report.assignments.length === 0 && canWriteSyncMap && (
                  <p className="mt-1 text-xs text-slate-500">
                    Nhấn &quot;Chạy mẫu kiểm định HIS/BHYT&quot; hoặc nạp CSV/JSON ở tab Cấu hình để bắt đầu rà soát.
                  </p>
                )}
              </div>
            ) : (
              filteredIssues.map((issue) => (
                <div
                  key={issue.issue_key}
                  className={`rounded-lg border bg-white p-4 space-y-3 ${
                    issue.resolved
                      ? 'border-slate-200 opacity-85'
                      : issue.severity === 'CRITICAL'
                        ? 'border-rose-300'
                        : issue.severity === 'HIGH'
                          ? 'border-amber-300'
                          : 'border-slate-300'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={`font-semibold uppercase tracking-wide ${
                            issue.resolved
                              ? 'text-emerald-700'
                              : issue.severity === 'CRITICAL'
                                ? 'text-rose-700'
                                : issue.severity === 'HIGH'
                                  ? 'text-amber-700'
                                  : 'text-sky-700'
                          }`}
                        >
                          {issue.resolved
                            ? 'ĐÃ XỬ LÝ'
                            : issue.severity === 'CRITICAL'
                              ? 'NGHIÊM TRỌNG'
                              : issue.severity === 'HIGH'
                                ? 'CẢNH BÁO CAO'
                                : 'CẦN RÀ SOÁT'}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span className="font-mono text-slate-600">{issue.rule_code}</span>
                        {issue.department_name && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span className="font-medium text-slate-700">{issue.department_name}</span>
                          </>
                        )}
                      </div>
                      <h3 className="text-sm sm:text-base font-semibold text-slate-900">
                        {issue.title}
                      </h3>
                      <p className="text-sm text-slate-600">{issue.description}</p>
                      <div className="text-xs text-sky-800 font-medium">
                        Căn cứ BHYT: {issue.bhyt_regulation_ref}
                      </div>
                    </div>

                    {/* HIS vs BEDCARE comparison box */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
                      <div className="rounded border border-slate-200 bg-slate-50 p-2.5 min-w-0">
                        <div className="text-[11px] font-semibold text-slate-500 uppercase">Ghi nhận trên HIS</div>
                        <div className="mt-0.5 font-medium text-slate-900 break-words">
                          {issue.his_summary || issue.his_bed_code || '—'}
                        </div>
                      </div>
                      <div className="rounded border border-slate-200 bg-slate-50 p-2.5 min-w-0">
                        <div className="text-[11px] font-semibold text-slate-500 uppercase">Thực tế BEDCARE</div>
                        <div className="mt-0.5 font-medium text-slate-900 break-words">
                          {issue.bedcare_summary || issue.bed_code || '—'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Action Bar */}
                  {issue.resolved ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs text-slate-600">
                      <span>
                        Đã xử lý bởi <strong className="text-slate-800">{issue.resolved_by_name}</strong> ·{' '}
                        {issue.resolved_at ? formatDateTimeVN(issue.resolved_at) : ''} · Ghi chú: {issue.resolution_note}
                      </span>
                      {canWriteSyncMap && (
                        <button
                          type="button"
                          onClick={() => handleResolveIssue(issue, true)}
                          className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Mở lại cảnh báo
                        </button>
                      )}
                    </div>
                  ) : (
                    canWriteSyncMap && (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-slate-100">
                        <div className="flex flex-wrap items-center gap-2">
                          {issue.can_quick_map && (
                            <button
                              type="button"
                              onClick={() => {
                                setQuickMapTargetIssue(issue);
                                setQuickMapBedId('');
                              }}
                              className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
                            >
                              <Link2 className="h-3.5 w-3.5" />
                              <span>Ánh xạ giường ngay</span>
                            </button>
                          )}
                          {issue.can_auto_admit && issue.bed_id && issue.his_record_code && (
                            <button
                              type="button"
                              onClick={() => handleAutoAdmitFromHis(issue)}
                              className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>Tiếp nhận BN từ HIS vào giường</span>
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 flex-1 sm:justify-end">
                          <input
                            type="text"
                            value={resolveNoteByKey[issue.issue_key] || ''}
                            onChange={(e) =>
                              setResolveNoteByKey((prev) => ({
                                ...prev,
                                [issue.issue_key]: e.target.value,
                              }))
                            }
                            placeholder="Ghi chú biên bản xử lý (tùy chọn)..."
                            className="w-full sm:w-64 rounded border border-slate-300 px-2.5 py-1.5 text-xs focus:border-sky-600 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleResolveIssue(issue, false)}
                            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                          >
                            Xác nhận đã xử lý
                          </button>
                        </div>
                      </div>
                    )
                  )}
                </div>
              ))
            )}
          </div>

          {/* Department Planned BHYT Quota Table */}
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Bảng kiểm soát Chỉ tiêu Giường Kế hoạch BHYT theo Khoa
                </h3>
                <p className="text-xs text-slate-500">
                  Đối chiếu số giường HIS đang tính tiền &amp; giường thực nằm so với giường kế hoạch BHYT được giao.
                </p>
              </div>
              {!isAdminFull && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <Lock className="h-3.5 w-3.5" />
                  <span>Chỉ Admin chỉnh sửa định mức BHYT</span>
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Khoa điều trị</th>
                    <th className="px-4 py-2.5 text-left font-medium">Mã khoa HIS</th>
                    <th className="px-4 py-2.5 text-right font-medium">KH BHYT</th>
                    <th className="px-4 py-2.5 text-right font-medium">Thực kê</th>
                    <th className="px-4 py-2.5 text-right font-medium">BEDCARE nằm</th>
                    <th className="px-4 py-2.5 text-right font-medium">HIS đang kê</th>
                    <th className="px-4 py-2.5 text-right font-medium">Công suất BHYT</th>
                    <th className="px-4 py-2.5 text-left font-medium">Đánh giá</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {report.departmentQuotas.map((dq) => (
                    <tr key={dq.department_id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-sans font-medium text-slate-900">{dq.department_name}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-700">{dq.his_dept_code || '—'}</td>
                      <td className="px-4 py-2.5 text-right text-slate-900 font-semibold">{dq.planned_bhyt_beds}</td>
                      <td className="px-4 py-2.5 text-right text-slate-600">{dq.physical_beds}</td>
                      <td className="px-4 py-2.5 text-right text-slate-800">{dq.bedcare_occupied_beds}</td>
                      <td className="px-4 py-2.5 text-right text-sky-700 font-semibold">{dq.his_effective_bed_units}</td>
                      <td className="px-4 py-2.5 text-right font-semibold">
                        <span
                          className={
                            dq.status === 'CRITICAL_OVERAGE'
                              ? 'text-rose-700'
                              : dq.status === 'OVER_PLANNED'
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                          }
                        >
                          {dq.quota_utilization_pct}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-sans text-xs font-semibold">
                        {dq.status === 'CRITICAL_OVERAGE' ? (
                          <span className="inline-flex items-center gap-1 text-rose-700">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Vượt trần (&gt;{dq.max_bhyt_overage_pct}%)
                          </span>
                        ) : dq.status === 'OVER_PLANNED' ? (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Vượt KH BHYT
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Đạt chuẩn
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: MAPPING & DEPARTMENT BHYT QUOTA CONFIG */}
      {activeTab === 'mapping' && report && (
        <div className="space-y-6">
          {/* Department Quota Editor (Admin Full Control) */}
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  1. Định mức Mã khoa HIS &amp; Giường Kế hoạch BHYT theo Khoa
                </h3>
                <p className="text-xs text-slate-500">
                  Thiết lập mã khoa HIS (QĐ 130/BYT) và ngưỡng vượt giường BHYT cho từng khoa.
                </p>
              </div>
              {!isAdminFull && (
                <span className="text-xs font-medium text-amber-700">
                  Chế độ chỉ xem · Cần quyền Admin để cập nhật định mức khoa
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Khoa BEDCARE</th>
                    <th className="px-4 py-2.5 text-left font-medium">Mã khoa HIS</th>
                    <th className="px-4 py-2.5 text-left font-medium">Số giường KH BHYT</th>
                    <th className="px-4 py-2.5 text-left font-medium">Ngưỡng trần cảnh báo (%)</th>
                    <th className="px-4 py-2.5 text-right font-medium">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.departmentQuotas.map((dq) => {
                    const draft = quotaDrafts[dq.department_id] ?? {
                      his_dept_code: dq.his_dept_code,
                      planned_bhyt_beds: dq.planned_bhyt_beds,
                      max_bhyt_overage_pct: dq.max_bhyt_overage_pct,
                    };
                    return (
                      <tr key={dq.department_id}>
                        <td className="px-4 py-2.5 font-medium text-slate-900">
                          {dq.department_name}
                          <div className="text-xs text-slate-400 font-mono">{dq.physical_beds} giường vật lý</div>
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="text"
                            disabled={!isAdminFull}
                            value={draft.his_dept_code}
                            onChange={(e) =>
                              setQuotaDrafts((prev) => ({
                                ...prev,
                                [dq.department_id]: { ...draft, his_dept_code: e.target.value.toUpperCase() },
                              }))
                            }
                            className="w-28 rounded border border-slate-300 px-2.5 py-1.5 text-xs font-mono disabled:bg-slate-100"
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="number"
                            min={0}
                            disabled={!isAdminFull}
                            value={draft.planned_bhyt_beds}
                            onChange={(e) =>
                              setQuotaDrafts((prev) => ({
                                ...prev,
                                [dq.department_id]: { ...draft, planned_bhyt_beds: Number(e.target.value) },
                              }))
                            }
                            className="w-24 rounded border border-slate-300 px-2.5 py-1.5 text-xs font-mono tabular-nums disabled:bg-slate-100"
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="number"
                            min={100}
                            max={300}
                            disabled={!isAdminFull}
                            value={draft.max_bhyt_overage_pct}
                            onChange={(e) =>
                              setQuotaDrafts((prev) => ({
                                ...prev,
                                [dq.department_id]: { ...draft, max_bhyt_overage_pct: Number(e.target.value) },
                              }))
                            }
                            className="w-24 rounded border border-slate-300 px-2.5 py-1.5 text-xs font-mono tabular-nums disabled:bg-slate-100"
                          />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {isAdminFull ? (
                            <button
                              type="button"
                              onClick={() => handleSaveQuota(dq)}
                              className="rounded border border-sky-700 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100"
                            >
                              Lưu định mức
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400">Chỉ Admin</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bed Mapping Control Panel */}
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3.5 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  2. HIS Mapping · Bảng điều khiển Ánh xạ Mã giường BEDCARE ↔ HIS
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Thiết lập ánh xạ 1-1 mã khoa, mã phòng, mã giường HIS và phân hạng BHYT. Hệ thống tự chặn gán trùng 1 mã HIS cho 2 giường vật lý.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={mappingFilterDept}
                  onChange={(e) => setMappingFilterDept(e.target.value)}
                  className="rounded border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                >
                  <option value="">Tất cả khoa</option>
                  {report.departmentQuotas.map((d) => (
                    <option key={d.department_id} value={d.department_id}>
                      {d.department_name}
                    </option>
                  ))}
                </select>
                <select
                  value={mappingStatusFilter}
                  onChange={(e) => setMappingStatusFilter(e.target.value as 'ALL' | 'UNMAPPED' | 'MAPPED')}
                  className="rounded border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                >
                  <option value="ALL">Tất cả trạng thái ({report.mappings.length})</option>
                  <option value="UNMAPPED">
                    Chưa gắn mã HIS ({report.summary.total_beds_count - report.summary.mapped_beds_count})
                  </option>
                  <option value="MAPPED">Đã ánh xạ ({report.summary.mapped_beds_count})</option>
                </select>
                <input
                  type="search"
                  value={mappingSearch}
                  onChange={(e) => setMappingSearch(e.target.value)}
                  placeholder="Tìm mã giường / phòng HIS..."
                  className="rounded border border-slate-300 px-2.5 py-1.5 text-xs w-44"
                />
                {canWriteSyncMap && (
                  <>
                    <button
                      type="button"
                      disabled={batchSavingMappings || changedMappingRows.length === 0 || draftDuplicateHisCodes.size > 0}
                      onClick={handleSaveAllChangedMappings}
                      className="inline-flex items-center gap-1 rounded border border-emerald-700 bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-45"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>
                        {batchSavingMappings
                          ? 'Đang lưu...'
                          : `Lưu tất cả thay đổi (${changedMappingRows.length})`}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={handleAutoSuggestMappings}
                      className="inline-flex items-center gap-1 rounded border border-sky-700 bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Tự động gợi ý ánh xạ</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* HIS Mapping KPI & Conflict Strip */}
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-4 font-mono tabular-nums text-slate-700">
                <span>
                  Đã ánh xạ: <strong className="text-emerald-700">{report.summary.mapped_beds_count}</strong>/
                  {report.summary.total_beds_count} giường
                </span>
                <span>
                  Chưa gắn mã HIS:{' '}
                  <strong className={report.summary.total_beds_count - report.summary.mapped_beds_count > 0 ? 'text-amber-700' : 'text-slate-700'}>
                    {report.summary.total_beds_count - report.summary.mapped_beds_count}
                  </strong>
                </span>
                <span>
                  Thay đổi chưa lưu:{' '}
                  <strong className={changedMappingRows.length > 0 ? 'text-sky-700' : 'text-slate-600'}>
                    {changedMappingRows.length}
                  </strong>
                </span>
              </div>
              {draftDuplicateHisCodes.size > 0 && (
                <div className="inline-flex items-center gap-1.5 text-rose-700 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Phát hiện trùng mã HIS trong bảng nháp: <span className="font-mono">{Array.from(draftDuplicateHisCodes).join(', ')}</span>
                  </span>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-2.5 py-2.5 text-left font-medium">Giường BEDCARE</th>
                    <th className="px-2.5 py-2.5 text-left font-medium">Loại / Giá</th>
                    <th className="px-2.5 py-2.5 text-left font-medium">Khoa HIS</th>
                    <th className="px-2.5 py-2.5 text-left font-medium">Phòng HIS</th>
                    <th className="px-2.5 py-2.5 text-left font-medium">Mã giường HIS</th>
                    <th className="px-2.5 py-2.5 text-left font-medium">Phân hạng BHYT</th>
                    <th className="px-2.5 py-2.5 text-center font-medium">Ghép</th>
                    <th className="px-2.5 py-2.5 text-right font-medium">Lưu</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredMappings.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-xs text-slate-500">
                        Không có giường nào phù hợp bộ lọc ánh xạ HIS hiện tại.
                      </td>
                    </tr>
                  ) : (
                    filteredMappings.map((m) => {
                      const draft = mappingDrafts[m.bed_id] ?? {
                        his_dept_code: m.his_dept_code,
                        his_room_code: m.his_room_code,
                        his_bed_code: m.his_bed_code,
                        his_bed_type_code: m.his_bed_type_code,
                        allow_shared_bed: m.allow_shared_bed,
                      };
                      const normalizedHisCode = (draft.his_bed_code || '').trim().toUpperCase();
                      const isDupInDraft = Boolean(normalizedHisCode && draftDuplicateHisCodes.has(normalizedHisCode));
                      const isRowChanged = changedMappingRows.some((cm) => cm.bed_id === m.bed_id);

                      return (
                        <tr key={m.bed_id} className={isDupInDraft ? 'bg-rose-50/40' : isRowChanged ? 'bg-sky-50/30' : 'hover:bg-slate-50'}>
                          <td className="px-2.5 py-2.5 whitespace-nowrap">
                            <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-slate-900">
                              <span>{m.bed_code}</span>
                              {isRowChanged && (
                                <span className="text-[10px] font-sans font-medium text-sky-700">· chưa lưu</span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500">
                              {m.department_name} · {m.room_name}
                            </div>
                          </td>
                          <td className="px-2.5 py-2.5 whitespace-nowrap text-xs">
                            <div className="font-medium text-slate-800">{m.room_type}</div>
                            <div className="font-mono tabular-nums text-slate-500">
                              {m.daily_price.toLocaleString('vi-VN')}đ/ngày
                            </div>
                          </td>
                          <td className="px-2.5 py-2.5">
                            <input
                              type="text"
                              disabled={!canWriteSyncMap}
                              value={draft.his_dept_code}
                              onChange={(e) =>
                                setMappingDrafts((prev) => ({
                                  ...prev,
                                  [m.bed_id]: { ...draft, his_dept_code: e.target.value.toUpperCase() },
                                }))
                              }
                              className="w-16 rounded border border-slate-300 px-2 py-1 text-xs font-mono disabled:bg-slate-100"
                            />
                          </td>
                          <td className="px-2.5 py-2.5">
                            <input
                              type="text"
                              disabled={!canWriteSyncMap}
                              value={draft.his_room_code}
                              placeholder={m.room_code}
                              onChange={(e) =>
                                setMappingDrafts((prev) => ({
                                  ...prev,
                                  [m.bed_id]: { ...draft, his_room_code: e.target.value.toUpperCase() },
                                }))
                              }
                              className="w-20 rounded border border-slate-300 px-2 py-1 text-xs font-mono disabled:bg-slate-100"
                            />
                          </td>
                          <td className="px-2.5 py-2.5">
                            <input
                              type="text"
                              disabled={!canWriteSyncMap}
                              value={draft.his_bed_code}
                              placeholder="VD: HIS-K15-A101-G01"
                              onChange={(e) =>
                                setMappingDrafts((prev) => ({
                                  ...prev,
                                  [m.bed_id]: { ...draft, his_bed_code: e.target.value.toUpperCase() },
                                }))
                              }
                              className={`w-36 rounded border px-2 py-1 text-xs font-mono disabled:bg-slate-100 ${
                                isDupInDraft
                                  ? 'border-rose-500 bg-rose-50 text-rose-900'
                                  : !draft.his_bed_code.trim()
                                    ? 'border-amber-300 bg-amber-50/40'
                                    : 'border-slate-300'
                              }`}
                            />
                            {isDupInDraft && (
                              <div className="text-[11px] text-rose-700 mt-0.5 font-medium">
                                Trùng mã HIS với giường khác
                              </div>
                            )}
                          </td>
                          <td className="px-2.5 py-2.5">
                            <select
                              disabled={!canWriteSyncMap}
                              value={draft.his_bed_type_code}
                              onChange={(e) =>
                                setMappingDrafts((prev) => ({
                                  ...prev,
                                  [m.bed_id]: { ...draft, his_bed_type_code: e.target.value },
                                }))
                              }
                              className="rounded border border-slate-300 px-2 py-1 text-xs bg-white disabled:bg-slate-100 max-w-[155px]"
                            >
                              {Object.entries(BHYT_BED_TYPE_LABELS).map(([code, label]) => (
                                <option key={code} value={code}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2.5 py-2.5 text-center">
                            <input
                              type="checkbox"
                              disabled={!canWriteSyncMap}
                              checked={Boolean(draft.allow_shared_bed)}
                              onChange={(e) =>
                                setMappingDrafts((prev) => ({
                                  ...prev,
                                  [m.bed_id]: { ...draft, allow_shared_bed: e.target.checked ? 1 : 0 },
                                }))
                              }
                              aria-label={`Cho phép giường ghép cho ${m.bed_code}`}
                            />
                          </td>
                          <td className="px-2.5 py-2.5 text-right">
                            {canWriteSyncMap ? (
                              <button
                                type="button"
                                disabled={isDupInDraft}
                                onClick={() => handleSaveMappingRow(m)}
                                className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-45"
                              >
                                Lưu
                              </button>
                            ) : (
                              <span className="text-xs text-slate-400">Chỉ xem</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: HIS ASSIGNMENT FEED */}
      {activeTab === 'feed' && report && (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Danh sách Hồ sơ Cấp giường Đồng bộ từ Phần mềm HIS
              </h3>
              <p className="text-xs text-slate-500">
                Dữ liệu gốc kéo về từ API HIS hoặc tệp CSV/JSON XML-130 dùng làm căn cứ đối soát.
              </p>
            </div>
            <input
              type="search"
              value={feedSearch}
              onChange={(e) => setFeedSearch(e.target.value)}
              placeholder="Tìm mã LK, tên BN, thẻ BHYT, mã giường HIS..."
              className="rounded border border-slate-300 px-3 py-1.5 text-xs w-72"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Mã LK (HIS)</th>
                  <th className="px-4 py-2.5 text-left font-medium">Bệnh nhân / Thẻ BHYT</th>
                  <th className="px-4 py-2.5 text-left font-medium">Khoa HIS</th>
                  <th className="px-4 py-2.5 text-left font-medium">Mã giường HIS</th>
                  <th className="px-4 py-2.5 text-left font-medium">Loại BHYT</th>
                  <th className="px-4 py-2.5 text-right font-medium">Hệ số</th>
                  <th className="px-4 py-2.5 text-right font-medium">Ngày giường kê</th>
                  <th className="px-4 py-2.5 text-left font-medium">Ngày giờ vào</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredAssignments.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-slate-500 text-sm">
                      Chưa có dữ liệu HIS nào được đồng bộ.
                    </td>
                  </tr>
                ) : (
                  filteredAssignments.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold text-slate-900">
                        {a.his_record_code}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">{a.patient_name}</div>
                        <div className="text-xs font-mono text-slate-500">{a.bhyt_card_no || a.patient_code}</div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-700">{a.his_dept_code}</td>
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold text-sky-800">{a.his_bed_code}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-700">{a.his_bed_type_code}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-xs">{a.bed_ratio}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-xs">{a.bed_days_billed}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                        {formatDateTimeVN(a.admitted_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: CONFIG, CSV/JSON IMPORT & RBAC INFO */}
      {activeTab === 'config' && report && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Endpoint Configuration (Admin only edit) */}
          <div className="lg:col-span-5 space-y-4">
            <form onSubmit={handleSaveHisConfig} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Cấu hình Endpoint REST API HIS</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Kết nối trực tiếp máy chủ HIS nội bộ qua mạng LAN bệnh viện (100% miễn phí).
                  </p>
                </div>
                {!isAdminFull && <Lock className="h-4 w-4 text-slate-400 shrink-0" />}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  URL API danh sách giường đang nằm HIS
                </label>
                <input
                  type="url"
                  disabled={!isAdminFull}
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="http://10.0.10.25:8080/api/v1/inpatient-beds"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-xs font-mono disabled:bg-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Bearer Token HIS {report.config.has_token ? '(đã lưu token)' : '(tùy chọn)'}
                </label>
                <input
                  type="password"
                  disabled={!isAdminFull}
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder={report.config.has_token ? '•••••••• (để trống nếu giữ nguyên)' : 'Nhập API Token HIS nếu có'}
                  className="w-full rounded border border-slate-300 px-3 py-2 text-xs disabled:bg-slate-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Chế độ đồng bộ</label>
                  <select
                    disabled={!isAdminFull}
                    value={syncMode}
                    onChange={(e) => setSyncMode(e.target.value)}
                    className="w-full rounded border border-slate-300 px-2.5 py-2 text-xs bg-white disabled:bg-slate-100"
                  >
                    <option value="MANUAL_IMPORT">Nhập CSV / JSON thủ công</option>
                    <option value="REST_API">Kéo REST API HIS</option>
                    <option value="HYBRID">Kết hợp API + CSV</option>
                  </select>
                </div>
                <div className="flex items-end pb-1">
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      disabled={!isAdminFull}
                      checked={apiEnabled}
                      onChange={(e) => setApiEnabled(e.target.checked)}
                    />
                    <span>Kích hoạt API HIS</span>
                  </label>
                </div>
              </div>

              {isAdminFull ? (
                <button
                  type="submit"
                  className="w-full rounded-md bg-sky-700 px-4 py-2 text-xs sm:text-sm font-medium text-white hover:bg-sky-800"
                >
                  Lưu cấu hình HIS (Admin)
                </button>
              ) : (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Chỉ Admin / Super Admin mới có quyền thay đổi URL kết nối &amp; Token HIS.
                </div>
              )}
            </form>

            {/* RBAC Note for Admin */}
            <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <ShieldCheck className="h-4 w-4 text-sky-700" />
                <span>Phân quyền truy cập HIS &amp; BHYT</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Admin và Super Admin luôn có toàn quyền (cấu hình API HIS, định mức giường BHYT theo khoa, ánh xạ và xử lý cảnh báo). Nhân viên các khoa/phòng chỉ thấy chức năng này khi được Admin cấp quyền <span className="font-mono font-semibold">VIEW</span> hoặc <span className="font-mono font-semibold">SYNC_AND_MAP</span>.
              </p>
              {isAdminFull && onNavigateUsers && (
                <button
                  type="button"
                  onClick={onNavigateUsers}
                  className="text-xs font-semibold text-sky-700 hover:underline"
                >
                  Đi tới Quản lý Tài khoản &amp; Cấp quyền HIS →
                </button>
              )}
            </div>
          </div>

          {/* Right: CSV / JSON Import & Logs */}
          <div className="lg:col-span-7 space-y-4">
            <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                    <FileSpreadsheet className="h-4 w-4 text-sky-700" />
                    <span>Nạp dữ liệu giường từ CSV / JSON xuất từ HIS (Chuẩn BHYT QĐ 130)</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Hỗ trợ cột tiếng Anh hoặc chuẩn XML-130 (`MA_LK`, `HO_TEN`, `MA_THE`, `MA_KHOA`, `MA_GIUONG`, `MA_LOAI_GIUONG`, `TY_LE_GIUONG`, `SO_NGAY_GIUONG`).
                  </p>
                </div>
                {canWriteSyncMap && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        downloadTextFile('mau_dong_bo_giuong_HIS_QD130.csv', SAMPLE_CSV_TEMPLATE);
                        onNotify('Đã tải file mẫu CSV HIS (QĐ 130): mau_dong_bo_giuong_HIS_QD130.csv');
                      }}
                      className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 whitespace-nowrap"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Tải file CSV mẫu</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayloadText(SAMPLE_CSV_TEMPLATE)}
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      Chèn CSV mẫu
                    </button>
                    <label className="inline-flex items-center gap-1 rounded border border-sky-700 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 cursor-pointer whitespace-nowrap">
                      <Upload className="h-3.5 w-3.5" />
                      <span>Tải tệp .csv / .json</span>
                      <input type="file" accept=".csv,.json,.txt" onChange={handleUploadFile} className="hidden" />
                    </label>
                  </div>
                )}
              </div>

              <textarea
                rows={7}
                disabled={!canWriteSyncMap}
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                placeholder="Dán dữ liệu CSV hoặc JSON xuất từ phần mềm HIS tại đây..."
                className="w-full rounded border border-slate-300 p-3 text-xs font-mono focus:border-sky-600 focus:outline-none disabled:bg-slate-100"
              />

              {canWriteSyncMap && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <input
                    type="text"
                    value={payloadSourceLabel}
                    onChange={(e) => setPayloadSourceLabel(e.target.value)}
                    placeholder="Tên nguồn dữ liệu"
                    className="rounded border border-slate-300 px-2.5 py-1.5 text-xs w-56"
                  />
                  <button
                    type="button"
                    disabled={syncing || !payloadText.trim()}
                    onClick={() => handleRunSync('PAYLOAD')}
                    className="rounded-md bg-sky-700 px-4 py-2 text-xs sm:text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-45"
                  >
                    {syncing ? 'Đang xử lý...' : 'Nạp & Đối soát ngay'}
                  </button>
                </div>
              )}
            </div>

            {/* Import History */}
            <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 text-xs font-semibold text-slate-700">
                Lịch sử các phiên đồng bộ HIS gần nhất
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-3.5 py-2 text-left font-medium">Nguồn / Tệp</th>
                      <th className="px-3.5 py-2 text-right font-medium">Số dòng</th>
                      <th className="px-3.5 py-2 text-left font-medium">Người thực hiện</th>
                      <th className="px-3.5 py-2 text-left font-medium">Thời gian</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.importLogs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                          Chưa có lịch sử đồng bộ HIS.
                        </td>
                      </tr>
                    ) : (
                      report.importLogs.map((log) => (
                        <tr key={String(log.id)}>
                          <td className="px-3.5 py-2 font-mono text-slate-800">{String(log.file_name)}</td>
                          <td className="px-3.5 py-2 text-right font-mono tabular-nums">{String(log.imported_rows)}</td>
                          <td className="px-3.5 py-2 text-slate-700">{String(log.performed_by)}</td>
                          <td className="px-3.5 py-2 text-slate-500">{formatDateTimeVN(String(log.created_at))}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Map Modal for Unmapped HIS Bed */}
      {quickMapTargetIssue && report && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={handleQuickMapSubmit}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 space-y-4 shadow-xl"
          >
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Ánh xạ nhanh mã HIS {quickMapTargetIssue.his_bed_code}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Chọn giường vật lý trên BEDCARE để liên kết với mã giường HIS{' '}
                <span className="font-mono font-semibold text-slate-800">{quickMapTargetIssue.his_bed_code}</span>.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Chọn giường vật lý BEDCARE *
              </label>
              <select
                required
                value={quickMapBedId}
                onChange={(e) => setQuickMapBedId(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="">-- Chọn giường BEDCARE --</option>
                {report.mappings.map((m) => (
                  <option key={m.bed_id} value={m.bed_id}>
                    {m.bed_code} · {m.department_name} ({m.room_name}){m.his_bed_code ? ` [Đã gắn: ${m.his_bed_code}]` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setQuickMapTargetIssue(null)}
                className="rounded-md border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                className="rounded-md bg-sky-700 px-4 py-2 text-xs font-medium text-white hover:bg-sky-800"
              >
                Lưu ánh xạ ngay
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

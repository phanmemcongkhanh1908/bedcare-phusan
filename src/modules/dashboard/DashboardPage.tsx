import type { EChartsOption } from 'echarts';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  GripVertical,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { BedStatusBadge } from '../../components/BedStatusBadge';
import { EChartBox } from '../../components/EChartBox';
import type { ScreenId } from '../../components/LayoutShell';
import { apiFetch } from '../../services/api';
import type { Bed, Department, SystemAlert, TransferRequest } from '../../types/bedcare';
import { formatDateVN } from '../../utils/formatters';
import type {
  CapacityForecast7dDay,
  DepartmentThresholdAlert24h,
  VacancyPrediction48hSummary,
  VacancyPredictionSummary,
} from '../../utils/vacancyPredictor';

export interface TriagePatientItem {
  id: string;
  admission_code: string;
  patient_name: string;
  patient_code: string;
  bed_id: string;
  bed_code: string;
  room_id: string;
  room_name: string;
  room_type?: string;
  floor?: string;
  department_id: string;
  department_name: string;
  diagnosis_group: string;
  is_whole_room?: number;
  priority: 'CRITICAL' | 'HIGH' | 'NORMAL';
  expected_discharge_at: string;
  reason_summary: string;
}

export interface DashboardOverviewData {
  summary: {
    totalDepartments: number;
    totalRooms: number;
    totalBeds: number;
    operationalBeds: number;
    vacantBeds: number;
    occupiedBeds: number;
    reservedBeds: number;
    pendingConfirmationBeds: number;
    cleaningBeds: number;
    isolationBeds?: number;
    maintenanceBeds: number;
    inactiveBeds: number;
    activeInpatients: number;
    dueSoonBeds: number;
    overdueBeds: number;
    delayedTransferCount?: number;
    occupancyRate: number;
    occupancyFormula: string;
    demoModeActive: boolean;
  };
  deptStats: Department[];
  criticalCapacityDepartments?: Department[];
  thresholdAlerts24h?: DepartmentThresholdAlert24h[];
  triagePatients?: TriagePatientItem[];
  priorityQueue?: {
    cleaningBeds: Bed[];
    pendingConfirmationBeds: Bed[];
    isolationBeds: Bed[];
    delayedTransfers: TransferRequest[];
  };
  quickDispatchPatients?: TriagePatientItem[];
  quickDispatchBeds?: Bed[];
  alerts: SystemAlert[];
  vacancyPrediction?: VacancyPredictionSummary;
  vacancyPrediction48h?: VacancyPrediction48hSummary;
  capacityForecast7d?: CapacityForecast7dDay[];
}

type QuickBedFilter = 'ALL' | 'VACANT' | 'CLEANING_ALL' | 'PENDING_CONFIRMATION' | 'ISOLATION';

interface DashboardPageProps {
  data: DashboardOverviewData | null;
  loading: boolean;
  onRefresh: () => void;
  onNotify?: (msg: string, type?: 'success' | 'error') => void;
  onNavigate: (id: ScreenId) => void;
  onOpenDepartmentBeds?: (deptId: string, statusFilter?: string) => void;
  onOpenTransferForAdmission?: (admissionId: string) => void;
}

export function DashboardPage({
  data,
  loading,
  onRefresh,
  onNotify,
  onNavigate,
  onOpenDepartmentBeds,
  onOpenTransferForAdmission,
}: DashboardPageProps) {
  const [quickFilter, setQuickFilter] = useState<QuickBedFilter>('ALL');
  const [selectedPatient, setSelectedPatient] = useState<TriagePatientItem | null>(null);
  const [draggingPatientId, setDraggingPatientId] = useState<string | null>(null);
  const [dropTargetBedId, setDropTargetBedId] = useState<string | null>(null);
  const [pendingDispatch, setPendingDispatch] = useState<{
    patient: TriagePatientItem;
    bed: Bed;
  } | null>(null);
  const [dispatchReason, setDispatchReason] = useState('Điều phối nhanh từ Bảng điều phối');
  const [busyActionId, setBusyActionId] = useState<string | null>(null);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-32 rounded-lg border border-slate-200 bg-white animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-lg border border-slate-200 bg-white animate-pulse" />
          ))}
        </div>
        <div className="h-72 rounded-lg border border-slate-200 bg-white animate-pulse" />
      </div>
    );
  }

  if (!data) return null;
  const {
    summary,
    deptStats,
    criticalCapacityDepartments = [],
    thresholdAlerts24h = [],
    triagePatients = [],
    priorityQueue,
    quickDispatchPatients = triagePatients,
    quickDispatchBeds = [],
    alerts,
    vacancyPrediction,
    vacancyPrediction48h,
    capacityForecast7d = [],
  } = data;

  const cleaningBedsQueue = priorityQueue?.cleaningBeds ?? quickDispatchBeds.filter((b) => b.status === 'PENDING_CLEANING' || b.status === 'CLEANING');
  const pendingConfirmQueue = priorityQueue?.pendingConfirmationBeds ?? quickDispatchBeds.filter((b) => b.status === 'PENDING_CONFIRMATION');
  const isolationBedsQueue = priorityQueue?.isolationBeds ?? quickDispatchBeds.filter((b) => b.room_type === 'ISOLATION');
  const delayedTransfersQueue = priorityQueue?.delayedTransfers ?? [];

  const filteredQuickBeds = quickDispatchBeds.filter((b) => {
    if (quickFilter === 'VACANT') return b.status === 'VACANT';
    if (quickFilter === 'CLEANING_ALL') return b.status === 'PENDING_CLEANING' || b.status === 'CLEANING';
    if (quickFilter === 'PENDING_CONFIRMATION') return b.status === 'PENDING_CONFIRMATION';
    if (quickFilter === 'ISOLATION') return b.room_type === 'ISOLATION';
    return true;
  });

  const handleCleaningAction = async (bed: Bed) => {
    if (!bed.cleaning_log_id) {
      onNavigate('cleaning');
      return;
    }
    setBusyActionId(bed.id);
    try {
      const endpoint =
        bed.status === 'PENDING_CLEANING'
          ? `/cleaning/${bed.cleaning_log_id}/start`
          : `/cleaning/${bed.cleaning_log_id}/complete`;
      await apiFetch(endpoint, { method: 'POST', body: JSON.stringify({}) });
      onNotify?.(
        bed.status === 'PENDING_CLEANING'
          ? `Đã bắt đầu vệ sinh giường ${bed.code}.`
          : `Giường ${bed.code} đã hoàn tất vệ sinh và sẵn sàng.`
      );
      onRefresh();
    } catch (e) {
      onNotify?.((e as Error).message, 'error');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleReconcileP2P = async () => {
    setBusyActionId('reconcile');
    try {
      await apiFetch('/cluster/reconcile', { method: 'POST' });
      onNotify?.('Đã đối chiếu đồng thuận P2P và cập nhật trạng thái giường.');
      onRefresh();
    } catch (e) {
      onNotify?.((e as Error).message, 'error');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleCompleteDelayedTransfer = async (tr: TransferRequest) => {
    setBusyActionId(tr.id);
    try {
      await apiFetch(`/transfer-requests/${tr.id}/complete`, { method: 'POST', body: JSON.stringify({}) });
      onNotify?.(`Đã hoàn tất điều chuyển ${tr.patient_name} sang giường ${tr.to_bed_code}.`);
      onRefresh();
    } catch (e) {
      onNotify?.((e as Error).message, 'error');
    } finally {
      setBusyActionId(null);
    }
  };

  const initiateQuickDispatch = (patient: TriagePatientItem, bed: Bed) => {
    if (patient.bed_id === bed.id) {
      onNotify?.('Bệnh nhân đang nằm tại chính giường này.', 'error');
      return;
    }
    if (bed.status !== 'VACANT') {
      onNotify?.(`Giường ${bed.code} hiện chưa ở trạng thái Sẵn sàng (Trống).`, 'error');
      return;
    }
    setPendingDispatch({ patient, bed });
    setDispatchReason('Điều phối nhanh từ Bảng điều phối');
  };

  const handleConfirmQuickDispatch = async (e: FormEvent) => {
    e.preventDefault();
    if (!pendingDispatch) return;
    setBusyActionId(`dispatch-${pendingDispatch.bed.id}`);
    try {
      await apiFetch(`/admissions/${pendingDispatch.patient.id}/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          to_department_id: pendingDispatch.bed.department_id,
          to_room_id: pendingDispatch.bed.room_id,
          to_bed_id: pendingDispatch.bed.id,
          reason: dispatchReason.trim() || 'Điều phối nhanh từ Bảng điều phối',
        }),
      });
      onNotify?.(
        `Đã chuyển ${pendingDispatch.patient.patient_name} từ ${pendingDispatch.patient.bed_code} sang ${pendingDispatch.bed.code}. Giường cũ chuyển sang Chờ vệ sinh.`
      );
      setPendingDispatch(null);
      setSelectedPatient(null);
      onRefresh();
    } catch (err) {
      onNotify?.((err as Error).message, 'error');
    } finally {
      setBusyActionId(null);
    }
  };

  const barOption: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, textStyle: { fontSize: 12, color: '#475569' } },
    grid: { left: 28, right: 16, top: 20, bottom: 54, containLabel: true },
    xAxis: {
      type: 'category',
      data: deptStats.map((d) => d.name),
      axisLabel: { color: '#334155', fontSize: 11, interval: 0, width: 105, overflow: 'break', lineHeight: 15 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#64748b', fontSize: 11 },
    },
    series: [
      { name: 'Đang sử dụng', type: 'bar', stack: 'beds', itemStyle: { color: '#0284c7' }, data: deptStats.map((d) => d.occupied_beds ?? 0) },
      { name: 'Giữ chỗ', type: 'bar', stack: 'beds', itemStyle: { color: '#d97706' }, data: deptStats.map((d) => d.reserved_beds ?? 0) },
      { name: 'Còn trống', type: 'bar', stack: 'beds', itemStyle: { color: '#16a34a' }, data: deptStats.map((d) => d.vacant_beds ?? 0) },
      {
        name: 'Vệ sinh / Bảo trì',
        type: 'bar',
        stack: 'beds',
        itemStyle: { color: '#0d9488' },
        data: deptStats.map((d) => (d.cleaning_beds ?? 0) + (d.maintenance_beds ?? 0)),
      },
    ],
  };

  const donutOption: EChartsOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} giường ({d}%)' },
    legend: { bottom: 0, textStyle: { fontSize: 11, color: '#475569' } },
    title: {
      text: `${summary.occupancyRate}%`,
      subtext: 'Công suất',
      left: 'center',
      top: '36%',
      textStyle: { fontSize: 22, fontWeight: 700, color: '#0f172a', fontFamily: 'JetBrains Mono, monospace' },
      subtextStyle: { fontSize: 11, color: '#64748b' },
    },
    series: [
      {
        type: 'pie',
        radius: ['50%', '72%'],
        center: ['50%', '43%'],
        label: { show: false },
        data: [
          { name: 'Trống', value: summary.vacantBeds, itemStyle: { color: '#16a34a' } },
          { name: 'Đang sử dụng', value: summary.occupiedBeds, itemStyle: { color: '#0284c7' } },
          { name: 'Đang giữ chỗ', value: summary.reservedBeds, itemStyle: { color: '#d97706' } },
          { name: 'Vệ sinh', value: summary.cleaningBeds, itemStyle: { color: '#0d9488' } },
          { name: 'Bảo trì', value: summary.maintenanceBeds, itemStyle: { color: '#dc2626' } },
          { name: 'Chờ xác nhận', value: summary.pendingConfirmationBeds, itemStyle: { color: '#ea580c' } },
        ].filter((d) => d.value > 0),
      },
    ],
  };

  const forecast48hOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, textStyle: { fontSize: 11, color: '#475569' } },
    grid: { left: 28, right: 16, top: 20, bottom: 48, containLabel: true },
    xAxis: {
      type: 'category',
      data: (vacancyPrediction48h?.buckets ?? []).map((b) => b.windowLabel),
      axisLabel: { color: '#334155', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#64748b', fontSize: 11 },
    },
    series: [
      {
        name: 'Giải phóng thêm',
        type: 'bar',
        itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
        data: (vacancyPrediction48h?.buckets ?? []).map((b) => b.expectedReleases),
      },
      {
        name: 'Dự kiến nhập mới',
        type: 'bar',
        itemStyle: { color: '#f59e0b', borderRadius: [4, 4, 0, 0] },
        data: (vacancyPrediction48h?.buckets ?? []).map((b) => b.expectedRegistrations),
      },
      {
        name: 'Trống ròng dự kiến',
        type: 'line',
        smooth: true,
        itemStyle: { color: '#0369a1' },
        lineStyle: { width: 2.5 },
        data: (vacancyPrediction48h?.buckets ?? []).map((b) => b.netProjectedVacant),
      },
    ],
  };

  const forecast7dOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, textStyle: { fontSize: 11, color: '#475569' } },
    grid: { left: 32, right: 24, top: 36, bottom: 48, containLabel: true },
    xAxis: {
      type: 'category',
      data: capacityForecast7d.map((d) => d.dateLabel),
      axisLabel: { color: '#334155', fontSize: 11 },
    },
    yAxis: [
      {
        type: 'value',
        name: '%',
        max: 105,
        axisLabel: { formatter: '{value}%', color: '#64748b', fontSize: 11 },
      },
      {
        type: 'value',
        name: 'Giường',
        axisLabel: { color: '#64748b', fontSize: 11 },
      },
    ],
    series: [
      {
        name: 'Công suất dự báo (%)',
        type: 'line',
        smooth: true,
        itemStyle: { color: '#e11d48' },
        lineStyle: { width: 2.5 },
        data: capacityForecast7d.map((d) => d.projectedOccupancyPct),
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: '#dc2626', type: 'dashed', width: 1.5 },
          label: { formatter: 'Ngưỡng 90%', color: '#dc2626', fontSize: 10 },
          data: [{ yAxis: 90 }],
        },
      },
      {
        name: 'Giường trống dự kiến',
        type: 'bar',
        yAxisIndex: 1,
        barMaxWidth: 26,
        itemStyle: { color: '#0284c7', borderRadius: [4, 4, 0, 0] },
        data: capacityForecast7d.map((d) => d.projectedVacant),
      },
    ],
  };

  const kpiCards = [
    { label: 'Tổng giường / Hoạt động', value: `${summary.totalBeds} / ${summary.operationalBeds}`, sub: `${summary.totalDepartments} khoa · ${summary.totalRooms} phòng`, tone: 'text-slate-900' },
    { label: 'Công suất sử dụng giường', value: `${summary.occupancyRate}%`, sub: `${summary.occupiedBeds} giường đang nằm`, tone: 'text-sky-700' },
    { label: 'Giường trống sẵn sàng', value: `${summary.vacantBeds}`, sub: `${summary.reservedBeds} giữ chỗ · ${summary.cleaningBeds} vệ sinh`, tone: 'text-emerald-700' },
    { label: 'Sắp trả / Quá ngày', value: `${summary.dueSoonBeds} / ${summary.overdueBeds}`, sub: `${summary.activeInpatients} bệnh nhân đang nằm`, tone: summary.overdueBeds > 0 ? 'text-rose-700' : 'text-amber-700' },
  ];

  const quickFilterTabs: Array<{ id: QuickBedFilter; label: string; count: number }> = [
    { id: 'ALL', label: 'Tất cả', count: quickDispatchBeds.length },
    { id: 'VACANT', label: 'Sẵn sàng', count: quickDispatchBeds.filter((b) => b.status === 'VACANT').length },
    { id: 'CLEANING_ALL', label: 'Đang dọn vệ sinh', count: cleaningBedsQueue.length },
    { id: 'PENDING_CONFIRMATION', label: 'Chờ xác nhận nhập', count: pendingConfirmQueue.length },
    { id: 'ISOLATION', label: 'Đang cách ly', count: isolationBedsQueue.length },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-slate-900">Trung tâm Điều phối &amp; Dự báo Giường bệnh</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Công thức: {summary.occupancyFormula}
            {summary.demoModeActive && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => onNavigate('settings')}
                  className="text-amber-700 font-medium hover:underline"
                >
                  Đang dùng dữ liệu demo (Cấu hình)
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Làm mới</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('beds')}
            className="flex items-center gap-1.5 rounded-md bg-sky-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
          >
            <span>Mở sơ đồ giường</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 1. TOP PRIORITY STATUS STRIP (Immediate Coordinator Actions) */}
      <section aria-label="Trạng thái ưu tiên cần xử lý ngay" className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Trạng thái ưu tiên — Thao tác nhanh 1 chạm
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Xử lý trực tiếp giường đang dọn vệ sinh, giường chờ xác nhận P2P và lệnh điều chuyển trễ hạn ngay từ màn hình chính.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums text-slate-600">
            <span>Vệ sinh: <strong className="text-teal-700">{cleaningBedsQueue.length}</strong></span>
            <span>Chờ xác nhận: <strong className="text-orange-700">{pendingConfirmQueue.length}</strong></span>
            <span>Chuyển trễ (&gt;30p): <strong className="text-rose-700">{delayedTransfersQueue.length}</strong></span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Cleaning Queue Direct Actions */}
          <div className="rounded-lg border border-teal-200 bg-teal-50/40 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-teal-900">
                <Sparkles className="h-3.5 w-3.5 text-teal-700" />
                Giường chờ / đang vệ sinh ({cleaningBedsQueue.length})
              </span>
              <button
                type="button"
                onClick={() => onNavigate('cleaning')}
                className="text-xs font-medium text-teal-800 hover:underline whitespace-nowrap"
              >
                Hàng đợi
              </button>
            </div>
            {cleaningBedsQueue.length === 0 ? (
              <div className="text-xs text-slate-500">Không có giường đang chờ vệ sinh.</div>
            ) : (
              <div className="space-y-2">
                {cleaningBedsQueue.slice(0, 3).map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-2 rounded-md border border-teal-200/80 bg-white px-2.5 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 truncate">
                        <span className="font-mono">{b.code}</span> · {b.department_name}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">{b.room_name}</div>
                    </div>
                    <button
                      type="button"
                      disabled={busyActionId === b.id}
                      onClick={() => handleCleaningAction(b)}
                      className="shrink-0 rounded bg-teal-700 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      {busyActionId === b.id
                        ? 'Đang xử lý...'
                        : b.status === 'PENDING_CLEANING'
                          ? 'Bắt đầu dọn'
                          : 'Hoàn tất sạch'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pending P2P Confirmation Direct Actions */}
          <div className="rounded-lg border border-orange-200 bg-orange-50/40 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-orange-900">
                <CheckCircle2 className="h-3.5 w-3.5 text-orange-700" />
                Chờ xác nhận P2P ({pendingConfirmQueue.length})
              </span>
              <button
                type="button"
                onClick={() => onNavigate('sync')}
                className="text-xs font-medium text-orange-800 hover:underline whitespace-nowrap"
              >
                Đồng thuận
              </button>
            </div>
            {pendingConfirmQueue.length === 0 ? (
              <div className="text-xs text-slate-500">Tất cả giao dịch giường đã đạt đồng thuận.</div>
            ) : (
              <div className="space-y-2">
                {pendingConfirmQueue.slice(0, 3).map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-2 rounded-md border border-orange-200/80 bg-white px-2.5 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 truncate">
                        <span className="font-mono">{b.code}</span> · {b.department_name}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {b.patient_name || b.reservation_patient_name || 'Đang chờ xác nhận nút'}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busyActionId === 'reconcile'}
                      onClick={handleReconcileP2P}
                      className="shrink-0 rounded bg-orange-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-orange-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      Đối chiếu ngay
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Delayed Transfer Requests (> 30 min) Direct Actions */}
          <div className="rounded-lg border border-rose-200 bg-rose-50/40 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-rose-900">
                <Clock className="h-3.5 w-3.5 text-rose-700" />
                Chuyển giường trễ &gt; 30 phút ({delayedTransfersQueue.length})
              </span>
              <button
                type="button"
                onClick={() => onNavigate('transfers')}
                className="text-xs font-medium text-rose-800 hover:underline whitespace-nowrap"
              >
                Điều chuyển
              </button>
            </div>
            {delayedTransfersQueue.length === 0 ? (
              <div className="text-xs text-slate-500">Không có lệnh điều chuyển quá 30 phút.</div>
            ) : (
              <div className="space-y-2">
                {delayedTransfersQueue.slice(0, 3).map((tr) => (
                  <div key={tr.id} className="flex items-center justify-between gap-2 rounded-md border border-rose-200 bg-white px-2.5 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 truncate">
                        {tr.patient_name} (<span className="font-mono">{tr.from_bed_code} → {tr.to_bed_code}</span>)
                      </div>
                      <div className="text-[11px] font-mono text-rose-700 font-semibold">
                        Chờ {tr.elapsed_minutes} phút · {tr.reason}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busyActionId === tr.id}
                      onClick={() => handleCompleteDelayedTransfer(tr)}
                      className="shrink-0 rounded bg-rose-700 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-rose-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      Hoàn tất
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 2. KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((k) => (
          <div key={k.label} className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
            <div className="text-xs font-medium text-slate-500">{k.label}</div>
            <div className={`mt-2 text-2xl font-bold font-mono tabular-nums ${k.tone}`}>
              {k.value}
            </div>
            <div className="mt-1.5 text-xs text-slate-500">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* 3. 24-HOUR > 90% THRESHOLD ALERT MODULE */}
      <section aria-label="Cảnh báo ngưỡng công suất trên 90% trong 24 giờ tới" className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-rose-700" />
              <span>Cảnh báo Ngưỡng Công suất 24h (&gt; 90%)</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Tự động tính từ số giường đang nằm + giữ chỗ/đăng ký chờ trong 24h − lượt dự kiến trả để cảnh báo trước tình trạng quá tải khoa.
            </p>
          </div>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded border ${
              thresholdAlerts24h.length > 0 || criticalCapacityDepartments.length > 0
                ? 'border-rose-200 bg-rose-50 text-rose-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
          >
            {thresholdAlerts24h.length > 0
              ? `${thresholdAlerts24h.length} khoa cảnh báo > 90% trong 24h`
              : 'Tất cả khoa dự kiến trong ngưỡng ≤ 90%'}
          </span>
        </div>

        {thresholdAlerts24h.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {thresholdAlerts24h.map((al) => (
              <div
                key={al.departmentId}
                className={`rounded-lg border p-4 space-y-2 ${
                  al.severity === 'CRITICAL'
                    ? 'border-rose-300 bg-rose-50/70'
                    : 'border-amber-300 bg-amber-50/70'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{al.departmentName}</div>
                    <div className="text-xs font-mono tabular-nums text-slate-700 mt-0.5">
                      Hiện tại: <strong>{al.currentOccupancyPct}%</strong> → Dự báo 24h:{' '}
                      <strong className="text-rose-700">{al.projectedOccupancyPct24h}%</strong> ({al.projectedOccupied24h}/{al.operationalBeds} giường)
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => (onOpenDepartmentBeds ? onOpenDepartmentBeds(al.departmentId, '') : onNavigate('beds'))}
                    className="shrink-0 rounded-md bg-rose-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-800 whitespace-nowrap"
                  >
                    Điều phối khoa
                  </button>
                </div>
                <div className="text-xs text-slate-700">{al.reasonSummary}</div>
                <div className="text-xs font-medium text-sky-900">Đề xuất: {al.recommendedAction}</div>
              </div>
            ))}
          </div>
        ) : (
          deptStats.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-100 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
              <span>
                Khoa công suất cao nhất:{' '}
                <strong className="text-slate-900">
                  {[...deptStats].sort((a, b) => Number(b.occupancy_rate ?? 0) - Number(a.occupancy_rate ?? 0))[0]?.name}
                </strong>{' '}
                (
                <span className="font-mono font-semibold text-slate-900">
                  {[...deptStats].sort((a, b) => Number(b.occupancy_rate ?? 0) - Number(a.occupancy_rate ?? 0))[0]?.occupancy_rate}%
                </span>
                )
              </span>
              <button
                type="button"
                onClick={() => {
                  const topDept = [...deptStats].sort(
                    (a, b) => Number(b.occupancy_rate ?? 0) - Number(a.occupancy_rate ?? 0)
                  )[0];
                  if (topDept && onOpenDepartmentBeds) onOpenDepartmentBeds(topDept.id, '');
                  else onNavigate('beds');
                }}
                className="font-medium text-sky-700 hover:underline"
              >
                Xem sơ đồ giường khoa này
              </button>
            </div>
          )
        )}
      </section>

      {/* 4. QUICK DISPATCH PANEL (DRAG-AND-DROP + 1-CLICK QUICK FILTER BAR) */}
      <section aria-label="Bảng điều phối nhanh và Bộ lọc nhanh" className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 border-b border-slate-100 pb-3.5">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Bảng điều phối nhanh (Kéo-thả hoặc Chạm chọn để chuyển giường)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Kéo thẻ bệnh nhân ở cột trái thả vào giường <strong>Sẵn sàng</strong> ở cột phải (hoặc chạm chọn BN trên tablet/điện thoại rồi chạm giường trống).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Bộ lọc nhanh trạng thái giường">
            {quickFilterTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={quickFilter === tab.id}
                onClick={() => setQuickFilter(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium border transition-colors whitespace-nowrap ${
                  quickFilter === tab.id
                    ? 'border-sky-700 bg-sky-700 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {tab.label} <span className="font-mono tabular-nums ml-1">({tab.count})</span>
              </button>
            ))}
          </div>
        </div>

        {selectedPatient && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-300 bg-sky-50 px-3.5 py-2 text-xs text-sky-900">
            <span>
              Đang chọn điều phối: <strong>{selectedPatient.patient_name}</strong> (<span className="font-mono">{selectedPatient.bed_code}</span> · {selectedPatient.department_name}). Chạm vào bất kỳ giường <strong>Sẵn sàng</strong> bên phải để chuyển.
            </span>
            <button
              type="button"
              onClick={() => setSelectedPatient(null)}
              className="font-semibold text-sky-800 hover:underline whitespace-nowrap"
            >
              Bỏ chọn
            </button>
          </div>
        )}

        {pendingDispatch && (
          <form onSubmit={handleConfirmQuickDispatch} className="rounded-lg border-2 border-sky-600 bg-sky-50/70 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-900">
                Xác nhận Điều phối nhanh: {pendingDispatch.patient.patient_name}{' '}
                (<span className="font-mono text-slate-600">{pendingDispatch.patient.bed_code}</span> →{' '}
                <span className="font-mono text-sky-700">{pendingDispatch.bed.code}</span>)
              </div>
              <button
                type="button"
                onClick={() => setPendingDispatch(null)}
                className="text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Hủy
              </button>
            </div>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                required
                value={dispatchReason}
                onChange={(e) => setDispatchReason(e.target.value)}
                placeholder="Lý do điều phối nhanh..."
                aria-label="Lý do điều phối nhanh"
                className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busyActionId === `dispatch-${pendingDispatch.bed.id}`}
                className="rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50 whitespace-nowrap"
              >
                {busyActionId === `dispatch-${pendingDispatch.bed.id}` ? 'Đang chuyển...' : 'Xác nhận chuyển giường'}
              </button>
            </div>
          </form>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Draggable / Selectable Inpatient Cards */}
          <div className="lg:col-span-5 space-y-2">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Bệnh nhân đang nằm ({quickDispatchPatients.length})
            </div>
            <div className="max-h-[360px] overflow-y-auto space-y-2 pr-1">
              {quickDispatchPatients.length === 0 ? (
                <div className="rounded-md border border-slate-100 bg-slate-50 p-4 text-xs text-slate-500">
                  Hiện chưa có bệnh nhân đang nằm giường.
                </div>
              ) : (
                quickDispatchPatients.map((p) => {
                  const isSel = selectedPatient?.id === p.id;
                  return (
                    <div
                      key={p.id}
                      draggable
                      onDragStart={(e) => {
                        setDraggingPatientId(p.id);
                        setSelectedPatient(p);
                        e.dataTransfer.setData('text/plain', p.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => {
                        setDraggingPatientId(null);
                        setDropTargetBedId(null);
                      }}
                      onClick={() => setSelectedPatient(isSel ? null : p)}
                      className={`cursor-grab active:cursor-grabbing rounded-lg border p-3 transition-colors ${
                        isSel
                          ? 'border-sky-600 bg-sky-50/70 ring-1 ring-sky-200'
                          : 'border-slate-200 bg-white hover:border-sky-400'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <GripVertical className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-900 truncate">{p.patient_name}</div>
                            <div className="text-xs text-slate-600 truncate">
                              <span className="font-mono font-semibold text-sky-700">{p.bed_code}</span> · {p.department_name}
                            </div>
                          </div>
                        </div>
                        {onOpenTransferForAdmission && (
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onOpenTransferForAdmission(p.id);
                            }}
                            className="shrink-0 text-[11px] font-medium text-sky-700 hover:underline whitespace-nowrap"
                          >
                            Smart Match
                          </button>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 pl-6">
                        <span>{p.diagnosis_group}</span>
                        <span className="font-mono tabular-nums">Trả DK: {formatDateVN(p.expected_discharge_at)}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Filtered Quick Target Beds */}
          <div className="lg:col-span-7 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                Danh sách giường theo bộ lọc ({filteredQuickBeds.length})
              </span>
              {quickFilter !== 'ALL' && onOpenDepartmentBeds && (
                <button
                  type="button"
                  onClick={() =>
                    onOpenDepartmentBeds(
                      '',
                      quickFilter === 'VACANT'
                        ? 'VACANT'
                        : quickFilter === 'PENDING_CONFIRMATION'
                          ? 'PENDING_CONFIRMATION'
                          : ''
                    )
                  }
                  className="text-xs font-medium text-sky-700 hover:underline"
                >
                  Mở trên Sơ đồ đầy đủ
                </button>
              )}
            </div>

            <div className="max-h-[360px] overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2.5 pr-1">
              {filteredQuickBeds.length === 0 ? (
                <div className="sm:col-span-2 rounded-md border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-500">
                  Không có giường nào thuộc bộ lọc đã chọn.
                </div>
              ) : (
                filteredQuickBeds.map((b) => {
                  const isVacant = b.status === 'VACANT';
                  const isDropHover = dropTargetBedId === b.id;
                  const canCleanAction = (b.status === 'PENDING_CLEANING' || b.status === 'CLEANING') && b.cleaning_log_id;
                  return (
                    <div
                      key={b.id}
                      onDragOver={(e) => {
                        if (isVacant && draggingPatientId) {
                          e.preventDefault();
                          setDropTargetBedId(b.id);
                        }
                      }}
                      onDragLeave={() => {
                        if (dropTargetBedId === b.id) setDropTargetBedId(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDropTargetBedId(null);
                        const droppedId = e.dataTransfer.getData('text/plain') || draggingPatientId;
                        const patient = quickDispatchPatients.find((p) => p.id === droppedId);
                        if (patient) initiateQuickDispatch(patient, b);
                      }}
                      onClick={() => {
                        if (isVacant && selectedPatient) {
                          initiateQuickDispatch(selectedPatient, b);
                        }
                      }}
                      className={`rounded-lg border p-3 transition-all ${
                        isDropHover
                          ? 'border-sky-600 bg-sky-50 ring-2 ring-sky-200'
                          : isVacant && selectedPatient
                            ? 'cursor-pointer border-emerald-400 bg-emerald-50/40 hover:bg-emerald-50'
                            : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-bold text-slate-900">{b.code}</span>
                        <BedStatusBadge status={b.status} compact />
                      </div>
                      <div className="mt-1 text-xs text-slate-600 truncate">
                        {b.department_name} · {b.room_name}
                        {b.room_type === 'ISOLATION' ? ' (Cách ly)' : ''}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-slate-500 truncate">
                          {b.patient_name
                            ? `BN: ${b.patient_name}`
                            : isVacant
                              ? selectedPatient
                                ? 'Chạm / Thả để chuyển vào'
                                : 'Sẵn sàng tiếp nhận'
                              : b.reservation_patient_name
                                ? `Giữ chỗ: ${b.reservation_patient_name}`
                                : b.notes || '—'}
                        </span>
                        {canCleanAction && (
                          <button
                            type="button"
                            disabled={busyActionId === b.id}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              handleCleaningAction(b);
                            }}
                            className="shrink-0 rounded bg-teal-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-teal-800 whitespace-nowrap"
                          >
                            {b.status === 'PENDING_CLEANING' ? 'Bắt đầu dọn' : 'Sạch ngay'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 5. PREDICTIVE ANALYTICS: 48-HOUR VACANCY & 7-DAY CAPACITY FORECAST */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {vacancyPrediction48h && (
          <section aria-label="Dự báo xu hướng giường trống 48 giờ tới" className="xl:col-span-6 rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-sky-700" />
                  <span>Dự báo Giường trống 48 giờ tới</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Dựa trên lịch xuất viện dự kiến, tốc độ nhập/ra lịch sử ({vacancyPrediction48h.historicalAdmissionsPerDay} nhập/ngày · {vacancyPrediction48h.historicalDischargesPerDay} ra/ngày) &amp; vệ sinh.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] text-slate-500">Trống hiện tại</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-emerald-700">
                  {vacancyPrediction48h.currentVacantBeds}
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] text-slate-500">Dự kiến trống 24h</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-sky-700">
                  {vacancyPrediction48h.projectedVacantAt24h}
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] text-slate-500">Dự kiến trống 48h</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-sky-800">
                  {vacancyPrediction48h.projectedVacantAt48h}
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] text-slate-500">Ra / Vào 48h</div>
                <div className="mt-1 text-sm font-bold font-mono tabular-nums text-slate-900">
                  +{vacancyPrediction48h.expectedDischarges48h} / -{vacancyPrediction48h.expectedIncomingRegistrations48h}
                </div>
              </div>
            </div>

            <EChartBox option={forecast48hOption} height={240} />
          </section>
        )}

        {capacityForecast7d.length > 0 && (
          <section aria-label="Dự báo công suất giường bệnh 7 ngày tới" className="xl:col-span-6 rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <span>Dự báo Công suất Giường 7 ngày tới</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Kết hợp danh sách giữ chỗ/đăng ký chờ theo ngày dự kiến và nhịp luân chuyển thực tế toàn viện (đường đỏ = ngưỡng 90%).
                </p>
              </div>
            </div>

            <EChartBox option={forecast7dOption} height={210} />

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-2.5 py-2 text-left font-medium">Ngày</th>
                    <th className="px-2.5 py-2 text-right font-medium">DK Vào</th>
                    <th className="px-2.5 py-2 text-right font-medium">DK Ra</th>
                    <th className="px-2.5 py-2 text-right font-medium">Đang nằm</th>
                    <th className="px-2.5 py-2 text-right font-medium">Trống</th>
                    <th className="px-2.5 py-2 text-right font-medium">Công suất</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {capacityForecast7d.map((d) => (
                    <tr key={d.dateIso} className={d.isOverThreshold90 ? 'bg-rose-50/50' : ''}>
                      <td className="px-2.5 py-1.5 font-mono font-semibold text-slate-900">{d.dateLabel}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-amber-700">+{d.expectedAdmissions}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-emerald-700">-{d.expectedDischarges}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-slate-700">{d.projectedOccupied}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono tabular-nums font-semibold text-sky-700">{d.projectedVacant}</td>
                      <td className={`px-2.5 py-1.5 text-right font-mono tabular-nums font-bold ${d.isOverThreshold90 ? 'text-rose-700' : 'text-slate-900'}`}>
                        {d.projectedOccupancyPct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {/* 6. 4-HOUR LOGISTIC HAZARD SNAPSHOT & CHARTS */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold text-slate-900">Phân bổ trạng thái giường theo khoa</h3>
            <button
              type="button"
              onClick={() => onNavigate('departments')}
              className="text-xs font-medium text-sky-700 hover:underline whitespace-nowrap"
            >
              Chi tiết theo khoa
            </button>
          </div>
          <EChartBox option={barOption} height={280} />
        </div>

        <div className="lg:col-span-4 rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-3">Tỷ trọng trạng thái toàn viện</h3>
          <EChartBox option={donutOption} height={280} />
        </div>
      </div>

      {/* 7. 4h Candidates + Bed Coordination Priority */}
      {vacancyPrediction && (
        <section aria-label="Dự báo khả năng trống giường 4 giờ tới" className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Giường có xác suất giải phóng cao trong 4 giờ tới
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {vacancyPrediction.modelType} · ALOS TB: {vacancyPrediction.avgLengthOfStayDays} ngày · Xác suất có giường trống: {vacancyPrediction.anyVacancyProbabilityPct}% (~{vacancyPrediction.expectedVacanciesNext4h} giường)
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('beds')}
              className="text-xs font-medium text-sky-700 hover:underline whitespace-nowrap"
            >
              Xem sơ đồ giường trống
            </button>
          </div>

          {vacancyPrediction.topCandidates.length === 0 ? (
            <div className="text-sm text-slate-500">Chưa có giường dự kiến giải phóng trong 4 giờ tới.</div>
          ) : (
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {vacancyPrediction.topCandidates.map((c) => (
                <div key={c.bedId} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono font-bold text-slate-900">{c.bedCode}</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-slate-700 truncate">{c.departmentName}</span>
                      {c.patientName && (
                        <>
                          <span className="text-slate-300">·</span>
                          <span className="text-slate-600 truncate">{c.patientName}</span>
                        </>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{c.reasonSummary}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 sm:w-44">
                    <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          c.probabilityPct >= 75 ? 'bg-emerald-600' : c.probabilityPct >= 40 ? 'bg-amber-500' : 'bg-sky-600'
                        }`}
                        style={{ width: `${c.probabilityPct}%` }}
                      />
                    </div>
                    <span className="w-10 text-right font-mono tabular-nums text-xs font-bold text-slate-900">
                      {c.probabilityPct}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 8. Bed Coordination Triage List (NO clinical vitals) + Department Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Công suất từng khoa</h3>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-sky-700 hover:underline"
            >
              Xem báo cáo đầy đủ
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Khoa nội trú</th>
                  <th className="px-4 py-2.5 text-right font-medium">Tổng giường</th>
                  <th className="px-4 py-2.5 text-right font-medium">Đang nằm</th>
                  <th className="px-4 py-2.5 text-right font-medium">Trống</th>
                  <th className="px-4 py-2.5 text-right font-medium">Công suất</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deptStats.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-900">{d.name}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">{d.total_beds}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-sky-700 font-medium">{d.occupied_beds}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-700 font-medium">{d.vacant_beds}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">{d.occupancy_rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Cảnh báo điều phối ưu tiên</h3>
            <button
              type="button"
              onClick={() => onNavigate('alerts')}
              className="text-xs font-medium text-sky-700 hover:underline"
            >
              Xem tất cả ({alerts.length})
            </button>
          </div>
          {alerts.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">Không có cảnh báo nào cần xử lý.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {alerts.slice(0, 6).map((al) => (
                <div key={al.id} className="px-5 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{al.title}</div>
                    <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{al.message}</div>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-semibold whitespace-nowrap ${
                      al.priority === 'CRITICAL'
                        ? 'text-rose-700'
                        : al.priority === 'HIGH'
                          ? 'text-amber-700'
                          : 'text-sky-700'
                    }`}
                  >
                    {al.priority === 'CRITICAL' ? 'Khẩn cấp' : al.priority === 'HIGH' ? 'Cao' : 'Trung bình'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

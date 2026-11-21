import type { EChartsOption } from 'echarts';
import { Download, Lightbulb, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EChartBox } from '../../components/EChartBox';
import { OfficialReportHeader, OfficialReportSignatures } from '../../components/OfficialDocumentParts';
import { PrintPreviewModal, type PrintPreviewColumn } from '../../components/PrintPreviewModal';
import { apiFetch } from '../../services/api';
import type { Department } from '../../types/bedcare';
import type { CustomerTrendAnalytics } from '../../utils/bedCoordinatorIntelligence';
import { exportToExcel, exportToPdf, type ExportColumn } from '../../utils/exportUtils';
import { formatDateTimeVN } from '../../utils/formatters';

interface AnalyticsPayload {
  kpi: {
    totalAdmissions: number;
    totalDischarges: number;
    totalBedDays: number;
    totalExtensions: number;
    totalTransfers: number;
    avgStayDays: number;
    occupancyRate: number;
  };
  deptUsage: Array<{
    department_id: string;
    department_name: string;
    total_beds: number;
    operational_beds: number;
    occupied_beds: number;
    occupancy_rate: number;
    admission_count: number;
    discharge_count: number;
  }>;
  roomUsage: Array<{
    room_id: string;
    room_code: string;
    room_name: string;
    room_type: string;
    capacity: number;
    occupied: number;
    occupancy_rate: number;
  }>;
  overdueList: Array<Record<string, unknown>>;
  dueSoonList: Array<Record<string, unknown>>;
  transfers: Array<Record<string, unknown>>;
  extensions: Array<Record<string, unknown>>;
  customerTrends?: CustomerTrendAnalytics;
}

interface ReportsPageProps {
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

type ReportTab = 'dept' | 'room' | 'trends' | 'overdue' | 'duesoon' | 'transfers';

export function ReportsPage({ onNotify }: ReportsPageProps) {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [deptFilter, setDeptFilter] = useState('');
  const [activeReportTab, setActiveReportTab] = useState<ReportTab>('dept');
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  const load = async () => {
    try {
      const [rep, depts] = await Promise.all([
        apiFetch<AnalyticsPayload>(deptFilter ? `/reports/analytics?departmentId=${deptFilter}` : '/reports/analytics'),
        apiFetch<Department[]>('/departments'),
      ]);
      setData(rep);
      setDepartments(depts);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, [deptFilter]);

  if (!data) return <div className="h-64 rounded-lg border border-slate-200 bg-white animate-pulse" />;

  const scopeLabel = deptFilter
    ? departments.find((d) => d.id === deptFilter)?.name || 'Khoa đã chọn'
    : 'Toàn viện';

  const chartOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 24, bottom: 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: data.deptUsage.map((d) => d.department_name),
      axisLabel: { color: '#334155', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLabel: { formatter: '{value}%', color: '#64748b' },
    },
    series: [
      {
        name: 'Công suất sử dụng (%)',
        type: 'bar',
        barMaxWidth: 44,
        itemStyle: { color: '#0369a1', borderRadius: [4, 4, 0, 0] },
        data: data.deptUsage.map((d) => d.occupancy_rate),
      },
    ],
  };

  const trendsChartOption: EChartsOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { bottom: 0, textStyle: { fontSize: 11, color: '#475569' } },
    grid: { left: 32, right: 16, top: 24, bottom: 48, containLabel: true },
    xAxis: {
      type: 'category',
      data: (data.customerTrends?.standardPreferences ?? []).map((s) => s.standardName),
      axisLabel: { color: '#334155', fontSize: 11, interval: 0, width: 100, overflow: 'break', lineHeight: 14 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: '{value}%', color: '#64748b' },
    },
    series: [
      {
        name: 'Nhu cầu khách hàng (%)',
        type: 'bar',
        itemStyle: { color: '#0284c7', borderRadius: [4, 4, 0, 0] },
        data: (data.customerTrends?.standardPreferences ?? []).map((s) => s.requestSharePct),
      },
      {
        name: 'Tỷ lệ phòng đáp ứng (%)',
        type: 'bar',
        itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
        data: (data.customerTrends?.standardPreferences ?? []).map((s) => s.supplySharePct),
      },
    ],
  };

  const getExportSpec = (): {
    fileBase: string;
    sheetName: string;
    title: string;
    documentCode: string;
    columns: ExportColumn[];
    rows: Array<Record<string, string | number | null | undefined>>;
  } => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (activeReportTab === 'room') {
      return {
        fileBase: 'Bao-cao-cong-suat-phong-BEDCARE',
        sheetName: 'CongSuatPhong',
        title: 'BÁO CÁO CÔNG SUẤT SỬ DỤNG THEO PHÒNG BỆNH',
        documentCode: `BC-PHONG-${stamp}`,
        columns: [
          { header: 'Mã phòng', key: 'room_code', width: 14 },
          { header: 'Tên phòng', key: 'room_name', width: 24 },
          { header: 'Loại phòng', key: 'room_type', width: 15 },
          { header: 'Quy mô giường', key: 'capacity', width: 14 },
          { header: 'Đang nằm', key: 'occupied', width: 14 },
          { header: 'Công suất (%)', key: 'occupancy_rate', width: 15 },
        ],
        rows: data.roomUsage,
      };
    }
    if (activeReportTab === 'trends' && data.customerTrends) {
      return {
        fileBase: 'Bao-cao-xu-huong-khach-hang-BEDCARE',
        sheetName: 'XuHuongKhachHang',
        title: 'BÁO CÁO PHÂN TÍCH XU HƯỚNG ĐĂNG KÝ & LỰA CHỌN KHÁCH HÀNG',
        documentCode: `BC-XUHUONG-${stamp}`,
        columns: [
          { header: 'Tiêu chuẩn phòng', key: 'standardName', width: 26 },
          { header: 'Số lượt chọn', key: 'requestCount', width: 14 },
          { header: 'Tỷ lệ nhu cầu (%)', key: 'requestSharePct', width: 18 },
          { header: 'Số phòng hiện có', key: 'supplyRoomCount', width: 16 },
          { header: 'Tỷ lệ nguồn cung (%)', key: 'supplySharePct', width: 18 },
          { header: 'Chênh lệch cung-cầu (%)', key: 'demandSupplyGapPct', width: 20 },
        ],
        rows: data.customerTrends.standardPreferences.map((s) => ({ ...s })),
      };
    }
    if (activeReportTab === 'transfers') {
      return {
        fileBase: 'Bao-cao-lich-su-dieu-chuyen-BEDCARE',
        sheetName: 'LichSuDieuChuyen',
        title: 'BÁO CÁO TỔNG HỢP LỊCH SỬ ĐIỀU CHUYỂN GIƯỜNG BỆNH',
        documentCode: `BC-CHUYEN-${stamp}`,
        columns: [
          { header: 'Bệnh nhân', key: 'patient_name', width: 24 },
          { header: 'Từ khoa / giường', key: 'from_loc', width: 24 },
          { header: 'Đến khoa / giường', key: 'to_loc', width: 24 },
          { header: 'Lý do', key: 'reason', width: 28 },
          { header: 'Người thực hiện', key: 'performed_by_name', width: 20 },
          { header: 'Thời gian', key: 'performed_at_fmt', width: 18 },
        ],
        rows: data.transfers.map((t) => ({
          patient_name: String(t.patient_name ?? ''),
          from_loc: `${t.from_department_name ?? ''} (${t.from_bed_code ?? ''})`,
          to_loc: `${t.to_department_name ?? ''} (${t.to_bed_code ?? ''})`,
          reason: String(t.reason ?? ''),
          performed_by_name: String(t.performed_by_name ?? ''),
          performed_at_fmt: formatDateTimeVN(String(t.performed_at ?? '')),
        })),
      };
    }
    if (activeReportTab === 'overdue' || activeReportTab === 'duesoon') {
      const list = activeReportTab === 'overdue' ? data.overdueList : data.dueSoonList;
      return {
        fileBase: activeReportTab === 'overdue' ? 'Bao-cao-qua-ngay-tra-giuong' : 'Bao-cao-sap-tra-giuong',
        sheetName: activeReportTab === 'overdue' ? 'QuaNgayTra' : 'SapTraGiuong',
        title:
          activeReportTab === 'overdue'
            ? 'DANH SÁCH BỆNH NHÂN QUÁ NGÀY DỰ KIẾN TRẢ GIƯỜNG'
            : 'DANH SÁCH BỆNH NHÂN SẮP ĐẾN HẠN TRẢ GIƯỜNG',
        documentCode: `BC-HAN-${stamp}`,
        columns: [
          { header: 'Bệnh nhân', key: 'patient_name', width: 24 },
          { header: 'Khoa', key: 'department_name', width: 22 },
          { header: 'Giường', key: 'bed_code', width: 14 },
          { header: 'Dự kiến trả', key: 'expected_fmt', width: 18 },
          { header: 'Đã nằm (ngày)', key: 'days_stayed', width: 14 },
          { header: 'Chênh lệch (ngày)', key: 'days_remaining', width: 16 },
        ],
        rows: list.map((item) => {
          const m = item.stay_metrics as { daysStayed: number; daysRemaining: number };
          return {
            patient_name: String(item.patient_name ?? ''),
            department_name: String(item.department_name ?? ''),
            bed_code: String(item.bed_code ?? ''),
            expected_fmt: formatDateTimeVN(String(item.expected_discharge_at ?? '')),
            days_stayed: m.daysStayed,
            days_remaining: m.daysRemaining,
          };
        }),
      };
    }
    return {
      fileBase: 'Bao-cao-cong-suat-giuong-BEDCARE',
      sheetName: 'CongSuatTheoKhoa',
      title: 'BÁO CÁO CÔNG SUẤT SỬ DỤNG GIƯỜNG BỆNH',
      documentCode: `BC-CS-${stamp}`,
      columns: [
        { header: 'Khoa nội trú', key: 'department_name', width: 26 },
        { header: 'Tổng giường', key: 'total_beds', width: 14 },
        { header: 'Giường hoạt động', key: 'operational_beds', width: 18 },
        { header: 'Đang sử dụng', key: 'occupied_beds', width: 15 },
        { header: 'Công suất (%)', key: 'occupancy_rate', width: 15 },
        { header: 'Lượt tiếp nhận', key: 'admission_count', width: 16 },
        { header: 'Lượt trả giường', key: 'discharge_count', width: 16 },
      ],
      rows: data.deptUsage,
    };
  };

  const handleExportExcel = async () => {
    const spec = getExportSpec();
    await exportToExcel(spec.fileBase, spec.sheetName, spec.columns, spec.rows, {
      title: spec.title,
      scopeLabel: `${scopeLabel} · Công suất toàn viện: ${data.kpi.occupancyRate}%`,
      documentCode: spec.documentCode,
    });
    onNotify(`Đã xuất Excel (.xlsx) chuẩn thể thức văn bản: ${spec.fileBase}.xlsx`);
  };

  const handleExportPdf = async () => {
    setExportingPdf(true);
    try {
      const spec = getExportSpec();
      await exportToPdf(
        spec.fileBase,
        spec.title,
        `${scopeLabel} · Công suất: ${data.kpi.occupancyRate}% · Tổng ngày giường: ${data.kpi.totalBedDays} ngày`,
        spec.columns,
        spec.rows,
        {
          scopeLabel: `${scopeLabel} · Công suất: ${data.kpi.occupancyRate}%`,
          documentCode: spec.documentCode,
        }
      );
      onNotify(`Đã xuất PDF (.pdf) đúng thể thức văn bản hành chính.`);
    } finally {
      setExportingPdf(false);
    }
  };

  const trends = data.customerTrends;

  const getPrintColumnsForTab = (): PrintPreviewColumn[] => {
    const commonHeader: PrintPreviewColumn[] = [
      { key: 'kpi_summary', label: 'Dải chỉ số tổng quan (KPI)' },
    ];
    if (activeReportTab === 'room') {
      return [
        ...commonHeader,
        { key: 'stt', label: 'STT', locked: true },
        { key: 'room_name', label: 'Phòng bệnh', locked: true },
        { key: 'room_type', label: 'Loại phòng' },
        { key: 'capacity', label: 'Quy mô giường' },
        { key: 'occupied', label: 'Đang sử dụng' },
        { key: 'occupancy_rate', label: 'Công suất (%)' },
      ];
    }
    if (activeReportTab === 'trends') {
      return [
        ...commonHeader,
        { key: 'trend_kpis', label: 'Thẻ tỷ lệ đăng ký & chuyển đổi' },
        { key: 'standardName', label: 'Tiêu chuẩn phòng', locked: true },
        { key: 'requestCount', label: 'Lượt chọn' },
        { key: 'requestSharePct', label: 'Tỷ lệ nhu cầu' },
        { key: 'supplyRoomCount', label: 'Số phòng đáp ứng' },
        { key: 'supplySharePct', label: 'Tỷ lệ cung' },
        { key: 'demandSupplyGapPct', label: 'Chênh lệch cung-cầu' },
        { key: 'proposals', label: 'Đề xuất tối ưu xu hướng' },
      ];
    }
    if (activeReportTab === 'overdue' || activeReportTab === 'duesoon') {
      return [
        ...commonHeader,
        { key: 'stt', label: 'STT', locked: true },
        { key: 'patient_name', label: 'Bệnh nhân', locked: true },
        { key: 'bed', label: 'Khoa / Giường' },
        { key: 'expected', label: 'Dự kiến trả' },
        { key: 'days_stayed', label: 'Đã nằm' },
        { key: 'days_remaining', label: 'Chênh lệch' },
      ];
    }
    if (activeReportTab === 'transfers') {
      return [
        ...commonHeader,
        { key: 'stt', label: 'STT', locked: true },
        { key: 'patient_name', label: 'Bệnh nhân', locked: true },
        { key: 'from_bed', label: 'Từ giường' },
        { key: 'to_bed', label: 'Đến giường' },
        { key: 'reason', label: 'Lý do' },
        { key: 'performed_by', label: 'Người thực hiện' },
        { key: 'performed_at', label: 'Thời gian' },
      ];
    }
    return [
      ...commonHeader,
      { key: 'stt', label: 'STT', locked: true },
      { key: 'department_name', label: 'Khoa điều trị', locked: true },
      { key: 'total_beds', label: 'Tổng giường' },
      { key: 'operational_beds', label: 'Hoạt động' },
      { key: 'occupied_beds', label: 'Đang nằm' },
      { key: 'occupancy_rate', label: 'Công suất (%)' },
      { key: 'admission_count', label: 'Tiếp nhận' },
      { key: 'discharge_count', label: 'Trả giường' },
    ];
  };

  return (
    <div className="space-y-6">
      <OfficialReportHeader
        className="print-only"
        title={getExportSpec().title}
        scopeLabel={`${scopeLabel} · Công suất hiện tại: ${data.kpi.occupancyRate}%`}
        documentCode={getExportSpec().documentCode}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Báo cáo, Thống kê &amp; Xu hướng Khách hàng</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Số liệu thời gian thực từ giao dịch thực tế; hỗ trợ xuất Excel, PDF và bản in đúng thể thức văn bản hành chính (Nghị định 30/2020/NĐ-CP).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Lọc theo khoa" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">Toàn viện</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleExportExcel}
            className="flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Xuất Excel</span>
          </button>
          <button
            type="button"
            disabled={exportingPdf}
            onClick={handleExportPdf}
            className="flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100 whitespace-nowrap disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            <span>{exportingPdf ? 'Đang tạo PDF...' : 'Xuất PDF'}</span>
          </button>
          <button
            type="button"
            onClick={() => setPrintPreviewOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>Xem trước &amp; In</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Công suất giường', val: `${data.kpi.occupancyRate}%` },
          { label: 'Lượt tiếp nhận', val: `${data.kpi.totalAdmissions}` },
          { label: 'Lượt trả giường', val: `${data.kpi.totalDischarges}` },
          { label: 'Tổng ngày giường', val: `${data.kpi.totalBedDays}` },
          { label: 'Lượt gia hạn', val: `${data.kpi.totalExtensions}` },
          { label: 'Thời gian TB (ngày)', val: `${data.kpi.avgStayDays}` },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">{k.label}</div>
            <div className="mt-1.5 text-xl font-bold font-mono tabular-nums text-slate-900">{k.val}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 no-print">
        <h3 className="text-base font-semibold text-slate-900 mb-3">Biểu đồ công suất sử dụng giường theo khoa</h3>
        <EChartBox option={chartOption} height={240} />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-1.5 bg-slate-50 no-print">
          {[
            { id: 'dept', label: 'Sử dụng theo khoa' },
            { id: 'room', label: 'Sử dụng theo phòng' },
            { id: 'trends', label: 'Xu hướng đăng ký & Lựa chọn KH' },
            { id: 'overdue', label: `Quá ngày (${data.overdueList.length})` },
            { id: 'duesoon', label: `Sắp trả (${data.dueSoonList.length})` },
            { id: 'transfers', label: `Điều chuyển (${data.transfers.length})` },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveReportTab(t.id as ReportTab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                activeReportTab === t.id ? 'bg-white text-sky-800 shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto">
          {activeReportTab === 'dept' && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left">Khoa</th>
                  <th className="px-4 py-2.5 text-right">Tổng giường</th>
                  <th className="px-4 py-2.5 text-right">Hoạt động</th>
                  <th className="px-4 py-2.5 text-right">Đang nằm</th>
                  <th className="px-4 py-2.5 text-right">Công suất</th>
                  <th className="px-4 py-2.5 text-right">Tiếp nhận</th>
                  <th className="px-4 py-2.5 text-right">Trả giường</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.deptUsage.map((d) => (
                  <tr key={d.department_id}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{d.department_name}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{d.total_beds}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{d.operational_beds}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-sky-700">{d.occupied_beds}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">{d.occupancy_rate}%</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{d.admission_count}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{d.discharge_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {activeReportTab === 'room' && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left">Phòng</th>
                  <th className="px-4 py-2.5 text-left">Loại phòng</th>
                  <th className="px-4 py-2.5 text-right">Quy mô giường</th>
                  <th className="px-4 py-2.5 text-right">Đang sử dụng</th>
                  <th className="px-4 py-2.5 text-right">Công suất</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.roomUsage.map((r) => (
                  <tr key={r.room_id}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{r.room_name} ({r.room_code})</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.room_type}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{r.capacity}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-sky-700">{r.occupied}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">{r.occupancy_rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {activeReportTab === 'trends' && trends && (
            <div className="p-5 space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  <div className="text-xs text-slate-500">Tổng hồ sơ đăng ký trước</div>
                  <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">{trends.totalRegistrations}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  <div className="text-xs text-slate-500">Tỷ lệ chuyển đổi tiếp nhận</div>
                  <div className="mt-1 text-xl font-bold font-mono tabular-nums text-emerald-700">{trends.waitlistConversionPct}%</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  <div className="text-xs text-slate-500">Tỷ lệ chọn bao trọn phòng</div>
                  <div className="mt-1 text-xl font-bold font-mono tabular-nums text-sky-700">{trends.wholeRoomPreferencePct}%</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  <div className="text-xs text-slate-500">ĐK chưa xác định khoa</div>
                  <div className="mt-1 text-xl font-bold font-mono tabular-nums text-amber-700">{trends.unknownDeptRatioPct}%</div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                <div className="lg:col-span-7 rounded-lg border border-slate-200 p-4">
                  <h4 className="text-sm font-semibold text-slate-900 mb-2">
                    So sánh Nhu cầu tiêu chuẩn phòng vs Nguồn cung hiện có
                  </h4>
                  <EChartBox option={trendsChartOption} height={240} />
                </div>
                <div className="lg:col-span-5 space-y-4">
                  <div className="rounded-lg border border-slate-200 p-4 space-y-2">
                    <h4 className="text-sm font-semibold text-slate-900">Phân bổ Hình thức giữ chỗ khách chọn</h4>
                    {trends.reservationTypeChoices.map((c) => (
                      <div key={c.label} className="flex items-center justify-between text-xs py-1 border-b border-slate-100 last:border-0">
                        <span className="text-slate-700">{c.label}</span>
                        <span className="font-mono font-semibold text-slate-900">{c.count} ({c.sharePct}%)</span>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-lg border border-slate-200 p-4 space-y-2">
                    <h4 className="text-sm font-semibold text-slate-900">Nhóm nhu cầu điều trị phổ biến</h4>
                    {trends.diagnosisDemand.slice(0, 5).map((d) => (
                      <div key={d.label} className="flex items-center justify-between text-xs py-1 border-b border-slate-100 last:border-0">
                        <span className="text-slate-700">{d.label}</span>
                        <span className="font-mono font-semibold text-sky-800">{d.count} ca ({d.sharePct}%)</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Actionable Trend Proposals */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-amber-600" />
                  <span>Đề xuất tối ưu từ Xu hướng Đăng ký &amp; Lựa chọn Khách hàng</span>
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {trends.trendProposals.map((prop) => (
                    <div
                      key={prop.id}
                      className={`rounded-lg border p-4 space-y-1.5 ${
                        prop.priority === 'HIGH'
                          ? 'border-amber-300 bg-amber-50/60'
                          : prop.priority === 'MEDIUM'
                            ? 'border-sky-200 bg-sky-50/50'
                            : 'border-emerald-200 bg-emerald-50/40'
                      }`}
                    >
                      <div className="text-sm font-semibold text-slate-900">{prop.title}</div>
                      <div className="text-xs text-slate-700">{prop.evidence}</div>
                      <div className="text-xs font-medium text-sky-900 pt-1">Khuyến nghị: {prop.recommendation}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {(activeReportTab === 'overdue' || activeReportTab === 'duesoon') && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left">Bệnh nhân</th>
                  <th className="px-4 py-2.5 text-left">Khoa / Giường</th>
                  <th className="px-4 py-2.5 text-left">Dự kiến trả</th>
                  <th className="px-4 py-2.5 text-right">Đã nằm</th>
                  <th className="px-4 py-2.5 text-right">Chênh lệch</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(activeReportTab === 'overdue' ? data.overdueList : data.dueSoonList).map((item) => {
                  const m = item.stay_metrics as { daysStayed: number; daysRemaining: number };
                  return (
                    <tr key={String(item.id)}>
                      <td className="px-4 py-2.5 font-medium text-slate-900">{String(item.patient_name)}</td>
                      <td className="px-4 py-2.5 text-slate-700">{String(item.department_name)} · {String(item.bed_code)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{formatDateTimeVN(String(item.expected_discharge_at))}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{m.daysStayed} ngày</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-rose-700">{m.daysRemaining} ngày</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {activeReportTab === 'transfers' && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left">Bệnh nhân</th>
                  <th className="px-4 py-2.5 text-left">Từ giường</th>
                  <th className="px-4 py-2.5 text-left">Đến giường</th>
                  <th className="px-4 py-2.5 text-left">Lý do</th>
                  <th className="px-4 py-2.5 text-left">Người thực hiện</th>
                  <th className="px-4 py-2.5 text-left">Thời gian</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.transfers.map((t) => (
                  <tr key={String(t.id)}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{String(t.patient_name)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{String(t.from_department_name ?? '')} ({String(t.from_bed_code ?? '')})</td>
                    <td className="px-4 py-2.5 text-xs text-sky-800 font-medium">{String(t.to_department_name ?? '')} ({String(t.to_bed_code ?? '')})</td>
                    <td className="px-4 py-2.5 text-slate-700">{String(t.reason)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{String(t.performed_by_name)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{formatDateTimeVN(String(t.performed_at))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <OfficialReportSignatures
        className="print-only"
        signers={['Người lập báo cáo', 'Điều phối viên giường bệnh', 'Giám đốc / Trưởng phòng KHTH']}
      />

      {/* Print Preview Modal for Official Administrative Reports */}
      <PrintPreviewModal
        isOpen={printPreviewOpen}
        onClose={() => setPrintPreviewOpen(false)}
        title={`Xem trước bản in: ${getExportSpec().title}`}
        subtitle={`${scopeLabel} · Thể thức Nghị định 30/2020/NĐ-CP`}
        defaultOrientation={activeReportTab === 'transfers' || activeReportTab === 'dept' || activeReportTab === 'trends' ? 'landscape' : 'portrait'}
        columns={getPrintColumnsForTab()}
        onExportPdf={handleExportPdf}
        exportingPdf={exportingPdf}
      >
        {({ isColumnVisible, visibleColumnCount }) => (
          <div className="space-y-5">
            <OfficialReportHeader
              title={getExportSpec().title}
              scopeLabel={`${scopeLabel} · Công suất hiện tại: ${data.kpi.occupancyRate}%`}
              documentCode={getExportSpec().documentCode}
            />

            {/* Compact Print KPI Strip */}
            {isColumnVisible('kpi_summary') && (
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
                {[
                  { label: 'Công suất', val: `${data.kpi.occupancyRate}%` },
                  { label: 'Tiếp nhận', val: `${data.kpi.totalAdmissions}` },
                  { label: 'Trả giường', val: `${data.kpi.totalDischarges}` },
                  { label: 'Ngày giường', val: `${data.kpi.totalBedDays}` },
                  { label: 'Gia hạn', val: `${data.kpi.totalExtensions}` },
                  { label: 'TB lưu trú', val: `${data.kpi.avgStayDays} ng` },
                ].map((k) => (
                  <div key={k.label} className="rounded border border-slate-300 bg-slate-50/50 px-2.5 py-2">
                    <div className="text-[11px] text-slate-600">{k.label}</div>
                    <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">{k.val}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Printable Table Content for Active Report Tab */}
            {activeReportTab === 'dept' && (
              <div className="overflow-x-auto print:overflow-visible">
                <table className="w-full text-xs border border-slate-400">
                  <thead className="bg-slate-100 text-slate-800 border-b border-slate-400">
                    <tr>
                      {isColumnVisible('stt') && <th className="border border-slate-300 px-3 py-2 text-left">STT</th>}
                      {isColumnVisible('department_name') && <th className="border border-slate-300 px-3 py-2 text-left">Khoa điều trị</th>}
                      {isColumnVisible('total_beds') && <th className="border border-slate-300 px-3 py-2 text-right">Tổng giường</th>}
                      {isColumnVisible('operational_beds') && <th className="border border-slate-300 px-3 py-2 text-right">Hoạt động</th>}
                      {isColumnVisible('occupied_beds') && <th className="border border-slate-300 px-3 py-2 text-right">Đang nằm</th>}
                      {isColumnVisible('occupancy_rate') && <th className="border border-slate-300 px-3 py-2 text-right">Công suất</th>}
                      {isColumnVisible('admission_count') && <th className="border border-slate-300 px-3 py-2 text-right">Tiếp nhận</th>}
                      {isColumnVisible('discharge_count') && <th className="border border-slate-300 px-3 py-2 text-right">Trả giường</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.deptUsage.map((d, idx) => (
                      <tr key={d.department_id}>
                        {isColumnVisible('stt') && <td className="border border-slate-300 px-3 py-1.5 font-mono tabular-nums">{idx + 1}</td>}
                        {isColumnVisible('department_name') && <td className="border border-slate-300 px-3 py-1.5 font-medium">{d.department_name}</td>}
                        {isColumnVisible('total_beds') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{d.total_beds}</td>}
                        {isColumnVisible('operational_beds') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{d.operational_beds}</td>}
                        {isColumnVisible('occupied_beds') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums font-semibold">{d.occupied_beds}</td>}
                        {isColumnVisible('occupancy_rate') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums font-bold">{d.occupancy_rate}%</td>}
                        {isColumnVisible('admission_count') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{d.admission_count}</td>}
                        {isColumnVisible('discharge_count') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{d.discharge_count}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeReportTab === 'room' && (
              <div className="overflow-x-auto print:overflow-visible">
                <table className="w-full text-xs border border-slate-400">
                  <thead className="bg-slate-100 text-slate-800 border-b border-slate-400">
                    <tr>
                      {isColumnVisible('stt') && <th className="border border-slate-300 px-3 py-2 text-left">STT</th>}
                      {isColumnVisible('room_name') && <th className="border border-slate-300 px-3 py-2 text-left">Phòng bệnh</th>}
                      {isColumnVisible('room_type') && <th className="border border-slate-300 px-3 py-2 text-left">Loại phòng</th>}
                      {isColumnVisible('capacity') && <th className="border border-slate-300 px-3 py-2 text-right">Quy mô giường</th>}
                      {isColumnVisible('occupied') && <th className="border border-slate-300 px-3 py-2 text-right">Đang sử dụng</th>}
                      {isColumnVisible('occupancy_rate') && <th className="border border-slate-300 px-3 py-2 text-right">Công suất</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.roomUsage.map((r, idx) => (
                      <tr key={r.room_id}>
                        {isColumnVisible('stt') && <td className="border border-slate-300 px-3 py-1.5 font-mono tabular-nums">{idx + 1}</td>}
                        {isColumnVisible('room_name') && <td className="border border-slate-300 px-3 py-1.5 font-medium">{r.room_name} ({r.room_code})</td>}
                        {isColumnVisible('room_type') && <td className="border border-slate-300 px-3 py-1.5">{r.room_type}</td>}
                        {isColumnVisible('capacity') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{r.capacity}</td>}
                        {isColumnVisible('occupied') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{r.occupied}</td>}
                        {isColumnVisible('occupancy_rate') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums font-bold">{r.occupancy_rate}%</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeReportTab === 'trends' && trends && (
              <div className="space-y-4 text-xs">
                {isColumnVisible('trend_kpis') && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded border border-slate-300 p-2.5">
                      <div className="text-slate-600">Tổng hồ sơ đăng ký trước</div>
                      <div className="text-base font-bold font-mono tabular-nums mt-0.5">{trends.totalRegistrations}</div>
                    </div>
                    <div className="rounded border border-slate-300 p-2.5">
                      <div className="text-slate-600">Tỷ lệ chuyển đổi tiếp nhận</div>
                      <div className="text-base font-bold font-mono tabular-nums mt-0.5">{trends.waitlistConversionPct}%</div>
                    </div>
                    <div className="rounded border border-slate-300 p-2.5">
                      <div className="text-slate-600">Tỷ lệ chọn bao trọn phòng</div>
                      <div className="text-base font-bold font-mono tabular-nums mt-0.5">{trends.wholeRoomPreferencePct}%</div>
                    </div>
                    <div className="rounded border border-slate-300 p-2.5">
                      <div className="text-slate-600">ĐK chưa xác định khoa</div>
                      <div className="text-base font-bold font-mono tabular-nums mt-0.5">{trends.unknownDeptRatioPct}%</div>
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto print:overflow-visible">
                  <table className="w-full text-xs border border-slate-400">
                    <thead className="bg-slate-100 text-slate-800 border-b border-slate-400">
                      <tr>
                        {isColumnVisible('standardName') && <th className="border border-slate-300 px-3 py-2 text-left">Tiêu chuẩn phòng</th>}
                        {isColumnVisible('requestCount') && <th className="border border-slate-300 px-3 py-2 text-right">Lượt chọn</th>}
                        {isColumnVisible('requestSharePct') && <th className="border border-slate-300 px-3 py-2 text-right">Tỷ lệ nhu cầu</th>}
                        {isColumnVisible('supplyRoomCount') && <th className="border border-slate-300 px-3 py-2 text-right">Số phòng đáp ứng</th>}
                        {isColumnVisible('supplySharePct') && <th className="border border-slate-300 px-3 py-2 text-right">Tỷ lệ cung</th>}
                        {isColumnVisible('demandSupplyGapPct') && <th className="border border-slate-300 px-3 py-2 text-right">Chênh lệch cung-cầu</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {trends.standardPreferences.map((s) => (
                        <tr key={s.standardName}>
                          {isColumnVisible('standardName') && <td className="border border-slate-300 px-3 py-1.5 font-medium">{s.standardName}</td>}
                          {isColumnVisible('requestCount') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{s.requestCount}</td>}
                          {isColumnVisible('requestSharePct') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{s.requestSharePct}%</td>}
                          {isColumnVisible('supplyRoomCount') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{s.supplyRoomCount}</td>}
                          {isColumnVisible('supplySharePct') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{s.supplySharePct}%</td>}
                          {isColumnVisible('demandSupplyGapPct') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums font-semibold">{s.demandSupplyGapPct}%</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {isColumnVisible('proposals') && (
                  <div className="space-y-1.5">
                    <div className="font-bold uppercase text-slate-800">Đề xuất tối ưu từ xu hướng khách hàng</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {trends.trendProposals.map((prop) => (
                        <div key={prop.id} className="rounded border border-slate-300 p-2.5 space-y-1">
                          <div className="font-semibold text-slate-900">{prop.title}</div>
                          <div className="text-slate-600">{prop.evidence}</div>
                          <div className="font-medium text-slate-900">Khuyến nghị: {prop.recommendation}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {(activeReportTab === 'overdue' || activeReportTab === 'duesoon') && (
              <div className="overflow-x-auto print:overflow-visible">
                <table className="w-full text-xs border border-slate-400">
                  <thead className="bg-slate-100 text-slate-800 border-b border-slate-400">
                    <tr>
                      {isColumnVisible('stt') && <th className="border border-slate-300 px-3 py-2 text-left">STT</th>}
                      {isColumnVisible('patient_name') && <th className="border border-slate-300 px-3 py-2 text-left">Bệnh nhân</th>}
                      {isColumnVisible('bed') && <th className="border border-slate-300 px-3 py-2 text-left">Khoa / Giường</th>}
                      {isColumnVisible('expected') && <th className="border border-slate-300 px-3 py-2 text-left">Dự kiến trả</th>}
                      {isColumnVisible('days_stayed') && <th className="border border-slate-300 px-3 py-2 text-right">Đã nằm</th>}
                      {isColumnVisible('days_remaining') && <th className="border border-slate-300 px-3 py-2 text-right">Chênh lệch</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(activeReportTab === 'overdue' ? data.overdueList : data.dueSoonList).length === 0 ? (
                      <tr>
                        <td colSpan={Math.max(1, visibleColumnCount)} className="border border-slate-300 px-4 py-6 text-center text-slate-500">
                          Không có bệnh nhân trong danh mục này.
                        </td>
                      </tr>
                    ) : (
                      (activeReportTab === 'overdue' ? data.overdueList : data.dueSoonList).map((item, idx) => {
                        const m = item.stay_metrics as { daysStayed: number; daysRemaining: number };
                        return (
                          <tr key={String(item.id)}>
                            {isColumnVisible('stt') && <td className="border border-slate-300 px-3 py-1.5 font-mono tabular-nums">{idx + 1}</td>}
                            {isColumnVisible('patient_name') && <td className="border border-slate-300 px-3 py-1.5 font-medium">{String(item.patient_name)}</td>}
                            {isColumnVisible('bed') && <td className="border border-slate-300 px-3 py-1.5">{String(item.department_name)} · {String(item.bed_code)}</td>}
                            {isColumnVisible('expected') && <td className="border border-slate-300 px-3 py-1.5 font-mono">{formatDateTimeVN(String(item.expected_discharge_at))}</td>}
                            {isColumnVisible('days_stayed') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums">{m.daysStayed} ngày</td>}
                            {isColumnVisible('days_remaining') && <td className="border border-slate-300 px-3 py-1.5 text-right font-mono tabular-nums font-bold">{m.daysRemaining} ngày</td>}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeReportTab === 'transfers' && (
              <div className="overflow-x-auto print:overflow-visible">
                <table className="w-full text-xs border border-slate-400">
                  <thead className="bg-slate-100 text-slate-800 border-b border-slate-400">
                    <tr>
                      {isColumnVisible('stt') && <th className="border border-slate-300 px-3 py-2 text-left">STT</th>}
                      {isColumnVisible('patient_name') && <th className="border border-slate-300 px-3 py-2 text-left">Bệnh nhân</th>}
                      {isColumnVisible('from_bed') && <th className="border border-slate-300 px-3 py-2 text-left">Từ giường</th>}
                      {isColumnVisible('to_bed') && <th className="border border-slate-300 px-3 py-2 text-left">Đến giường</th>}
                      {isColumnVisible('reason') && <th className="border border-slate-300 px-3 py-2 text-left">Lý do</th>}
                      {isColumnVisible('performed_by') && <th className="border border-slate-300 px-3 py-2 text-left">Người thực hiện</th>}
                      {isColumnVisible('performed_at') && <th className="border border-slate-300 px-3 py-2 text-left">Thời gian</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.transfers.length === 0 ? (
                      <tr>
                        <td colSpan={Math.max(1, visibleColumnCount)} className="border border-slate-300 px-4 py-6 text-center text-slate-500">
                          Chưa có dữ liệu điều chuyển giường.
                        </td>
                      </tr>
                    ) : (
                      data.transfers.map((t, idx) => (
                        <tr key={String(t.id)}>
                          {isColumnVisible('stt') && <td className="border border-slate-300 px-3 py-1.5 font-mono tabular-nums">{idx + 1}</td>}
                          {isColumnVisible('patient_name') && <td className="border border-slate-300 px-3 py-1.5 font-medium">{String(t.patient_name)}</td>}
                          {isColumnVisible('from_bed') && <td className="border border-slate-300 px-3 py-1.5">{String(t.from_department_name ?? '')} ({String(t.from_bed_code ?? '')})</td>}
                          {isColumnVisible('to_bed') && <td className="border border-slate-300 px-3 py-1.5 font-medium">{String(t.to_department_name ?? '')} ({String(t.to_bed_code ?? '')})</td>}
                          {isColumnVisible('reason') && <td className="border border-slate-300 px-3 py-1.5">{String(t.reason)}</td>}
                          {isColumnVisible('performed_by') && <td className="border border-slate-300 px-3 py-1.5">{String(t.performed_by_name)}</td>}
                          {isColumnVisible('performed_at') && <td className="border border-slate-300 px-3 py-1.5 font-mono">{formatDateTimeVN(String(t.performed_at))}</td>}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <OfficialReportSignatures
              signers={['Người lập báo cáo', 'Điều phối viên giường bệnh', 'Giám đốc / Trưởng phòng KHTH']}
            />
          </div>
        )}
      </PrintPreviewModal>
    </div>
  );
}

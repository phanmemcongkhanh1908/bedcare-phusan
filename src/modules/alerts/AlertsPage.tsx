import { useState } from 'react';
import type { ScreenId } from '../../components/LayoutShell';
import type { Department, SystemAlert } from '../../types/bedcare';
import { formatDateTimeVN } from '../../utils/formatters';

interface AlertsPageProps {
  alerts: SystemAlert[];
  departments: Department[];
  onNavigate: (id: ScreenId) => void;
}

const ALERT_TYPE_LABELS: Record<SystemAlert['type'], string> = {
  BED_DUE_SOON: 'Giường sắp trả',
  BED_DUE_TODAY: 'Giường đến hạn trả',
  BED_OVERDUE: 'Giường quá ngày',
  RESERVATION_EXPIRING: 'Giữ chỗ sắp hết hạn',
  UNALLOCATED_REGISTRATION: 'Đăng ký chưa phân bổ',
  BED_PENDING_CLEANING: 'Giường chờ vệ sinh',
  BED_MAINTENANCE: 'Giường bảo trì',
  SYNC_PENDING: 'Đồng bộ chưa hoàn tất',
  DATA_CONFLICT: 'Xung đột dữ liệu',
  DEVICE_OFFLINE: 'Thiết bị mất kết nối',
  BACKUP_FAILED: 'Bản sao lưu lỗi',
  PENDING_CONFIRMATION: 'Yêu cầu chờ xác nhận',
};

export function AlertsPage({ alerts, departments, onNavigate }: AlertsPageProps) {
  const [deptFilter, setDeptFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<SystemAlert['priority'] | ''>('');

  const filtered = alerts.filter((a) => {
    if (deptFilter && a.department_id !== deptFilter) return false;
    if (priorityFilter && a.priority !== priorityFilter) return false;
    return true;
  });

  const routeForAlert = (type: SystemAlert['type']): ScreenId => {
    switch (type) {
      case 'BED_DUE_SOON':
      case 'BED_DUE_TODAY':
      case 'BED_OVERDUE':
        return 'inpatients';
      case 'RESERVATION_EXPIRING':
        return 'reservations';
      case 'UNALLOCATED_REGISTRATION':
        return 'waitlist';
      case 'BED_PENDING_CLEANING':
        return 'cleaning';
      case 'BED_MAINTENANCE':
        return 'beds';
      case 'BACKUP_FAILED':
        return 'backup';
      case 'DEVICE_OFFLINE':
        return 'devices';
      default:
        return 'sync';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Trung tâm Cảnh báo tự động</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Theo dõi 12 nhóm cảnh báo nghiệp vụ giường bệnh, vệ sinh, đồng bộ P2P và sao lưu theo thời gian thực.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Lọc theo khoa" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">Tất cả khoa &amp; hệ thống</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as typeof priorityFilter)} aria-label="Lọc mức độ ưu tiên" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">Tất cả mức độ</option>
            <option value="CRITICAL">Khẩn cấp (Critical)</option>
            <option value="HIGH">Cao (High)</option>
            <option value="MEDIUM">Trung bình (Medium)</option>
            <option value="LOW">Thấp (Low)</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Không có cảnh báo nào khớp bộ lọc hiện tại.
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
          {filtered.map((al) => (
            <div key={al.id} className="p-4 flex flex-wrap items-center justify-between gap-4 hover:bg-slate-50">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={`font-semibold ${
                      al.priority === 'CRITICAL'
                        ? 'text-rose-700'
                        : al.priority === 'HIGH'
                        ? 'text-amber-700'
                        : al.priority === 'MEDIUM'
                        ? 'text-sky-700'
                        : 'text-slate-600'
                    }`}
                  >
                    {al.priority === 'CRITICAL' ? 'Khẩn cấp' : al.priority === 'HIGH' ? 'Ưu tiên cao' : al.priority === 'MEDIUM' ? 'Trung bình' : 'Thông tin'}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-600">{ALERT_TYPE_LABELS[al.type]}</span>
                  {al.department_name && (
                    <>
                      <span className="text-slate-300">·</span>
                      <span className="text-slate-600">{al.department_name}</span>
                    </>
                  )}
                  <span className="text-slate-300">·</span>
                  <span className="font-mono text-slate-400">{formatDateTimeVN(al.created_at)}</span>
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-900">{al.title}</div>
                <div className="mt-0.5 text-sm text-slate-600">{al.message}</div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate(routeForAlert(al.type))}
                className="rounded-md border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50 whitespace-nowrap"
              >
                Xử lý ngay
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

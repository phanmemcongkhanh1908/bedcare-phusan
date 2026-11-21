import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import type { ScreenId } from '../../components/LayoutShell';
import { apiFetch } from '../../services/api';
import type { Registration, RoomStandard } from '../../types/bedcare';
import { formatDateTimeVN, formatDateVN } from '../../utils/formatters';

interface WaitlistPageProps {
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onNavigate: (id: ScreenId) => void;
  onOpenAdmission?: (regId: string) => void;
}

export function WaitlistPage({ onNotify, onNavigate, onOpenAdmission }: WaitlistPageProps) {
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [standards, setStandards] = useState<RoomStandard[]>([]);
  const [pendingReqs, setPendingReqs] = useState<Array<Record<string, unknown>>>([]);
  const [search, setSearch] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState<'ALL' | 'OVERDUE' | 'TODAY'>('ALL');
  const [cancelTarget, setCancelTarget] = useState<Registration | null>(null);

  const load = async () => {
    try {
      const [regs, stds, cluster] = await Promise.all([
        apiFetch<Registration[]>('/registrations'),
        apiFetch<RoomStandard[]>('/room-standards'),
        apiFetch<{ pendingRequests: Array<Record<string, unknown>> }>('/cluster/status'),
      ]);
      setRegistrations(regs.filter((r) => r.status === 'WAITING' || r.status === 'PENDING_CONFIRMATION'));
      setStandards(stds);
      setPendingReqs(cluster.pendingRequests.filter((p) => p.status === 'WAITING_QUORUM'));
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const stdMap = Object.fromEntries(standards.map((s) => [s.id, s.name]));

  const getUrgency = (expectedIso: string): { key: 'OVERDUE' | 'TODAY' | 'UPCOMING'; label: string; cls: string } => {
    const today = new Date().toISOString().slice(0, 10);
    const expDay = expectedIso.slice(0, 10);
    if (expDay < today) return { key: 'OVERDUE', label: 'Quá ngày ĐK', cls: 'bg-rose-50 text-rose-700 border border-rose-200' };
    if (expDay === today) return { key: 'TODAY', label: 'Hôm nay', cls: 'bg-amber-50 text-amber-800 border border-amber-200' };
    return { key: 'UPCOMING', label: 'Sắp tới', cls: 'bg-slate-100 text-slate-700 border border-slate-200' };
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    try {
      await apiFetch(`/registrations/${cancelTarget.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Hủy từ danh sách chờ phân bổ' }),
      });
      onNotify(`Đã hủy phiếu chờ ${cancelTarget.registration_code}.`);
      setCancelTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
      setCancelTarget(null);
    }
  };

  const filtered = registrations.filter((r) => {
    const urg = getUrgency(r.expected_admission_date);
    if (urgencyFilter === 'OVERDUE' && urg.key !== 'OVERDUE') return false;
    if (urgencyFilter === 'TODAY' && urg.key !== 'TODAY') return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const hay = `${r.registration_code} ${r.patient_name} ${r.patient_code} ${r.diagnosis_group}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Danh sách Chờ phân bổ &amp; Chờ xác nhận</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Theo dõi bệnh nhân đăng ký chưa xác định giường và phân bổ thẳng sang Tiếp nhận chỉ với 1 chạm.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('admissions')}
          className="min-h-[44px] rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
        >
          Chuyển sang Tiếp nhận vào khoa
        </button>
      </div>

      {pendingReqs.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-5 space-y-2">
          <div className="text-sm font-semibold text-orange-900">
            Có {pendingReqs.length} yêu cầu cấp/giữ giường đang chờ đồng thuận quorum
          </div>
          <div className="text-xs text-orange-800">
            Các yêu cầu này được ghi nhận khi mạng bị phân vùng hoặc không đủ nút xác nhận. Mở mục Đồng bộ &amp; Đồng thuận để đối chiếu khi mạng khôi phục.
          </div>
        </div>
      )}

      {/* Search & Urgency filter */}
      <div className="rounded-lg border border-slate-200 bg-white p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm mã ĐK, họ tên, mã BN, chẩn đoán..."
            className="w-full min-h-[44px] rounded-md border border-slate-300 pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            { id: 'ALL', label: `Tất cả (${registrations.length})` },
            { id: 'OVERDUE', label: 'Quá ngày ĐK' },
            { id: 'TODAY', label: 'Nhập hôm nay' },
          ].map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setUrgencyFilter(u.id as typeof urgencyFilter)}
              className={`min-h-[38px] rounded-md border px-3 py-1.5 text-xs font-medium ${
                urgencyFilter === u.id
                  ? 'border-sky-600 bg-sky-50 text-sky-800'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {u.label}
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
                <th className="px-4 py-3 text-left font-medium">Mã đăng ký</th>
                <th className="px-4 py-3 text-left font-medium">Bệnh nhân</th>
                <th className="px-4 py-3 text-left font-medium">Chẩn đoán</th>
                <th className="px-4 py-3 text-left font-medium">Tiêu chuẩn mong muốn</th>
                <th className="px-4 py-3 text-left font-medium">Dự kiến nhập</th>
                <th className="px-4 py-3 text-left font-medium">Đăng ký lúc</th>
                <th className="px-4 py-3 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Không có hồ sơ nào trong danh sách chờ.</td></tr>
              ) : filtered.map((r) => {
                const urg = getUrgency(r.expected_admission_date);
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs font-semibold text-slate-900">{r.registration_code}</div>
                      <span className={`inline-block mt-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${urg.cls}`}>
                        {urg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{r.patient_name}</div>
                      <div className="text-xs text-slate-500">{r.patient_code} · {r.phone || 'Chưa có SĐT'}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{r.diagnosis_group}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {(r.desired_standard_ids || []).map((id) => stdMap[id] || id).join(' · ') || 'Không yêu cầu cụ thể'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{formatDateVN(r.expected_admission_date)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{formatDateTimeVN(r.created_at)}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap space-x-2.5">
                      <button
                        type="button"
                        onClick={() => (onOpenAdmission ? onOpenAdmission(r.id) : onNavigate('admissions'))}
                        className="text-xs font-semibold text-sky-700 hover:underline"
                      >
                        Tiếp nhận ngay
                      </button>
                      <button
                        type="button"
                        onClick={() => setCancelTarget(r)}
                        className="text-xs font-medium text-rose-600 hover:underline"
                      >
                        Hủy ĐK
                      </button>
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
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            Không có hồ sơ nào trong danh sách chờ.
          </div>
        ) : filtered.map((r) => {
          const urg = getUrgency(r.expected_admission_date);
          return (
            <div key={r.id} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-sm text-slate-900">{r.patient_name}</div>
                  <div className="font-mono text-xs text-slate-500 mt-0.5">
                    {r.registration_code} · {r.patient_code}
                  </div>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs font-semibold shrink-0 ${urg.cls}`}>{urg.label}</span>
              </div>
              <div className="text-xs text-slate-600 space-y-1">
                <div>Chẩn đoán: <strong className="text-slate-800">{r.diagnosis_group}</strong></div>
                <div>
                  Tiêu chuẩn: {(r.desired_standard_ids || []).map((id) => stdMap[id] || id).join(' · ') || 'Không yêu cầu cụ thể'}
                </div>
                <div className="font-mono text-slate-500">Dự kiến nhập: {formatDateVN(r.expected_admission_date)}</div>
              </div>
              <div className="flex gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => (onOpenAdmission ? onOpenAdmission(r.id) : onNavigate('admissions'))}
                  className="flex-1 min-h-[44px] rounded-md bg-sky-700 px-3 py-2 text-xs font-semibold text-white active:scale-[0.98]"
                >
                  Tiếp nhận ngay
                </button>
                <button
                  type="button"
                  onClick={() => setCancelTarget(r)}
                  className="min-h-[44px] rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 active:scale-[0.98]"
                >
                  Hủy ĐK
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmModal
        open={Boolean(cancelTarget)}
        title="Hủy hồ sơ chờ phân bổ"
        description={`Xác nhận hủy phiếu đăng ký ${cancelTarget?.registration_code} của bệnh nhân ${cancelTarget?.patient_name}?`}
        danger
        confirmLabel="Xác nhận hủy"
        onConfirm={handleCancel}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}

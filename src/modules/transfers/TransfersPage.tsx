import { AlertTriangle, CheckCircle2, Clock, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../services/api';
import type { Admission, Bed, Department, Room, TransferRequest } from '../../types/bedcare';
import type { SmartBedRecommendation } from '../../utils/bedCoordinatorIntelligence';
import { formatDateTimeVN } from '../../utils/formatters';

interface TransfersPageProps {
  initialAdmissionId?: string;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function TransfersPage({ initialAdmissionId, onNotify }: TransfersPageProps) {
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [transfers, setTransfers] = useState<Array<Record<string, unknown>>>([]);
  const [transferRequests, setTransferRequests] = useState<TransferRequest[]>([]);
  const [smartTop3, setSmartTop3] = useState<SmartBedRecommendation[]>([]);
  const [loadingSmartMatch, setLoadingSmartMatch] = useState(false);

  const [admId, setAdmId] = useState('');
  const [actionMode, setActionMode] = useState<'IMMEDIATE' | 'REQUEST'>('IMMEDIATE');
  const [toDeptId, setToDeptId] = useState('');
  const [toRoomId, setToRoomId] = useState('');
  const [toBedId, setToBedId] = useState('');
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const [adms, depts, rms, bds, trfs, trReqs] = await Promise.all([
        apiFetch<Admission[]>('/admissions?status=ACTIVE'),
        apiFetch<Department[]>('/departments'),
        apiFetch<Room[]>('/rooms'),
        apiFetch<Bed[]>('/beds'),
        apiFetch<Array<Record<string, unknown>>>('/transfers'),
        apiFetch<TransferRequest[]>('/transfer-requests'),
      ]);
      setAdmissions(adms);
      setDepartments(depts);
      setRooms(rms);
      setBeds(bds);
      setTransfers(trfs);
      setTransferRequests(trReqs);
      if (initialAdmissionId && adms.some((a) => a.id === initialAdmissionId)) {
        setAdmId(initialAdmissionId);
      } else if (!admId && adms.length > 0) {
        setAdmId(adms[0].id);
      }
      if (!toDeptId && depts.length > 0) setToDeptId(depts[0].id);
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
    if (initialAdmissionId && admissions.some((a) => a.id === initialAdmissionId)) {
      setAdmId(initialAdmissionId);
    }
  }, [initialAdmissionId, admissions]);

  useEffect(() => {
    if (!admId) {
      setSmartTop3([]);
      return;
    }
    let cancelled = false;
    setLoadingSmartMatch(true);
    apiFetch<{ top3: SmartBedRecommendation[] }>(`/admissions/${admId}/smart-match`)
      .then((res) => {
        if (!cancelled) setSmartTop3(res.top3 ?? []);
      })
      .catch(() => {
        if (!cancelled) setSmartTop3([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSmartMatch(false);
      });
    return () => {
      cancelled = true;
    };
  }, [admId, beds.length]);

  const targetRooms = rooms.filter((r) => r.department_id === toDeptId && r.status === 'ACTIVE' && !r.exclusive_locked);
  const targetBeds = beds.filter((b) => {
    if (b.room_id !== toRoomId) return false;
    if (actionMode === 'REQUEST') {
      return b.status === 'VACANT' || b.status === 'CLEANING' || b.status === 'PENDING_CLEANING';
    }
    return b.status === 'VACANT';
  });

  const delayedRequests = transferRequests.filter((tr) => tr.is_delayed);
  const pendingRequests = transferRequests.filter((tr) => tr.status === 'PENDING');

  const applySmartBed = (rec: SmartBedRecommendation) => {
    setToDeptId(rec.departmentId);
    setToRoomId(rec.roomId);
    setToBedId(rec.bedId);
    if (rec.bedStatus !== 'VACANT') {
      setActionMode('REQUEST');
      onNotify(
        `Đã chọn giường ${rec.bedCode} (${rec.sanitizationLabel}). Chế độ được đặt sang "Tạo lệnh chờ" để theo dõi hoàn tất vệ sinh.`
      );
    } else {
      onNotify(`Đã áp dụng đề xuất Smart Match: ${rec.bedCode} (${rec.departmentName} · ${rec.distanceLabel}).`);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (actionMode === 'REQUEST') {
        const res = await apiFetch<{ queuedOffline?: boolean }>('/transfer-requests', {
          method: 'POST',
          body: JSON.stringify({
            admission_id: admId,
            to_department_id: toDeptId,
            to_room_id: toRoomId,
            to_bed_id: toBedId,
            reason,
          }),
        });
        onNotify(
          res?.queuedOffline
            ? 'Đang mất mạng: đã lưu lệnh chờ điều chuyển vào Pending Actions.'
            : 'Đã tạo lệnh chờ điều chuyển giường (hệ thống sẽ cảnh báo nếu quá 30 phút chưa hoàn tất).'
        );
      } else {
        const res = await apiFetch<{ queuedOffline?: boolean }>(`/admissions/${admId}/transfer`, {
          method: 'POST',
          body: JSON.stringify({
            to_department_id: toDeptId,
            to_room_id: toRoomId,
            to_bed_id: toBedId,
            reason,
          }),
        });
        onNotify(
          res?.queuedOffline
            ? 'Đang mất mạng: đã lưu lệnh điều chuyển giường vào Pending Actions.'
            : 'Đã điều chuyển giường thành công. Giường cũ đã chuyển sang Chờ vệ sinh.'
        );
      }
      setReason('');
      setToBedId('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleCompleteRequest = async (tr: TransferRequest) => {
    setBusyId(tr.id);
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/transfer-requests/${tr.id}/complete`, { method: 'POST', body: JSON.stringify({}) });
      onNotify(
        res?.queuedOffline
          ? `Đang mất mạng: đã lưu xác nhận hoàn tất chuyển ${tr.patient_name} vào Pending Actions.`
          : `Đã hoàn tất điều chuyển ${tr.patient_name} sang giường ${tr.to_bed_code}.`
      );
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleCancelRequest = async (tr: TransferRequest) => {
    setBusyId(tr.id);
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/transfer-requests/${tr.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Hủy lệnh điều chuyển từ màn hình Điều chuyển' }),
      });
      onNotify(
        res?.queuedOffline
          ? `Đang mất mạng: đã lưu lệnh hủy điều chuyển vào Pending Actions.`
          : `Đã hủy lệnh điều chuyển của ${tr.patient_name}.`
      );
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Điều chuyển giường bệnh &amp; Smart Match</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Gợi ý Top 3 giường tối ưu theo chuyên khoa, tình trạng vệ sinh và khoảng cách di chuyển; giám sát trễ chuyển vị trí quá 30 phút.
        </p>
      </div>

      {/* Delay Alert Banner (> 30 min) */}
      {delayedRequests.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border-2 border-rose-300 bg-rose-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-rose-700 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-bold text-rose-950">
                Cảnh báo Chuyển giường trễ (&gt; 30 phút): {delayedRequests.length} yêu cầu chưa hoàn tất!
              </div>
              <div className="text-xs text-rose-800 mt-0.5">
                {delayedRequests
                  .map((r) => `${r.patient_name} (${r.from_bed_code} → ${r.to_bed_code}, đã chờ ${r.elapsed_minutes} phút)`)
                  .join(' · ')}
              </div>
            </div>
          </div>
          <span className="font-mono text-xs font-bold text-rose-700 whitespace-nowrap">
            Cần xử lý ưu tiên
          </span>
        </div>
      )}

      {/* Transfer Form + Smart Match */}
      <form onSubmit={handleSubmit} className="rounded-lg border border-slate-200 bg-white p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <h3 className="text-base font-semibold text-slate-900">Điều phối chuyển giường</h3>
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setActionMode('IMMEDIATE')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                actionMode === 'IMMEDIATE' ? 'bg-white text-sky-800 shadow-sm' : 'text-slate-600'
              }`}
            >
              Điều chuyển ngay
            </button>
            <button
              type="button"
              onClick={() => setActionMode('REQUEST')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                actionMode === 'REQUEST' ? 'bg-white text-sky-800 shadow-sm' : 'text-slate-600'
              }`}
            >
              Tạo lệnh chờ (theo dõi SLA 30p)
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Bệnh nhân hiện tại *</label>
            <select value={admId} onChange={(e) => setAdmId(e.target.value)} required className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              {admissions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.patient_name} ({a.bed_code} · {a.department_name})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Khoa đích *</label>
            <select value={toDeptId} onChange={(e) => { setToDeptId(e.target.value); setToRoomId(''); setToBedId(''); }} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Phòng đích *</label>
            <select required value={toRoomId} onChange={(e) => { setToRoomId(e.target.value); setToBedId(''); }} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">-- Chọn phòng --</option>
              {targetRooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Giường đích *</label>
            <select required value={toBedId} onChange={(e) => setToBedId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">-- Chọn giường --</option>
              {targetBeds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} {b.status !== 'VACANT' ? `(${b.status === 'CLEANING' ? 'Đang vệ sinh' : 'Chờ vệ sinh'})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Smart Match Top-3 Recommendation Panel */}
        <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-sky-900">
              <Sparkles className="h-4 w-4 text-sky-700" />
              <span>Smart Match — Top 3 giường đề xuất tối ưu nhất</span>
            </div>
            <span className="text-[11px] text-slate-500">
              Chấm điểm tự động theo: Chuyên khoa &amp; Chuẩn phòng · Vệ sinh khử khuẩn · Khoảng cách di chuyển
            </span>
          </div>

          {loadingSmartMatch ? (
            <div className="text-xs text-slate-500 py-2">Đang tính toán gợi ý Smart Match...</div>
          ) : smartTop3.length === 0 ? (
            <div className="text-xs text-slate-500 py-2">Hiện không có giường trống/vệ sinh phù hợp để gợi ý.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {smartTop3.map((rec, idx) => {
                const isSelected = toBedId === rec.bedId;
                const cleanCls =
                  rec.sanitizationStatus === 'READY_SANITIZED'
                    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                    : rec.sanitizationStatus === 'SANITIZING'
                      ? 'text-teal-700 bg-teal-50 border-teal-200'
                      : 'text-amber-700 bg-amber-50 border-amber-200';
                return (
                  <div
                    key={rec.bedId}
                    className={`rounded-lg border bg-white p-3.5 flex flex-col justify-between gap-3 ${
                      isSelected ? 'border-sky-600 ring-1 ring-sky-200' : 'border-slate-200'
                    }`}
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-sky-800">
                          #{idx + 1} · <span className="font-mono text-sm text-slate-900">{rec.bedCode}</span>
                        </span>
                        <span className="font-mono text-xs font-bold text-sky-700 tabular-nums">
                          {rec.matchScore}% phù hợp
                        </span>
                      </div>
                      <div className="text-xs font-medium text-slate-800 truncate">
                        {rec.departmentName} · {rec.roomName}
                      </div>
                      <div className={`inline-block rounded border px-2 py-0.5 text-[11px] font-medium ${cleanCls}`}>
                        {rec.sanitizationLabel}
                      </div>
                      <div className="text-[11px] text-slate-600">{rec.distanceLabel}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => applySmartBed(rec)}
                      className={`w-full rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                        isSelected
                          ? 'bg-sky-700 text-white'
                          : 'border border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100'
                      }`}
                    >
                      {isSelected ? 'Đã chọn giường này' : `Áp dụng giường #${idx + 1}`}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Lý do điều chuyển *</label>
          <input
            type="text"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="VD: Chuyển phòng dịch vụ / Cách ly / Theo yêu cầu chuyên khoa"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={admissions.length === 0}
            className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
          >
            {actionMode === 'REQUEST' ? 'Tạo lệnh chờ điều chuyển' : 'Xác nhận điều chuyển ngay'}
          </button>
        </div>
      </form>

      {/* Transfer Requests Queue with >30 Min Delay Highlight */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-sm text-slate-900">
            Hàng đợi Yêu cầu Điều chuyển ({pendingRequests.length} đang chờ · {delayedRequests.length} trễ &gt; 30 phút)
          </div>
          <span className="text-xs text-slate-500">
            Mốc SLA nội bộ: hoàn tất chuyển vị trí trong vòng 30 phút kể từ lúc phát lệnh
          </span>
        </div>

        {/* Desktop Queue Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Bệnh nhân</th>
                <th className="px-4 py-2.5 text-left font-medium">Lộ trình giường</th>
                <th className="px-4 py-2.5 text-left font-medium">Lý do</th>
                <th className="px-4 py-2.5 text-left font-medium">Thời gian chờ</th>
                <th className="px-4 py-2.5 text-left font-medium">Trạng thái</th>
                <th className="px-4 py-2.5 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {transferRequests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    Chưa có lệnh điều chuyển chờ xử lý.
                  </td>
                </tr>
              ) : (
                transferRequests.map((tr) => (
                  <tr
                    key={tr.id}
                    className={tr.is_delayed ? 'bg-rose-50/70' : tr.status === 'PENDING' ? 'bg-amber-50/30' : ''}
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <div>{tr.patient_name}</div>
                      <div className="text-xs text-slate-500">Phát lệnh: {tr.requested_by_name}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="font-mono font-semibold text-slate-700">{tr.from_bed_code}</span>
                      <span className="mx-1.5 text-slate-400">→</span>
                      <span className="font-mono font-bold text-sky-800">{tr.to_bed_code}</span>
                      <div className="text-slate-500 mt-0.5">
                        {tr.from_department_name} → {tr.to_department_name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">{tr.reason}</td>
                    <td className="px-4 py-3 text-xs font-mono tabular-nums whitespace-nowrap">
                      {tr.is_delayed ? (
                        <div className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-100 px-2 py-0.5 font-bold text-rose-800">
                          <Clock className="h-3 w-3" />
                          <span>TRỄ {tr.elapsed_minutes} PHÚT (&gt; 30P)</span>
                        </div>
                      ) : (
                        <span className="text-slate-700">{tr.elapsed_minutes} phút</span>
                      )}
                      <div className="text-[11px] text-slate-400 mt-0.5">{formatDateTimeVN(tr.requested_at)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap">
                      {tr.status === 'PENDING' ? (
                        <span className={tr.is_delayed ? 'text-rose-700' : 'text-amber-700'}>Đang chờ chuyển</span>
                      ) : tr.status === 'COMPLETED' ? (
                        <span className="text-emerald-700">Đã hoàn tất</span>
                      ) : (
                        <span className="text-slate-500">Đã hủy</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {tr.status === 'PENDING' ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyId === tr.id}
                            onClick={() => handleCompleteRequest(tr)}
                            className="inline-flex items-center gap-1 rounded bg-sky-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Hoàn tất chuyển</span>
                          </button>
                          <button
                            type="button"
                            disabled={busyId === tr.id}
                            onClick={() => handleCancelRequest(tr)}
                            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            <XCircle className="h-3.5 w-3.5 text-rose-600" />
                            <span>Hủy</span>
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Cards for Transfer Requests */}
        <div className="md:hidden divide-y divide-slate-100">
          {transferRequests.map((tr) => (
            <div key={tr.id} className={`p-4 space-y-2.5 ${tr.is_delayed ? 'bg-rose-50/70' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-900">{tr.patient_name}</div>
                  <div className="text-xs font-mono text-sky-800 font-semibold">
                    {tr.from_bed_code} → {tr.to_bed_code}
                  </div>
                </div>
                {tr.is_delayed ? (
                  <span className="rounded border border-rose-300 bg-rose-100 px-2 py-0.5 font-mono text-[11px] font-bold text-rose-800">
                    TRỄ {tr.elapsed_minutes}p
                  </span>
                ) : (
                  <span className="font-mono text-xs text-slate-500">{tr.elapsed_minutes}p</span>
                )}
              </div>
              <div className="text-xs text-slate-600">{tr.reason}</div>
              {tr.status === 'PENDING' && (
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    disabled={busyId === tr.id}
                    onClick={() => handleCompleteRequest(tr)}
                    className="flex-1 rounded-md bg-sky-700 px-3 py-2 text-xs font-semibold text-white"
                  >
                    Hoàn tất chuyển
                  </button>
                  <button
                    type="button"
                    disabled={busyId === tr.id}
                    onClick={() => handleCancelRequest(tr)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700"
                  >
                    Hủy
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Completed Transfer History */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 font-semibold text-sm text-slate-900">
          Lịch sử điều chuyển đã hoàn tất ({transfers.length})
        </div>
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Bệnh nhân</th>
                <th className="px-4 py-2.5 text-left font-medium">Từ giường</th>
                <th className="px-4 py-2.5 text-left font-medium">Đến giường</th>
                <th className="px-4 py-2.5 text-left font-medium">Lý do</th>
                <th className="px-4 py-2.5 text-left font-medium">Người thực hiện</th>
                <th className="px-4 py-2.5 text-left font-medium">Thời gian</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {transfers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                    Chưa có lượt điều chuyển nào.
                  </td>
                </tr>
              ) : (
                transfers.map((t) => (
                  <tr key={String(t.id)}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{String(t.patient_name)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {String(t.from_department_name)} · <span className="font-mono">{String(t.from_bed_code)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-sky-800 font-medium">
                      {String(t.to_department_name)} · <span className="font-mono">{String(t.to_bed_code)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{String(t.reason)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{String(t.performed_by_name)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{formatDateTimeVN(String(t.performed_at))}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="md:hidden divide-y divide-slate-100">
          {transfers.map((t) => (
            <div key={String(t.id)} className="p-4 space-y-1 text-xs">
              <div className="font-semibold text-sm text-slate-900">{String(t.patient_name)}</div>
              <div className="text-sky-800 font-mono">
                {String(t.from_bed_code)} → {String(t.to_bed_code)}
              </div>
              <div className="text-slate-600">{String(t.reason)}</div>
              <div className="text-slate-400 font-mono">
                {String(t.performed_by_name)} · {formatDateTimeVN(String(t.performed_at))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

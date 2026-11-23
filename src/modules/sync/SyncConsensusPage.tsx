import { Clock, Eye, RefreshCw, Trash2, UploadCloud, X, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getAuthToken } from '../../services/api';
import type { Bed, UserRole } from '../../types/bedcare';
import { formatDateTimeVN } from '../../utils/formatters';
import { clearServiceOutage } from '../../utils/networkResilience';
import {
  clearOfflineQueue,
  flushOfflineQueue,
  getOfflineQueue,
  OFFLINE_QUEUE_EVENT,
  removeOfflineAction,
  type OfflinePendingAction,
} from '../../utils/offlineQueue';

interface RuntimeNodeInfo {
  deviceId: string;
  nodeName: string;
  online: boolean;
  revoked: boolean;
  isCoordinator: boolean;
  partitionGroup: string;
  lamportClock: number;
  term: number;
  eventCount: number;
  pendingSyncCount: number;
}

interface ClusterStatusResponse {
  activeNodeId: string;
  quorumRequired: number;
  runtimeNodes: RuntimeNodeInfo[];
  events: Array<Record<string, unknown>>;
  syncQueue: Array<Record<string, unknown>>;
  consensusLogs: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  pendingRequests: Array<Record<string, unknown>>;
}

interface InspectedOperation {
  sourceLabel: string;
  title: string;
  id: string;
  device: string;
  status: string;
  timestamp: string;
  note?: string;
  payload: unknown;
}

interface SyncConsensusPageProps {
  userRole: UserRole;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function SyncConsensusPage({ userRole, onNotify }: SyncConsensusPageProps) {
  const [data, setData] = useState<ClusterStatusResponse | null>(null);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [raceBedId, setRaceBedId] = useState('');
  const [raceResult, setRaceResult] = useState<Array<{ nodeId: string; outcome: string; detail: string }> | null>(null);
  const [activeTab, setActiveTab] = useState<'pending_actions' | 'consensus' | 'events' | 'queue' | 'conflicts' | 'pending'>('pending_actions');
  const [offlineActions, setOfflineActions] = useState<OfflinePendingAction[]>(() => getOfflineQueue());
  const [retryingSync, setRetryingSync] = useState(false);
  const [inspectedOp, setInspectedOp] = useState<InspectedOperation | null>(null);

  const isAdmin = userRole === 'SUPER_ADMIN' || userRole === 'ADMIN';

  const syncLocalQueueState = useCallback(() => {
    setOfflineActions(getOfflineQueue());
  }, []);

  const load = useCallback(async () => {
    syncLocalQueueState();
    try {
      const [cl, bds] = await Promise.all([
        apiFetch<ClusterStatusResponse>('/cluster/status'),
        apiFetch<Bed[]>('/beds'),
      ]);
      setData(cl);
      const vacant = bds.filter((b) => b.status === 'VACANT');
      setBeds(vacant);
      if (!raceBedId && vacant.length > 0) setRaceBedId(vacant[0].id);
    } catch (e) {
      if (navigator.onLine) {
        onNotify((e as Error).message, 'error');
      }
    }
  }, [onNotify, raceBedId, syncLocalQueueState]);

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const onQueueChange = () => syncLocalQueueState();
    const onClusterSync = () => load();
    window.addEventListener(OFFLINE_QUEUE_EVENT, onQueueChange);
    window.addEventListener('bedcare-cluster-sync', onClusterSync);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, onQueueChange);
      window.removeEventListener('bedcare-cluster-sync', onClusterSync);
    };
  }, [load, syncLocalQueueState]);

  const handleToggleNode = async (
    n: RuntimeNodeInfo,
    patch: Partial<{ online: boolean; partitionGroup: string; isCoordinator: boolean }>
  ) => {
    try {
      await apiFetch('/cluster/node-state', {
        method: 'POST',
        body: JSON.stringify({ deviceId: n.deviceId, ...patch }),
      });
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  const handleRetrySyncNow = async () => {
    if (!navigator.onLine) {
      onNotify('Thiết bị vẫn đang ngoại tuyến. Vui lòng kiểm tra kết nối WiFi/4G rồi thử đồng bộ lại.', 'error');
      return;
    }
    setRetryingSync(true);
    clearServiceOutage();
    try {
      const token = getAuthToken();
      const flushRes = await flushOfflineQueue(token, { includePermanentErrors: true });
      syncLocalQueueState();

      const reconcileRes = await apiFetch<{
        syncedEvents: number;
        resolvedPending: number;
        rejectedConflicts: number;
      }>('/cluster/reconcile', {
        method: 'POST',
      });

      const parts: string[] = [];
      if (flushRes.flushed > 0) {
        parts.push(`đẩy thành công ${flushRes.flushed} thao tác ngoại tuyến`);
      }
      if (flushRes.failed > 0) {
        parts.push(`còn ${flushRes.failed} thao tác chưa đẩy được`);
      }
      parts.push(
        `đồng bộ cụm P2P (+${reconcileRes.syncedEvents} sự kiện, xử lý ${reconcileRes.resolvedPending} yêu cầu chờ, từ chối xung đột ${reconcileRes.rejectedConflicts})`
      );
      onNotify(`Đồng bộ hoàn tất: ${parts.join(', ')}.`, flushRes.failed > 0 ? 'error' : 'success');
      window.dispatchEvent(new CustomEvent('bedcare-cluster-sync'));
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    } finally {
      setRetryingSync(false);
    }
  };

  const handleSimulateRace = async () => {
    if (!raceBedId) return;
    try {
      const res = await apiFetch<{ bedCode: string; results: Array<{ nodeId: string; outcome: string; detail: string }> }>(
        '/cluster/simulate-race',
        {
          method: 'POST',
          body: JSON.stringify({ bedId: raceBedId }),
        }
      );
      setRaceResult(res.results);
      onNotify(`Đã chạy kiểm thử tranh chấp đồng thời trên giường ${res.bedCode}. Chỉ duy nhất 1 máy thắng khóa!`);
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  const handleResolveConflict = async (id: string) => {
    try {
      await apiFetch(`/cluster/conflicts/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolutionNote: 'Đã xác nhận giữ giao dịch thắng đồng thuận' }),
      });
      onNotify('Đã đánh dấu xử lý xung đột.');
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  const inspectOfflineOp = (op: OfflinePendingAction) => {
    let parsed: unknown = op.bodyText;
    if (op.bodyText) {
      try {
        parsed = JSON.parse(op.bodyText);
      } catch {
        parsed = op.bodyText;
      }
    }
    setInspectedOp({
      sourceLabel: 'Thao tác ngoại tuyến trên trình duyệt (Pending Actions)',
      title: op.actionLabel,
      id: op.id,
      device: data?.activeNodeId || 'CLIENT_LOCAL',
      status: op.attempts > 0 ? `Thử lại ${op.attempts} lần` : 'Chờ kết nối mạng',
      timestamp: op.createdAt,
      note: op.lastError || undefined,
      payload: {
        method: op.method,
        endpoint: `/api${op.path}`,
        body: parsed,
      },
    });
  };

  const inspectServerRecord = (sourceLabel: string, rec: Record<string, unknown>, kind: 'PENDING_REQ' | 'SYNC_QUEUE' | 'EVENT') => {
    if (kind === 'PENDING_REQ') {
      setInspectedOp({
        sourceLabel,
        title: String(rec.request_type || 'Yêu cầu chờ xác nhận'),
        id: String(rec.id || ''),
        device: String(rec.device_id || ''),
        status: String(rec.status || ''),
        timestamp: String(rec.created_at || ''),
        note: rec.conflict_reason ? String(rec.conflict_reason) : undefined,
        payload: rec.payload_parsed ?? rec.payload ?? {},
      });
      return;
    }
    if (kind === 'SYNC_QUEUE') {
      setInspectedOp({
        sourceLabel,
        title: String(rec.event_type || 'Đồng bộ sự kiện hàng đợi'),
        id: String(rec.event_id || rec.id || ''),
        device: `${String(rec.source_device_id || '?')} → ${String(rec.target_device_id || '?')}`,
        status: String(rec.status || ''),
        timestamp: String(rec.created_at || ''),
        note: rec.last_error ? String(rec.last_error) : undefined,
        payload: rec.payload_parsed ?? {
          aggregate_type: rec.aggregate_type,
          aggregate_id: rec.aggregate_id,
          lamport_clock: rec.lamport_clock,
        },
      });
      return;
    }
    setInspectedOp({
      sourceLabel,
      title: String(rec.event_type || 'Sự kiện P2P'),
      id: String(rec.event_id || ''),
      device: `${String(rec.device_id || '')} (${String(rec.user_id || '')})`,
      status: String(rec.consensus_status || ''),
      timestamp: String(rec.created_at || ''),
      payload: rec.payload_parsed ?? rec.payload ?? {},
    });
  };

  const totalPendingCount =
    offlineActions.length + (data?.pendingRequests.length ?? 0) + (data?.syncQueue.length ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Đồng bộ P2P &amp; Đồng thuận Giao dịch</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Local-first Event Log + chữ ký Ed25519 + Quorum tối thiểu {data?.quorumRequired ?? 2} nút để xác nhận cấp giường (chống Last-Write-Wins).
          </p>
        </div>
        <button
          type="button"
          onClick={handleRetrySyncNow}
          disabled={retryingSync}
          data-testid="retry-sync-now-btn"
          className="min-h-[42px] flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-60 whitespace-nowrap"
        >
          <RefreshCw className={`h-4 w-4 ${retryingSync ? 'animate-spin' : ''}`} />
          <span>{retryingSync ? 'Đang đồng bộ...' : 'Thử đồng bộ lại ngay'}</span>
        </button>
      </div>

      {/* Dedicated Pending Actions (Client Offline + Server Queued Ops) Summary Panel */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <UploadCloud className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Pending Actions — Thao tác ngoại tuyến chờ đồng bộ ({offlineActions.length} tại máy này · {totalPendingCount} tổng chờ xử lý)
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                Mọi thao tác thực hiện khi mất kết nối mạng được lưu an toàn tại bộ nhớ cục bộ và tự động phát lên peer chính ngay khi có mạng.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {offlineActions.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  clearOfflineQueue();
                  syncLocalQueueState();
                  onNotify('Đã dọn danh sách thao tác chờ ngoại tuyến.');
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Xóa hàng chờ cục bộ
              </button>
            )}
            <button
              type="button"
              onClick={handleRetrySyncNow}
              disabled={retryingSync}
              className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${retryingSync ? 'animate-spin' : ''}`} />
              <span>Thử đồng bộ lại ngay</span>
            </button>
          </div>
        </div>

        {offlineActions.length === 0 ? (
          <div className="rounded-md border border-emerald-200 bg-white px-4 py-3 text-xs text-emerald-800 flex items-center gap-2">
            <Clock className="h-4 w-4 text-emerald-600 shrink-0" />
            <span>
              Không có thao tác ngoại tuyến nào đang tồn đọng trên thiết bị này. Mọi thay đổi đã được đồng bộ với máy chủ trung tâm.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {offlineActions.map((op) => (
              <div key={op.id} className="rounded-lg border border-amber-300 bg-white p-3.5 flex flex-col justify-between gap-2.5">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">{op.actionLabel}</span>
                    <span className="font-mono text-[11px] font-semibold rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800">
                      {op.method}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">
                    Endpoint: /api{op.path} · Lúc {formatDateTimeVN(op.createdAt)}
                  </div>
                  {op.lastError && (
                    <div className="text-xs text-amber-800">Trạng thái: {op.lastError}</div>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => inspectOfflineOp(op)}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Eye className="h-3.5 w-3.5 text-sky-700" />
                    <span>Xem chi tiết</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeOfflineAction(op.id);
                      syncLocalQueueState();
                    }}
                    className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Hủy bỏ</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Node Topology & Partition Controls */}
      {data ? (
        <>
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-900">Cấu trúc cụm máy ngang hàng (SQLite độc lập)</h3>
              <span className="text-xs font-mono text-slate-500">Nút đang thao tác: {data.activeNodeId}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {data.runtimeNodes.map((n) => (
                <div key={n.deviceId} className="rounded-lg border border-slate-200 p-4 space-y-2.5 bg-slate-50/50">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-mono text-xs font-bold text-slate-900">{n.deviceId}</div>
                      <div className="text-sm font-semibold text-slate-800">{n.nodeName}</div>
                    </div>
                    <span className={`text-xs font-semibold ${n.revoked ? 'text-rose-700' : n.online ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {n.revoked ? 'Thu hồi' : n.online ? 'Trực tuyến' : 'Ngoại tuyến'}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs text-slate-600 pt-1">
                    <div>Lamport: <span className="font-mono font-semibold text-slate-900">{n.lamportClock}</span></div>
                    <div>Sự kiện: <span className="font-mono font-semibold text-slate-900">{n.eventCount}</span></div>
                    <div>Hàng đợi: <span className="font-mono font-semibold text-amber-700">{n.pendingSyncCount}</span></div>
                  </div>
                  <div className="text-xs text-slate-500">
                    Nhóm mạng: <span className="font-mono font-semibold text-slate-800">{n.partitionGroup}</span>
                    {n.isCoordinator && <span className="ml-2 text-sky-700 font-semibold">· Leader (Term {n.term})</span>}
                  </div>
                  {isAdmin && !n.revoked && (
                    <div className="flex flex-wrap gap-1.5 pt-2 border-t border-slate-200">
                      <button
                        type="button"
                        onClick={() => handleToggleNode(n, { online: !n.online })}
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        {n.online ? 'Ngắt kết nối' : 'Kết nối lại'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleNode(n, { partitionGroup: n.partitionGroup === 'MAIN' ? 'ISOLATED_B' : 'MAIN' })}
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        {n.partitionGroup === 'MAIN' ? 'Tách phân vùng B' : 'Gộp về MAIN'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Live Multi-Node Race Condition Tester */}
          {isAdmin && (
            <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Kiểm thử tranh chấp cấp cùng một giường từ nhiều máy</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Phát lệnh tiếp nhận đồng thời trên cùng 1 giường trống từ các nút P2P để kiểm chứng chỉ 1 giao dịch thành công.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select value={raceBedId} onChange={(e) => setRaceBedId(e.target.value)} aria-label="Chọn giường kiểm thử" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">
                    {beds.map((b) => (
                      <option key={b.id} value={b.id}>{b.code} ({b.department_name})</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleSimulateRace}
                    disabled={!raceBedId}
                    className="flex items-center gap-1.5 rounded-md bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    <span>Chạy kiểm thử đồng thời</span>
                  </button>
                </div>
              </div>

              {raceResult && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-2">
                  {raceResult.map((r) => (
                    <div key={r.nodeId} className="rounded border border-slate-200 p-3 text-xs">
                      <div className="font-mono font-bold text-slate-900">{r.nodeId}</div>
                      <div className={`mt-1 font-semibold ${r.outcome === 'WON_COMMITTED' ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {r.outcome}
                      </div>
                      <div className="mt-0.5 text-slate-600">{r.detail}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Logs Tabs */}
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap gap-1.5">
              {[
                { id: 'pending_actions', label: `Pending Actions (${offlineActions.length})` },
                { id: 'queue', label: `Hàng đợi đồng bộ (${data.syncQueue.length})` },
                { id: 'pending', label: `Chờ xác nhận (${data.pendingRequests.length})` },
                { id: 'consensus', label: `Nhật ký đồng thuận (${data.consensusLogs.length})` },
                { id: 'events', label: `Nhật ký sự kiện (${data.events.length})` },
                { id: 'conflicts', label: `Xung đột (${data.conflicts.length})` },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id as typeof activeTab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                    activeTab === t.id ? 'bg-white text-sky-800 border border-slate-200 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              {activeTab === 'pending_actions' && (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Thao tác</th>
                      <th className="px-4 py-2.5 text-left">API Endpoint</th>
                      <th className="px-4 py-2.5 text-left">Thời gian tạo</th>
                      <th className="px-4 py-2.5 text-left">Trạng thái</th>
                      <th className="px-4 py-2.5 text-right">Chi tiết</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {offlineActions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                          Không có thao tác offline nào đang chờ đồng bộ.
                        </td>
                      </tr>
                    ) : (
                      offlineActions.map((op) => (
                        <tr key={op.id} className="hover:bg-slate-50">
                          <td className="px-4 py-2.5 font-semibold text-slate-900">{op.actionLabel}</td>
                          <td className="px-4 py-2.5 font-mono text-slate-600">{op.method} /api{op.path}</td>
                          <td className="px-4 py-2.5 font-mono text-slate-500">{formatDateTimeVN(op.createdAt)}</td>
                          <td className="px-4 py-2.5 text-amber-700 font-medium">{op.lastError || 'Chờ mạng'}</td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-2">
                            <button type="button" onClick={() => inspectOfflineOp(op)} className="text-sky-700 font-medium hover:underline">
                              Xem chi tiết
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                removeOfflineAction(op.id);
                                syncLocalQueueState();
                              }}
                              className="text-rose-600 font-medium hover:underline"
                            >
                              Xóa
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}

              {activeTab === 'consensus' && (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Term / Leader</th>
                      <th className="px-4 py-2.5 text-left">Tài nguyên khóa</th>
                      <th className="px-4 py-2.5 text-left">Quorum</th>
                      <th className="px-4 py-2.5 text-left">Quyết định</th>
                      <th className="px-4 py-2.5 text-left">Thời gian</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.consensusLogs.map((c) => (
                      <tr key={String(c.id)}>
                        <td className="px-4 py-2.5 font-mono">T{String(c.term)} · {String(c.coordinator_id)}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-800">{String(c.resource_key)}</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums">{String(c.quorum_achieved)}/{String(c.quorum_required)}</td>
                        <td className="px-4 py-2.5 font-semibold">
                          <span className={c.decision === 'COMMITTED' ? 'text-emerald-700' : c.decision === 'DEFERRED_NO_QUORUM' ? 'text-amber-700' : 'text-rose-700'}>
                            {String(c.decision)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-500">{formatDateTimeVN(String(c.created_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeTab === 'events' && (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Lamport / Seq</th>
                      <th className="px-4 py-2.5 text-left">Loại sự kiện</th>
                      <th className="px-4 py-2.5 text-left">Thiết bị / Người thực hiện</th>
                      <th className="px-4 py-2.5 text-left">Đồng thuận</th>
                      <th className="px-4 py-2.5 text-left">Thời gian</th>
                      <th className="px-4 py-2.5 text-right">Chi tiết</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.events.map((ev) => (
                      <tr key={String(ev.event_id)} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-mono">L{String(ev.lamport_clock)} (#{String(ev.sequence_no)})</td>
                        <td className="px-4 py-2.5 font-semibold text-slate-900">{String(ev.event_type)}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-600">{String(ev.device_id)} · {String(ev.user_id)}</td>
                        <td className="px-4 py-2.5 text-emerald-700 font-semibold">{String(ev.consensus_status)}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-500">{formatDateTimeVN(String(ev.created_at))}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => inspectServerRecord('Nhật ký sự kiện P2P', ev, 'EVENT')}
                            className="text-sky-700 font-medium hover:underline"
                          >
                            Xem payload
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeTab === 'queue' && (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Sự kiện / Event ID</th>
                      <th className="px-4 py-2.5 text-left">Máy đích</th>
                      <th className="px-4 py-2.5 text-left">Trạng thái</th>
                      <th className="px-4 py-2.5 text-left">Lý do</th>
                      <th className="px-4 py-2.5 text-left">Tạo lúc</th>
                      <th className="px-4 py-2.5 text-right">Chi tiết</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.syncQueue.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">Hàng đợi đồng bộ trống.</td></tr>
                    ) : data.syncQueue.map((sq) => (
                      <tr key={String(sq.id)} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5">
                          <div className="font-semibold text-slate-900">{String(sq.event_type || 'SYNC_EVENT')}</div>
                          <div className="font-mono text-[11px] text-slate-500">{String(sq.event_id)}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono font-semibold">{String(sq.target_device_id)}</td>
                        <td className="px-4 py-2.5 font-semibold">{String(sq.status)}</td>
                        <td className="px-4 py-2.5 text-slate-600">{String(sq.last_error)}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-500">{formatDateTimeVN(String(sq.created_at))}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => inspectServerRecord('Hàng đợi đồng bộ giữa các Peer', sq, 'SYNC_QUEUE')}
                            className="text-sky-700 font-medium hover:underline"
                          >
                            Xem chi tiết
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeTab === 'conflicts' && (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Tài nguyên</th>
                      <th className="px-4 py-2.5 text-left">Máy thắng / Máy xung đột</th>
                      <th className="px-4 py-2.5 text-left">Nguyên nhân</th>
                      <th className="px-4 py-2.5 text-left">Trạng thái</th>
                      <th className="px-4 py-2.5 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.conflicts.length === 0 ? (
                      <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">Chưa ghi nhận xung đột dữ liệu nào.</td></tr>
                    ) : data.conflicts.map((c) => (
                      <tr key={String(c.id)}>
                        <td className="px-4 py-2.5 font-mono">{String(c.resource_type)}:{String(c.resource_id)}</td>
                        <td className="px-4 py-2.5 font-mono">{String(c.winning_device_id || '—')} vs {String(c.conflicting_device_id)}</td>
                        <td className="px-4 py-2.5 text-rose-700">{String(c.reason)}</td>
                        <td className="px-4 py-2.5 font-semibold">{String(c.status)}</td>
                        <td className="px-4 py-2.5 text-right">
                          {c.status === 'OPEN' && isAdmin && (
                            <button type="button" onClick={() => handleResolveConflict(String(c.id))} className="text-sky-700 font-medium hover:underline">
                              Đánh dấu đã xử lý
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeTab === 'pending' && (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Loại yêu cầu</th>
                      <th className="px-4 py-2.5 text-left">Mục tiêu</th>
                      <th className="px-4 py-2.5 text-left">Thiết bị gửi</th>
                      <th className="px-4 py-2.5 text-left">Trạng thái</th>
                      <th className="px-4 py-2.5 text-left">Ghi chú xung đột</th>
                      <th className="px-4 py-2.5 text-right">Chi tiết</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.pendingRequests.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">Không có yêu cầu nào đang chờ xác nhận.</td></tr>
                    ) : data.pendingRequests.map((pr) => (
                      <tr key={String(pr.id)} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-semibold">{String(pr.request_type)}</td>
                        <td className="px-4 py-2.5 font-mono">{String(pr.target_id)}</td>
                        <td className="px-4 py-2.5 font-mono">{String(pr.device_id)}</td>
                        <td className="px-4 py-2.5 font-semibold text-amber-700">{String(pr.status)}</td>
                        <td className="px-4 py-2.5 text-slate-600">{String(pr.conflict_reason || '—')}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => inspectServerRecord('Giao dịch chờ xác nhận Quorum', pr, 'PENDING_REQ')}
                            className="text-sky-700 font-medium hover:underline"
                          >
                            Xem chi tiết
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
          {navigator.onLine
            ? 'Đang tải trạng thái cụm đồng bộ...'
            : 'Thiết bị đang ngoại tuyến — các thao tác bạn thực hiện vẫn được lưu tại mục Pending Actions ở trên.'}
        </div>
      )}

      {/* Operation Payload Detail Inspector Modal */}
      {inspectedOp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="op-detail-title"
        >
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 space-y-4 shadow-xl max-h-[88vh] flex flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <div className="text-xs font-medium text-sky-700">{inspectedOp.sourceLabel}</div>
                <h3 id="op-detail-title" className="text-lg font-semibold text-slate-900 mt-0.5">
                  {inspectedOp.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setInspectedOp(null)}
                aria-label="Đóng chi tiết giao dịch"
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs bg-slate-50 rounded-lg border border-slate-200 p-3.5">
              <div>
                Mã giao dịch: <span className="font-mono font-semibold text-slate-900 break-all">{inspectedOp.id}</span>
              </div>
              <div>
                Thiết bị / Nguồn: <span className="font-mono font-semibold text-slate-900">{inspectedOp.device}</span>
              </div>
              <div>
                Trạng thái: <span className="font-semibold text-amber-800">{inspectedOp.status}</span>
              </div>
              <div>
                Thời gian: <span className="font-mono text-slate-700">{formatDateTimeVN(inspectedOp.timestamp)}</span>
              </div>
              {inspectedOp.note && (
                <div className="sm:col-span-2 text-rose-700">
                  Ghi chú / Lỗi: <strong>{inspectedOp.note}</strong>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className="text-xs font-semibold text-slate-700 mb-1.5">Dữ liệu chi tiết (Payload JSON):</div>
              <pre className="rounded-lg border border-slate-200 bg-slate-950 text-slate-100 p-3.5 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(inspectedOp.payload, null, 2)}
              </pre>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setInspectedOp(null)}
                className="rounded-md border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

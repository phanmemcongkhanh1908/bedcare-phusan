import { useEffect, useState } from 'react';
import { apiFetch } from '../../services/api';
import type { CleaningLog } from '../../types/bedcare';
import { formatDateTimeVN } from '../../utils/formatters';

interface CleaningPageProps {
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function CleaningPage({ onNotify }: CleaningPageProps) {
  const [logs, setLogs] = useState<CleaningLog[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'>('ALL');

  const load = async () => {
    try {
      const data = await apiFetch<CleaningLog[]>('/cleaning');
      setLogs(data);
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

  const handleStart = async (id: string) => {
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/cleaning/${id}/start`, { method: 'POST' });
      onNotify(
        res?.queuedOffline
          ? 'Đang mất mạng: đã lưu lệnh bắt đầu vệ sinh vào Pending Actions.'
          : 'Đã bắt đầu vệ sinh giường.'
      );
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  const handleComplete = async (id: string) => {
    try {
      const res = await apiFetch<{ queuedOffline?: boolean }>(`/cleaning/${id}/complete`, { method: 'POST', body: JSON.stringify({}) });
      onNotify(
        res?.queuedOffline
          ? 'Đang mất mạng: đã lưu lệnh hoàn tất vệ sinh vào Pending Actions.'
          : 'Hoàn tất vệ sinh. Giường đã chuyển sang Trống và đồng bộ tới các máy.'
      );
      await load();
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  const filtered = filter === 'ALL' ? logs : logs.filter((l) => l.status === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Quản lý Vệ sinh giường bệnh</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Quy trình khử khuẩn bắt buộc sau trả giường: Chờ vệ sinh -&gt; Đang vệ sinh -&gt; Trống.
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {[
            { id: 'ALL', label: 'Tất cả' },
            { id: 'PENDING', label: 'Chờ vệ sinh' },
            { id: 'IN_PROGRESS', label: 'Đang vệ sinh' },
            { id: 'COMPLETED', label: 'Đã hoàn tất' },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id as typeof filter)}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                filter === f.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Giường / Phòng / Khoa</th>
                <th className="px-4 py-3 text-left font-medium">Trạng thái</th>
                <th className="px-4 py-3 text-left font-medium">Yêu cầu lúc</th>
                <th className="px-4 py-3 text-left font-medium">Hoàn tất lúc</th>
                <th className="px-4 py-3 text-left font-medium">Người thực hiện</th>
                <th className="px-4 py-3 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">Không có phiếu vệ sinh nào.</td></tr>
              ) : filtered.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span className="font-mono font-semibold text-slate-900">{l.bed_code}</span>
                    <span className="ml-2 text-xs text-slate-600">{l.room_name} · {l.department_name}</span>
                  </td>
                  <td className="px-4 py-3 text-xs font-semibold">
                    <span className={l.status === 'PENDING' ? 'text-teal-700' : l.status === 'IN_PROGRESS' ? 'text-cyan-700' : 'text-emerald-700'}>
                      {l.status === 'PENDING' ? 'Chờ vệ sinh' : l.status === 'IN_PROGRESS' ? 'Đang vệ sinh' : 'Đã hoàn tất'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{formatDateTimeVN(l.requested_at)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{formatDateTimeVN(l.completed_at)}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">{l.completed_by_name || l.assigned_to || '—'}</td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    {l.status === 'PENDING' && (
                      <button
                        type="button"
                        onClick={() => handleStart(l.id)}
                        className="rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-800 hover:bg-cyan-100"
                      >
                        Bắt đầu vệ sinh
                      </button>
                    )}
                    {(l.status === 'PENDING' || l.status === 'IN_PROGRESS') && (
                      <button
                        type="button"
                        onClick={() => handleComplete(l.id)}
                        className="rounded-md bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800"
                      >
                        Xác nhận đã vệ sinh xong
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

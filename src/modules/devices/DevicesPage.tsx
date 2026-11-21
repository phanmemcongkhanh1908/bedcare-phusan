import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { apiFetch } from '../../services/api';
import type { Department, DeviceNode, UserRole } from '../../types/bedcare';
import { formatDateTimeVN } from '../../utils/formatters';

interface DevicesPageProps {
  currentUserRole: UserRole;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onNodeSwitched: () => void;
}

export function DevicesPage({ currentUserRole, onNotify, onNodeSwitched }: DevicesPageProps) {
  const [devices, setDevices] = useState<DeviceNode[]>([]);
  const [activeNodeId, setActiveNodeId] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [showPair, setShowPair] = useState(false);
  const [nodeName, setNodeName] = useState('');
  const [deptId, setDeptId] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<DeviceNode | null>(null);

  const load = async () => {
    try {
      const [cluster, depts] = await Promise.all([
        apiFetch<{ activeNodeId: string; devices: DeviceNode[] }>('/cluster/status'),
        apiFetch<Department[]>('/departments'),
      ]);
      setDevices(cluster.devices);
      setActiveNodeId(cluster.activeNodeId);
      setDepartments(depts);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handlePair = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/devices/pair', {
        method: 'POST',
        body: JSON.stringify({ nodeName, departmentId: deptId || null }),
      });
      onNotify(`Đã ghép nối nút P2P mới: ${nodeName} và cấp khóa Ed25519.`);
      setShowPair(false);
      setNodeName('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleSwitchNode = async (deviceId: string) => {
    try {
      await apiFetch('/cluster/switch-node', {
        method: 'POST',
        body: JSON.stringify({ deviceId }),
      });
      onNotify(`Đã chuyển phiên thao tác sang máy trạm ${deviceId}.`);
      await load();
      onNodeSwitched();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await apiFetch(`/devices/${revokeTarget.device_id}/revoke`, { method: 'POST' });
      onNotify(`Đã thu hồi quyền truy cập của thiết bị ${revokeTarget.node_name}.`);
      setRevokeTarget(null);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
      setRevokeTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Quản lý Thiết bị &amp; Khóa tin cậy P2P</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Mỗi máy trạm sở hữu Device ID duy nhất, cơ sở dữ liệu SQLite riêng và cặp khóa ký số Ed25519.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowPair((v) => !v)}
          className="flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>Ghép nối thiết bị mới</span>
        </button>
      </div>

      {showPair && (
        <form onSubmit={handlePair} className="rounded-lg border border-slate-200 bg-white p-5 grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Tên máy trạm *</label>
            <input type="text" required value={nodeName} onChange={(e) => setNodeName(e.target.value)} placeholder="VD: Máy Quầy Thu Viện Phí 02" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Khoa gắn kết (nếu có)</label>
            <select value={deptId} onChange={(e) => setDeptId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">Toàn viện / Quầy thu viện phí</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">Tạo cặp khóa &amp; Ghép nối</button>
            <button type="button" onClick={() => setShowPair(false)} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600">Hủy</button>
          </div>
        </form>
      )}

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Device ID</th>
                <th className="px-4 py-3 text-left font-medium">Tên máy trạm</th>
                <th className="px-4 py-3 text-left font-medium">Vai trò đồng thuận</th>
                <th className="px-4 py-3 text-left font-medium">Khóa công khai Ed25519</th>
                <th className="px-4 py-3 text-left font-medium">Trạng thái</th>
                <th className="px-4 py-3 text-left font-medium">Lần cuối kết nối</th>
                <th className="px-4 py-3 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {devices.map((d) => (
                <tr key={d.device_id} className={d.device_id === activeNodeId ? 'bg-sky-50/40' : ''}>
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">
                    {d.device_id}
                    {d.device_id === activeNodeId && <span className="ml-2 text-sky-700">(Đang chọn)</span>}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">{d.node_name}</td>
                  <td className="px-4 py-3 text-xs text-slate-700">{d.is_coordinator ? 'Nút điều phối (Leader)' : 'Nút thành viên'}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-500 max-w-[200px] truncate">{d.public_key.replace(/-----[^-]+-----/g, '').trim()}</td>
                  <td className="px-4 py-3 text-xs font-semibold">
                    <span className={d.status === 'TRUSTED' ? 'text-emerald-700' : d.status === 'OFFLINE' ? 'text-amber-700' : 'text-rose-700'}>
                      {d.status === 'TRUSTED' ? 'Tin cậy' : d.status === 'OFFLINE' ? 'Mất kết nối' : 'Đã thu hồi'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{formatDateTimeVN(d.last_seen_at)}</td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    {d.status !== 'REVOKED' && d.device_id !== activeNodeId && (
                      <button type="button" onClick={() => handleSwitchNode(d.device_id)} className="text-xs font-medium text-sky-700 hover:underline">
                        Chuyển sang nút này
                      </button>
                    )}
                    {currentUserRole === 'SUPER_ADMIN' && d.status !== 'REVOKED' && d.device_id !== activeNodeId && (
                      <button type="button" onClick={() => setRevokeTarget(d)} className="text-xs font-medium text-rose-600 hover:underline">
                        Thu hồi
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmModal
        open={Boolean(revokeTarget)}
        title="Thu hồi quyền thiết bị"
        description={`Thu hồi quyền truy cập mạng P2P của thiết bị ${revokeTarget?.node_name} (${revokeTarget?.device_id})? Mọi sự kiện từ thiết bị này sẽ bị từ chối trên toàn mạng.`}
        danger
        confirmLabel="Thu hồi thiết bị"
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}

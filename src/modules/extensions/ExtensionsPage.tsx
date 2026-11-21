import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../services/api';
import type { Admission, BedExtension } from '../../types/bedcare';
import { formatDateTimeVN, toLocalDateTimeInputValue } from '../../utils/formatters';

interface ExtensionsPageProps {
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function ExtensionsPage({ onNotify }: ExtensionsPageProps) {
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [history, setHistory] = useState<BedExtension[]>([]);
  const [selectedAdmId, setSelectedAdmId] = useState('');
  const [newDate, setNewDate] = useState('');
  const [reason, setReason] = useState('');

  const load = async () => {
    try {
      const [adms, exts] = await Promise.all([
        apiFetch<Admission[]>('/admissions?status=ACTIVE'),
        apiFetch<BedExtension[]>('/extensions'),
      ]);
      setAdmissions(adms);
      setHistory(exts);
      if (!selectedAdmId && adms.length > 0) {
        setSelectedAdmId(adms[0].id);
        const d = new Date(new Date(adms[0].expected_discharge_at).getTime() + 2 * 86400000);
        setNewDate(toLocalDateTimeInputValue(d));
      }
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleExtend = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = new Date(newDate);
    if (!newDate || Number.isNaN(parsed.getTime())) {
      onNotify('Ngày trả dự kiến mới không hợp lệ.', 'error');
      return;
    }
    try {
      await apiFetch(`/admissions/${selectedAdmId}/extend`, {
        method: 'POST',
        body: JSON.stringify({
          new_expected_discharge_at: parsed.toISOString(),
          reason,
        }),
      });
      onNotify('Đã gia hạn ngày giường và ghi nhận vào lịch sử bất biến.');
      setReason('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Gia hạn ngày sử dụng giường</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Khoa nội trú gia hạn ngày trả dự kiến, lưu toàn bộ lịch sử gia hạn không thể xóa và tự động đồng bộ cảnh báo.
        </p>
      </div>

      <form onSubmit={handleExtend} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <h3 className="text-base font-semibold text-slate-900">Tạo phiếu gia hạn ngày giường</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Bệnh nhân &amp; Giường *</label>
            <select
              value={selectedAdmId}
              onChange={(e) => {
                setSelectedAdmId(e.target.value);
                const found = admissions.find((a) => a.id === e.target.value);
                if (found) {
                  setNewDate(toLocalDateTimeInputValue(new Date(new Date(found.expected_discharge_at).getTime() + 2 * 86400000)));
                }
              }}
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {admissions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.patient_name} ({a.bed_code}) - Hạn cũ: {formatDateTimeVN(a.expected_discharge_at)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Ngày trả dự kiến mới *</label>
            <input type="datetime-local" required value={newDate} onChange={(e) => setNewDate(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Lý do gia hạn *</label>
            <input type="text" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: Theo dõi thêm sau phẫu thuật" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex justify-end">
          <button type="submit" disabled={admissions.length === 0} className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50">
            Xác nhận gia hạn
          </button>
        </div>
      </form>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 font-semibold text-sm text-slate-900">
          Lịch sử gia hạn bất biến ({history.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Bệnh nhân / Giường</th>
                <th className="px-4 py-2.5 text-left font-medium">Ngày trả cũ</th>
                <th className="px-4 py-2.5 text-left font-medium">Ngày trả mới</th>
                <th className="px-4 py-2.5 text-left font-medium">Lý do</th>
                <th className="px-4 py-2.5 text-left font-medium">Người thực hiện</th>
                <th className="px-4 py-2.5 text-left font-medium">Thời gian</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-900">{h.patient_name}</span>
                    <span className="ml-2 font-mono text-xs text-sky-700">{h.bed_code}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{formatDateTimeVN(h.old_expected_discharge_at)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs font-semibold text-sky-800">{formatDateTimeVN(h.new_expected_discharge_at)}</td>
                  <td className="px-4 py-2.5 text-slate-700">{h.reason}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{h.performed_by_name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{formatDateTimeVN(h.performed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

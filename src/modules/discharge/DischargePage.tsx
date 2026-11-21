import { useEffect, useState } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { apiFetch } from '../../services/api';
import type { Admission } from '../../types/bedcare';
import { formatDateTimeVN } from '../../utils/formatters';

interface DischargePageProps {
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function DischargePage({ onNotify }: DischargePageProps) {
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [target, setTarget] = useState<Admission | null>(null);
  const [notes, setNotes] = useState('');

  const load = async () => {
    try {
      const data = await apiFetch<Admission[]>('/admissions?status=ACTIVE');
      setAdmissions(data);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDischarge = async () => {
    if (!target) return;
    try {
      await apiFetch(`/admissions/${target.id}/discharge`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
      });
      onNotify(`Đã xác nhận trả giường ${target.bed_code}. Giường đã chuyển sang trạng thái Chờ vệ sinh.`);
      setTarget(null);
      setNotes('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
      setTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Xuất viện &amp; Trả giường</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Chỉ nhân viên khoa nội trú (hoặc Admin) được xác nhận trả giường. Sau khi trả, giường tự động chuyển sang Chờ vệ sinh.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Mã hồ sơ</th>
                <th className="px-4 py-3 text-left font-medium">Bệnh nhân</th>
                <th className="px-4 py-3 text-left font-medium">Khoa / Phòng / Giường</th>
                <th className="px-4 py-3 text-left font-medium">Ngày nhận giường</th>
                <th className="px-4 py-3 text-left font-medium">Dự kiến trả</th>
                <th className="px-4 py-3 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {admissions.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">Không có bệnh nhân đang nằm cần trả giường.</td></tr>
              ) : admissions.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">{a.admission_code}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{a.patient_name}</div>
                    <div className="text-xs text-slate-500">{a.patient_code} · {a.diagnosis_group}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {a.department_name} · {a.room_name} · <span className="font-mono font-semibold text-sky-700">{a.bed_code}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{formatDateTimeVN(a.bed_assigned_at)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{formatDateTimeVN(a.expected_discharge_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setTarget(a)}
                      className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 whitespace-nowrap"
                    >
                      Xác nhận trả giường
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmModal
        open={Boolean(target)}
        title="Xác nhận trả giường"
        description={`Xác nhận kết thúc lượt sử dụng giường ${target?.bed_code} của bệnh nhân ${target?.patient_name}? Giường sẽ chuyển sang trạng thái Chờ vệ sinh và giải phóng phòng bao trọn (nếu có).`}
        confirmLabel="Xác nhận trả giường"
        onConfirm={handleDischarge}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}

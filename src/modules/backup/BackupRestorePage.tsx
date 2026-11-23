import { CheckCircle2, DatabaseBackup, Download, FileCheck2, RotateCcw, ShieldCheck, Upload } from 'lucide-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { apiFetch, getAuthToken } from '../../services/api';
import { describeBackupOrigin } from '../../utils/databaseSafety';
import { formatDateTimeVN } from '../../utils/formatters';
import { resolveApiUrl } from '../../utils/networkResilience';

interface BackupRecord {
  id: string;
  backup_name: string;
  device_id: string;
  app_version: string;
  schema_version: string;
  checksum_sha256: string;
  encrypted: number;
  record_count: number;
  status: 'SUCCESS' | 'FAILED' | 'RESTORED';
  file_path: string;
  created_by: string;
  created_at: string;
}

interface BackupRestorePageProps {
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function BackupRestorePage({ onNotify }: BackupRestorePageProps) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifiedMap, setVerifiedMap] = useState<Record<string, boolean>>({});
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [lastPreRestoreBackup, setLastPreRestoreBackup] = useState<BackupRecord | null>(null);
  const [uploadCandidate, setUploadCandidate] = useState<{
    fileName: string;
    envelope: Record<string, unknown>;
    checksum: string;
  } | null>(null);

  const load = async () => {
    try {
      const data = await apiFetch<BackupRecord[]>('/backups');
      setBackups(data);
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const b = await apiFetch<{ backup_name: string; checksum_sha256: string }>('/backups', {
        method: 'POST',
      });
      onNotify(`Đã tạo bản sao lưu mã hóa AES-256-GCM: ${b.backup_name}`);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = async (b: BackupRecord) => {
    try {
      const token = getAuthToken();
      const res = await fetch(resolveApiUrl(`/backups/${b.id}/download`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || 'Không thể tải file sao lưu.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = b.backup_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onNotify(`Đã tải file sao lưu mã hóa ${b.backup_name} về máy/điện thoại.`);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleVerify = async (b: BackupRecord) => {
    setVerifyingId(b.id);
    try {
      const res = await apiFetch<{ valid: boolean; record_count: number; checksum_sha256: string }>(
        `/backups/${b.id}/verify`,
        { method: 'POST' }
      );
      setVerifiedMap((prev) => ({ ...prev, [b.id]: res.valid }));
      onNotify(
        res.valid
          ? `Toàn vẹn hợp lệ 100%: SHA-256 khớp (${res.record_count} bản ghi).`
          : 'Cảnh báo: Checksum bản sao lưu không khớp!',
        res.valid ? 'success' : 'error'
      );
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setVerifyingId(null);
    }
  };

  const handlePickUploadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.algorithm !== 'aes-256-gcm' || !parsed.ciphertext || !parsed.checksum_sha256) {
        throw new Error('File không đúng định dạng sao lưu mã hóa .bcare của BEDCARE.');
      }
      setRestorePassword('');
      setRestoreError('');
      setUploadCandidate({
        fileName: file.name,
        envelope: parsed,
        checksum: String(parsed.checksum_sha256),
      });
    } catch (err) {
      onNotify(`Không đọc được file sao lưu: ${(err as Error).message}`, 'error');
    }
  };

  const handleConfirmUploadRestore = async () => {
    if (!uploadCandidate) return;
    setRestoring(true);
    setRestoreError('');
    try {
      const res = await apiFetch<{
        restored: boolean;
        reconciledEvents: number;
        checksumVerified: boolean;
        preRestoreBackup?: BackupRecord;
      }>('/backups/upload-restore', {
        method: 'POST',
        body: JSON.stringify({
          fileName: uploadCandidate.fileName,
          envelope: uploadCandidate.envelope,
          password: restorePassword,
          authoritative: true,
        }),
      });
      if (res.preRestoreBackup) {
        setLastPreRestoreBackup(res.preRestoreBackup);
      }
      onNotify(
        `Đã sao lưu mốc cũ và khôi phục từ file ${uploadCandidate.fileName} (Checksum hợp lệ: ${res.checksumVerified ? 'Có' : 'Không'}).`
      );
      setUploadCandidate(null);
      setRestorePassword('');
      await load();
    } catch (err) {
      setRestoreError((err as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    setRestoreError('');
    try {
      const res = await apiFetch<{
        restored: boolean;
        reconciledEvents: number;
        checksumVerified: boolean;
        preRestoreBackup?: BackupRecord;
      }>(`/backups/${restoreTarget.id}/restore`, {
        method: 'POST',
        body: JSON.stringify({
          password: restorePassword,
          authoritative: true,
        }),
      });
      if (res.preRestoreBackup) {
        setLastPreRestoreBackup(res.preRestoreBackup);
      }
      onNotify(
        `Khôi phục thành công (Checksum hợp lệ: ${res.checksumVerified ? 'Có' : 'Không'}). Đã tự động lưu mốc dự phòng trước khôi phục.`
      );
      setRestoreTarget(null);
      setRestorePassword('');
      await load();
    } catch (err) {
      setRestoreError((err as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Lưu trữ, Sao lưu &amp; Phục hồi dữ liệu</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Lưu trữ SQLite cục bộ hoàn toàn miễn phí, tạo và tải xuống file sao lưu mã hóa AES-256-GCM (.bcare) để lưu trên điện thoại/máy tính hoặc đám mây cá nhân và phục hồi mọi lúc.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer min-h-[42px] inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap">
            <Upload className="h-4 w-4 text-sky-700" />
            <span>Nạp file .bcare phục hồi</span>
            <input type="file" accept=".bcare,.json" onChange={handlePickUploadFile} className="hidden" />
          </label>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="min-h-[42px] inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-xs sm:text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60 whitespace-nowrap"
          >
            <DatabaseBackup className="h-4 w-4" />
            <span>{creating ? 'Đang mã hóa...' : 'Tạo bản sao lưu mới'}</span>
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 flex items-start gap-3 text-xs sm:text-sm text-slate-700">
        <ShieldCheck className="h-5 w-5 text-teal-700 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div>
            <strong>Kiến trúc lưu trữ miễn phí 100% &amp; an toàn:</strong> Dữ liệu vận hành lưu trực tiếp trên SQLite cục bộ; khuyến nghị bấm <strong>Tải về máy</strong> sau mỗi ca để lưu file <code>.bcare</code> mã hóa AES-256-GCM sang điện thoại, USB hoặc Google Drive cá nhân miễn phí.
          </div>
          <div className="text-xs text-slate-500">
            Quy trình khôi phục: Kiểm tra toàn vẹn SHA-256 -&gt; Giải mã AES-256-GCM -&gt; Khôi phục theo thứ tự khóa ngoại -&gt; Đối chiếu sự kiện mới nhất từ mạng P2P.
          </div>
        </div>
      </div>

      {lastPreRestoreBackup && (
        <div
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="text-xs text-amber-950">
            <strong>Hệ thống vừa tự lưu trạng thái trước khi khôi phục:</strong>{' '}
            <span className="font-mono">{lastPreRestoreBackup.backup_name}</span>. Nếu vừa chọn nhầm bản sao lưu, bấm hoàn tác ngay:
          </div>
          <button
            type="button"
            onClick={() => {
              setRestorePassword('');
              setRestoreError('');
              setRestoreTarget(lastPreRestoreBackup);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-800 whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Hoàn tác lần khôi phục vừa rồi</span>
          </button>
        </div>
      )}

      {/* Desktop Table */}
      <div className="hidden md:block rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Tên bản sao lưu</th>
                <th className="px-4 py-3 text-left font-medium">Thiết bị / Phiên bản</th>
                <th className="px-4 py-3 text-left font-medium">Checksum SHA-256</th>
                <th className="px-4 py-3 text-right font-medium">Bản ghi</th>
                <th className="px-4 py-3 text-left font-medium">Trạng thái</th>
                <th className="px-4 py-3 text-left font-medium">Thời gian</th>
                <th className="px-4 py-3 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {backups.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Chưa có bản sao lưu nào trên máy trạm này.</td></tr>
              ) : backups.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{b.backup_name}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{describeBackupOrigin(b.backup_name).label}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{b.device_id} · v{b.app_version}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-500 max-w-[150px] truncate">{b.checksum_sha256}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{b.record_count}</td>
                  <td className="px-4 py-3 text-xs font-semibold">
                    <span className={b.status === 'FAILED' ? 'text-rose-700' : b.status === 'RESTORED' ? 'text-sky-700' : 'text-emerald-700'}>
                      {b.status === 'SUCCESS' ? 'Hợp lệ (AES-256)' : b.status === 'RESTORED' ? 'Đã khôi phục' : 'Lỗi'}
                    </span>
                    {verifiedMap[b.id] && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-teal-700">
                        <CheckCircle2 className="h-3 w-3" /> Đã kiểm tra
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">{formatDateTimeVN(b.created_at)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleDownload(b)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Download className="h-3.5 w-3.5 text-sky-700" />
                        <span>Tải về</span>
                      </button>
                      <button
                        type="button"
                        disabled={verifyingId === b.id}
                        onClick={() => handleVerify(b)}
                        className="inline-flex items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-xs font-medium text-teal-800 hover:bg-teal-100 disabled:opacity-50"
                      >
                        <FileCheck2 className="h-3.5 w-3.5" />
                        <span>{verifyingId === b.id ? 'Đang kiểm...' : 'Kiểm tra'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRestorePassword('');
                          setRestoreError('');
                          setRestoreTarget(b);
                        }}
                        className="rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
                      >
                        Khôi phục
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Cards (< md) */}
      <div className="md:hidden space-y-3">
        {backups.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            Chưa có bản sao lưu nào trên máy trạm này.
          </div>
        ) : backups.map((b) => (
          <div key={b.id} className="rounded-xl border border-slate-200 bg-white p-4 space-y-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-xs text-slate-900 break-all">{b.backup_name}</div>
                <div className="font-mono text-[11px] text-slate-500 mt-0.5">{b.device_id} · {b.record_count} bản ghi</div>
              </div>
              <span className={`shrink-0 text-xs font-semibold ${b.status === 'FAILED' ? 'text-rose-700' : b.status === 'RESTORED' ? 'text-sky-700' : 'text-emerald-700'}`}>
                {b.status === 'SUCCESS' ? 'AES-256' : b.status === 'RESTORED' ? 'Đã khôi phục' : 'Lỗi'}
              </span>
            </div>
            <div className="font-mono text-[11px] text-slate-500">
              Tạo lúc: {formatDateTimeVN(b.created_at)}
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => handleDownload(b)}
                className="min-h-[42px] inline-flex items-center justify-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-700"
              >
                <Download className="h-3.5 w-3.5 text-sky-700" />
                <span>Tải về</span>
              </button>
              <button
                type="button"
                disabled={verifyingId === b.id}
                onClick={() => handleVerify(b)}
                className="min-h-[42px] inline-flex items-center justify-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2 py-1.5 text-xs font-medium text-teal-800"
              >
                <FileCheck2 className="h-3.5 w-3.5" />
                <span>Kiểm tra</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setRestorePassword('');
                  setRestoreError('');
                  setRestoreTarget(b);
                }}
                className="min-h-[42px] inline-flex items-center justify-center rounded-md bg-sky-700 px-2 py-1.5 text-xs font-semibold text-white"
              >
                Khôi phục
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmModal
        open={Boolean(restoreTarget)}
        title="Cảnh báo: Khôi phục dữ liệu từ bản sao lưu"
        description={`Khôi phục từ ${restoreTarget?.backup_name} (${restoreTarget?.record_count ?? 0} bản ghi)? Dữ liệu hiện tại trên cụm sẽ được thay thế bằng bản sao lưu này sau khi kiểm tra toàn vẹn SHA-256 và giải mã AES-256-GCM.`}
        autoBackupNote="An toàn chống ghi nhầm: Trước khi khôi phục, hệ thống sẽ tự động lưu lại một bản dự phòng (auto-pre-restore) của CSDL hiện tại để bạn có thể hoàn tác bất kỳ lúc nào."
        danger
        requirePassword
        passwordValue={restorePassword}
        onPasswordChange={setRestorePassword}
        errorMessage={restoreError}
        confirmLabel="Xác thực & Bắt đầu khôi phục"
        busy={restoring}
        onConfirm={handleRestore}
        onCancel={() => {
          if (!restoring) {
            setRestoreTarget(null);
            setRestoreError('');
          }
        }}
      />

      <ConfirmModal
        open={Boolean(uploadCandidate)}
        title="Cảnh báo: Khôi phục dữ liệu từ file .bcare tải lên"
        description={`Xác nhận giải mã & khôi phục dữ liệu từ file "${uploadCandidate?.fileName}" (SHA-256: ${uploadCandidate?.checksum.slice(0, 16)}...)?`}
        autoBackupNote="An toàn chống ghi nhầm: Trước khi nạp file mới đè lên CSDL hiện tại, hệ thống sẽ tự động tạo một bản sao lưu dự phòng (auto-pre-restore) để bạn hoàn tác nếu chọn nhầm file."
        danger
        requirePassword
        passwordValue={restorePassword}
        onPasswordChange={setRestorePassword}
        errorMessage={restoreError}
        confirmLabel="Xác thực & Nạp khôi phục"
        busy={restoring}
        onConfirm={handleConfirmUploadRestore}
        onCancel={() => {
          if (!restoring) {
            setUploadCandidate(null);
            setRestoreError('');
          }
        }}
      />
    </div>
  );
}

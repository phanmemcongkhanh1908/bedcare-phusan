export const CLEAR_DEMO_CONFIRM_PHRASE = 'XAC NHAN XOA DEMO';
export const PURGE_DB_CONFIRM_PHRASE = 'XOA DU LIEU CSDL';
export const RESTORE_SNAPSHOT_CONFIRM_PHRASE = 'KHOI PHUC DU LIEU';

export type DatabasePurgeScope = 'OPERATIONAL_ONLY' | 'OPERATIONAL_AND_HIS';

export function stripVietnameseDiacritics(input: string): string {
  return input
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeConfirmPhrase(input: string): string {
  return stripVietnameseDiacritics(input || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function matchesConfirmPhrase(input: string | undefined, expected: string): boolean {
  if (!input) return false;
  return normalizeConfirmPhrase(input) === normalizeConfirmPhrase(expected);
}

export function sanitizeBackupPrefix(prefix?: string): string {
  const cleaned = (prefix || 'bedcare-backup')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'bedcare-backup';
}

export function isAutoSafetyBackupName(backupName: string): boolean {
  return backupName.startsWith('auto-pre-');
}

export function describeBackupOrigin(backupName: string): {
  code: 'PRE_CLEAR_DEMO' | 'PRE_PURGE_DB' | 'PRE_RESTORE' | 'PRE_SEED_DEMO' | 'UPLOADED' | 'MANUAL';
  label: string;
} {
  if (backupName.startsWith('auto-pre-clear-demo')) {
    return { code: 'PRE_CLEAR_DEMO', label: 'Tự động lưu trước khi xóa Demo' };
  }
  if (backupName.startsWith('auto-pre-purge-db')) {
    return { code: 'PRE_PURGE_DB', label: 'Tự động lưu trước khi xóa CSDL' };
  }
  if (backupName.startsWith('auto-pre-restore')) {
    return { code: 'PRE_RESTORE', label: 'Tự động lưu trước khi khôi phục' };
  }
  if (backupName.startsWith('auto-pre-seed-demo')) {
    return { code: 'PRE_SEED_DEMO', label: 'Tự động lưu trước khi nạp Demo' };
  }
  if (backupName.includes('uploaded') || !backupName.startsWith('bedcare-backup-')) {
    return { code: 'UPLOADED', label: 'Bản nạp từ file .bcare' };
  }
  return { code: 'MANUAL', label: 'Sao lưu thủ công' };
}

import type { BedStatus, UserRole } from '../types/bedcare';

export const BED_STATUS_META: Record<
  BedStatus,
  { label: string; color: string; bg: string; border: string; dot: string }
> = {
  VACANT: {
    label: 'Trống',
    color: 'text-emerald-700',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    dot: 'bg-emerald-600',
  },
  RESERVED: {
    label: 'Đang giữ chỗ',
    color: 'text-amber-700',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    dot: 'bg-amber-500',
  },
  OCCUPIED: {
    label: 'Đang sử dụng',
    color: 'text-sky-700',
    bg: 'bg-sky-50',
    border: 'border-sky-200',
    dot: 'bg-sky-600',
  },
  PENDING_CONFIRMATION: {
    label: 'Chờ xác nhận',
    color: 'text-orange-700',
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    dot: 'bg-orange-500',
  },
  PENDING_CLEANING: {
    label: 'Chờ vệ sinh',
    color: 'text-teal-700',
    bg: 'bg-teal-50',
    border: 'border-teal-200',
    dot: 'bg-teal-600',
  },
  CLEANING: {
    label: 'Đang vệ sinh',
    color: 'text-cyan-700',
    bg: 'bg-cyan-50',
    border: 'border-cyan-200',
    dot: 'bg-cyan-600',
  },
  MAINTENANCE: {
    label: 'Bảo trì',
    color: 'text-rose-700',
    bg: 'bg-rose-50',
    border: 'border-rose-200',
    dot: 'bg-rose-600',
  },
  INACTIVE: {
    label: 'Ngừng hoạt động',
    color: 'text-slate-600',
    bg: 'bg-slate-100',
    border: 'border-slate-300',
    dot: 'bg-slate-400',
  },
};

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin hệ thống',
  CASHIER: 'Nhân viên thu viện phí',
  WARD_STAFF: 'Nhân viên khoa nội trú',
  EXECUTIVE: 'Lãnh đạo / Báo cáo',
};

export function formatDateTimeVN(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateVN(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function toLocalDateTimeInputValue(input?: Date | string | null): string {
  const d = input ? (input instanceof Date ? input : new Date(input)) : new Date();
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date();
    return new Date(fallback.getTime() - fallback.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

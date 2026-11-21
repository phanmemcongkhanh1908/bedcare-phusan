import type { BedStatus } from '../types/bedcare';
import { BED_STATUS_META } from '../utils/formatters';

interface BedStatusBadgeProps {
  status: BedStatus;
  compact?: boolean;
}

export function BedStatusBadge({ status, compact = false }: BedStatusBadgeProps) {
  const meta = BED_STATUS_META[status] ?? BED_STATUS_META.VACANT;
  return (
    <span
      className={`inline-flex items-center font-semibold whitespace-nowrap ${
        compact ? 'text-xs' : 'text-xs px-2 py-0.5 rounded border'
      } ${compact ? meta.color : `${meta.color} ${meta.bg} ${meta.border}`}`}
    >
      {meta.label}
    </span>
  );
}

export type PrintOrientation = 'portrait' | 'landscape';
export type PrintMarginPreset = 'narrow' | 'standard' | 'wide' | 'custom';

export interface PrintPreviewColumn {
  key: string;
  label: string;
  defaultVisible?: boolean;
  locked?: boolean;
}

export const PRINT_MARGIN_MIN_MM = 4;
export const PRINT_MARGIN_MAX_MM = 25;
export const DEFAULT_PRINT_MARGIN_MM = 10;

export const PRINT_MARGIN_PRESETS: ReadonlyArray<{
  id: Exclude<PrintMarginPreset, 'custom'>;
  label: string;
  shortLabel: string;
  marginMm: number;
}> = [
  { id: 'narrow', label: 'Hẹp (6mm)', shortLabel: 'Hẹp', marginMm: 6 },
  { id: 'standard', label: 'Chuẩn (10mm)', shortLabel: 'Chuẩn', marginMm: 10 },
  { id: 'wide', label: 'Rộng (16mm)', shortLabel: 'Rộng', marginMm: 16 },
];

export const PRINT_ZOOM_LEVELS = [75, 90, 100, 115] as const;
export type PrintZoomLevel = (typeof PRINT_ZOOM_LEVELS)[number];

export function clampMarginMm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PRINT_MARGIN_MM;
  const rounded = Math.round(value);
  return Math.min(PRINT_MARGIN_MAX_MM, Math.max(PRINT_MARGIN_MIN_MM, rounded));
}

export function resolveMarginPreset(marginMm: number): PrintMarginPreset {
  const normalized = clampMarginMm(marginMm);
  const found = PRINT_MARGIN_PRESETS.find((preset) => preset.marginMm === normalized);
  return found ? found.id : 'custom';
}

export function buildInitialColumnVisibility(
  columns: readonly PrintPreviewColumn[]
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const col of columns) {
    result[col.key] = col.locked ? true : col.defaultVisible !== false;
  }
  return result;
}

export function showAllColumns(columns: readonly PrintPreviewColumn[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const col of columns) {
    result[col.key] = true;
  }
  return result;
}

export function countVisibleColumns(
  visibility: Record<string, boolean>,
  columns: readonly PrintPreviewColumn[]
): number {
  return columns.reduce((acc, col) => {
    const visible = col.locked ? true : visibility[col.key] !== false;
    return acc + (visible ? 1 : 0);
  }, 0);
}

export function toggleColumnVisibility(
  visibility: Record<string, boolean>,
  columns: readonly PrintPreviewColumn[],
  key: string
): Record<string, boolean> {
  const target = columns.find((col) => col.key === key);
  if (!target || target.locked) {
    return visibility;
  }

  const currentlyVisible = visibility[key] !== false;
  if (currentlyVisible && countVisibleColumns(visibility, columns) <= 1) {
    // Keep at least one column visible so the printed sheet is never blank
    return visibility;
  }

  return {
    ...visibility,
    [key]: !currentlyVisible,
  };
}

export function buildPrintPageCss(orientation: PrintOrientation, marginMm: number): string {
  const safeOrientation: PrintOrientation = orientation === 'landscape' ? 'landscape' : 'portrait';
  const safeMargin = clampMarginMm(marginMm);
  return `@page { size: A4 ${safeOrientation}; margin: ${safeMargin}mm; }`;
}

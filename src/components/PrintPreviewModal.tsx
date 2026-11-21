import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Columns3,
  Download,
  Maximize2,
  Minus,
  Plus,
  Printer,
  RotateCcw,
  Ruler,
  X,
} from 'lucide-react';
import {
  buildInitialColumnVisibility,
  buildPrintPageCss,
  clampMarginMm,
  countVisibleColumns,
  DEFAULT_PRINT_MARGIN_MM,
  PRINT_MARGIN_MAX_MM,
  PRINT_MARGIN_MIN_MM,
  PRINT_MARGIN_PRESETS,
  PRINT_ZOOM_LEVELS,
  resolveMarginPreset,
  showAllColumns,
  toggleColumnVisibility,
  type PrintOrientation,
  type PrintPreviewColumn,
  type PrintZoomLevel,
} from '../utils/printPreviewConfig';

export type { PrintOrientation, PrintPreviewColumn };

export interface PrintPreviewRenderContext {
  orientation: PrintOrientation;
  marginMm: number;
  zoomPct: PrintZoomLevel;
  visibleColumns: Record<string, boolean>;
  isColumnVisible: (key: string) => boolean;
  visibleColumnCount: number;
}

interface PrintPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  defaultOrientation?: PrintOrientation;
  allowOrientationToggle?: boolean;
  defaultMarginMm?: number;
  allowMarginAdjust?: boolean;
  columns?: PrintPreviewColumn[];
  onExportPdf?: (ctx: PrintPreviewRenderContext) => void | Promise<void>;
  exportingPdf?: boolean;
  extraToolbarControls?: React.ReactNode;
  maxWidthClass?: string;
  children: React.ReactNode | ((ctx: PrintPreviewRenderContext) => React.ReactNode);
}

export function PrintPreviewModal({
  isOpen,
  onClose,
  title,
  subtitle,
  defaultOrientation = 'portrait',
  allowOrientationToggle = true,
  defaultMarginMm = DEFAULT_PRINT_MARGIN_MM,
  allowMarginAdjust = true,
  columns,
  onExportPdf,
  exportingPdf = false,
  extraToolbarControls,
  maxWidthClass,
  children,
}: PrintPreviewModalProps) {
  const [orientation, setOrientation] = useState<PrintOrientation>(defaultOrientation);
  const [marginMm, setMarginMm] = useState<number>(clampMarginMm(defaultMarginMm));
  const [zoomPct, setZoomPct] = useState<PrintZoomLevel>(100);
  const [showMarginGuide, setShowMarginGuide] = useState<boolean>(true);
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState<boolean>(false);
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(() =>
    columns ? buildInitialColumnVisibility(columns) : {}
  );

  const popoverRef = useRef<HTMLDivElement | null>(null);

  const columnsSignature = useMemo(
    () => (columns ?? []).map((c) => `${c.key}:${c.defaultVisible !== false}:${Boolean(c.locked)}`).join('|'),
    [columns]
  );

  useEffect(() => {
    if (!isOpen) return;
    setOrientation(defaultOrientation);
    setMarginMm(clampMarginMm(defaultMarginMm));
    setZoomPct(100);
    setColumnsPopoverOpen(false);
  }, [defaultOrientation, defaultMarginMm, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setVisibleColumns(columns ? buildInitialColumnVisibility(columns) : {});
  }, [columnsSignature, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    document.body.classList.add('bedcare-print-preview-open');
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (columnsPopoverOpen) {
          setColumnsPopoverOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.classList.remove('bedcare-print-preview-open');
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, columnsPopoverOpen]);

  useEffect(() => {
    if (!columnsPopoverOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setColumnsPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [columnsPopoverOpen]);

  if (!isOpen || typeof document === 'undefined') return null;

  const sheetWidthClass =
    maxWidthClass ?? (orientation === 'landscape' ? 'max-w-[1060px]' : 'max-w-[794px]');

  const activeMarginPreset = resolveMarginPreset(marginMm);
  const totalColumnCount = columns?.length ?? 0;
  const visibleColumnCount = columns ? countVisibleColumns(visibleColumns, columns) : 0;

  const isColumnVisible = (key: string): boolean => {
    if (!columns || columns.length === 0) return true;
    const colDef = columns.find((c) => c.key === key);
    if (colDef?.locked) return true;
    return visibleColumns[key] !== false;
  };

  const renderContext: PrintPreviewRenderContext = {
    orientation,
    marginMm,
    zoomPct,
    visibleColumns,
    isColumnVisible,
    visibleColumnCount,
  };

  const renderedChildren = typeof children === 'function' ? children(renderContext) : children;

  return createPortal(
    <div
      className="bedcare-print-preview-root fixed inset-0 z-50 flex flex-col bg-slate-900/70 backdrop-blur-[1px] print:static print:bg-white"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Dynamic Print Page Orientation & Printer Margins Rule */}
      <style media="print">{buildPrintPageCss(orientation, marginMm)}</style>

      {/* Top Print Preview Toolbar */}
      <header className="no-print shrink-0 border-b border-slate-700 bg-slate-900 text-white">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm sm:text-base font-semibold text-white truncate">{title}</h3>
            {subtitle && (
              <p className="text-xs text-slate-300 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {extraToolbarControls}

            {/* Column / Section Visibility Control */}
            {columns && columns.length > 0 && (
              <div className="relative" ref={popoverRef}>
                <button
                  type="button"
                  onClick={() => setColumnsPopoverOpen((prev) => !prev)}
                  aria-expanded={columnsPopoverOpen}
                  aria-label="Tùy chỉnh cột và mục hiển thị khi in"
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                    columnsPopoverOpen
                      ? 'border-sky-400 bg-sky-900/70 text-white'
                      : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
                  }`}
                >
                  <Columns3 className="h-3.5 w-3.5 text-sky-400" />
                  <span>
                    Cột hiển thị ({visibleColumnCount}/{totalColumnCount})
                  </span>
                </button>

                {columnsPopoverOpen && (
                  <div
                    role="region"
                    aria-label="Tùy chọn cột hiển thị khi in"
                    className="absolute left-0 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl p-3 z-50 space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                      <span className="text-xs font-semibold text-white whitespace-nowrap">
                        Chọn cột / mục cần in
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => setVisibleColumns(showAllColumns(columns))}
                          className="text-[11px] font-medium text-sky-400 hover:text-sky-300 whitespace-nowrap"
                        >
                          Hiện tất cả
                        </button>
                        <span className="text-slate-600">·</span>
                        <button
                          type="button"
                          onClick={() => setVisibleColumns(buildInitialColumnVisibility(columns))}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-300 hover:text-white whitespace-nowrap"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Mặc định</span>
                        </button>
                      </div>
                    </div>

                    <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                      {columns.map((col) => {
                        const checked = isColumnVisible(col.key);
                        const isLastVisible = checked && visibleColumnCount <= 1;
                        return (
                          <label
                            key={col.key}
                            className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs ${
                              col.locked || isLastVisible
                                ? 'opacity-80 cursor-not-allowed bg-slate-800/40'
                                : 'cursor-pointer hover:bg-slate-800'
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={col.locked || isLastVisible}
                                onChange={() =>
                                  setVisibleColumns((prev) =>
                                    toggleColumnVisibility(prev, columns, col.key)
                                  )
                                }
                                className="rounded border-slate-500 bg-slate-800 text-sky-500"
                              />
                              <span className="truncate text-slate-100">{col.label}</span>
                            </span>
                            {col.locked && (
                              <span className="text-[10px] font-medium text-slate-400 shrink-0">
                                Bắt buộc
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Printer Margin Presets & Stepper */}
            {allowMarginAdjust && (
              <div
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-xs"
                role="group"
                aria-label="Điều chỉnh lề trang in"
              >
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-300 px-1 whitespace-nowrap">
                  <Ruler className="h-3 w-3 text-sky-400" />
                  <span className="hidden sm:inline">Lề:</span>
                </span>
                {PRINT_MARGIN_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setMarginMm(preset.marginMm)}
                    title={preset.label}
                    className={`rounded px-2 py-1 font-medium whitespace-nowrap transition-colors ${
                      activeMarginPreset === preset.id
                        ? 'bg-white text-slate-900'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {preset.shortLabel}
                  </button>
                ))}
                <div className="h-4 w-px bg-slate-700 mx-0.5" />
                <button
                  type="button"
                  onClick={() => setMarginMm((m) => clampMarginMm(m - 1))}
                  disabled={marginMm <= PRINT_MARGIN_MIN_MM}
                  aria-label="Giảm lề trang"
                  className="rounded p-1 text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-40"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <span
                  className="font-mono tabular-nums text-[11px] font-semibold text-white min-w-[34px] text-center"
                  aria-label="Lề trang hiện tại"
                >
                  {marginMm}mm
                </span>
                <button
                  type="button"
                  onClick={() => setMarginMm((m) => clampMarginMm(m + 1))}
                  disabled={marginMm >= PRINT_MARGIN_MAX_MM}
                  aria-label="Tăng lề trang"
                  className="rounded p-1 text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* Orientation Switcher */}
            {allowOrientationToggle && (
              <div
                className="inline-flex rounded-md border border-slate-700 bg-slate-800 p-0.5 text-xs"
                role="group"
                aria-label="Khổ giấy in"
              >
                <button
                  type="button"
                  onClick={() => setOrientation('portrait')}
                  className={`rounded px-2.5 py-1.5 font-medium whitespace-nowrap transition-colors ${
                    orientation === 'portrait'
                      ? 'bg-white text-slate-900'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  A4 Dọc
                </button>
                <button
                  type="button"
                  onClick={() => setOrientation('landscape')}
                  className={`rounded px-2.5 py-1.5 font-medium whitespace-nowrap transition-colors ${
                    orientation === 'landscape'
                      ? 'bg-white text-slate-900'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  A4 Ngang
                </button>
              </div>
            )}

            {/* Preview Zoom & Margin Boundary Verification */}
            <div className="hidden md:inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs">
              <Maximize2 className="h-3 w-3 text-slate-400" />
              <select
                value={zoomPct}
                onChange={(e) => setZoomPct(Number(e.target.value) as PrintZoomLevel)}
                aria-label="Tỷ lệ phóng xem trước"
                className="bg-transparent text-xs font-mono text-slate-100 focus:outline-none cursor-pointer"
              >
                {PRINT_ZOOM_LEVELS.map((z) => (
                  <option key={z} value={z} className="bg-slate-900 text-white">
                    {z}%
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => setShowMarginGuide((prev) => !prev)}
              aria-pressed={showMarginGuide}
              title="Bật/tắt đường kẻ căn lề bản in (không in ra giấy)"
              className={`hidden sm:inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                showMarginGuide
                  ? 'border-sky-500/60 bg-sky-950/60 text-sky-200'
                  : 'border-slate-700 bg-slate-800 text-slate-300 hover:text-white'
              }`}
            >
              <span>Khung lề</span>
            </button>

            {onExportPdf && (
              <button
                type="button"
                disabled={exportingPdf}
                onClick={() => onExportPdf(renderContext)}
                className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/50 bg-sky-900/60 px-3 py-1.5 text-xs font-semibold text-sky-100 hover:bg-sky-800 whitespace-nowrap disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{exportingPdf ? 'Đang tạo PDF...' : 'Xuất PDF'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 whitespace-nowrap"
            >
              <Printer className="h-3.5 w-3.5" />
              <span>In ngay (Print)</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng xem trước bản in"
              className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
            >
              <X className="h-3.5 w-3.5" />
              <span>Đóng</span>
            </button>
          </div>
        </div>

        {/* Live Print Configuration Verification Strip */}
        <div className="border-t border-slate-800 bg-slate-950/70 px-4 sm:px-6 py-1.5">
          <div className="max-w-[1280px] mx-auto flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
              <span>Khổ: {orientation === 'landscape' ? 'A4 Ngang (297×210mm)' : 'A4 Dọc (210×297mm)'}</span>
              <span>·</span>
              <span>Lề máy in: {marginMm}mm</span>
              {columns && columns.length > 0 && (
                <>
                  <span>·</span>
                  <span>
                    Hiển thị: {visibleColumnCount}/{totalColumnCount} cột/mục
                  </span>
                </>
              )}
            </div>
            <span className="text-slate-400">
              Kiểm tra bố cục, lề giấy và cột cần in trước khi gửi lệnh đến máy in vật lý.
            </span>
          </div>
        </div>
      </header>

      {/* Scrollable A4 Paper Desk Area */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-6 lg:p-8 print:overflow-visible print:p-0">
        <div
          className={`bedcare-print-sheet mx-auto w-full ${sheetWidthClass} bg-white text-slate-900 border border-slate-300 shadow-2xl rounded-sm print:rounded-none print:border-0 print:shadow-none print:p-0 print:max-w-none transition-[padding,max-width] duration-150`}
          style={{
            padding: `${marginMm}mm`,
            zoom: zoomPct !== 100 ? `${zoomPct}%` : undefined,
          }}
        >
          <div
            className={
              showMarginGuide
                ? 'border border-dashed border-sky-300/80 p-2 print:border-0 print:p-0'
                : ''
            }
          >
            {renderedChildren}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInitialColumnVisibility,
  buildPrintPageCss,
  clampMarginMm,
  countVisibleColumns,
  resolveMarginPreset,
  showAllColumns,
  toggleColumnVisibility,
  type PrintPreviewColumn,
} from '../src/utils/printPreviewConfig';

const SAMPLE_COLUMNS: PrintPreviewColumn[] = [
  { key: 'stt', label: 'STT', locked: true },
  { key: 'bed', label: 'Giường' },
  { key: 'patient', label: 'Bệnh nhân' },
  { key: 'notes', label: 'Ghi chú', defaultVisible: false },
];

test('clampMarginMm enforces 4mm–25mm bounds and handles invalid input', () => {
  assert.equal(clampMarginMm(10), 10);
  assert.equal(clampMarginMm(1), 4);
  assert.equal(clampMarginMm(40), 25);
  assert.equal(clampMarginMm(12.6), 13);
  assert.equal(clampMarginMm(Number.NaN), 10);
  assert.equal(resolveMarginPreset(6), 'narrow');
  assert.equal(resolveMarginPreset(10), 'standard');
  assert.equal(resolveMarginPreset(16), 'wide');
  assert.equal(resolveMarginPreset(13), 'custom');
});

test('column visibility respects defaultVisible, locked columns, and minimum 1 visible column', () => {
  const initial = buildInitialColumnVisibility(SAMPLE_COLUMNS);
  assert.deepEqual(initial, {
    stt: true,
    bed: true,
    patient: true,
    notes: false,
  });
  assert.equal(countVisibleColumns(initial, SAMPLE_COLUMNS), 3);

  // Locked column cannot be hidden
  const afterLockedAttempt = toggleColumnVisibility(initial, SAMPLE_COLUMNS, 'stt');
  assert.equal(afterLockedAttempt.stt, true);

  // Toggle optional column on and non-locked columns off until 1 remains
  const withNotes = toggleColumnVisibility(initial, SAMPLE_COLUMNS, 'notes');
  assert.equal(withNotes.notes, true);
  assert.equal(countVisibleColumns(withNotes, SAMPLE_COLUMNS), 4);

  let reduced = toggleColumnVisibility(withNotes, SAMPLE_COLUMNS, 'bed');
  reduced = toggleColumnVisibility(reduced, SAMPLE_COLUMNS, 'patient');
  reduced = toggleColumnVisibility(reduced, SAMPLE_COLUMNS, 'notes');
  assert.equal(countVisibleColumns(reduced, SAMPLE_COLUMNS), 1);

  // Show all restores every column
  const allVisible = showAllColumns(SAMPLE_COLUMNS);
  assert.equal(countVisibleColumns(allVisible, SAMPLE_COLUMNS), 4);

  // When no columns are locked, cannot hide the last remaining column
  const unlockedCols: PrintPreviewColumn[] = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
  ];
  const oneLeft = toggleColumnVisibility({ a: true, b: true }, unlockedCols, 'a');
  const blockedLast = toggleColumnVisibility(oneLeft, unlockedCols, 'b');
  assert.equal(blockedLast.b, true);
});

test('buildPrintPageCss generates valid @page orientation and clamped margin rules', () => {
  assert.equal(buildPrintPageCss('landscape', 16), '@page { size: A4 landscape; margin: 16mm; }');
  assert.equal(buildPrintPageCss('portrait', 2), '@page { size: A4 portrait; margin: 4mm; }');
});

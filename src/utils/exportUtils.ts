import ExcelJS from 'exceljs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface ExportColumn {
  header: string;
  key: string;
  width?: number;
}

export interface OfficialDocumentOptions {
  facilityBanner?: string;
  departmentBanner?: string;
  documentCode?: string;
  scopeLabel?: string;
  preparedBy?: string;
  signers?: [string, string, string];
  issuedAt?: Date;
}

export interface OfficialDocumentMeta {
  facilityBanner: string;
  departmentBanner: string;
  nationalMotto: string;
  nationalSubMotto: string;
  documentCode: string;
  vietnameseDateLine: string;
  issuedAtLabel: string;
  scopeLabel: string;
  preparedBy: string;
  signers: [string, string, string];
  signerNote: string;
}

export function buildOfficialDocumentMeta(options?: OfficialDocumentOptions): OfficialDocumentMeta {
  const dt = options?.issuedAt ?? new Date();
  const day = String(dt.getDate()).padStart(2, '0');
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const year = dt.getFullYear();

  return {
    facilityBanner: options?.facilityBanner ?? 'BỆNH VIỆN ĐA KHOA',
    departmentBanner: options?.departmentBanner ?? 'HỆ THỐNG ĐIỀU PHỐI GIƯỜNG BỆNH BEDCARE',
    nationalMotto: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
    nationalSubMotto: 'Độc lập - Tự do - Hạnh phúc',
    documentCode: options?.documentCode ?? `BC-${year}${month}${day}`,
    vietnameseDateLine: `Ngày ${day} tháng ${month} năm ${year}`,
    issuedAtLabel: dt.toLocaleString('vi-VN'),
    scopeLabel: options?.scopeLabel ?? 'Toàn viện',
    preparedBy: options?.preparedBy ?? 'Điều phối viên giường bệnh',
    signers: options?.signers ?? [
      'Người lập biểu',
      'Điều phối viên giường bệnh',
      'Trưởng khoa / Lãnh đạo duyệt',
    ],
    signerNote: '(Ký, ghi rõ họ tên)',
  };
}

export async function buildOfficialExcelWorkbook(
  sheetName: string,
  title: string,
  subtitle: string,
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>,
  options?: OfficialDocumentOptions
): Promise<ExcelJS.Workbook> {
  const meta = buildOfficialDocumentMeta({ ...options, scopeLabel: options?.scopeLabel ?? subtitle });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BEDCARE';
  wb.created = options?.issuedAt ?? new Date();
  const sheet = wb.addWorksheet(sheetName.slice(0, 31));

  const colCount = Math.max(4, columns.length);
  const splitCol = Math.max(2, Math.floor(colCount / 2));

  // Set column widths cleanly
  columns.forEach((c, idx) => {
    sheet.getColumn(idx + 1).width = c.width ?? 22;
  });

  // Row 1-2: Administrative Header Banner & National Motto (Nghị định 30/2020/NĐ-CP)
  sheet.mergeCells(1, 1, 1, splitCol);
  sheet.mergeCells(1, splitCol + 1, 1, colCount);
  sheet.getCell(1, 1).value = meta.facilityBanner;
  sheet.getCell(1, 1).font = { bold: true, size: 10, color: { argb: 'FF0F172A' } };
  sheet.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.getCell(1, splitCol + 1).value = meta.nationalMotto;
  sheet.getCell(1, splitCol + 1).font = { bold: true, size: 10, color: { argb: 'FF0F172A' } };
  sheet.getCell(1, splitCol + 1).alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.mergeCells(2, 1, 2, splitCol);
  sheet.mergeCells(2, splitCol + 1, 2, colCount);
  sheet.getCell(2, 1).value = meta.departmentBanner;
  sheet.getCell(2, 1).font = { bold: true, size: 10, color: { argb: 'FF0369A1' } };
  sheet.getCell(2, 1).alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.getCell(2, splitCol + 1).value = meta.nationalSubMotto;
  sheet.getCell(2, splitCol + 1).font = { bold: true, underline: true, size: 10, color: { argb: 'FF0F172A' } };
  sheet.getCell(2, splitCol + 1).alignment = { horizontal: 'center', vertical: 'middle' };

  // Row 3: Document Code & Date line
  sheet.mergeCells(3, 1, 3, splitCol);
  sheet.mergeCells(3, splitCol + 1, 3, colCount);
  sheet.getCell(3, 1).value = `Số hiệu: ${meta.documentCode}`;
  sheet.getCell(3, 1).font = { italic: true, size: 9, color: { argb: 'FF475569' } };
  sheet.getCell(3, 1).alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.getCell(3, splitCol + 1).value = meta.vietnameseDateLine;
  sheet.getCell(3, splitCol + 1).font = { italic: true, size: 9, color: { argb: 'FF475569' } };
  sheet.getCell(3, splitCol + 1).alignment = { horizontal: 'center', vertical: 'middle' };

  // Row 5: Title
  sheet.mergeCells(5, 1, 5, colCount);
  sheet.getCell(5, 1).value = title.toUpperCase();
  sheet.getCell(5, 1).font = { bold: true, size: 13, color: { argb: 'FF0C4A6E' } };
  sheet.getCell(5, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(5).height = 24;

  // Row 6: Scope / Subtitle / Export Timestamp
  sheet.mergeCells(6, 1, 6, colCount);
  sheet.getCell(6, 1).value = `Phạm vi: ${meta.scopeLabel} · Ngày lập: ${meta.issuedAtLabel} · Tổng số dòng: ${rows.length}`;
  sheet.getCell(6, 1).font = { italic: true, size: 9.5, color: { argb: 'FF475569' } };
  sheet.getCell(6, 1).alignment = { horizontal: 'center', vertical: 'middle' };

  // Row 8: Table Headers
  const headerRowIdx = 8;
  const headerRow = sheet.getRow(headerRowIdx);
  headerRow.height = 24;
  columns.forEach((c, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = c.header;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0369A1' },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FF0369A1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
  });

  // Data Rows
  rows.forEach((r, rowOffset) => {
    const dataRow = sheet.getRow(headerRowIdx + 1 + rowOffset);
    columns.forEach((c, colIdx) => {
      const cell = dataRow.getCell(colIdx + 1);
      const rawVal = r[c.key];
      cell.value = rawVal === undefined || rawVal === null || rawVal === '' ? '—' : rawVal;
      cell.font = { size: 10, color: { argb: 'FF1E293B' } };
      cell.alignment = {
        horizontal: typeof rawVal === 'number' ? 'right' : 'left',
        vertical: 'middle',
        wrapText: true,
      };
      if (rowOffset % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    });
  });

  // Signature Block below table
  const sigStartRow = headerRowIdx + rows.length + 2;
  sheet.mergeCells(sigStartRow, Math.max(1, colCount - 1), sigStartRow, colCount);
  sheet.getCell(sigStartRow, Math.max(1, colCount - 1)).value = meta.vietnameseDateLine;
  sheet.getCell(sigStartRow, Math.max(1, colCount - 1)).font = { italic: true, size: 9.5 };
  sheet.getCell(sigStartRow, Math.max(1, colCount - 1)).alignment = { horizontal: 'center' };

  const signerCols = [
    1,
    Math.max(2, Math.ceil(colCount / 2)),
    Math.max(3, colCount),
  ];
  meta.signers.forEach((signerTitle, idx) => {
    const col = Math.min(colCount, signerCols[idx]);
    const titleCell = sheet.getCell(sigStartRow + 1, col);
    titleCell.value = signerTitle.toUpperCase();
    titleCell.font = { bold: true, size: 9.5, color: { argb: 'FF0F172A' } };
    titleCell.alignment = { horizontal: 'center' };

    const noteCell = sheet.getCell(sigStartRow + 2, col);
    noteCell.value = meta.signerNote;
    noteCell.font = { italic: true, size: 8.5, color: { argb: 'FF64748B' } };
    noteCell.alignment = { horizontal: 'center' };
  });

  return wb;
}

export async function exportToExcel(
  fileName: string,
  sheetName: string,
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>,
  options?: OfficialDocumentOptions & { title?: string; subtitle?: string }
) {
  const wb = await buildOfficialExcelWorkbook(
    sheetName,
    options?.title ?? sheetName,
    options?.subtitle ?? 'Báo cáo tổng hợp điều phối giường bệnh',
    columns,
    rows,
    options
  );
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

let cachedFontBase64: { normal: string; bold: string } | null = null;

export async function loadDejaVuFonts(): Promise<{ normal: string; bold: string } | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return null;
  if (cachedFontBase64) return cachedFontBase64;
  try {
    const [normRes, boldRes] = await Promise.all([
      fetch('/fonts/DejaVuSans.ttf'),
      fetch('/fonts/DejaVuSans-Bold.ttf'),
    ]);
    if (!normRes.ok || !boldRes.ok) return null;
    const [normBuf, boldBuf] = await Promise.all([normRes.arrayBuffer(), boldRes.arrayBuffer()]);
    cachedFontBase64 = {
      normal: arrayBufferToBase64(normBuf),
      bold: arrayBufferToBase64(boldBuf),
    };
    return cachedFontBase64;
  } catch {
    return null;
  }
}

export async function buildOfficialPdfDoc(
  title: string,
  subtitle: string,
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>,
  options?: OfficialDocumentOptions
): Promise<jsPDF> {
  const meta = buildOfficialDocumentMeta({ ...options, scopeLabel: options?.scopeLabel ?? subtitle });
  const isLandscape = columns.length > 5;
  const doc = new jsPDF({ orientation: isLandscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const fonts = await loadDejaVuFonts();

  let fontName = 'helvetica';
  if (fonts) {
    doc.addFileToVFS('DejaVuSans.ttf', fonts.normal);
    doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
    doc.addFileToVFS('DejaVuSans-Bold.ttf', fonts.bold);
    doc.addFont('DejaVuSans-Bold.ttf', 'DejaVuSans', 'bold');
    fontName = 'DejaVuSans';
    doc.setFont('DejaVuSans', 'bold');
  } else {
    doc.setFont('helvetica', 'bold');
  }

  // Left: Facility Banner; Right: National Motto
  const leftCenterX = 56;
  const rightCenterX = pageWidth - 62;

  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text(meta.facilityBanner, leftCenterX, 13, { align: 'center' });
  doc.text(meta.nationalMotto, rightCenterX, 13, { align: 'center' });

  doc.setFontSize(9);
  doc.setTextColor(3, 105, 161);
  doc.text(meta.departmentBanner, leftCenterX, 18, { align: 'center' });

  doc.setTextColor(15, 23, 42);
  doc.text(meta.nationalSubMotto, rightCenterX, 18, { align: 'center' });
  doc.setLineWidth(0.35);
  doc.line(rightCenterX - 24, 19.5, rightCenterX + 24, 19.5);

  if (fonts) doc.setFont('DejaVuSans', 'normal');
  else doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.2);
  doc.setTextColor(71, 85, 105);
  doc.text(`Số: ${meta.documentCode}`, leftCenterX, 23.5, { align: 'center' });
  doc.text(meta.vietnameseDateLine, rightCenterX, 23.5, { align: 'center' });

  // Horizontal rule
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  doc.line(14, 26.5, pageWidth - 14, 26.5);

  // Main Document Title & Metadata
  if (fonts) doc.setFont('DejaVuSans', 'bold');
  else doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(12, 74, 110);
  doc.text(title.toUpperCase(), pageWidth / 2, 33.5, { align: 'center' });

  if (fonts) doc.setFont('DejaVuSans', 'normal');
  else doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.8);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Phạm vi: ${meta.scopeLabel} · Thời điểm xuất: ${meta.issuedAtLabel}`,
    pageWidth / 2,
    39,
    { align: 'center' }
  );

  autoTable(doc, {
    startY: 43,
    margin: { left: 14, right: 14, bottom: 20 },
    head: [columns.map((c) => c.header)],
    body: rows.map((r) => columns.map((c) => String(r[c.key] ?? '—'))),
    styles: {
      font: fontName,
      fontSize: 8.2,
      cellPadding: 2.3,
      textColor: [30, 41, 59],
      lineColor: [203, 213, 225],
      lineWidth: 0.2,
    },
    headStyles: {
      font: fontName,
      fillColor: [3, 105, 161],
      textColor: 255,
      fontStyle: 'bold',
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
  });

  let finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 60;
  if (finalY > pageHeight - 48) {
    doc.addPage();
    finalY = 20;
  }

  const sigDateY = finalY + 9;
  const sigTitleY = sigDateY + 6;
  const sigNoteY = sigTitleY + 4.5;

  if (fonts) doc.setFont('DejaVuSans', 'normal');
  else doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.text(meta.vietnameseDateLine, pageWidth - 36, sigDateY, { align: 'center' });

  const colPositions = [pageWidth * 0.2, pageWidth * 0.5, pageWidth * 0.82];
  meta.signers.forEach((signer, idx) => {
    if (fonts) doc.setFont('DejaVuSans', 'bold');
    else doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(signer.toUpperCase(), colPositions[idx], sigTitleY, { align: 'center' });

    if (fonts) doc.setFont('DejaVuSans', 'normal');
    else doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(meta.signerNote, colPositions[idx], sigNoteY, { align: 'center' });
  });

  // Page numbering footer
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    if (fonts) doc.setFont('DejaVuSans', 'normal');
    else doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `${meta.departmentBanner} · Trang ${p}/${totalPages}`,
      pageWidth / 2,
      pageHeight - 8,
      { align: 'center' }
    );
  }

  return doc;
}

export async function exportToPdf(
  fileName: string,
  title: string,
  subtitle: string,
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>,
  options?: OfficialDocumentOptions
) {
  const doc = await buildOfficialPdfDoc(title, subtitle, columns, rows, options);
  doc.save(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`);
}

export function escapeCsvCell(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvString(
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>
): string {
  const headerLine = columns.map((c) => escapeCsvCell(c.header)).join(',');
  const dataLines = rows.map((r) => columns.map((c) => escapeCsvCell(r[c.key])).join(','));
  return '\uFEFF' + [headerLine, ...dataLines].join('\r\n');
}

export function exportToCsv(
  fileName: string,
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>
) {
  const csv = buildCsvString(columns, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportHandoverPdf(
  fileName: string,
  filterSummary: string,
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>
) {
  const doc = await buildOfficialPdfDoc(
    'PHIẾU BÀN GIAO CA ĐIỀU PHỐI GIƯỜNG BỆNH NỘI TRÚ',
    filterSummary,
    columns,
    rows,
    {
      documentCode: `BG-CA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      signers: [
        'Điều dưỡng / ĐPV giao ca',
        'Điều dưỡng / ĐPV nhận ca',
        'Trưởng khoa / Điều dưỡng trưởng',
      ],
    }
  );
  doc.save(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`);
}

export async function exportBedSummaryPdf(
  fileName: string,
  filterSummary: string,
  columns: ExportColumn[],
  rows: Array<Record<string, string | number | null | undefined>>
) {
  const doc = await buildOfficialPdfDoc(
    'BẢNG TỔNG HỢP GIƯỜNG BỆNH GIAO BAN BUỔI SÁNG (BED SUMMARY)',
    filterSummary,
    columns,
    rows,
    {
      documentCode: `BED-SUM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      signers: [
        'Điều dưỡng giao ca đêm',
        'Điều dưỡng trưởng khoa',
        'Bác sĩ trực / Trưởng khoa',
      ],
    }
  );
  doc.save(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`);
}

export const PATIENT_IMPORT_TEMPLATE_COLUMNS: ExportColumn[] = [
  { header: 'Mã BN', key: 'patient_code', width: 18 },
  { header: 'Mã hồ sơ HIS', key: 'his_record_code', width: 18 },
  { header: 'Họ tên', key: 'full_name', width: 28 },
  { header: 'Ngày sinh', key: 'date_of_birth', width: 15 },
  { header: 'Số điện thoại', key: 'phone', width: 16 },
  { header: 'Chẩn đoán', key: 'diagnosis_group', width: 24 },
];

export const PATIENT_IMPORT_SAMPLE_ROWS: Array<Record<string, string>> = [
  {
    patient_code: 'BN-MAU-001',
    his_record_code: 'HIS-990001',
    full_name: 'Nguyễn Thị Lan Anh',
    date_of_birth: '1994-05-18',
    phone: '0905123456',
    diagnosis_group: 'Sinh thường',
  },
  {
    patient_code: 'BN-MAU-002',
    his_record_code: 'HIS-990002',
    full_name: 'Trần Minh Ngọc',
    date_of_birth: '1991-11-03',
    phone: '0912345678',
    diagnosis_group: 'Sinh mổ',
  },
  {
    patient_code: 'BN-MAU-003',
    his_record_code: 'HIS-990003',
    full_name: 'Lê Hoàng Nam',
    date_of_birth: '1978-02-24',
    phone: '0987654321',
    diagnosis_group: 'Theo dõi nội khoa',
  },
];

export async function buildPatientImportTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BEDCARE';
  wb.created = new Date();

  const sheet = wb.addWorksheet('MauNhapBenhNhan');
  PATIENT_IMPORT_TEMPLATE_COLUMNS.forEach((col, idx) => {
    sheet.getColumn(idx + 1).width = col.width ?? 20;
  });

  const headerRow = sheet.getRow(1);
  headerRow.height = 24;
  PATIENT_IMPORT_TEMPLATE_COLUMNS.forEach((col, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = col.header;
    cell.font = { bold: true, size: 10.5, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0369A1' },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FF0369A1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
  });

  PATIENT_IMPORT_SAMPLE_ROWS.forEach((sampleRow, rowIdx) => {
    const row = sheet.getRow(rowIdx + 2);
    PATIENT_IMPORT_TEMPLATE_COLUMNS.forEach((col, colIdx) => {
      const cell = row.getCell(colIdx + 1);
      cell.value = sampleRow[col.key] ?? '';
      cell.numFmt = '@'; // Keep date/phone strings formatted as text
      cell.font = { size: 10, color: { argb: 'FF0F172A' } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    });
  });

  const guideSheet = wb.addWorksheet('HuongDan');
  guideSheet.getColumn(1).width = 24;
  guideSheet.getColumn(2).width = 16;
  guideSheet.getColumn(3).width = 60;
  guideSheet.addRow(['Tên cột (Sheet MauNhapBenhNhan)', 'Bắt buộc', 'Quy cách dữ liệu']);
  guideSheet.getRow(1).font = { bold: true };
  guideSheet.addRow(['Mã BN', 'Bắt buộc', 'Mã định danh bệnh nhân duy nhất (VD: BN-2026-001)']);
  guideSheet.addRow(['Mã hồ sơ HIS', 'Tùy chọn', 'Mã lượt khám / hồ sơ bên HIS để tránh nhập trùng']);
  guideSheet.addRow(['Họ tên', 'Bắt buộc', 'Họ và tên đầy đủ của bệnh nhân']);
  guideSheet.addRow(['Ngày sinh', 'Bắt buộc', 'Định dạng chuẩn YYYY-MM-DD (VD: 1994-05-18)']);
  guideSheet.addRow(['Số điện thoại', 'Tùy chọn', 'Số điện thoại liên hệ bệnh nhân / người nhà']);
  guideSheet.addRow(['Chẩn đoán', 'Tùy chọn', 'Nhóm chẩn đoán hoặc khoa dự kiến (mặc định: Khác)']);

  return wb;
}

export function buildPatientImportTemplateCsv(): string {
  return buildCsvString(PATIENT_IMPORT_TEMPLATE_COLUMNS, PATIENT_IMPORT_SAMPLE_ROWS);
}

export async function exportPatientImportTemplate(format: 'xlsx' | 'csv') {
  if (format === 'csv') {
    exportToCsv('mau_nhap_benh_nhan_BEDCARE.csv', PATIENT_IMPORT_TEMPLATE_COLUMNS, PATIENT_IMPORT_SAMPLE_ROWS);
    return;
  }
  const wb = await buildPatientImportTemplateWorkbook();
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mau_nhap_benh_nhan_BEDCARE.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(fileName: string, content: string, mimeType = 'text/csv;charset=utf-8;') {
  const withBom = content.startsWith('\uFEFF') ? content : '\uFEFF' + content;
  const blob = new Blob([withBom], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

export function normalizeExcelCellValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'object') {
    const obj = val as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: string }>;
    };
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part) => part.text ?? '').join('').trim();
    }
    if (obj.result !== undefined) {
      return normalizeExcelCellValue(obj.result);
    }
    if (obj.text !== undefined) {
      return String(obj.text).trim();
    }
  }
  return String(val).trim();
}

export function parseSpreadsheetCsvText(text: string): {
  headers: string[];
  rows: Array<Record<string, string>>;
} {
  const cleanText = text.replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h, idx) => h || `Cột ${idx + 1}`);
  const rows = lines.slice(1).map((line) => {
    const vals = splitCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = vals[idx] ?? '';
    });
    return obj;
  });
  return { headers, rows };
}

export async function parseSpreadsheetWorkbookBuffer(buf: ArrayBuffer | Uint8Array): Promise<{
  headers: string[];
  rows: Array<Record<string, string>>;
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headers: string[] = [];
  const rows: Array<Record<string, string>> = [];
  sheet.eachRow((row, rowNumber) => {
    const values = (row.values as Array<unknown>).slice(1).map(normalizeExcelCellValue);
    if (rowNumber === 1) {
      values.forEach((h, idx) => headers.push(h || `Cột ${idx + 1}`));
    } else if (values.some((v) => v.length > 0)) {
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        obj[h] = values[idx] ?? '';
      });
      rows.push(obj);
    }
  });
  return { headers, rows };
}

export async function parseSpreadsheetFile(file: File): Promise<{
  headers: string[];
  rows: Array<Record<string, string>>;
}> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = await file.text();
    return parseSpreadsheetCsvText(text);
  }
  const buf = await file.arrayBuffer();
  return parseSpreadsheetWorkbookBuffer(buf);
}

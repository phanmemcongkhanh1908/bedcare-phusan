import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  buildOfficialPdfDoc,
  buildPatientImportTemplateCsv,
  buildPatientImportTemplateWorkbook,
  normalizeExcelCellValue,
  parseSpreadsheetCsvText,
  parseSpreadsheetWorkbookBuffer,
} from '../src/utils/exportUtils';

test('Patient import Excel template workbook round-trips cleanly with all auto-map headers', async () => {
  const wb = await buildPatientImportTemplateWorkbook();
  assert.equal(wb.worksheets.length, 2);
  assert.equal(wb.worksheets[0].name, 'MauNhapBenhNhan');
  assert.equal(wb.worksheets[1].name, 'HuongDan');

  const rawBuf = await wb.xlsx.writeBuffer();
  const parsed = await parseSpreadsheetWorkbookBuffer(new Uint8Array(rawBuf));

  assert.deepEqual(parsed.headers, [
    'Mã BN',
    'Mã hồ sơ HIS',
    'Họ tên',
    'Ngày sinh',
    'Số điện thoại',
    'Chẩn đoán',
  ]);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0]['Mã BN'], 'BN-MAU-001');
  assert.equal(parsed.rows[0]['Họ tên'], 'Nguyễn Thị Lan Anh');
  assert.equal(parsed.rows[0]['Ngày sinh'], '1994-05-18');
  assert.equal(parsed.rows[2]['Chẩn đoán'], 'Theo dõi nội khoa');
});

test('Patient import CSV template strips UTF-8 BOM and handles quoted commas safely', () => {
  const csv = buildPatientImportTemplateCsv();
  assert.ok(csv.startsWith('\uFEFF'), 'CSV template should start with UTF-8 BOM');

  const parsed = parseSpreadsheetCsvText(csv);
  assert.deepEqual(parsed.headers, [
    'Mã BN',
    'Mã hồ sơ HIS',
    'Họ tên',
    'Ngày sinh',
    'Số điện thoại',
    'Chẩn đoán',
  ]);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[1]['Mã BN'], 'BN-MAU-002');

  const quotedCsv =
    '\uFEFF"Mã BN","Họ tên","Ngày sinh","Chẩn đoán"\r\n' +
    '"BN-Q-01","Phạm Văn Hùng","1985-09-12","Suy tim, tăng huyết áp"';
  const quotedParsed = parseSpreadsheetCsvText(quotedCsv);
  assert.equal(quotedParsed.rows.length, 1);
  assert.equal(quotedParsed.rows[0]['Chẩn đoán'], 'Suy tim, tăng huyết áp');
});

test('Excel Date and richText cell values normalize cleanly to YYYY-MM-DD and plain text', async () => {
  assert.equal(normalizeExcelCellValue(new Date('1994-05-18T00:00:00.000Z')), '1994-05-18');
  assert.equal(
    normalizeExcelCellValue({ richText: [{ text: 'Sinh ' }, { text: 'thường' }] }),
    'Sinh thường'
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Mã BN', 'Họ tên', 'Ngày sinh']);
  ws.addRow(['BN-DATE-01', 'Lê Thị Hoa', new Date('1990-12-25T00:00:00.000Z')]);
  const buf = await wb.xlsx.writeBuffer();
  const parsed = await parseSpreadsheetWorkbookBuffer(new Uint8Array(buf));
  assert.equal(parsed.rows[0]['Ngày sinh'], '1990-12-25');
});

test('Morning Rounds Bed Summary official PDF builds cleanly in landscape orientation', async () => {
  const doc = await buildOfficialPdfDoc(
    'BẢNG TỔNG HỢP GIƯỜNG BỆNH GIAO BAN BUỔI SÁNG (BED SUMMARY)',
    'Khoa Sản · Đang nằm · Tổng: 2 bệnh nhân',
    [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Giường / Phòng / Khoa', key: 'department_bed', width: 26 },
      { header: 'Mã BN / Mã HS', key: 'codes', width: 20 },
      { header: 'Họ tên BN', key: 'patient_name', width: 24 },
      { header: 'Chẩn đoán điều trị', key: 'diagnosis_group', width: 20 },
      { header: 'Ngày vào / Dự kiến trả', key: 'dates', width: 24 },
      { header: 'Đã nằm / Còn lại', key: 'stay_summary', width: 18 },
      { header: 'Tình trạng giao ban', key: 'due_label', width: 16 },
    ],
    [
      {
        stt: 1,
        department_bed: 'S-101-1 · P.101 (Khoa Sản)',
        codes: 'BN-001 / HS-001',
        patient_name: 'Nguyễn Thị An',
        diagnosis_group: 'Sinh thường',
        dates: 'Vào: 18/11/2026 | Trả: 21/11/2026',
        stay_summary: '3 ng (Còn 0 ng)',
        due_label: 'Đến hạn hôm nay',
      },
      {
        stt: 2,
        department_bed: 'S-102-1 · P.102 (Khoa Sản) [Bao phòng]',
        codes: 'BN-002 / HS-002',
        patient_name: 'Trần Thị Bình',
        diagnosis_group: 'Sinh mổ',
        dates: 'Vào: 15/11/2026 | Trả: 20/11/2026',
        stay_summary: '6 ng (Quá 1 ng)',
        due_label: 'Quá ngày trả',
      },
    ],
    {
      documentCode: 'BED-SUM-20261121',
      signers: [
        'Điều dưỡng giao ca đêm',
        'Điều dưỡng trưởng khoa',
        'Bác sĩ trực / Trưởng khoa',
      ],
    }
  );
  assert.ok(doc.getNumberOfPages() >= 1);
  assert.ok(doc.internal.pageSize.getWidth() > doc.internal.pageSize.getHeight());
});

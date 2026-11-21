import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const ROOT = process.cwd();
const DELIVERABLES_DIR = path.join(ROOT, 'deliverables');
fs.mkdirSync(DELIVERABLES_DIR, { recursive: true });

interface ParsedTest {
  index: number;
  status: 'PASS' | 'FAIL';
  name: string;
  durationMs: string;
}

function runAndParseTests(): {
  tests: ParsedTest[];
  total: number;
  pass: number;
  fail: number;
  totalDurationMs: string;
  rawOutput: string;
} {
  const proc = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', '.bin', 'tsx'),
      '--test',
      '--test-reporter=tap',
      'tests/bedDaysAndAlerts.test.ts',
      'tests/bedcare25Scenarios.test.ts',
      'tests/handoverAndBedHistory.test.ts',
      'tests/vacancyAndExclusiveRoom.test.ts',
      'tests/roomValidationAndCatalog.test.ts',
      'tests/helpCenter.test.ts',
      'tests/vitalsAndUsers.test.ts',
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );

  const rawOutput = `${proc.stdout || ''}\n${proc.stderr || ''}`.trim();
  const lines = (proc.stdout || '').split(/\r?\n/);

  const tests: ParsedTest[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^(ok|not ok)\s+(\d+)\s+-\s+(.+)$/);
    if (match) {
      let durationMs = '-';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const dMatch = lines[j].match(/duration_ms:\s*([\d.]+)/);
        if (dMatch) {
          durationMs = `${Number(dMatch[1]).toFixed(1)} ms`;
          break;
        }
        if (lines[j].trim() === '...') break;
      }
      tests.push({
        index: Number(match[2]),
        status: match[1] === 'ok' ? 'PASS' : 'FAIL',
        name: match[3].trim(),
        durationMs,
      });
    }
  }

  const passMatch = (proc.stdout || '').match(/#\s+pass\s+(\d+)/);
  const failMatch = (proc.stdout || '').match(/#\s+fail\s+(\d+)/);
  const totalMatch = (proc.stdout || '').match(/#\s+tests\s+(\d+)/);
  const durMatch = (proc.stdout || '').match(/#\s+duration_ms\s+([\d.]+)/);

  return {
    tests,
    total: totalMatch ? Number(totalMatch[1]) : tests.length,
    pass: passMatch ? Number(passMatch[1]) : tests.filter((t) => t.status === 'PASS').length,
    fail: failMatch ? Number(failMatch[1]) : tests.filter((t) => t.status === 'FAIL').length,
    totalDurationMs: durMatch ? `${Number(durMatch[1]).toFixed(1)} ms` : '-',
    rawOutput,
  };
}

function generateTestReportPdf(summary: ReturnType<typeof runAndParseTests>) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const fontNormal = fs.readFileSync(path.join(ROOT, 'public/fonts/DejaVuSans.ttf')).toString('base64');
  const fontBold = fs.readFileSync(path.join(ROOT, 'public/fonts/DejaVuSans-Bold.ttf')).toString('base64');

  doc.addFileToVFS('DejaVuSans.ttf', fontNormal);
  doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', fontBold);
  doc.addFont('DejaVuSans-Bold.ttf', 'DejaVuSans', 'bold');
  doc.setFont('DejaVuSans', 'normal');

  doc.setFillColor(12, 74, 110);
  doc.rect(0, 0, 595, 76, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(16);
  doc.text('BEDCARE - BÁO CÁO KẾT QUẢ KIỂM THỬ TỰ ĐỘNG', 40, 34);
  doc.setFont('DejaVuSans', 'normal');
  doc.setFontSize(10);
  doc.text(`Thời gian chạy: ${new Date().toISOString()} | Node.js ${process.version} | SQLite + P2P Raft`, 40, 54);

  doc.setTextColor(15, 23, 42);
  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(12);
  doc.text('1. Tóm tắt kết quả thực thi thực tế', 40, 102);

  doc.setFont('DejaVuSans', 'normal');
  doc.setFontSize(10);
  doc.text(
    `Tổng số test case: ${summary.total}   |   Đạt (PASS): ${summary.pass}   |   Thất bại (FAIL): ${summary.fail}   |   Tổng thời gian: ${summary.totalDurationMs}`,
    40,
    122
  );
  doc.text(
    'Phạm vi kiểm thử: Thuật toán tính ngày giường, bộ sinh 12 cảnh báo tự động, 25 kịch bản nghiệp vụ & đồng thuận P2P.',
    40,
    138
  );

  autoTable(doc, {
    startY: 154,
    head: [['STT', 'Nhóm kiểm thử / Kịch bản nghiệp vụ', 'Trạng thái', 'Thời gian']],
    body: summary.tests.map((t) => [String(t.index), t.name, t.status, t.durationMs]),
    styles: {
      font: 'DejaVuSans',
      fontSize: 8.5,
      cellPadding: 5,
      textColor: [30, 41, 59],
    },
    headStyles: {
      font: 'DejaVuSans',
      fontStyle: 'bold',
      fillColor: [3, 105, 161],
      textColor: [255, 255, 255],
    },
    columnStyles: {
      0: { cellWidth: 34, halign: 'center' },
      1: { cellWidth: 365 },
      2: { cellWidth: 58, halign: 'center' },
      3: { cellWidth: 58, halign: 'right' },
    },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 2) {
        if (data.cell.raw === 'PASS') {
          data.cell.styles.textColor = [21, 128, 61];
          data.cell.styles.fontStyle = 'bold';
        } else {
          data.cell.styles.textColor = [185, 28, 28];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    },
  });

  const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 600;
  const noteY = Math.min(finalY + 26, 760);

  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(10.5);
  doc.text('2. Ghi chú môi trường đóng gói Desktop Windows (Tauri + NSIS)', 40, noteY);
  doc.setFont('DejaVuSans', 'normal');
  doc.setFontSize(9);
  doc.text(
    'Mã nguồn ứng dụng Desktop Windows (src-tauri/, installer/bedcare.nsi, scripts/build-windows.ps1) đã được hoàn thiện đầy đủ.',
    40,
    noteY + 16
  );
  doc.text(
    'Môi trường container Linux hiện tại không có trình biên dịch Rust/Cargo và NSIS cho Windows nên tệp .exe cần được biên dịch trên Windows.',
    40,
    noteY + 30
  );

  const outPdf = path.join(DELIVERABLES_DIR, 'BEDCARE-TEST-REPORT.pdf');
  const bytes = Buffer.from(doc.output('arraybuffer'));
  fs.writeFileSync(outPdf, bytes);
  console.log(`Generated ${outPdf} (${bytes.length} bytes)`);
}

function generateZipArchives() {
  const sourceZip = path.join(DELIVERABLES_DIR, 'BEDCARE-SOURCE.zip');
  const docsZip = path.join(DELIVERABLES_DIR, 'BEDCARE-DOCUMENTATION.zip');

  const pyScript = `
import os, zipfile

root = os.getcwd()
source_zip = ${JSON.stringify(sourceZip)}
docs_zip = ${JSON.stringify(docsZip)}

exclude_dirs = {'node_modules', 'dist', 'data', '.git', '.playwright-cli', 'deliverables', '.aistudio'}

with zipfile.ZipFile(source_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
        for fname in filenames:
            if fname.endswith('.sqlite') or fname.endswith('.log'):
                continue
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, root)
            zf.write(full, rel)

with zipfile.ZipFile(docs_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
    for top in ['README.md', 'CHANGELOG.md', 'LICENSES.md']:
        p = os.path.join(root, top)
        if os.path.exists(p):
            zf.write(p, top)
    docs_dir = os.path.join(root, 'docs')
    if os.path.isdir(docs_dir):
        for fname in sorted(os.listdir(docs_dir)):
            full = os.path.join(docs_dir, fname)
            if os.path.isfile(full):
                zf.write(full, os.path.join('docs', fname))

print('SOURCE_SIZE', os.path.getsize(source_zip))
print('DOCS_SIZE', os.path.getsize(docs_zip))
`;

  const out = execFileSync('python3', ['-c', pyScript], { cwd: ROOT, encoding: 'utf8' });
  console.log(out.trim());
}

const summary = runAndParseTests();
console.log(`Test execution complete: ${summary.pass}/${summary.total} passed (fail=${summary.fail})`);
if (summary.fail > 0) {
  console.error(summary.rawOutput);
  process.exit(1);
}
generateTestReportPdf(summary);
generateZipArchives();

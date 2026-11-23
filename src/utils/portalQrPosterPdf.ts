import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { loadDejaVuFonts } from './exportUtils';
import {
  formatPortalDisplayUrl,
  resolvePosterTemplate,
  resolvePosterTheme,
  sanitizePosterConfig,
  type PortalQrPosterConfig,
} from './portalQrPoster';

function drawCornerBrackets(
  doc: jsPDF,
  x: number,
  y: number,
  size: number,
  arm: number,
  color: [number, number, number]
) {
  doc.setDrawColor(color[0], color[1], color[2]);
  doc.setLineWidth(0.7);
  // Top-left
  doc.line(x, y, x + arm, y);
  doc.line(x, y, x, y + arm);
  // Top-right
  doc.line(x + size - arm, y, x + size, y);
  doc.line(x + size, y, x + size, y + arm);
  // Bottom-left
  doc.line(x, y + size - arm, x, y + size);
  doc.line(x, y + size, x + arm, y + size);
  // Bottom-right
  doc.line(x + size, y + size - arm, x + size, y + size);
  doc.line(x + size - arm, y + size, x + size, y + size);
}

function drawPosterCardInBox(
  doc: jsPDF,
  box: { x: number; y: number; w: number; h: number },
  qrDataUrl: string,
  targetUrl: string,
  cfg: PortalQrPosterConfig,
  fontName: string,
  compact: boolean
) {
  const theme = resolvePosterTheme(cfg.themeId);
  const cx = box.x + box.w / 2;

  // Outer frame
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.35);
  doc.roundedRect(box.x, box.y, box.w, box.h, 3, 3, 'FD');

  // Top Header Band
  const headerH = compact ? (box.h > 140 ? 22 : 18) : 34;
  doc.setFillColor(theme.rgbHeaderBg[0], theme.rgbHeaderBg[1], theme.rgbHeaderBg[2]);
  doc.roundedRect(box.x, box.y, box.w, headerH, 3, 3, 'F');
  doc.rect(box.x, box.y + headerH - 3, box.w, 3, 'F');

  doc.setFont(fontName, 'bold');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(compact ? 8.5 : 12.5);
  const hospLines = doc.splitTextToSize(cfg.hospitalName.toUpperCase(), box.w - 14) as string[];
  doc.text(hospLines.slice(0, 2), cx, box.y + (compact ? 8 : 13), { align: 'center' });

  doc.setFont(fontName, 'normal');
  doc.setFontSize(compact ? 6.8 : 9.5);
  const scopeText = cfg.departmentName
    ? `Khu vực áp dụng: ${cfg.departmentName}`
    : 'Cổng Đặt giường Trực tuyến BEDCARE';
  doc.text(scopeText, cx, box.y + headerH - (compact ? 4 : 7), { align: 'center' });

  // Main Headline & Subtitle
  let cursorY = box.y + headerH + (compact ? 9 : 16);
  doc.setFont(fontName, 'bold');
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(compact ? 11.5 : 20);
  const headLines = doc.splitTextToSize(cfg.headline, box.w - 16) as string[];
  doc.text(headLines.slice(0, 2), cx, cursorY, { align: 'center' });
  cursorY += headLines.slice(0, 2).length * (compact ? 5.2 : 8.5) + (compact ? 1 : 2);

  doc.setFont(fontName, 'normal');
  doc.setTextColor(71, 85, 105);
  doc.setFontSize(compact ? 7.2 : 10.5);
  const subLines = doc.splitTextToSize(cfg.subtitle, box.w - 18) as string[];
  doc.text(subLines.slice(0, 2), cx, cursorY, { align: 'center' });
  cursorY += subLines.slice(0, 2).length * (compact ? 3.5 : 5) + (compact ? 4 : 8);

  // QR Frame Stage
  const qrSize = compact ? (box.w < 105 ? 38 : 48) : 78;
  const stagePad = compact ? 5 : 8;
  const stageSize = qrSize + stagePad * 2;
  const stageX = cx - stageSize / 2;
  const stageY = cursorY;

  doc.setFillColor(theme.rgbSoftBg[0], theme.rgbSoftBg[1], theme.rgbSoftBg[2]);
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  doc.roundedRect(stageX - 4, stageY - 3, stageSize + 8, stageSize + (compact ? 12 : 17), 3, 3, 'FD');

  doc.setFillColor(255, 255, 255);
  doc.roundedRect(stageX, stageY, stageSize, stageSize, 2, 2, 'F');
  drawCornerBrackets(doc, stageX - 1.5, stageY - 1.5, stageSize + 3, compact ? 4 : 6, theme.rgbAccent);

  doc.addImage(qrDataUrl, 'PNG', stageX + stagePad, stageY + stagePad, qrSize, qrSize);

  doc.setFont(fontName, 'bold');
  doc.setTextColor(theme.rgbAccent[0], theme.rgbAccent[1], theme.rgbAccent[2]);
  doc.setFontSize(compact ? 7.2 : 10.5);
  doc.text(cfg.scanCta, cx, stageY + stageSize + (compact ? 6.5 : 10), { align: 'center' });

  cursorY = stageY + stageSize + (compact ? 13 : 21);

  // Optional 3 Steps
  if (cfg.showSteps && box.h >= 120) {
    const steps = compact
      ? ['01. Mở Camera / Zalo quét mã', '02. Chọn khoa & giường phù hợp', '03. Nhập Họ tên & SĐT giữ chỗ']
      : [
          '01. Mở Camera điện thoại hoặc Zalo và hướng vào mã QR',
          '02. Xem danh sách phòng trống, tiện nghi & đơn giá niêm yết',
          '03. Chọn giường hoặc bao phòng, nhập Họ tên & SĐT để gửi giữ chỗ',
        ];
    const stepBoxW = box.w - (compact ? 14 : 26);
    const stepBoxX = cx - stepBoxW / 2;
    const stepBoxH = compact ? 20 : 28;
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(stepBoxX, cursorY, stepBoxW, stepBoxH, 2, 2, 'FD');

    doc.setFont(fontName, 'normal');
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(compact ? 6.8 : 9.8);
    steps.forEach((s, idx) => {
      doc.text(s, stepBoxX + (compact ? 4 : 7), cursorY + (compact ? 5.8 + idx * 5.6 : 8 + idx * 7.8));
    });
  }

  // Footer strip
  const footerY = box.y + box.h - (compact ? 10 : 14);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.25);
  doc.line(box.x + 8, footerY - (compact ? 4.5 : 6), box.x + box.w - 8, footerY - (compact ? 4.5 : 6));

  doc.setFont(fontName, 'bold');
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(compact ? 6.8 : 9.5);
  const footerLeft = cfg.hotline ? `Hotline hỗ trợ: ${cfg.hotline}` : 'Hỗ trợ tại Quầy Tiếp nhận';
  doc.text(footerLeft, box.x + 8, footerY);

  doc.setFont(fontName, 'normal');
  doc.setTextColor(71, 85, 105);
  doc.setFontSize(compact ? 6 : 8.5);
  const shortUrl = formatPortalDisplayUrl(targetUrl);
  const trimmedUrl = shortUrl.length > (compact ? 34 : 52) ? `${shortUrl.slice(0, compact ? 31 : 49)}...` : shortUrl;
  doc.text(trimmedUrl, box.x + box.w - 8, footerY, { align: 'right' });
}

export async function exportPortalQrPosterPdf(
  rawConfig: PortalQrPosterConfig,
  targetUrl: string,
  marginMm = 10
): Promise<void> {
  const cfg = sanitizePosterConfig(rawConfig);
  const template = resolvePosterTemplate(cfg.templateId);
  const theme = resolvePosterTheme(cfg.themeId);

  const qrDataUrl = await QRCode.toDataURL(targetUrl, {
    width: 1200,
    margin: 2,
    errorCorrectionLevel: cfg.errorCorrectionLevel,
    color: {
      dark: theme.qrDarkHex,
      light: '#ffffff',
    },
  });

  const doc = new jsPDF({
    orientation: template.orientation,
    unit: 'mm',
    format: 'a4',
  });

  const fonts = await loadDejaVuFonts();
  let fontName = 'helvetica';
  if (fonts) {
    doc.addFileToVFS('DejaVuSans.ttf', fonts.normal);
    doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
    doc.addFileToVFS('DejaVuSans-Bold.ttf', fonts.bold);
    doc.addFont('DejaVuSans-Bold.ttf', 'DejaVuSans', 'bold');
    fontName = 'DejaVuSans';
  }

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = Math.max(6, Math.min(20, marginMm));
  const innerW = pageW - margin * 2;
  const innerH = pageH - margin * 2;

  if (template.id === 'A4_POSTER') {
    drawPosterCardInBox(doc, { x: margin, y: margin, w: innerW, h: innerH }, qrDataUrl, targetUrl, cfg, fontName, false);
  } else if (template.id === 'A5_DESK_PAIR') {
    const gap = 8;
    const cardW = (innerW - gap) / 2;
    drawPosterCardInBox(doc, { x: margin, y: margin, w: cardW, h: innerH }, qrDataUrl, targetUrl, cfg, fontName, true);
    drawPosterCardInBox(
      doc,
      { x: margin + cardW + gap, y: margin, w: cardW, h: innerH },
      qrDataUrl,
      targetUrl,
      cfg,
      fontName,
      true
    );
    // Dashed cut guide in center
    doc.setDrawColor(148, 163, 184);
    doc.setLineDashPattern([2, 2], 0);
    doc.line(pageW / 2, margin - 2, pageW / 2, pageH - margin + 2);
    doc.setLineDashPattern([], 0);
  } else {
    const gap = 6;
    const cardW = (innerW - gap) / 2;
    const cardH = (innerH - gap) / 2;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        drawPosterCardInBox(
          doc,
          { x: margin + c * (cardW + gap), y: margin + r * (cardH + gap), w: cardW, h: cardH },
          qrDataUrl,
          targetUrl,
          cfg,
          fontName,
          true
        );
      }
    }
    doc.setDrawColor(148, 163, 184);
    doc.setLineDashPattern([2, 2], 0);
    doc.line(pageW / 2, margin - 2, pageW / 2, pageH - margin + 2);
    doc.line(margin - 2, pageH / 2, pageW - margin + 2, pageH / 2);
    doc.setLineDashPattern([], 0);
  }

  const slug = cfg.departmentId ? `-${cfg.departmentId}` : '';
  doc.save(`BEDCARE-QR-Cong-Dat-Giuong${slug}-${template.id.toLowerCase()}.pdf`);
}

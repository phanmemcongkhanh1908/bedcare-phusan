export type PosterTemplateId = 'A4_POSTER' | 'A5_DESK_PAIR' | 'STICKER_GRID_4';
export type PosterThemeId = 'CLINICAL_NAVY' | 'MATERNITY_TEAL' | 'MONO_PRINT';
export type QrErrorCorrectionLevel = 'M' | 'Q' | 'H';

export interface PortalQrPosterConfig {
  baseUrl: string;
  departmentId: string;
  departmentName: string;
  hospitalName: string;
  headline: string;
  subtitle: string;
  hotline: string;
  scanCta: string;
  templateId: PosterTemplateId;
  themeId: PosterThemeId;
  errorCorrectionLevel: QrErrorCorrectionLevel;
  showSteps: boolean;
}

export interface PosterTemplateSpec {
  id: PosterTemplateId;
  label: string;
  shortLabel: string;
  description: string;
  orientation: 'portrait' | 'landscape';
  cardsPerSheet: 1 | 2 | 4;
}

export interface PosterThemeSpec {
  id: PosterThemeId;
  label: string;
  headerBgHex: string;
  headerTextHex: string;
  accentHex: string;
  accentSoftHex: string;
  accentBorderHex: string;
  textPrimaryHex: string;
  textMutedHex: string;
  qrDarkHex: string;
  rgbAccent: [number, number, number];
  rgbHeaderBg: [number, number, number];
  rgbSoftBg: [number, number, number];
}

export const POSTER_TEMPLATES: PosterTemplateSpec[] = [
  {
    id: 'A4_POSTER',
    label: 'Poster Đứng A4 (Standee / Sảnh chờ)',
    shortLabel: 'Poster A4',
    description: '1 bản A4 Dọc cỡ lớn đặt tại quầy tiếp nhận, sảnh chờ khám hoặc bảng thông báo khoa.',
    orientation: 'portrait',
    cardsPerSheet: 1,
  },
  {
    id: 'A5_DESK_PAIR',
    label: 'Bảng Mica Để Bàn A5 (2 bảng / A4 Ngang)',
    shortLabel: 'Để bàn 2×A5',
    description: '2 bảng A5 đặt cạnh nhau trên khổ A4 Ngang kèm đường cắt, vừa vặn kệ mica quầy thu viện phí.',
    orientation: 'landscape',
    cardsPerSheet: 2,
  },
  {
    id: 'STICKER_GRID_4',
    label: 'Bộ 4 Tem Dán Cửa / Tờ Rơi (2×2 trên A4)',
    shortLabel: '4 Tem / A4',
    description: '4 thẻ gọn đặt lưới 2×2 trên 1 tờ A4 Dọc, dán cửa phòng bệnh, thang máy hoặc phát tay.',
    orientation: 'portrait',
    cardsPerSheet: 4,
  },
];

export const POSTER_THEMES: PosterThemeSpec[] = [
  {
    id: 'CLINICAL_NAVY',
    label: 'Xanh Y tế Chuyên sâu',
    headerBgHex: '#0c4a6e',
    headerTextHex: '#ffffff',
    accentHex: '#0369a1',
    accentSoftHex: '#f0f9ff',
    accentBorderHex: '#bae6fd',
    textPrimaryHex: '#0f172a',
    textMutedHex: '#475569',
    qrDarkHex: '#0f172a',
    rgbAccent: [3, 105, 161],
    rgbHeaderBg: [12, 74, 110],
    rgbSoftBg: [240, 249, 255],
  },
  {
    id: 'MATERNITY_TEAL',
    label: 'Xanh Ngọc Sản phụ khoa',
    headerBgHex: '#115e59',
    headerTextHex: '#ffffff',
    accentHex: '#0f766e',
    accentSoftHex: '#f0fdfa',
    accentBorderHex: '#99f6e4',
    textPrimaryHex: '#0f172a',
    textMutedHex: '#475569',
    qrDarkHex: '#0f172a',
    rgbAccent: [15, 118, 110],
    rgbHeaderBg: [17, 94, 89],
    rgbSoftBg: [240, 253, 250],
  },
  {
    id: 'MONO_PRINT',
    label: 'Đen Trắng Laser (Tiết kiệm mực)',
    headerBgHex: '#0f172a',
    headerTextHex: '#ffffff',
    accentHex: '#1e293b',
    accentSoftHex: '#f8fafc',
    accentBorderHex: '#cbd5e1',
    textPrimaryHex: '#0f172a',
    textMutedHex: '#334155',
    qrDarkHex: '#000000',
    rgbAccent: [30, 41, 59],
    rgbHeaderBg: [15, 23, 42],
    rgbSoftBg: [248, 250, 252],
  },
];

export function resolvePosterTemplate(id: PosterTemplateId): PosterTemplateSpec {
  return POSTER_TEMPLATES.find((t) => t.id === id) || POSTER_TEMPLATES[0];
}

export function resolvePosterTheme(id: PosterThemeId): PosterThemeSpec {
  return POSTER_THEMES.find((t) => t.id === id) || POSTER_THEMES[0];
}

/**
 * Builds the canonical URL encoded inside the public QR code.
 * Always targets `?portal=customer` and optionally pre-filters `&dept=<departmentId>`.
 */
export function buildPublicPortalQrUrl(options: {
  originOrBaseUrl: string;
  departmentId?: string | null;
}): string {
  const raw = options.originOrBaseUrl.trim();
  if (!raw) {
    throw new Error('Vui lòng nhập địa chỉ trang web triển khai BEDCARE.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Địa chỉ URL không hợp lệ (cần bắt đầu bằng https:// hoặc http://).');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL cổng đặt giường phải dùng giao thức http:// hoặc https://.');
  }

  parsed.searchParams.set('portal', 'customer');
  const dept = options.departmentId?.trim();
  if (dept) {
    parsed.searchParams.set('dept', dept);
  } else {
    parsed.searchParams.delete('dept');
  }
  parsed.hash = '';
  return parsed.toString();
}

export function isLocalhostOrigin(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export function formatPortalDisplayUrl(fullUrl: string): string {
  try {
    const parsed = new URL(fullUrl);
    const qs = parsed.searchParams.toString();
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return fullUrl;
  }
}

export function sanitizePosterConfig(config: PortalQrPosterConfig): PortalQrPosterConfig {
  return {
    ...config,
    hospitalName: config.hospitalName.trim() || 'BỆNH VIỆN CHUYÊN KHOA PHỤ SẢN',
    headline: config.headline.trim() || 'ĐẶT GIƯỜNG BỆNH TRỰC TUYẾN',
    subtitle:
      config.subtitle.trim() ||
      'Xem phòng trống theo thời gian thực · Niêm yết giá công khai · Giữ chỗ trong 30 giây',
    hotline: config.hotline.trim(),
    scanCta: config.scanCta.trim() || 'MỞ CAMERA HOẶC ZALO ĐỂ QUÉT MÃ QR',
  };
}

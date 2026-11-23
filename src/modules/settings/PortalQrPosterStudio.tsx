import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Phone,
  Printer,
  QrCode,
  RotateCcw,
  Scissors,
  Smartphone,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { PrintPreviewModal } from '../../components/PrintPreviewModal';
import type { Department } from '../../types/bedcare';
import {
  buildPublicPortalQrUrl,
  formatPortalDisplayUrl,
  isLocalhostOrigin,
  POSTER_TEMPLATES,
  POSTER_THEMES,
  resolvePosterTemplate,
  resolvePosterTheme,
  sanitizePosterConfig,
  type PortalQrPosterConfig,
  type PosterTemplateId,
  type PosterThemeId,
  type QrErrorCorrectionLevel,
} from '../../utils/portalQrPoster';
import { exportPortalQrPosterPdf } from '../../utils/portalQrPosterPdf';

interface PortalQrPosterStudioProps {
  departments: Department[];
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

const PREFS_STORAGE_KEY = 'bedcare_portal_qr_poster_prefs_v1';

function getDefaultOrigin(): string {
  if (typeof window !== 'undefined' && window.location.origin) {
    return window.location.origin;
  }
  return 'https://bedcare.hospital.vn';
}

function readSavedPrefs(): Partial<PortalQrPosterConfig> {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<PortalQrPosterConfig>;
  } catch {
    return {};
  }
}

interface PosterCardArtworkProps {
  config: PortalQrPosterConfig;
  qrDataUrl: string;
  targetUrl: string;
  compact?: boolean;
}

function PosterCardArtwork({ config, qrDataUrl, targetUrl, compact = false }: PosterCardArtworkProps) {
  const theme = resolvePosterTheme(config.themeId);
  const displayUrl = formatPortalDisplayUrl(targetUrl);

  return (
    <article
      className="bg-white flex flex-col justify-between overflow-hidden rounded-lg border border-slate-300 text-slate-900 break-inside-avoid"
      style={{
        height: '100%',
        minHeight: compact ? '380px' : '740px',
      }}
    >
      {/* Top Clinical Header Band */}
      <header
        className={compact ? 'px-4 py-3 text-center' : 'px-8 py-6 text-center'}
        style={{
          backgroundColor: theme.headerBgHex,
          color: theme.headerTextHex,
        }}
      >
        <div className={compact ? 'text-[11px] font-bold tracking-wider uppercase' : 'text-sm font-bold tracking-widest uppercase'}>
          {config.hospitalName}
        </div>
        <div className={compact ? 'text-[11px] opacity-90 mt-0.5' : 'text-xs opacity-90 mt-1'}>
          {config.departmentName
            ? `Cổng đặt giường trực tuyến · ${config.departmentName}`
            : 'Hệ thống Điều phối & Đặt giường Trực tuyến BEDCARE'}
        </div>
      </header>

      {/* Main Editorial Focal Area */}
      <div className={compact ? 'flex-1 flex flex-col items-center justify-center px-4 py-4 text-center gap-3' : 'flex-1 flex flex-col items-center justify-center px-10 py-8 text-center gap-6'}>
        <div className="space-y-1.5 max-w-md">
          <h3
            className={compact ? 'text-base font-bold tracking-tight leading-snug text-balance' : 'text-3xl font-bold tracking-tight leading-tight text-balance'}
            style={{ color: theme.textPrimaryHex }}
          >
            {config.headline}
          </h3>
          <p
            className={compact ? 'text-[11px] leading-relaxed' : 'text-sm leading-relaxed'}
            style={{ color: theme.textMutedHex }}
          >
            {config.subtitle}
          </p>
        </div>

        {/* Architectural QR Frame */}
        <div
          className={compact ? 'rounded-xl border px-4 py-3.5 flex flex-col items-center gap-2' : 'rounded-2xl border px-7 py-6 flex flex-col items-center gap-3.5'}
          style={{
            backgroundColor: theme.accentSoftHex,
            borderColor: theme.accentBorderHex,
          }}
        >
          <div className="relative bg-white p-2.5 rounded-lg border border-slate-200">
            {/* Corner Scan Brackets */}
            <span
              aria-hidden="true"
              className="absolute -top-1 -left-1 w-4 h-4 border-t-[3px] border-l-[3px] rounded-tl"
              style={{ borderColor: theme.accentHex }}
            />
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 w-4 h-4 border-t-[3px] border-r-[3px] rounded-tr"
              style={{ borderColor: theme.accentHex }}
            />
            <span
              aria-hidden="true"
              className="absolute -bottom-1 -left-1 w-4 h-4 border-b-[3px] border-l-[3px] rounded-bl"
              style={{ borderColor: theme.accentHex }}
            />
            <span
              aria-hidden="true"
              className="absolute -bottom-1 -right-1 w-4 h-4 border-b-[3px] border-r-[3px] rounded-br"
              style={{ borderColor: theme.accentHex }}
            />

            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Mã QR truy cập Cổng Đặt giường BEDCARE"
                className={compact ? 'w-32 h-32 block' : 'w-56 h-56 block'}
              />
            ) : (
              <div className={`${compact ? 'w-32 h-32' : 'w-56 h-56'} flex items-center justify-center bg-slate-50 text-xs font-mono text-slate-400`}>
                Đang tạo mã QR...
              </div>
            )}
          </div>

          <div
            className={compact ? 'inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wide' : 'inline-flex items-center gap-2 text-sm font-bold tracking-wide'}
            style={{ color: theme.accentHex }}
          >
            <Smartphone className={compact ? 'h-3.5 w-3.5 shrink-0' : 'h-4 w-4 shrink-0'} />
            <span>{config.scanCta}</span>
          </div>
        </div>

        {/* Numbered 3-Step Guide */}
        {config.showSteps && (
          <div
            className={
              compact
                ? 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-[10px] space-y-1'
                : 'w-full max-w-lg rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 text-left text-xs space-y-2'
            }
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono tabular-nums font-bold shrink-0" style={{ color: theme.accentHex }}>
                01.
              </span>
              <span className="text-slate-800">Mở Camera điện thoại hoặc Zalo và hướng vào mã QR</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono tabular-nums font-bold shrink-0" style={{ color: theme.accentHex }}>
                02.
              </span>
              <span className="text-slate-800">Xem phòng trống thực tế, tiện nghi &amp; giá giường công khai</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono tabular-nums font-bold shrink-0" style={{ color: theme.accentHex }}>
                03.
              </span>
              <span className="text-slate-800">Chọn giường / bao phòng và nhập Họ tên + SĐT để giữ chỗ</span>
            </div>
          </div>
        )}
      </div>

      {/* Quiet Footer Strip */}
      <footer
        className={
          compact
            ? 'border-t border-slate-200 bg-slate-50/70 px-3 py-2 flex items-center justify-between gap-2 text-[10px]'
            : 'border-t border-slate-200 bg-slate-50/70 px-8 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs'
        }
      >
        <div className="inline-flex items-center gap-1 font-semibold text-slate-800 whitespace-nowrap shrink-0">
          <Phone className={compact ? 'h-3 w-3 shrink-0' : 'h-3.5 w-3.5 shrink-0'} style={{ color: theme.accentHex }} />
          <span>{config.hotline ? `Hỗ trợ: ${config.hotline}` : 'Liên hệ trực tiếp Quầy Tiếp nhận'}</span>
        </div>
        <div className="font-mono text-slate-500 truncate min-w-0" title={targetUrl}>
          {displayUrl}
        </div>
      </footer>
    </article>
  );
}

interface PrintablePosterSheetProps {
  config: PortalQrPosterConfig;
  qrDataUrl: string;
  targetUrl: string;
}

function PrintablePosterSheet({ config, qrDataUrl, targetUrl }: PrintablePosterSheetProps) {
  const template = resolvePosterTemplate(config.templateId);

  if (template.id === 'A4_POSTER') {
    return <PosterCardArtwork config={config} qrDataUrl={qrDataUrl} targetUrl={targetUrl} compact={false} />;
  }

  if (template.id === 'A5_DESK_PAIR') {
    return (
      <div className="relative grid grid-cols-2 gap-4">
        <PosterCardArtwork config={config} qrDataUrl={qrDataUrl} targetUrl={targetUrl} compact />
        <PosterCardArtwork config={config} qrDataUrl={qrDataUrl} targetUrl={targetUrl} compact />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 border-l border-dashed border-slate-400 flex items-start justify-center pt-1"
        >
          <span className="bg-white px-1 text-[10px] text-slate-500 inline-flex items-center gap-0.5">
            <Scissors className="h-3 w-3" /> Cắt
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative grid grid-cols-2 gap-3">
      {[0, 1, 2, 3].map((idx) => (
        <PosterCardArtwork key={idx} config={config} qrDataUrl={qrDataUrl} targetUrl={targetUrl} compact />
      ))}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 border-l border-dashed border-slate-400"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-slate-400"
      />
    </div>
  );
}

export function PortalQrPosterStudio({ departments, onNotify }: PortalQrPosterStudioProps) {
  const saved = useMemo(() => readSavedPrefs(), []);
  const [baseUrl, setBaseUrl] = useState<string>(() => saved.baseUrl || getDefaultOrigin());
  const [departmentId, setDepartmentId] = useState<string>('');
  const [hospitalName, setHospitalName] = useState<string>(
    () => saved.hospitalName || 'BỆNH VIỆN CHUYÊN KHOA PHỤ SẢN'
  );
  const [headline, setHeadline] = useState<string>(
    () => saved.headline || 'ĐẶT GIƯỜNG BỆNH TRỰC TUYẾN'
  );
  const [subtitle, setSubtitle] = useState<string>(
    () =>
      saved.subtitle ||
      'Xem phòng trống theo thời gian thực · Niêm yết giá công khai · Giữ chỗ trong 30 giây'
  );
  const [hotline, setHotline] = useState<string>(() => saved.hotline || '1900 1234');
  const [scanCta, setScanCta] = useState<string>(
    () => saved.scanCta || 'MỞ CAMERA HOẶC ZALO ĐỂ QUÉT MÃ QR'
  );
  const [templateId, setTemplateId] = useState<PosterTemplateId>(
    () => (saved.templateId as PosterTemplateId) || 'A4_POSTER'
  );
  const [themeId, setThemeId] = useState<PosterThemeId>(
    () => (saved.themeId as PosterThemeId) || 'CLINICAL_NAVY'
  );
  const [ecc, setEcc] = useState<QrErrorCorrectionLevel>(
    () => (saved.errorCorrectionLevel as QrErrorCorrectionLevel) || 'H'
  );
  const [showSteps, setShowSteps] = useState<boolean>(
    () => (typeof saved.showSteps === 'boolean' ? saved.showSteps : true)
  );

  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  const activeDepartments = useMemo(
    () => departments.filter((d) => d.status === 'ACTIVE'),
    [departments]
  );

  const selectedDeptName = useMemo(
    () => activeDepartments.find((d) => d.id === departmentId)?.name || '',
    [activeDepartments, departmentId]
  );

  const rawConfig: PortalQrPosterConfig = useMemo(
    () => ({
      baseUrl,
      departmentId,
      departmentName: selectedDeptName,
      hospitalName,
      headline,
      subtitle,
      hotline,
      scanCta,
      templateId,
      themeId,
      errorCorrectionLevel: ecc,
      showSteps,
    }),
    [baseUrl, departmentId, selectedDeptName, hospitalName, headline, subtitle, hotline, scanCta, templateId, themeId, ecc, showSteps]
  );

  const sanitizedConfig = useMemo(() => sanitizePosterConfig(rawConfig), [rawConfig]);

  const urlComputation = useMemo(() => {
    try {
      const target = buildPublicPortalQrUrl({
        originOrBaseUrl: baseUrl,
        departmentId,
      });
      return { target, error: '' };
    } catch (err) {
      return { target: '', error: (err as Error).message };
    }
  }, [baseUrl, departmentId]);

  const activeTheme = resolvePosterTheme(themeId);
  const activeTemplate = resolvePosterTemplate(templateId);

  // Persist reusable hospital poster preferences locally
  useEffect(() => {
    try {
      localStorage.setItem(
        PREFS_STORAGE_KEY,
        JSON.stringify({
          baseUrl,
          hospitalName,
          headline,
          subtitle,
          hotline,
          scanCta,
          templateId,
          themeId,
          errorCorrectionLevel: ecc,
          showSteps,
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }, [baseUrl, hospitalName, headline, subtitle, hotline, scanCta, templateId, themeId, ecc, showSteps]);

  // Render crisp 1200x1200 high-resolution QR matrix with safe quiet zone
  useEffect(() => {
    if (!urlComputation.target) {
      setQrDataUrl('');
      return;
    }
    let mounted = true;
    QRCode.toDataURL(urlComputation.target, {
      width: 1200,
      margin: 2,
      errorCorrectionLevel: ecc,
      color: {
        dark: activeTheme.qrDarkHex,
        light: '#ffffff',
      },
    })
      .then((dataUrl) => {
        if (mounted) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (mounted) setQrDataUrl('');
      });
    return () => {
      mounted = false;
    };
  }, [urlComputation.target, ecc, activeTheme.qrDarkHex]);

  const handleCopyUrl = async () => {
    if (!urlComputation.target) return;
    try {
      await navigator.clipboard.writeText(urlComputation.target);
      setCopiedUrl(true);
      onNotify('Đã sao chép đường dẫn Cổng Đặt giường Online.');
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      onNotify('Không sao chép tự động được, vui lòng chọn và copy trực tiếp đường dẫn.', 'error');
    }
  };

  const handleDownloadQrPng = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    const slug = departmentId ? `-${departmentId}` : '';
    a.download = `BEDCARE-QR-Cong-Dat-Giuong${slug}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    onNotify('Đã tải ảnh QR PNG (1200×1200px) sắc nét để gửi in ấn hoặc ghép thiết kế.');
  };

  const handleExportPdf = async (marginMm = 10) => {
    if (!urlComputation.target) {
      onNotify(urlComputation.error || 'URL chưa hợp lệ.', 'error');
      return;
    }
    setExportingPdf(true);
    try {
      await exportPortalQrPosterPdf(sanitizedConfig, urlComputation.target, marginMm);
      onNotify('Đã xuất file PDF Poster QR chuẩn in ấn.');
    } catch (err) {
      onNotify(`Lỗi xuất PDF: ${(err as Error).message}`, 'error');
    } finally {
      setExportingPdf(false);
    }
  };

  const handleResetDefaults = () => {
    setBaseUrl(getDefaultOrigin());
    setDepartmentId('');
    setHospitalName('BỆNH VIỆN CHUYÊN KHOA PHỤ SẢN');
    setHeadline('ĐẶT GIƯỜNG BỆNH TRỰC TUYẾN');
    setSubtitle('Xem phòng trống theo thời gian thực · Niêm yết giá công khai · Giữ chỗ trong 30 giây');
    setHotline('1900 1234');
    setScanCta('MỞ CAMERA HOẶC ZALO ĐỂ QUÉT MÃ QR');
    setTemplateId('A4_POSTER');
    setThemeId('CLINICAL_NAVY');
    setEcc('H');
    setShowSteps(true);
    onNotify('Đã khôi phục mẫu thiết kế Poster QR mặc định.');
  };

  const isLocalOrigin = isLocalhostOrigin(baseUrl);

  return (
    <div className="space-y-6">
      {/* Studio Action Header */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2 shrink-0">
            <QrCode className="h-5 w-5 text-sky-800" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Thiết kế &amp; In Poster Mã QR Cổng Đặt giường Online
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Tạo standee A4, bảng mica để bàn A5 hoặc tem dán cửa phòng bệnh để người dân quét truy cập trực tiếp Cổng Đặt giường Trực tuyến không cần đăng nhập.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleDownloadQrPng}
            disabled={!qrDataUrl}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5 text-sky-700" />
            <span>Tải ảnh QR PNG</span>
          </button>
          <button
            type="button"
            onClick={() => handleExportPdf(10)}
            disabled={!urlComputation.target || exportingPdf}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5 text-teal-700" />
            <span>{exportingPdf ? 'Đang tạo PDF...' : 'Xuất PDF'}</span>
          </button>
          <button
            type="button"
            onClick={() => setPrintPreviewOpen(true)}
            disabled={!urlComputation.target}
            data-testid="open-qr-poster-print-preview"
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>Xem trước &amp; In Poster</span>
          </button>
        </div>
      </div>

      {/* Main 2-Column Studio Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Configuration Controls (5 cols) */}
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white p-5 space-y-5">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <h4 className="text-sm font-semibold text-slate-900">Tùy chỉnh nội dung &amp; bố cục in</h4>
            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Khôi phục mẫu</span>
            </button>
          </div>

          {/* 1. Target URL & Department Filter */}
          <div className="space-y-3">
            <div>
              <label htmlFor="qr-base-url" className="block text-xs font-medium text-slate-700 mb-1">
                Địa chỉ trang web triển khai (Domain chính thức) *
              </label>
              <div className="flex gap-2">
                <input
                  id="qr-base-url"
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://bedcare-phusan.onrender.com"
                  className="flex-1 min-w-0 rounded-md border border-slate-300 px-3 py-2 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() => setBaseUrl(getDefaultOrigin())}
                  className="rounded-md border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0"
                >
                  Lấy URL hiện tại
                </button>
              </div>
              {isLocalOrigin && (
                <p className="text-[11px] text-amber-800 mt-1">
                  Đang dùng địa chỉ nội bộ ({baseUrl}). Nếu in dán cho người dân quét từ 4G, hãy thay bằng địa chỉ công khai (VD: https://ten-app.onrender.com).
                </p>
              )}
              {urlComputation.error && (
                <p role="alert" className="text-[11px] text-rose-700 font-medium mt-1">
                  {urlComputation.error}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="qr-department-scope" className="block text-xs font-medium text-slate-700 mb-1">
                Phạm vi hiển thị khi người dân quét mã
              </label>
              <select
                id="qr-department-scope"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs"
              >
                <option value="">Toàn bộ Bệnh viện (Tất cả các khoa)</option>
                {activeDepartments.map((d) => (
                  <option key={d.id} value={d.id}>
                    Mở thẳng khoa: {d.name} ({d.code})
                  </option>
                ))}
              </select>
            </div>

            {urlComputation.target && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
                <div className="text-[11px] font-medium text-slate-600">Đường dẫn mã hóa trong QR:</div>
                <div
                  data-testid="qr-encoded-url"
                  className="font-mono text-[11px] text-sky-800 break-all select-all"
                >
                  {urlComputation.target}
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 hover:text-sky-800 whitespace-nowrap"
                  >
                    {copiedUrl ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedUrl ? 'Đã sao chép' : 'Sao chép link'}</span>
                  </button>
                  <a
                    href={urlComputation.target}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 hover:underline whitespace-nowrap"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>Mở thử cổng</span>
                  </a>
                </div>
              </div>
            )}
          </div>

          <hr className="border-slate-100" />

          {/* 2. Print Format & Theme */}
          <div className="space-y-3">
            <div>
              <span className="block text-xs font-medium text-slate-700 mb-1.5">Mẫu ấn phẩm &amp; Khổ giấy</span>
              <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-100 rounded-lg" role="radiogroup" aria-label="Chọn mẫu ấn phẩm QR">
                {POSTER_TEMPLATES.map((tpl) => {
                  const active = templateId === tpl.id;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setTemplateId(tpl.id)}
                      className={`rounded-md px-2 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                        active ? 'bg-white text-slate-900 shadow-sm font-semibold' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tpl.shortLabel}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">{activeTemplate.description}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="qr-theme-select" className="block text-xs font-medium text-slate-700 mb-1">
                  Tông màu in ấn
                </label>
                <select
                  id="qr-theme-select"
                  value={themeId}
                  onChange={(e) => setThemeId(e.target.value as PosterThemeId)}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs"
                >
                  {POSTER_THEMES.map((th) => (
                    <option key={th.id} value={th.id}>
                      {th.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="qr-ecc-select" className="block text-xs font-medium text-slate-700 mb-1">
                  Độ chịu lỗi QR (Chống lóa/rách)
                </label>
                <select
                  id="qr-ecc-select"
                  value={ecc}
                  onChange={(e) => setEcc(e.target.value as QrErrorCorrectionLevel)}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs"
                >
                  <option value="H">Mức H (30% - Tốt nhất cho ép mica)</option>
                  <option value="Q">Mức Q (25% - Cân bằng)</option>
                  <option value="M">Mức M (15% - Mắt QR thưa hơn)</option>
                </select>
              </div>
            </div>
          </div>

          <hr className="border-slate-100" />

          {/* 3. Poster Copy Fields */}
          <div className="space-y-3">
            <div>
              <label htmlFor="qr-hospital-name" className="block text-xs font-medium text-slate-700 mb-1">
                Tên Bệnh viện / Cơ sở Y tế
              </label>
              <input
                id="qr-hospital-name"
                type="text"
                value={hospitalName}
                onChange={(e) => setHospitalName(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold"
              />
            </div>

            <div>
              <label htmlFor="qr-headline" className="block text-xs font-medium text-slate-700 mb-1">
                Tiêu đề lớn trên Poster
              </label>
              <input
                id="qr-headline"
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label htmlFor="qr-subtitle" className="block text-xs font-medium text-slate-700 mb-1">
                Mô tả lợi ích cho người bệnh
              </label>
              <textarea
                id="qr-subtitle"
                rows={2}
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="qr-scan-cta" className="block text-xs font-medium text-slate-700 mb-1">
                  Lời kêu gọi quét mã
                </label>
                <input
                  id="qr-scan-cta"
                  type="text"
                  value={scanCta}
                  onChange={(e) => setScanCta(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label htmlFor="qr-hotline" className="block text-xs font-medium text-slate-700 mb-1">
                  Hotline hỗ trợ trực tiếp
                </label>
                <input
                  id="qr-hotline"
                  type="text"
                  value={hotline}
                  onChange={(e) => setHotline(e.target.value)}
                  placeholder="VD: 1900 1234"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={showSteps}
                onChange={(e) => setShowSteps(e.target.checked)}
                className="rounded border-slate-300 text-sky-700"
              />
              <span>Hiển thị khung 3 bước hướng dẫn quét cho người lớn tuổi</span>
            </label>
          </div>
        </div>

        {/* Right: Live Printable Sheet Preview (7 cols) */}
        <div className="lg:col-span-7 rounded-lg border border-slate-200 bg-slate-100/90 p-4 sm:p-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span className="font-semibold text-slate-800">{activeTemplate.label}</span>
            <span className="font-mono tabular-nums">
              {activeTemplate.orientation === 'landscape' ? 'A4 Ngang (297×210mm)' : 'A4 Dọc (210×297mm)'}
              {' · '}
              {activeTemplate.cardsPerSheet} bản/trang
            </span>
          </div>

          <div
            data-testid="qr-poster-live-preview"
            className="mx-auto bg-white p-4 sm:p-6 rounded border border-slate-300 shadow-sm"
            style={{
              maxWidth: activeTemplate.orientation === 'landscape' ? '100%' : '560px',
            }}
          >
            <PrintablePosterSheet
              config={sanitizedConfig}
              qrDataUrl={qrDataUrl}
              targetUrl={urlComputation.target}
            />
          </div>
        </div>
      </div>

      {/* Shared Print Preview Overlay for Margin Check, PDF Export & Physical Printing */}
      <PrintPreviewModal
        isOpen={printPreviewOpen}
        onClose={() => setPrintPreviewOpen(false)}
        title={`In ${activeTemplate.label}`}
        subtitle={`URL đích: ${urlComputation.target} · Mức chống lỗi QR: ${ecc}`}
        defaultOrientation={activeTemplate.orientation}
        defaultMarginMm={10}
        exportingPdf={exportingPdf}
        onExportPdf={(ctx) => handleExportPdf(ctx.marginMm)}
      >
        <PrintablePosterSheet
          config={sanitizedConfig}
          qrDataUrl={qrDataUrl}
          targetUrl={urlComputation.target}
        />
      </PrintPreviewModal>
    </div>
  );
}

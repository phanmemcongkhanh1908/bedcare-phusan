import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

interface BedQrCodeProps {
  bedId: string;
  bedCode: string;
  admissionId?: string | null;
  size?: number;
  caption?: string;
  compact?: boolean;
}

export function buildBedQrUrl(bedId: string, admissionId?: string | null): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://bedcare.hospital';
  const params = new URLSearchParams();
  params.set('bed', bedId);
  if (admissionId) params.set('admission', admissionId);
  return `${origin}/?${params.toString()}`;
}

export function BedQrCode({
  bedId,
  bedCode,
  admissionId,
  size = 112,
  caption,
  compact = false,
}: BedQrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string>('');
  const scanUrl = buildBedQrUrl(bedId, admissionId);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(scanUrl, {
      width: size * 2,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active) setDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [scanUrl, size]);

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded border border-slate-200 bg-slate-50 flex items-center justify-center text-[10px] font-mono text-slate-400"
      >
        QR...
      </div>
    );
  }

  return (
    <div className={`inline-flex flex-col items-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
      <div className="rounded-md border border-slate-300 bg-white p-1.5">
        <img
          src={dataUrl}
          alt={`Mã QR giường ${bedCode}`}
          width={size}
          height={size}
          className="block"
        />
      </div>
      {caption !== undefined ? (
        <span className="text-[10px] font-mono text-slate-600 text-center max-w-[150px] break-all">
          {caption}
        </span>
      ) : (
        <span className="text-[10px] font-mono font-semibold text-slate-700 text-center">
          QR · {bedCode}
        </span>
      )}
    </div>
  );
}

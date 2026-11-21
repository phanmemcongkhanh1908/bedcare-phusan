import { buildOfficialDocumentMeta } from '../utils/exportUtils';

interface OfficialReportHeaderProps {
  title: string;
  scopeLabel?: string;
  documentCode?: string;
  facilityBanner?: string;
  departmentBanner?: string;
  className?: string;
}

export function OfficialReportHeader({
  title,
  scopeLabel,
  documentCode,
  facilityBanner,
  departmentBanner,
  className = '',
}: OfficialReportHeaderProps) {
  const meta = buildOfficialDocumentMeta({
    scopeLabel,
    documentCode,
    facilityBanner,
    departmentBanner,
  });

  return (
    <div className={`space-y-4 border-b-2 border-slate-800 pb-4 text-slate-900 ${className}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-center">
        <div className="space-y-0.5">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-800">
            {meta.facilityBanner}
          </div>
          <div className="text-xs font-bold uppercase text-sky-800">
            {meta.departmentBanner}
          </div>
          <div className="text-[11px] italic text-slate-600 pt-0.5">
            Số: {meta.documentCode}
          </div>
        </div>
        <div className="space-y-0.5">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-900">
            {meta.nationalMotto}
          </div>
          <div className="text-xs font-bold text-slate-900 underline underline-offset-4">
            {meta.nationalSubMotto}
          </div>
          <div className="text-[11px] italic text-slate-600 pt-0.5">
            {meta.vietnameseDateLine}
          </div>
        </div>
      </div>

      <div className="text-center pt-1">
        <h3 className="text-base sm:text-lg font-bold uppercase tracking-tight text-slate-900">
          {title}
        </h3>
        <div className="text-xs text-slate-600 mt-1">
          Phạm vi: {meta.scopeLabel} · Thời điểm xuất: {meta.issuedAtLabel}
        </div>
      </div>
    </div>
  );
}

interface OfficialReportSignaturesProps {
  signers?: [string, string, string];
  className?: string;
}

export function OfficialReportSignatures({
  signers,
  className = '',
}: OfficialReportSignaturesProps) {
  const meta = buildOfficialDocumentMeta({ signers });

  return (
    <div className={`pt-6 text-slate-900 break-inside-avoid ${className}`}>
      <div className="text-right text-xs italic text-slate-700 mb-3 pr-4">
        {meta.vietnameseDateLine}
      </div>
      <div className="grid grid-cols-3 gap-4 text-center">
        {meta.signers.map((roleLabel) => (
          <div key={roleLabel} className="space-y-1">
            <div className="text-xs font-bold uppercase text-slate-900">{roleLabel}</div>
            <div className="text-[11px] italic text-slate-500">{meta.signerNote}</div>
            <div className="h-14" />
          </div>
        ))}
      </div>
    </div>
  );
}

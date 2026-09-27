import React, { useRef, useState } from 'react';
import { FileText, UploadCloud, X } from 'lucide-react';
import { Button, cx } from '../ui';

/** Document fourni à un outil public : fichier (PDF, Word, texte) ou texte collé. */
export type DocSource =
  | { kind: 'file'; fileName: string; mimeType: string; fileBase64: string; size: number }
  | { kind: 'text'; text: string };
/** Ancien nom, conservé pour la lisibilité côté CV. */
export type CvSource = DocSource;

const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPT = '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

/** Message d'erreur, ou null si le fichier est accepté. */
export function docFileError(file: { name: string; type: string; size: number }): string | null {
  const ok = /\.(pdf|docx|txt)$/i.test(file.name) || /^(application\/(pdf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)|text\/plain)$/.test(file.type);
  if (!ok) return 'Format non pris en charge : déposez un PDF, un document Word (.docx) ou un fichier texte (.txt).';
  if (file.size > MAX_BYTES) return 'Fichier trop volumineux (8 Mo maximum).';
  return null;
}
export const cvFileError = docFileError;

/** Corps de requête du CV pour /api/tools/*. */
export const cvSourceBody = (s: DocSource) =>
  s.kind === 'file' ? { fileBase64: s.fileBase64, mimeType: s.mimeType, fileName: s.fileName } : { cvText: s.text };

/** Corps de requête de l'offre pour /api/tools/match. */
export const offerSourceBody = (s: DocSource) =>
  s.kind === 'file' ? { offerFileBase64: s.fileBase64, offerMimeType: s.mimeType, offerFileName: s.fileName } : { offerText: s.text };

const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

const guessMime = (name: string) =>
  /\.pdf$/i.test(name) ? 'application/pdf' : /\.docx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.txt$/i.test(name) ? 'text/plain' : '';

export interface DocLabels {
  /** Nom du document dans les messages (« votre CV », « l'offre »). */
  what: string;
  dropTitle: string;
  pastePlaceholder: string;
}

export const CV_LABELS: DocLabels = { what: 'votre CV', dropTitle: 'Glissez votre CV ici', pastePlaceholder: 'Collez ici le texte complet de votre CV…' };
export const OFFER_LABELS: DocLabels = { what: 'l’offre', dropTitle: 'Glissez l’offre ici', pastePlaceholder: 'Collez ici le texte de l’offre : intitulé, missions, profil recherché…' };

export const DocumentInput: React.FC<{
  value: DocSource | null;
  onChange: (s: DocSource | null) => void;
  idPrefix: string;
  labels?: DocLabels;
  /** Mode affiché au départ. */
  defaultMode?: 'file' | 'text';
}> = ({ value, onChange, idPrefix, labels = CV_LABELS, defaultMode = 'file' }) => {
  const [mode, setMode] = useState<'file' | 'text'>(value ? value.kind : defaultMode);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const takeFile = async (file?: File) => {
    setError(null);
    if (!file) return;
    const err = docFileError(file);
    if (err) { setError(err); return; }
    try {
      const dataUrl = await readAsDataUrl(file);
      onChange({ kind: 'file', fileName: file.name, mimeType: file.type || guessMime(file.name), fileBase64: dataUrl, size: file.size });
    } catch {
      setError('Impossible de lire ce fichier : réessayez.');
    }
  };

  return (
    <div className="space-y-2">
      <div role="group" aria-label={`Façon de fournir ${labels.what}`} className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
        {([['file', 'Déposer un fichier'], ['text', 'Coller le texte']] as const).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={mode === id}
            onClick={() => { setMode(id); setError(null); if (value && value.kind !== id) onChange(null); }}
            className={cx('rounded-lg px-3 py-1.5 text-sm font-medium', mode === id ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900')}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'file' ? (
        value?.kind === 'file' ? (
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
            <FileText className="h-8 w-8 shrink-0 text-brand-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-900">{value.fileName}</p>
              <p className="text-xs text-slate-500">{Math.max(1, Math.round(value.size / 1024))} Ko</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)} aria-label={`Retirer ${value.fileName}`}>
              <X className="h-4 w-4" aria-hidden="true" /> Changer
            </Button>
          </div>
        ) : (
          <div
            data-testid={`${idPrefix}-dropzone`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setDragging(false); takeFile(e.dataTransfer.files?.[0]); }}
            className={cx('flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition-colors',
              dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50/60')}
          >
            <UploadCloud className={cx('h-9 w-9', dragging ? 'text-brand-600' : 'text-slate-400')} aria-hidden="true" />
            <div>
              <p className="text-[15px] font-semibold text-slate-900">{dragging ? 'Déposez le fichier ici' : labels.dropTitle}</p>
              <p className="mt-0.5 text-sm text-slate-500">PDF, Word (.docx) ou texte (.txt), 8 Mo maximum</p>
            </div>
            <Button type="button" variant="primary" onClick={() => inputRef.current?.click()}>Choisir un fichier</Button>
            <input ref={inputRef} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-label={`Choisir le fichier de ${labels.what}`}
              onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
        )
      ) : (
        <div>
          <label htmlFor={`${idPrefix}-text`} className="sr-only">Texte de {labels.what}</label>
          <textarea id={`${idPrefix}-text`} rows={8} placeholder={labels.pastePlaceholder}
            value={value?.kind === 'text' ? value.text : ''}
            onChange={(e) => onChange(e.target.value.trim() ? { kind: 'text', text: e.target.value } : null)}
            className="block w-full resize-y rounded-xl border border-slate-300 bg-white p-3 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
        </div>
      )}
      {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
    </div>
  );
};

/** Saisie du CV (fichier ou texte). */
export const CvSourceInput: React.FC<{ value: DocSource | null; onChange: (s: DocSource | null) => void; idPrefix: string }> = (props) => (
  <DocumentInput {...props} labels={CV_LABELS} />
);

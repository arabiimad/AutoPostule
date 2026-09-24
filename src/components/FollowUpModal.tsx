import React, { useEffect, useState } from 'react';
import { Copy, Check, Send, RefreshCw, Mail, CalendarPlus } from 'lucide-react';
import { Application, UserProfile } from '../types';
import { apiFetch, readJson } from '../utils/api';
import { Badge, Button, LinkButton, Modal, cx } from './ui';

interface FollowUpModalProps {
  application: Application;
  userProfile: UserProfile;
  onClose: () => void;
  onMarkSent: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Rappel calendrier (.ics, RFC 5545)
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');

/** Date locale au format AAAAMMJJ (événement « journée entière »). */
const icsDate = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/** Horodatage UTC au format AAAAMMJJTHHMMSSZ. */
const icsStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Échappe une valeur TEXT (antislash, point-virgule, virgule, retours à la ligne). */
const icsEscape = (s: string) =>
  (s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

/** Replie les lignes à 75 octets UTF-8 maximum (continuation préfixée d'une espace). */
const icsFold = (line: string) => {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = ch;
      bytes = size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  out.push(current);
  return out.join('\r\n ');
};

/** Construit un fichier iCalendar (UTF-8, fins de ligne CRLF) rappelant de relancer l'entreprise. */
export function buildFollowUpIcs(application: Application): string {
  const now = new Date();
  let day: Date;
  const parsed = application.followUpAt ? new Date(application.followUpAt) : null;
  if (parsed && !isNaN(parsed.getTime())) {
    day = parsed;
  } else {
    day = new Date(now);
    day.setDate(day.getDate() + 7);
  }
  const next = new Date(day);
  next.setDate(next.getDate() + 1);

  const summary = `Relancer ${application.company || 'l’entreprise'} — ${application.jobTitle || 'candidature'}`;
  const description = [
    `Relance de la candidature « ${application.jobTitle || ''} » chez ${application.company || ''}.`,
    application.jobUrl ? `Offre : ${application.jobUrl}` : ''
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Postu//Relance candidature//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:relance-${application.id || 'candidature'}-${icsDate(day)}@postu`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART;VALUE=DATE:${icsDate(day)}`,
    `DTEND;VALUE=DATE:${icsDate(next)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(application.jobUrl ? [`URL:${application.jobUrl.replace(/[\r\n]/g, '')}`] : []),
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(summary)}`,
    'TRIGGER:PT9H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

const slug = (s: string) =>
  (s || 'entreprise').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'entreprise';

/** Brouillon d'email de relance pour une candidature restée sans réponse. */
export const FollowUpModal: React.FC<FollowUpModalProps> = ({ application, userProfile, onClose, onMarkSent }) => {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isTemplate, setIsTemplate] = useState(false);
  const [icsDone, setIcsDone] = useState(false);

  // Fermeture stable : évite de réinitialiser le focus de la modale à chaque rendu du parent.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const handleClose = React.useCallback(() => onCloseRef.current(), []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await readJson<any>(await apiFetch('/api/tailor/followup', { candidate: userProfile, application }));
      setSubject(data.subject || '');
      setBody(data.body || '');
      setIsTemplate(data.source !== 'gemini-ai');
    } catch (e: any) {
      setError(e?.message || 'Brouillon indisponible.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application.id]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Objet : ${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copie refusée par le navigateur : sélectionnez le texte manuellement.');
    }
  };

  const downloadIcs = () => {
    const ics = buildFollowUpIcs(application);
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `relance-${slug(application.company)}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setIcsDone(true);
    setTimeout(() => setIcsDone(false), 2500);
  };

  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const count = application.followUpCount || 0;
  const followUpDate = application.followUpAt && !isNaN(new Date(application.followUpAt).getTime())
    ? new Date(application.followUpAt).toLocaleDateString('fr-FR')
    : null;
  const fieldClass = 'mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-brand-500 disabled:bg-slate-50 disabled:text-slate-400';

  return (
    <Modal
      onClose={handleClose}
      size="lg"
      title={`Relancer ${application.company}`}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-slate-700">{application.jobTitle}</span>
          <span aria-hidden="true">·</span>
          <span>{application.appliedAt ? `Envoyée le ${new Date(application.appliedAt).toLocaleDateString('fr-FR')}` : 'Date d’envoi inconnue'}</span>
          {count > 0 && <Badge tone="amber">{count} relance{count > 1 ? 's' : ''} envoyée{count > 1 ? 's' : ''}</Badge>}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={load} disabled={loading} className="mr-auto">
            <RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
            Nouvelle proposition
          </Button>
          <Button variant="primary" onClick={() => onMarkSent()} disabled={loading} className="w-full sm:w-auto">
            <Send className="h-4 w-4" aria-hidden="true" />
            J'ai envoyé la relance
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-5 sm:px-6">
        {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{error}</div>}
        {isTemplate && !loading && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
            Modèle standard (IA indisponible) : personnalisez-le avant l'envoi.
          </div>
        )}

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Objet</span>
          <input
            value={loading ? 'Rédaction en cours…' : subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={loading}
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Message</span>
          <textarea
            value={loading ? '' : body}
            onChange={(e) => setBody(e.target.value)}
            disabled={loading}
            rows={12}
            placeholder={loading ? 'Rédaction en cours…' : undefined}
            className={cx(fieldClass, 'resize-y leading-relaxed')}
          />
        </label>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="secondary" size="sm" onClick={copy} disabled={loading || !body}>
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? 'Copié' : 'Copier'}
          </Button>
          <LinkButton variant="secondary" size="sm" href={mailto}>
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            Ouvrir dans ma messagerie
          </LinkButton>
          <Button
            variant="secondary"
            size="sm"
            onClick={downloadIcs}
            title={followUpDate ? `Rappel le ${followUpDate}` : 'Rappel dans 7 jours'}
          >
            {icsDone ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />}
            Ajouter un rappel au calendrier
          </Button>
        </div>
        <p className="text-xs text-slate-500">
          Le rappel ({followUpDate ? `le ${followUpDate}` : 'dans 7 jours'}) s'importe dans Outlook, Google Agenda ou Calendrier Apple.
        </p>
      </div>
    </Modal>
  );
};

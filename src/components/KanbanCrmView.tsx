import React, { useMemo, useRef, useState } from 'react';
import { ExternalLink, FileText, MapPin, Mail, MessagesSquare, Copy, Check, Trash2, Bell, KanbanSquare, Send, Download, Upload, BarChart3 } from 'lucide-react';
import { Application, ApplicationStatus } from '../types';
import { Badge, Button, CompanyAvatar, EmptyState, LinkButton, PageHeader, Tabs, cx } from './ui';
import { CONTRACT_LABELS, formatLongDate } from '../utils/format';
import { applicationsBackup, applicationsToCsv, computeStats, downloadFile, parseApplicationsBackup } from '../utils/applicationsData';

interface KanbanCrmViewProps {
  applications: Application[];
  onOpenLatexForApp: (app: Application) => void;
  onOpenInterviewPrep: (app: Application) => void;
  onUpdateAppStatus: (appId: string, newStatus: ApplicationStatus) => void;
  /** Postuler : ouvre le portail, copie la lettre et télécharge le CV en PDF. Sans lui : simple lien. */
  onApply?: (app: Application) => void;
  /** Ouvre le brouillon de relance d'une candidature. */
  onFollowUp?: (app: Application) => void;
  onDelete?: (appId: string) => void;
  onGoToOffers?: () => void;
  /** Import d'une sauvegarde JSON (les dossiers existants de même id sont remplacés). */
  onImport?: (apps: Application[]) => void;
  onError?: (message: string) => void;
}

const COLUMNS: { id: ApplicationStatus; title: string; hint: string; dot: string }[] = [
  { id: 'detected', title: 'Sauvegardées', hint: 'Offres mises de côté', dot: 'bg-slate-400' },
  { id: 'prepared', title: 'Dossier prêt', hint: 'CV et lettre générés', dot: 'bg-brand-500' },
  { id: 'applied', title: 'Envoyées', hint: 'En attente de réponse', dot: 'bg-sky-500' },
  { id: 'interview', title: 'Entretiens', hint: 'À préparer', dot: 'bg-emerald-500' },
  { id: 'offer', title: 'Offres reçues', hint: 'Félicitations !', dot: 'bg-amber-500' },
  { id: 'rejected', title: 'Refusées', hint: 'Classées', dot: 'bg-rose-400' }
];

const isDue = (a: Application) => a.status === 'applied' && !!a.followUpAt && new Date(a.followUpAt).getTime() <= Date.now();

const AppCard: React.FC<{
  app: Application;
  onOpenLatex: () => void;
  onInterview: () => void;
  onStatus: (s: ApplicationStatus) => void;
  onApply?: () => void;
  onFollowUp?: () => void;
  onDelete?: () => void;
}> = ({ app, onOpenLatex, onInterview, onStatus, onApply, onFollowUp, onDelete }) => {
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hasDossier = !!app.latexResumeCode;
  const due = isDue(app);

  const copyLetter = async () => {
    if (!app.coverLetter) return;
    try {
      await navigator.clipboard.writeText(app.coverLetter);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  const askDelete = () => {
    if (confirmDelete) { onDelete?.(); return; }
    setConfirmDelete(true);
    setTimeout(() => setConfirmDelete(false), 3500);
  };

  return (
    <article className={cx('rounded-2xl border bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,.05)]', due ? 'border-amber-300' : 'border-slate-200')}>
      <div className="flex gap-3">
        <CompanyAvatar name={app.company} size={36} />
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold leading-snug text-slate-900 line-clamp-2">{app.jobTitle}</h4>
          <p className="truncate text-[13px] text-slate-600">{app.company}</p>
          {app.location && <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-400"><MapPin className="h-3 w-3 shrink-0" />{app.location}</p>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge>{CONTRACT_LABELS[app.contractType] || app.contractType}</Badge>
        {app.isSpontaneous && <Badge tone="sky">Spontanée</Badge>}
        {typeof app.matchScore === 'number' && app.matchScore > 0 && <Badge tone={app.matchScore >= 70 ? 'green' : app.matchScore >= 40 ? 'amber' : 'neutral'}>{app.matchScore} % compatible</Badge>}
        {(app.versions?.length || 0) > 0 && <Badge title="Versions précédentes du CV et de la lettre">{app.versions!.length + 1} versions</Badge>}
      </div>

      <p className="mt-2 text-xs text-slate-400">
        {app.appliedAt ? `Envoyée le ${formatLongDate(app.appliedAt)}` : `Ajoutée le ${formatLongDate(app.createdAt)}`}
      </p>

      {app.status === 'applied' && (
        <p className={cx('mt-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs', due ? 'bg-amber-50 text-amber-800 font-semibold' : 'bg-slate-50 text-slate-500')}>
          <Bell className="h-3.5 w-3.5" />
          {app.followUpAt
            ? due ? 'À relancer maintenant' : `Relance prévue le ${formatLongDate(app.followUpAt)}`
            : (app.followUpCount || 0) >= 3 ? '3 relances envoyées' : 'Pas de relance prévue'}
          {(app.followUpCount || 0) > 0 && app.followUpAt ? ` · ${app.followUpCount} envoyée(s)` : ''}
        </p>
      )}

      {/* Action principale selon l'étape */}
      <div className="mt-3 grid gap-1.5">
        {app.status === 'detected' && (
          <Button variant="primary" size="sm" onClick={onOpenLatex}><FileText className="h-3.5 w-3.5" /> Préparer CV + lettre</Button>
        )}
        {app.status === 'prepared' && (
          <>
            {app.jobUrl && (onApply && hasDossier
              ? <Button variant="primary" size="sm" onClick={onApply} title="Ouvre le site, copie la lettre et télécharge le CV en PDF">Postuler sur le site <ExternalLink className="h-3.5 w-3.5" /></Button>
              : <LinkButton href={app.jobUrl} target="_blank" rel="noopener noreferrer" variant="primary" size="sm">Postuler sur le site <ExternalLink className="h-3.5 w-3.5" /></LinkButton>)}
            <Button variant="secondary" size="sm" onClick={() => onStatus('applied')}><Send className="h-3.5 w-3.5" /> J’ai postulé</Button>
          </>
        )}
        {app.status === 'applied' && onFollowUp && (
          <Button variant={due ? 'primary' : 'secondary'} size="sm" onClick={onFollowUp}><Mail className="h-3.5 w-3.5" /> Préparer une relance</Button>
        )}
        {app.status === 'interview' && (
          <Button variant="primary" size="sm" onClick={onInterview}><MessagesSquare className="h-3.5 w-3.5" /> Préparer l’entretien</Button>
        )}
      </div>

      {/* Actions secondaires */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {hasDossier && <button onClick={onOpenLatex} className="font-medium text-slate-600 hover:text-brand-700">Voir le CV et la lettre</button>}
        {app.coverLetter && (
          <button onClick={copyLetter} className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-brand-700">
            {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}{copied ? 'Copiée' : 'Copier la lettre'}
          </button>
        )}
        {app.status !== 'prepared' && app.jobUrl && <a href={app.jobUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-600 hover:text-brand-700">Voir l’offre ↗</a>}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
        <label className="text-xs text-slate-500">
          <span className="sr-only">Déplacer vers</span>
          <select
            value={app.status}
            onChange={(e) => onStatus(e.target.value as ApplicationStatus)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-300"
            aria-label="Étape de la candidature"
          >
            {COLUMNS.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </label>
        {onDelete && (
          <button onClick={askDelete} className={cx('inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium', confirmDelete ? 'bg-rose-600 text-white' : 'text-slate-400 hover:bg-rose-50 hover:text-rose-600')}
            aria-label="Supprimer la candidature">
            <Trash2 className="h-3.5 w-3.5" />{confirmDelete && 'Confirmer'}
          </button>
        )}
      </div>
    </article>
  );
};

export const KanbanCrmView: React.FC<KanbanCrmViewProps> = ({
  applications,
  onOpenLatexForApp,
  onOpenInterviewPrep,
  onUpdateAppStatus,
  onApply,
  onFollowUp,
  onDelete,
  onGoToOffers,
  onImport,
  onError
}) => {
  const [mobileStatus, setMobileStatus] = useState<ApplicationStatus>('prepared');
  const [view, setView] = useState<'board' | 'stats'>('board');
  const fileRef = useRef<HTMLInputElement>(null);
  const stamp = () => new Date().toISOString().slice(0, 10);

  const importBackup = async (file?: File | null) => {
    if (!file || !onImport) return;
    try {
      onImport(parseApplicationsBackup(await file.text()));
    } catch (e: any) {
      onError?.(e?.message || 'Fichier de sauvegarde illisible.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const dueCount = applications.filter(isDue).length;
  const sent = applications.filter(a => ['applied', 'interview', 'offer', 'rejected'].includes(a.status)).length;
  const interviews = applications.filter(a => a.status === 'interview' || a.status === 'offer').length;

  const card = (app: Application) => (
    <AppCard
      key={app.id}
      app={app}
      onOpenLatex={() => onOpenLatexForApp(app)}
      onInterview={() => onOpenInterviewPrep(app)}
      onStatus={(s) => onUpdateAppStatus(app.id, s)}
      onApply={onApply ? () => onApply(app) : undefined}
      onFollowUp={onFollowUp ? () => onFollowUp(app) : undefined}
      onDelete={onDelete ? () => onDelete(app.id) : undefined}
    />
  );

  return (
    <div>
      <PageHeader
        title="Mes candidatures"
        subtitle="Suivez chaque dossier, de l’offre sauvegardée à la réponse de l’entreprise. Vous postulez vous-même sur le site du recruteur ; déplacez ensuite la carte."
        actions={
          <>
            {applications.length > 0 && (
              <>
                <Button variant="secondary" size="sm" onClick={() => downloadFile(`candidatures-${stamp()}.csv`, applicationsToCsv(applications), 'text/csv;charset=utf-8')} title="Tableau compatible Excel">
                  <Download className="h-3.5 w-3.5" /> Exporter (Excel)
                </Button>
                <Button variant="ghost" size="sm" onClick={() => downloadFile(`autopostule-sauvegarde-${stamp()}.json`, applicationsBackup(applications), 'application/json')} title="Sauvegarde complète, réimportable (CV et lettres inclus)">
                  <Download className="h-3.5 w-3.5" /> Sauvegarde
                </Button>
              </>
            )}
            {onImport && (
              <>
                <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} title="Restaurer une sauvegarde AutoPostule (.json)">
                  <Upload className="h-3.5 w-3.5" /> Importer
                </Button>
                <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" aria-label="Fichier de sauvegarde" onChange={(e) => importBackup(e.target.files?.[0])} />
              </>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Suivies', value: applications.length },
          { label: 'Envoyées', value: sent },
          { label: 'Entretiens', value: interviews },
          { label: 'À relancer', value: dueCount, warn: dueCount > 0 }
        ].map(s => (
          <div key={s.label} className={cx('rounded-2xl border bg-white px-4 py-3', s.warn ? 'border-amber-300' : 'border-slate-200')}>
            <p className="text-xs font-medium text-slate-500">{s.label}</p>
            <p className={cx('mt-0.5 text-2xl font-bold tracking-tight', s.warn ? 'text-amber-600' : 'text-slate-900')}>{s.value}</p>
          </div>
        ))}
      </div>

      {applications.length > 0 && (
        <Tabs
          className="mb-5"
          value={view}
          onChange={(v) => setView(v as 'board' | 'stats')}
          tabs={[{ id: 'board', label: 'Tableau de suivi' }, { id: 'stats', label: <span className="inline-flex items-center gap-1.5"><BarChart3 className="h-4 w-4" />Statistiques</span> }]}
        />
      )}

      {applications.length > 0 && view === 'stats' ? (
        <StatsPanel applications={applications} />
      ) : applications.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white">
          <EmptyState icon={<KanbanSquare className="h-6 w-6" />} title="Aucune candidature pour l’instant"
            action={onGoToOffers && <Button variant="primary" onClick={onGoToOffers}>Parcourir les offres</Button>}>
            Sauvegardez une offre ou préparez un dossier depuis l’onglet Offres : il apparaîtra ici.
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Mobile : une étape à la fois */}
          <div className="lg:hidden">
            <div className="thin-scroll -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {COLUMNS.map(c => {
                const n = applications.filter(a => a.status === c.id).length;
                return (
                  <button key={c.id} onClick={() => setMobileStatus(c.id)}
                    aria-pressed={mobileStatus === c.id}
                    className={cx('shrink-0 rounded-full border px-3.5 h-9 text-sm font-medium', mobileStatus === c.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700')}>
                    {c.title} <span className="opacity-70">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="space-y-3">
              {applications.filter(a => a.status === mobileStatus).map(card)}
              {!applications.some(a => a.status === mobileStatus) && <p className="py-10 text-center text-sm text-slate-400">Aucun dossier à cette étape.</p>}
            </div>
          </div>

          {/* Bureau : tableau */}
          <div className="thin-scroll hidden lg:flex gap-4 overflow-x-auto pb-4">
            {COLUMNS.map(col => {
              const colApps = applications.filter(a => a.status === col.id);
              return (
                <section key={col.id} className="w-[272px] shrink-0 rounded-2xl bg-slate-100/80 p-3" aria-label={col.title}>
                  <header className="mb-3 flex items-center justify-between px-1">
                    <div className="flex items-center gap-2">
                      <span className={cx('h-2 w-2 rounded-full', col.dot)} />
                      <h3 className="text-sm font-semibold text-slate-800">{col.title}</h3>
                    </div>
                    <span className="rounded-full bg-white px-2 text-xs font-semibold leading-5 text-slate-600">{colApps.length}</span>
                  </header>
                  <div className="space-y-3">
                    {colApps.length === 0
                      ? <p className="rounded-xl border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">{col.hint}</p>
                      : colApps.map(card)}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

/** Tableau de bord : taux de réponse, délais, sources les plus efficaces, rythme d'envoi. */
const StatsPanel: React.FC<{ applications: Application[] }> = ({ applications }) => {
  const st = useMemo(() => computeStats(applications), [applications]);
  const maxWeek = Math.max(1, ...st.weekly.map(w => w.count));
  const kpis = [
    { label: 'Taux de réponse', value: st.responseRate === null ? '—' : `${st.responseRate} %`, hint: `${st.responses} réponse(s) sur ${st.sent} envoi(s)` },
    { label: 'Taux d’entretien', value: st.interviewRate === null ? '—' : `${st.interviewRate} %`, hint: `${st.interviews} entretien(s)` },
    { label: 'Délai médian de réponse', value: st.medianResponseDays === null ? '—' : `${st.medianResponseDays} j`, hint: 'entre l’envoi et la réponse' },
    { label: 'Offres reçues', value: String(st.offers), hint: `${st.rejected} refus` }
  ];

  if (st.sent === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white">
        <EmptyState icon={<BarChart3 className="h-6 w-6" />} title="Pas encore de statistiques">
          Les statistiques apparaissent dès que vous marquez une candidature comme envoyée (« J’ai postulé »).
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map(k => (
          <div key={k.label} className="rounded-2xl border border-slate-200 bg-white px-4 py-3.5">
            <p className="text-xs font-medium text-slate-500">{k.label}</p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{k.value}</p>
            <p className="mt-0.5 text-xs text-slate-400">{k.hint}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">Candidatures envoyées par semaine</h3>
          <div className="mt-4 flex h-40 items-end gap-2" role="img" aria-label={`Candidatures envoyées par semaine : ${st.weekly.map(w => `${w.label} ${w.count}`).join(', ')}`}>
            {st.weekly.map(w => (
              <div key={w.label} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-700">{w.count || ''}</span>
                <div className="w-full rounded-t-md bg-brand-500" style={{ height: `${Math.max(w.count ? 6 : 2, (w.count / maxWeek) * 110)}px`, opacity: w.count ? 1 : 0.25 }} />
                <span className="text-[10px] text-slate-400 whitespace-nowrap">{w.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">Efficacité par source</h3>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1.5 font-medium">Source</th>
                <th className="py-1.5 text-right font-medium">Envoyées</th>
                <th className="py-1.5 text-right font-medium">Réponses</th>
                <th className="py-1.5 text-right font-medium">Taux</th>
              </tr>
            </thead>
            <tbody>
              {st.bySource.map(r => (
                <tr key={r.source} className="border-t border-slate-100">
                  <td className="py-2 pr-2 text-slate-800">{r.source}</td>
                  <td className="py-2 text-right tabular-nums text-slate-700">{r.sent}</td>
                  <td className="py-2 text-right tabular-nums text-slate-700">{r.responses}</td>
                  <td className="py-2 text-right tabular-nums font-semibold text-slate-900">{Math.round((r.responses / r.sent) * 100)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import {
  Bot,
  Play,
  Settings,
  Terminal,
  ShieldCheck,
  ArrowRight,
  Layers,
  Square,
  Send,
  ExternalLink,
  FileText,
  Search
} from 'lucide-react';
import { UserProfile, AgentLog, ContractType, Application } from '../types';
import { Button, CompanyAvatar, PageHeader, cx } from './ui';

interface AgentAutomationViewProps {
  userProfile: UserProfile;
  /** Enregistre (et persiste) des réglages du profil. */
  onSaveSettings: (updated: Partial<UserProfile>) => void;
  onTriggerAgentCycle: () => Promise<void>;
  /** Prépare plusieurs dossiers d'affilée (sans ouvrir de portail). */
  onTriggerBatch: (count: number) => Promise<void>;
  onStop: () => void;
  progress: { done: number; total: number } | null;
  isAgentRunning: boolean;
  agentLogs: AgentLog[];
  onGoToInterviews: () => void;
  onGoToOffers: () => void;
  preparedCount: number;
  /** Nombre d'offres chargées et libellé de la recherche analysée. */
  jobsCount: number;
  searchLabel: string;
  /** Dossiers prêts (CV + lettre) pas encore envoyés. */
  queue: Application[];
  onOpenQueued: (app: Application) => void;
  onMarkApplied: (app: Application) => void;
  onOpenDossier: (app: Application) => void;
}

const BATCH_SIZES = [3, 5, 10];

const CONTRACTS: { id: ContractType; label: string }[] = [
  { id: 'alternance', label: 'Alternance' },
  { id: 'stage', label: 'Stage' },
  { id: 'cdi', label: 'CDI' },
  { id: 'cdd', label: 'CDD' },
  { id: 'freelance', label: 'Freelance' }
];

/**
 * Assistant de candidature (semi-automatique).
 * À chaque cycle : choisit la meilleure offre non traitée qui respecte le seuil et les contrats préférés,
 * génère CV + lettre, ouvre le portail de l'entreprise. En série, prépare plusieurs dossiers qui rejoignent
 * la file « prêts à envoyer ». La soumission reste faite par l'utilisateur.
 */
export const AgentAutomationView: React.FC<AgentAutomationViewProps> = ({
  userProfile,
  onSaveSettings,
  onTriggerAgentCycle,
  onTriggerBatch,
  onStop,
  progress,
  isAgentRunning,
  agentLogs,
  onGoToInterviews,
  onGoToOffers,
  preparedCount,
  jobsCount,
  searchLabel,
  queue,
  onOpenQueued,
  onMarkApplied,
  onOpenDossier
}) => {
  const [batchSize, setBatchSize] = useState<number>(5);
  const sortedQueue = [...queue].sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
  const [minScore, setMinScore] = useState<number>(userProfile.minMatchScore ?? 60);

  useEffect(() => {
    setMinScore(userProfile.minMatchScore ?? 60);
  }, [userProfile.minMatchScore]);

  const commitScore = () => {
    if (minScore !== userProfile.minMatchScore) {
      onSaveSettings({ minMatchScore: minScore });
    }
  };

  const toggleContract = (c: ContractType) => {
    const current = userProfile.preferredContracts || [];
    const next = current.includes(c) ? current.filter(x => x !== c) : [...current, c];
    onSaveSettings({ preferredContracts: next });
  };

  const hasProfile = userProfile.skills.length > 0 && userProfile.experiences.length > 0;
  const uid = React.useId();
  const scoreId = `${uid}-score`;
  const scoreHelpId = `${uid}-score-help`;
  const profileHintId = `${uid}-profile-hint`;

  return (
    <div>

      <PageHeader
        title="Assistant de candidatures"
        subtitle={<>L’assistant choisit les meilleures offres encore non traitées selon vos critères, génère pour chacune un CV et une lettre à partir de votre profil, puis vous ouvre le site de l’entreprise avec la lettre copiée et le CV en PDF. <strong className="text-slate-700">C’est vous qui envoyez la candidature</strong> : rien n’est envoyé à votre place.</>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        <div className="lg:col-span-5 space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <Settings className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Critères de sélection
            </h2>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={scoreId} className="text-sm font-medium text-slate-700">Compatibilité minimale</label>
                <span className="text-sm font-semibold text-brand-700" aria-hidden="true">{minScore} %</span>
              </div>
              <input
                id={scoreId}
                aria-describedby={scoreHelpId}
                aria-valuetext={`${minScore} %`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                onMouseUp={commitScore}
                onTouchEnd={commitScore}
                onKeyUp={commitScore}
                className="w-full cursor-pointer accent-brand-600"
              />
              <p id={scoreHelpId} className="text-xs text-slate-500">
                Part des compétences demandées par l'offre que vous possédez (d'après votre profil).
              </p>
            </div>

            <div className="space-y-2 border-t border-slate-200 pt-4">
              <p id={`${uid}-contracts`} className="text-sm font-medium text-slate-700">Types de contrat recherchés</p>
              <div role="group" aria-labelledby={`${uid}-contracts`} className="flex flex-wrap gap-2">
                {CONTRACTS.map(c => {
                  const active = (userProfile.preferredContracts || []).includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleContract(c.id)}
                      aria-pressed={active}
                      className={cx(
                        'rounded-xl border px-3 py-1.5 text-sm font-semibold transition-colors',
                        active ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                      )}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500">Aucun type sélectionné : tous les contrats sont retenus.</p>
            </div>

            {!hasProfile && (
              <p id={profileHintId} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                Importez votre CV (compétences + expériences) avant de lancer l'assistant.
              </p>
            )}

            <div className="space-y-2 border-t border-slate-200 pt-4">
              <div className="flex items-start justify-between gap-2 text-xs text-slate-500">
                <span className="flex items-start gap-1.5">
                  <Search className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    Offres analysées : <strong className="text-slate-700">{jobsCount}</strong>
                    {searchLabel ? <> ({searchLabel})</> : <> (dernière recherche)</>}. Les pages suivantes des sources sont chargées si besoin.
                  </span>
                </span>
                <button type="button" onClick={onGoToOffers} className="shrink-0 font-semibold text-brand-700 hover:text-brand-900">
                  Changer
                </button>
              </div>
            </div>

            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={onTriggerAgentCycle}
              disabled={isAgentRunning || !hasProfile}
              aria-describedby={!hasProfile ? profileHintId : undefined}
              className="w-full"
            >
              {isAgentRunning && !progress ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                  Préparation du dossier…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                  Préparer le prochain dossier
                </>
              )}
            </Button>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={`${uid}-batch`} className="text-sm font-medium text-slate-700">Série de</label>
                <select
                  id={`${uid}-batch`}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value))}
                  disabled={isAgentRunning}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
                >
                  {BATCH_SIZES.map(n => <option key={n} value={n}>{n} dossiers</option>)}
                </select>
                {progress ? (
                  <Button type="button" variant="secondary" size="sm" onClick={onStop} className="ml-auto">
                    <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> Arrêter
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onTriggerBatch(batchSize)}
                    disabled={isAgentRunning || !hasProfile}
                    className="ml-auto"
                  >
                    <Layers className="h-3.5 w-3.5" aria-hidden="true" /> Préparer en série
                  </Button>
                )}
              </div>
              {progress && (
                <div role="status" aria-live="polite" className="space-y-1">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full bg-brand-600 transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
                  </div>
                  <p className="text-xs text-slate-600">Dossier {Math.min(progress.done + 1, progress.total)} sur {progress.total}…</p>
                </div>
              )}
              <p className="text-xs text-slate-500">
                Prépare plusieurs CV et lettres d’affilée, sans ouvrir de fenêtre. Vous les envoyez ensuite un par un depuis la file ci-dessous.
              </p>
            </div>
          </div>

          <section aria-labelledby={`${uid}-queue`} className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
            <h2 id={`${uid}-queue`} className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <Send className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Dossiers prêts à envoyer
              <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{queue.length}</span>
            </h2>
            {sortedQueue.length === 0 ? (
              <p className="text-sm text-slate-500">Aucun dossier en attente. Les dossiers préparés apparaîtront ici.</p>
            ) : (
              <ul className="thin-scroll max-h-[420px] space-y-2 overflow-y-auto pr-1">
                {sortedQueue.map(app => (
                  <li key={app.id} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex items-start gap-3">
                      <CompanyAvatar name={app.company} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900" title={app.jobTitle}>{app.jobTitle}</p>
                        <p className="truncate text-xs text-slate-500">
                          {app.company}{app.location ? ` · ${app.location}` : ''}
                          {typeof app.matchScore === 'number' && <span className="font-semibold text-emerald-700"> · {app.matchScore} %</span>}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="primary" onClick={() => onOpenQueued(app)} disabled={!app.jobUrl} title={app.jobUrl ? 'Ouvre le site, copie la lettre et télécharge le CV' : 'Aucun lien de candidature pour cette offre'}>
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Postuler
                      </Button>
                      <Button type="button" size="sm" variant="secondary" onClick={() => onMarkApplied(app)}>
                        <Send className="h-3.5 w-3.5" aria-hidden="true" /> J’ai postulé
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => onOpenDossier(app)}>
                        <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Voir le dossier
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-2 text-sm text-slate-700">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              Préparez vos entretiens
            </h2>
            <p className="leading-relaxed text-slate-500">
              Chaque dossier préparé dispose d'un kit d'entretien (questions, pitch, évaluation de vos réponses).
            </p>
            <button
              type="button"
              onClick={onGoToInterviews}
              className="inline-flex items-center gap-1 pt-1 text-sm font-semibold text-brand-700 hover:text-brand-900"
            >
              Préparer mes entretiens <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="lg:col-span-7">
          <section aria-labelledby={`${uid}-log`} className="flex h-full min-h-[460px] flex-col rounded-2xl border border-slate-200 bg-white p-5">
            <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 id={`${uid}-log`} className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
                <Terminal className="h-4 w-4 text-slate-400" aria-hidden="true" />
                Journal de l'assistant
              </h2>
            </div>

            <div role="log" aria-live="polite" className="thin-scroll max-h-[420px] flex-1 space-y-1 overflow-y-auto pr-1 text-sm text-slate-700">
              {agentLogs.length === 0 ? (
                <div className="h-48 flex flex-col items-center justify-center text-slate-400 space-y-2">
                  <Bot className="h-8 w-8 text-slate-300" aria-hidden="true" />
                  <p className="px-4 text-center">Aucune activité. Cliquez sur « Préparer le prochain dossier ».</p>
                </div>
              ) : (
                agentLogs.map((log) => {
                  const LABEL: Record<string, [string, string]> = {
                    scan: ['Analyse', 'bg-sky-50 text-sky-700'],
                    match: ['Sélection', 'bg-amber-50 text-amber-800'],
                    latex: ['Génération', 'bg-brand-50 text-brand-700'],
                    apply: ['Envoi', 'bg-slate-100 text-slate-700'],
                    success: ['Terminé', 'bg-emerald-50 text-emerald-700'],
                    alert: ['Erreur', 'bg-rose-50 text-rose-700']
                  };
                  const [label, badgeColor] = LABEL[log.type] || [log.type, 'bg-slate-100 text-slate-700'];

                  return (
                    <div key={log.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-slate-100 py-2 last:border-0 sm:flex-nowrap">
                      <span className="whitespace-nowrap pt-0.5 text-xs tabular-nums text-slate-500">{log.timestamp}</span>
                      <span className={cx('whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold', badgeColor)}>
                        {label}
                      </span>
                      <p className="min-w-0 basis-full break-words leading-relaxed sm:basis-auto sm:flex-1">
                        {log.message}
                      </p>
                    </div>
                  );
                })
              )}
            </div>

            <div className="mt-3 flex flex-col gap-1 border-t border-slate-200 pt-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
              <span>Offres chargées : {jobsCount}</span>
              <span>Dossiers suivis : <strong className="text-slate-900">{preparedCount}</strong></span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

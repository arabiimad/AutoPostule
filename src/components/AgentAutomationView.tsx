import React, { useEffect, useState } from 'react';
import {
  Bot,
  Play,
  Settings,
  Terminal,
  ShieldCheck,
  ArrowRight
} from 'lucide-react';
import { UserProfile, AgentLog, ContractType } from '../types';
import { Button, PageHeader, cx } from './ui';

interface AgentAutomationViewProps {
  userProfile: UserProfile;
  /** Enregistre (et persiste) des réglages du profil. */
  onSaveSettings: (updated: Partial<UserProfile>) => void;
  onTriggerAgentCycle: () => Promise<void>;
  isAgentRunning: boolean;
  agentLogs: AgentLog[];
  onGoToInterviews: () => void;
  preparedCount: number;
}

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
 * génère CV + lettre, ouvre le portail de l'entreprise. La soumission reste faite par l'utilisateur.
 */
export const AgentAutomationView: React.FC<AgentAutomationViewProps> = ({
  userProfile,
  onSaveSettings,
  onTriggerAgentCycle,
  isAgentRunning,
  agentLogs,
  onGoToInterviews,
  preparedCount
}) => {
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
        subtitle={<>À chaque clic, l’assistant choisit la meilleure offre encore non traitée selon vos critères, génère un CV LaTeX et une lettre à partir de votre profil, puis ouvre le site de l’entreprise. <strong className="text-slate-700">C’est vous qui envoyez la candidature</strong> : rien n’est envoyé à votre place.</>}
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

            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={onTriggerAgentCycle}
              disabled={isAgentRunning || !hasProfile}
              aria-describedby={!hasProfile ? profileHintId : undefined}
              className="w-full"
            >
              {isAgentRunning ? (
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
          </div>

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
              <span>Offres analysées : celles de votre dernière recherche</span>
              <span>Dossiers suivis : <strong className="text-slate-900">{preparedCount}</strong></span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

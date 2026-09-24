import React, { useState } from 'react';
import {
  Sparkles,
  Building2,
  CheckCircle2,
  HelpCircle,
  ChevronDown,
  Copy,
  Check,
  Lightbulb,
  MessageSquare,
  RefreshCw,
  Target
} from 'lucide-react';
import { Application, InterviewPrepKit, UserProfile } from '../types';
import { apiFetch } from '../utils/api';
import { Badge, Button, Card, EmptyState, Modal, Tabs, cx } from './ui';

interface InterviewCockpitModalProps {
  application: Application | null;
  userProfile: UserProfile;
  onClose: () => void;
  /** Enregistre le kit dans la candidature (il n'est plus régénéré à chaque ouverture). */
  onSavePrepKit?: (kit: InterviewPrepKit) => void;
}

type CockpitTab = 'synthesis' | 'pitch' | 'questions' | 'questionsToAsk' | 'simulator';

const TABS: { id: CockpitTab; label: string }[] = [
  { id: 'synthesis', label: 'Synthèse entreprise' },
  { id: 'pitch', label: 'Pitch' },
  { id: 'questions', label: 'Questions probables' },
  { id: 'questionsToAsk', label: 'Questions à poser' },
  { id: 'simulator', label: "S'entraîner" }
];

const SectionTitle: React.FC<{ icon?: React.ElementType; children: React.ReactNode; hint?: React.ReactNode }> = ({ icon: Icon, children, hint }) => (
  <div className="mb-3">
    <h3 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
      {Icon && <Icon className="h-4 w-4 text-slate-400" aria-hidden="true" />}
      {children}
    </h3>
    {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
  </div>
);

export const InterviewCockpitModal: React.FC<InterviewCockpitModalProps> = ({
  application,
  userProfile,
  onClose,
  onSavePrepKit
}) => {
  const [activeTab, setActiveTab] = useState<CockpitTab>('synthesis');
  const [prepKit, setPrepKit] = useState<InterviewPrepKit | null>(application?.interviewPrep || null);
  const [loadingKit, setLoadingKit] = useState(false);
  const [copiedPitch, setCopiedPitch] = useState(false);
  const [openQuestions, setOpenQuestions] = useState<Set<number>>(() => new Set([0]));

  // Entraînement : réponse rédigée et évaluée par l'IA
  const [selectedQuestionIndex, setSelectedQuestionIndex] = useState(0);
  const [userDraftAnswer, setUserDraftAnswer] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [evaluationResult, setEvaluationResult] = useState<{
    score?: number | null;
    verdict: string;
    available?: boolean;
    starBreakdown?: {
      situation?: string;
      task?: string;
      action?: string;
      result?: string;
    };
    strengths?: string[];
    improvements?: string[];
    improvedSample?: string;
  } | null>(null);

  // Fermeture stable : évite de réinitialiser le focus de la modale à chaque rendu du parent.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const handleClose = React.useCallback(() => onCloseRef.current(), []);

  React.useEffect(() => {
    if (application && !prepKit) {
      handleFetchPrepKit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application]);

  const handleFetchPrepKit = async () => {
    if (!application) return;
    setLoadingKit(true);
    try {
      const res = await apiFetch('/api/interview/prep-kit', {
        candidate: userProfile,
        job: {
          title: application.jobTitle,
          company: application.company,
          description: application.jobDescription || '',
          // Toutes les compétences de l'offre (avant : seulement celles déjà maîtrisées)
          skillsRequired: application.skillsRequired || application.matchedKeywords,
          missingKeywords: application.missingKeywords || []
        }
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !Array.isArray(data.topQuestions)) {
        throw new Error('Kit indisponible');
      }
      const { source, ...kit } = data;
      setPrepKit(kit as InterviewPrepKit);
      // On ne sauvegarde que les kits générés par l'IA (le modèle générique est recalculable)
      if (source === 'gemini-ai' && onSavePrepKit) {
        onSavePrepKit(kit as InterviewPrepKit);
      }
    } catch (e) {
      console.error('Prep kit load error:', e);
    } finally {
      setLoadingKit(false);
    }
  };

  const handleCopyPitch = () => {
    if (!prepKit?.elevatorPitch) return;
    navigator.clipboard.writeText(prepKit.elevatorPitch).catch(() => {});
    setCopiedPitch(true);
    setTimeout(() => setCopiedPitch(false), 2000);
  };

  const handleEvaluateAnswer = async () => {
    if (!userDraftAnswer.trim() || !prepKit) return;
    setEvaluating(true);
    setEvaluationError(null);
    try {
      const currentQuestion = prepKit.topQuestions[selectedQuestionIndex];
      const res = await apiFetch('/api/interview/evaluate-answer', {
        question: currentQuestion.question,
        answer: userDraftAnswer,
        jobTitle: application?.jobTitle,
        company: application?.company,
        candidate: userProfile
      });
      const data = await res.json();
      setEvaluationResult(data);
    } catch (e) {
      console.error('Evaluation error:', e);
      setEvaluationError("L'évaluation n'a pas abouti. Réessayez dans un instant.");
    } finally {
      setEvaluating(false);
    }
  };

  const toggleQuestion = (idx: number) => {
    setOpenQuestions(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const practiceQuestion = (idx: number) => {
    setSelectedQuestionIndex(idx);
    setEvaluationResult(null);
    setEvaluationError(null);
    setActiveTab('simulator');
  };

  if (!application) return null;

  const synthesis = prepKit?.companySynthesis;
  const questions = prepKit?.topQuestions || [];
  const toAsk = prepKit?.smartQuestionsToAskInterviewer || [];
  const draftId = `interview-answer-${application.id}`;
  const selectId = `interview-question-${application.id}`;

  return (
    <Modal
      onClose={handleClose}
      size="xl"
      title="Préparer l'entretien"
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-slate-700">{application.jobTitle}</span>
          <span aria-hidden="true">·</span>
          <span>{application.company}</span>
        </span>
      }
      footer={
        <>
          <p className="mr-auto hidden text-xs text-slate-500 sm:block">Bonne chance pour votre entretien chez {application.company} !</p>
          <Button variant="secondary" onClick={handleClose} className="w-full sm:w-auto">Fermer</Button>
        </>
      }
    >
      {prepKit && !loadingKit && (
        <Tabs tabs={TABS} value={activeTab} onChange={(id) => setActiveTab(id as CockpitTab)} />
      )}

      <div className="px-5 py-5 sm:px-6">
        {loadingKit ? (
          <div role="status" className="flex h-64 flex-col items-center justify-center gap-3 text-slate-500">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-brand-600 border-t-transparent" aria-hidden="true" />
            <p className="text-sm font-medium">Préparation de votre kit d'entretien pour {application.company}…</p>
          </div>
        ) : !prepKit ? (
          <EmptyState
            icon={<HelpCircle className="h-5 w-5" />}
            title="Kit d'entretien indisponible"
            action={
              <Button variant="primary" onClick={handleFetchPrepKit}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Réessayer
              </Button>
            }
          >
            Le kit n'a pas pu être généré pour le moment.
          </EmptyState>
        ) : (
          <div className="mx-auto max-w-4xl space-y-5">
            {/* Synthèse entreprise */}
            {activeTab === 'synthesis' && synthesis && (
              <>
                <Card className="p-5">
                  <SectionTitle icon={Building2}>{application.company} en bref</SectionTitle>
                  <p className="text-sm leading-relaxed text-slate-700">{synthesis.summary}</p>
                </Card>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Card className="p-5">
                    <SectionTitle icon={Target}>Enjeux du poste</SectionTitle>
                    <ul className="space-y-2 text-sm text-slate-700">
                      {(synthesis.coreChallenges || []).map((c, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>

                  <Card className="space-y-4 p-5">
                    <div>
                      <SectionTitle icon={CheckCircle2}>Culture et profil recherché</SectionTitle>
                      <div className="flex flex-wrap gap-1.5">
                        {(synthesis.culturalValues || []).map((v, i) => <Badge key={i} tone="green">{v}</Badge>)}
                      </div>
                    </div>
                    {(synthesis.techStackAnticipated || []).length > 0 && (
                      <div>
                        <h4 className="mb-2 text-sm font-medium text-slate-700">Outils et technologies probables</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {synthesis.techStackAnticipated.map((t, i) => <Badge key={i} tone="neutral">{t}</Badge>)}
                        </div>
                      </div>
                    )}
                  </Card>
                </div>
              </>
            )}

            {/* Pitch */}
            {activeTab === 'pitch' && (
              <Card className="space-y-4 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <SectionTitle hint="Réponse à « Pouvez-vous vous présenter ? », en 90 secondes environ.">Votre pitch</SectionTitle>
                  <Button size="sm" variant="secondary" onClick={handleCopyPitch} className="self-start">
                    {copiedPitch ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                    {copiedPitch ? 'Copié' : 'Copier'}
                  </Button>
                </div>

                <blockquote className="rounded-xl border-l-4 border-brand-500 bg-slate-50 px-4 py-3.5 text-[15px] leading-relaxed text-slate-800">
                  {prepKit.elevatorPitch}
                </blockquote>

                <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
                  <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                  <p>
                    Ne récitez pas votre CV dans l'ordre chronologique : insistez sur « pourquoi vous » et « pourquoi {application.company} ».
                  </p>
                </div>
              </Card>
            )}

            {/* Questions probables */}
            {activeTab === 'questions' && (
              <div className="space-y-3">
                <SectionTitle hint="Ouvrez une question pour voir l'analyse et la réponse suggérée.">Questions probables</SectionTitle>
                {questions.map((q, idx) => {
                  const open = openQuestions.has(idx);
                  const panelId = `q-panel-${application.id}-${idx}`;
                  return (
                    <Card key={idx} className="overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggleQuestion(idx)}
                        aria-expanded={open}
                        aria-controls={panelId}
                        className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-slate-50 sm:px-5"
                      >
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{idx + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-slate-900">{q.question}</span>
                          {q.category && <Badge tone="neutral" className="mt-1.5">{q.category}</Badge>}
                        </span>
                        <ChevronDown className={cx('mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
                      </button>
                      {open && (
                        <div id={panelId} className="space-y-4 border-t border-slate-100 px-4 py-4 sm:px-5">
                          <div>
                            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Pourquoi on vous la pose</h4>
                            <p className="text-sm leading-relaxed text-slate-700">{q.whyTheyAsk}</p>
                          </div>
                          <div>
                            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Réponse suggérée</h4>
                            <p className="whitespace-pre-line rounded-xl bg-slate-50 px-3.5 py-3 text-sm leading-relaxed text-slate-800">{q.suggestedAnswer}</p>
                          </div>
                          {q.keyPoints && q.keyPoints.length > 0 && (
                            <div>
                              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Points clés</h4>
                              <ul className="space-y-1.5">
                                {q.keyPoints.map((kp, kpi) => (
                                  <li key={kpi} className="flex items-start gap-2 text-sm text-slate-700">
                                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                                    <span>{kp}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <Button size="sm" variant="secondary" onClick={() => practiceQuestion(idx)}>
                            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                            M'entraîner sur cette question
                          </Button>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Questions à poser */}
            {activeTab === 'questionsToAsk' && (
              <Card className="p-5">
                <SectionTitle hint="En fin d'entretien, des questions précises montrent votre intérêt et votre recul.">Questions à poser au recruteur</SectionTitle>
                <ol className="space-y-2">
                  {toAsk.map((q, i) => (
                    <li key={i} className="flex items-start gap-3 rounded-xl border border-slate-200 px-3.5 py-3 text-sm text-slate-800">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{i + 1}</span>
                      <span className="pt-0.5">{q}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            {/* Entraînement */}
            {activeTab === 'simulator' && (
              <div className="space-y-4">
                <Card className="p-5">
                  <SectionTitle hint="Rédigez votre réponse : l'IA en évalue la structure et les arguments.">S'entraîner à répondre</SectionTitle>
                  <form
                    className="space-y-4"
                    onSubmit={(e) => { e.preventDefault(); handleEvaluateAnswer(); }}
                  >
                    <div className="space-y-1.5">
                      <label htmlFor={selectId} className="text-sm font-medium text-slate-700">Question</label>
                      <select
                        id={selectId}
                        value={selectedQuestionIndex}
                        onChange={(e) => {
                          setSelectedQuestionIndex(Number(e.target.value));
                          setEvaluationResult(null);
                          setEvaluationError(null);
                        }}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-brand-500"
                      >
                        {questions.map((q, idx) => (
                          <option key={idx} value={idx}>Q{idx + 1} · {q.question}</option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor={draftId} className="text-sm font-medium text-slate-700">Votre réponse</label>
                      <textarea
                        id={draftId}
                        value={userDraftAnswer}
                        onChange={(e) => setUserDraftAnswer(e.target.value)}
                        placeholder="Situation, tâche, action concrète, résultat…"
                        rows={6}
                        className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-800 focus:border-brand-500"
                      />
                      <p className="text-xs text-slate-500">Conseil : suivez la méthode STAR et chiffrez le résultat si possible.</p>
                    </div>

                    {evaluationError && (
                      <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{evaluationError}</div>
                    )}

                    <Button type="submit" variant="primary" disabled={evaluating || !userDraftAnswer.trim()} className="w-full sm:w-auto">
                      <Sparkles className={cx('h-4 w-4', evaluating && 'animate-pulse')} aria-hidden="true" />
                      {evaluating ? 'Analyse en cours…' : 'Évaluer ma réponse'}
                    </Button>
                  </form>
                </Card>

                {evaluationResult && (
                  <Card className="space-y-5 p-5" >
                    <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                      <h4 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
                        <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
                        Retour sur votre réponse
                      </h4>
                      {evaluationResult.score !== null && evaluationResult.score !== undefined ? (
                        <Badge tone={evaluationResult.score >= 7 ? 'green' : evaluationResult.score >= 4 ? 'amber' : 'rose'} className="text-sm">
                          {evaluationResult.score}/10
                        </Badge>
                      ) : (
                        <Badge tone="neutral">{evaluationResult.available === false ? 'IA indisponible' : 'Analyse qualitative'}</Badge>
                      )}
                    </div>

                    {evaluationResult.verdict && (
                      <p className="text-sm leading-relaxed text-slate-700">{evaluationResult.verdict}</p>
                    )}

                    {evaluationResult.starBreakdown && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {([
                          ['Situation', evaluationResult.starBreakdown.situation],
                          ['Tâche', evaluationResult.starBreakdown.task],
                          ['Action', evaluationResult.starBreakdown.action],
                          ['Résultat', evaluationResult.starBreakdown.result]
                        ] as const).map(([label, text]) => (
                          <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                            <span className="mb-0.5 block text-xs font-semibold text-brand-700">{label}</span>
                            <span className="text-sm text-slate-700">{text || '—'}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {((evaluationResult.strengths?.length ?? 0) > 0 || (evaluationResult.improvements?.length ?? 0) > 0) && (
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {evaluationResult.strengths && evaluationResult.strengths.length > 0 && (
                          <div>
                            <h5 className="mb-1.5 text-sm font-medium text-emerald-700">Points forts</h5>
                            <ul className="space-y-1.5">
                              {evaluationResult.strengths.map((str, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                                  <span>{str}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {evaluationResult.improvements && evaluationResult.improvements.length > 0 && (
                          <div>
                            <h5 className="mb-1.5 text-sm font-medium text-amber-800">À améliorer</h5>
                            <ul className="space-y-1.5">
                              {evaluationResult.improvements.map((imp, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                                  <span>{imp}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {evaluationResult.improvedSample && (
                      <div className="space-y-2 border-t border-slate-100 pt-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <h5 className="text-sm font-medium text-slate-900">Proposition de reformulation</h5>
                          <Button size="sm" variant="ghost" onClick={() => setUserDraftAnswer(evaluationResult.improvedSample || '')} className="self-start">
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            Reprendre dans ma réponse
                          </Button>
                        </div>
                        <p className="whitespace-pre-line rounded-xl bg-slate-50 px-3.5 py-3 text-sm leading-relaxed text-slate-800">
                          {evaluationResult.improvedSample}
                        </p>
                      </div>
                    )}
                  </Card>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

import React, { useState } from 'react';
import {
  ExternalLink,
  Download,
  Copy,
  Check,
  Send,
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  History,
  Eye
} from 'lucide-react';
import { JobOffer, UserProfile, CvTemplate, DossierVersion, TailoredCv, OfferAnalysis } from '../types';
import { calculateCandidateMatch, candidateHasSkill } from '../utils/skillMatcher';
import { CvContentEditor } from './studio/CvContentEditor';
import { getApplyUrl } from '../utils/jobLinks';
import { apiFetch } from '../utils/api';
import { Badge, Button, Card, EmptyState, MatchRing, Modal, Tabs, cx } from './ui';

interface LatexStudioModalProps {
  job: JobOffer | null;
  userProfile: UserProfile;
  onClose: () => void;
  onApplyWithLatex: (job: JobOffer, latexCode: string, coverLetter: string, template: CvTemplate, tailored?: TailoredCv, analysis?: OfferAnalysis) => void;
  /** Contenu adapté d'un dossier enregistré (retouches sans nouvel appel à l'IA). */
  initialTailored?: TailoredCv;
  initialAnalysis?: OfferAnalysis;
  initialLatexCode?: string;
  initialLetter?: string;
  initialTemplate?: CvTemplate;
  /** Mémorise le modèle choisi comme modèle préféré du profil. */
  onTemplateChange?: (template: CvTemplate) => void;
  /** Versions précédentes du dossier (la plus récente en premier). */
  versions?: DossierVersion[];
}

const TEMPLATE_OPTIONS: { id: CvTemplate; label: string; hint: string }[] = [
  { id: 'article', label: 'Classique', hint: 'Sobre, une colonne' },
  { id: 'moderncv', label: 'Moderne', hint: 'Classe moderncv, dates en marge' },
  { id: 'compact', label: 'Compact', hint: 'Une page dense' }
];

const normalizeTemplate = (t: any): CvTemplate => (t === 'moderncv' || t === 'compact' ? t : 'article');
const templateLabel = (t?: CvTemplate) => TEMPLATE_OPTIONS.find(o => o.id === normalizeTemplate(t))?.label || 'Classique';

const slug = (s: string) =>
  (s || 'poste').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'poste';

const formatDateTime = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('fr-FR');
};

const isoDay = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
};

const downloadText = (content: string, filename: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

type StudioTab = 'content' | 'preview' | 'latex' | 'letter' | 'ats' | 'history';

export const LatexStudioModal: React.FC<LatexStudioModalProps> = ({
  job,
  userProfile,
  onClose,
  onApplyWithLatex,
  initialLatexCode,
  initialLetter,
  initialTemplate,
  onTemplateChange,
  versions,
  initialTailored,
  initialAnalysis
}) => {
  const [template, setTemplate] = useState<CvTemplate>(normalizeTemplate(initialTemplate ?? userProfile.preferredTemplate));
  const [compilerAvailable, setCompilerAvailable] = useState(false);
  // Moteur de rendu : « web » (HTML → PDF par Chromium, sans LaTeX) ou « latex » (pdfLaTeX / Tectonic / Overleaf)
  const [webPdfAvailable, setWebPdfAvailable] = useState(false);
  const [engine, setEngine] = useState<'web' | 'latex'>(() => {
    try { return localStorage.getItem('autopostule_cv_engine') === 'latex' ? 'latex' : 'web'; } catch { return 'web'; }
  });
  const [webHtml, setWebHtml] = useState<string>('');
  const webFrameRef = React.useRef<HTMLIFrameElement>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  // Aucune donnée de repli : le studio n'utilise que le profil de l'utilisateur connecté.
  const computedMatch = calculateCandidateMatch(userProfile.skills, job?.skillsRequired || []);

  const [activeTab, setActiveTab] = useState<StudioTab>(initialTailored ? 'content' : 'latex');
  const [tailored, setTailored] = useState<TailoredCv | null>(initialTailored || null);
  const [analysis, setAnalysis] = useState<OfferAnalysis | null>(initialAnalysis || null);
  const [model, setModel] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewedCode, setPreviewedCode] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoredNotice, setRestoredNotice] = useState<string | null>(null);
  const [latexCode, setLatexCode] = useState<string>(initialLatexCode || '');
  const [coverLetter, setCoverLetter] = useState<string>(initialLetter || '');
  // Le score affiché est toujours celui calculé localement (même règle que le Radar)
  const matchScore = computedMatch.score;
  const matchedKeywords = computedMatch.matchedKeywords;
  const missingKeywords = computedMatch.missingKeywords;
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedLatex, setCopiedLatex] = useState(false);
  const [copiedLetter, setCopiedLetter] = useState(false);

  const history = versions || [];
  const hasHistory = history.length > 0;

  // Fermeture stable : évite de réinitialiser le focus de la modale à chaque rendu du parent.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const handleClose = React.useCallback(() => onCloseRef.current(), []);

  // Compilation PDF locale disponible sur ce serveur ?
  React.useEffect(() => {
    let alive = true;
    apiFetch('/api/latex/compiler')
      .then(r => r.json())
      .then(d => { if (alive) { setCompilerAvailable(!!d?.available); setWebPdfAvailable(!!d?.web); } })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const changeEngine = (e: 'web' | 'latex') => {
    setEngine(e);
    try { localStorage.setItem('autopostule_cv_engine', e); } catch { /* ignore */ }
  };
  const renderPayload = () => ({ candidate: userProfile, job, template, tailored: tailored || undefined, sector: analysis?.domain || undefined });

  // Aperçu Web : HTML identique au PDF, instantané (sans IA ni compilation)
  React.useEffect(() => {
    if (engine !== 'web' || activeTab !== 'preview' || !job) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch('/api/cv/html', renderPayload());
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.message || `Aperçu impossible (${res.status}).`);
        }
        const html = await res.text();
        if (alive) { setWebHtml(html); setPreviewError(null); }
      } catch (e: any) {
        if (alive) setPreviewError(e?.message || 'Aperçu impossible.');
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, activeTab, tailored, template, analysis]);

  /** PDF du CV : moteur Web (Chromium) ou compilation LaTeX. */
  const fetchPdf = async (code: string): Promise<Blob> => {
    if (engine === 'web') {
      const res = await apiFetch('/api/cv/pdf', renderPayload());
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || `Génération du PDF impossible (${res.status}).`);
      }
      return res.blob();
    }
    const res = await apiFetch('/api/latex/compile', { latexCode: code });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Compilation impossible (${res.status}).`);
    }
    return res.blob();
  };

  const refreshPreview = async () => {
    if (!latexCode) return;
    setIsCompiling(true);
    setPreviewError(null);
    try {
      const blob = await fetchPdf(latexCode);
      const url = `${URL.createObjectURL(new Blob([blob], { type: "application/pdf" }))}#view=FitH`;
      setPreviewUrl(url);
      setPreviewedCode(latexCode);
    } catch (e: any) {
      setPreviewError(e?.message || 'Compilation impossible.');
    } finally {
      setIsCompiling(false);
    }
  };
  // L'ancienne adresse du PDF est libérée quand l'aperçu change ou à la fermeture
  React.useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl.split('#')[0]); }, [previewUrl]);
  // Aperçu compilé automatiquement à l'ouverture de l'onglet (et quand le CV a changé)
  React.useEffect(() => {
    if (engine === 'latex' && activeTab === 'preview' && compilerAvailable && latexCode && latexCode !== previewedCode && !isCompiling && !isRendering) refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, activeTab, compilerAvailable, latexCode, isRendering]);

  // Contenu modifié → nouveau code LaTeX (modèle, sans IA), avec un court délai
  const renderTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderContent = (content: TailoredCv, t: CvTemplate = template, delay = 450) => {
    if (renderTimer.current) clearTimeout(renderTimer.current);
    setIsRendering(true);
    renderTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch('/api/tailor/render', { candidate: userProfile, job, template: t, tailored: content });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.latexCode) setLatexCode(data.latexCode);
        else setErrorMessage(data?.error || `Mise à jour du CV impossible (${res.status}).`);
      } catch {
        setErrorMessage("Le serveur n'a pas répondu. Réessayez.");
      } finally {
        setIsRendering(false);
      }
    }, delay);
  };
  React.useEffect(() => () => { if (renderTimer.current) clearTimeout(renderTimer.current); }, []);

  const handleContentChange = (next: TailoredCv) => {
    setTailored(next);
    setRestoredNotice(null);
    renderContent(next);
  };

  const handleCompilePdf = async () => {
    if (!latexCode && engine === 'latex') return;
    // Web sans Chromium sur le serveur : impression du navigateur (« Enregistrer en PDF »)
    if (engine === 'web' && !webPdfAvailable) {
      setActiveTab('preview');
      setTimeout(() => webFrameRef.current?.contentWindow?.print(), 400);
      return;
    }
    setIsCompiling(true);
    setErrorMessage(null);
    try {
      const blob = await fetchPdf(latexCode);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CV_${(userProfile.fullName || 'Candidat').replace(/\s+/g, '_')}_${(job?.company || 'Poste').replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      setErrorMessage(e?.message || 'Compilation impossible.');
    } finally {
      setIsCompiling(false);
    }
  };

  const handleTemplateChange = (t: CvTemplate) => {
    if (t === template) return;
    setTemplate(t);
    onTemplateChange?.(t);
  };

  // Changement de modèle : le CV est régénéré dans le nouveau modèle
  // (sauf lors de la restauration d'une version, qui apporte son propre code).
  const firstTemplateRender = React.useRef(true);
  const skipRegenerateOnce = React.useRef(false);
  React.useEffect(() => {
    if (firstTemplateRender.current) { firstTemplateRender.current = false; return; }
    if (skipRegenerateOnce.current) { skipRegenerateOnce.current = false; return; }
    // Contenu déjà adapté : on change seulement la mise en forme (instantané, sans IA)
    if (tailored) renderContent(tailored, template, 0);
    else handleRegenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  // Ouverture : dossier enregistré → rien à générer ; contenu sans code → rendu ; sinon génération complète
  React.useEffect(() => {
    if (job && !latexCode) {
      if (initialTailored) renderContent(initialTailored, template, 0);
      else handleRegenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const handleRegenerate = async () => {
    if (!job) return;
    setIsGenerating(true);
    setErrorMessage(null);
    setNotice(null);
    setRestoredNotice(null);
    try {
      const [resLatex, resLetter] = await Promise.all([
        apiFetch('/api/tailor/latex', { candidate: userProfile, job, template }),
        apiFetch('/api/tailor/letter', { candidate: userProfile, job, ...(analysis ? { analysis } : {}) })
      ]);
      const dataLatex = await resLatex.json().catch(() => null);
      const dataLetter = await resLetter.json().catch(() => null);

      if (!resLatex.ok || !dataLatex?.latexCode) {
        setErrorMessage(dataLatex?.message || dataLatex?.error || `Génération du CV impossible (${resLatex.status}).`);
      } else {
        setLatexCode(dataLatex.latexCode);
        if (dataLatex.tailored) {
          setTailored(dataLatex.tailored);
          setActiveTab(tab => (tab === 'latex' || tab === 'history' ? 'content' : tab));
        }
        if (dataLatex.analysis) setAnalysis(dataLatex.analysis);
        setModel(dataLatex.model || null);
      }
      if (resLetter.ok && dataLetter?.letter) {
        setCoverLetter(dataLetter.letter);
      }
      const notices = [dataLatex?.notice, dataLetter?.notice].filter(Boolean);
      if (notices.length) setNotice(notices.join(' '));
    } catch (e) {
      console.error('Error generating LaTeX/Letter:', e);
      setErrorMessage("Le serveur n'a pas répondu. Réessayez.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyLatex = () => {
    navigator.clipboard.writeText(latexCode).catch(() => {});
    setCopiedLatex(true);
    setTimeout(() => setCopiedLatex(false), 2000);
  };

  const handleCopyLetter = () => {
    navigator.clipboard.writeText(coverLetter).catch(() => {});
    setCopiedLetter(true);
    setTimeout(() => setCopiedLetter(false), 2000);
  };

  const handleDownloadTex = () => {
    downloadText(latexCode, `CV_${(userProfile.fullName || 'Candidat').replace(/\s+/g, '_')}_${job?.company || 'Poste'}.tex`);
  };

  const handleOpenOverleaf = () => {
    try {
      // Official Overleaf POST API allows transmitting full uncompressed LaTeX documents
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = 'https://www.overleaf.com/docs';
      form.target = '_blank';
      form.rel = 'noopener noreferrer';

      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'snip';
      input.value = latexCode;
      form.appendChild(input);

      const nameInput = document.createElement('input');
      nameInput.type = 'hidden';
      nameInput.name = 'snip_name';
      nameInput.value = `CV_${(userProfile?.fullName || 'Candidat').replace(/\s+/g, '_')}_${(job?.company || 'Poste').replace(/\s+/g, '_')}.tex`;
      form.appendChild(nameInput);

      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);
    } catch (e) {
      console.warn('Direct form submit failed, downloading .tex as resilient fallback:', e);
      handleDownloadTex();
      window.open('https://www.overleaf.com/project', '_blank');
    }
  };

  const handleRestoreVersion = (v: DossierVersion) => {
    setLatexCode(v.latexResumeCode || '');
    setCoverLetter(v.coverLetter || '');
    if (v.template) {
      const t = normalizeTemplate(v.template);
      if (t !== template) {
        skipRegenerateOnce.current = true;
        setTemplate(t);
      }
    }
    setErrorMessage(null);
    setNotice(null);
    setRestoredNotice(`Version du ${formatDateTime(v.createdAt)} restaurée : enregistrez pour la conserver.`);
    setActiveTab('latex');
  };

  const handleDownloadVersion = (v: DossierVersion) => {
    downloadText(v.latexResumeCode || '', `cv-${slug(job?.company || '')}-${isoDay(v.createdAt)}.tex`);
  };

  const handleValidate = () => {
    if (!job) return;
    if (coverLetter) {
      navigator.clipboard?.writeText(coverLetter).catch(() => {});
    }
    const portal = window.open(getApplyUrl(job), '_blank');
    if (portal) portal.opener = null;
    onApplyWithLatex(job, latexCode, coverLetter, template, tailored || undefined, analysis || undefined);
    onClose();
  };

  if (!job) return null;

  const tabs: { id: StudioTab; label: React.ReactNode }[] = [
    ...(tailored ? [{ id: 'content' as StudioTab, label: 'Contenu' }] : []),
    ...(engine === 'web' || compilerAvailable ? [{ id: 'preview' as StudioTab, label: 'Aperçu' }] : []),
    { id: 'latex', label: 'Code LaTeX' },
    { id: 'letter', label: 'Lettre de motivation' },
    { id: 'ats', label: 'Compétences' },
    ...(hasHistory ? [{ id: 'history' as StudioTab, label: `Historique (${history.length})` }] : [])
  ];
  const currentTab: StudioTab =
    (activeTab === 'history' && !hasHistory) || (activeTab === 'content' && !tailored) || (activeTab === 'preview' && engine === 'latex' && !compilerAvailable) ? 'latex' : activeTab;

  const scoreTone = matchScore === null ? 'neutral' : matchScore >= 70 ? 'green' : matchScore >= 40 ? 'amber' : 'neutral';

  return (
    <Modal
      onClose={handleClose}
      size="xl"
      title="Studio CV & lettre"
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate"><span className="font-medium text-slate-700">{job.title}</span> · {job.company}</span>
          <Badge tone={scoreTone}>{matchScore === null ? 'Compatibilité non évaluable' : `${matchScore} % de compatibilité`}</Badge>
        </span>
      }
      footer={
        <>
          <p className="mr-auto hidden text-xs text-slate-500 md:block">Enregistre le dossier dans Candidatures puis ouvre le site de l'entreprise.</p>
          <Button variant="ghost" onClick={handleClose} className="flex-1 sm:flex-none">Annuler</Button>
          <Button
            variant="primary"
            onClick={handleValidate}
            disabled={!latexCode || isGenerating}
            title="Copie la lettre de motivation et ouvre le site du recruteur"
            className="flex-1 sm:flex-none"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Valider et postuler
          </Button>
        </>
      }
    >
      {/* Modèle + actions globales */}
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500" id="studio-template-label">Modèle</span>
          <div role="group" aria-labelledby="studio-template-label" className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            {TEMPLATE_OPTIONS.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => handleTemplateChange(t.id)}
                disabled={isGenerating}
                title={t.hint}
                aria-pressed={template === t.id}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed',
                  template === t.id ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-400">{tailored ? 'Changer de modèle garde votre contenu.' : 'Changer de modèle régénère le CV.'}</span>
          {isRendering && <span className="text-xs text-brand-700" role="status">Mise à jour du CV…</span>}

        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={handleRegenerate} disabled={isGenerating} title="Nouvelle adaptation par l'IA (remplace le contenu actuel)">
            <RefreshCw className={cx('h-3.5 w-3.5', isGenerating && 'animate-spin')} aria-hidden="true" />
            {isGenerating ? 'Génération…' : 'Régénérer avec l’IA'}
          </Button>
          <div role="group" aria-label="Moteur de rendu" className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            {([['web', 'Web'], ['latex', 'LaTeX']] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => changeEngine(id)} aria-pressed={engine === id}
                title={id === 'web' ? 'Mise en page moderne, PDF sans LaTeX' : 'Modèles LaTeX (pdfLaTeX, Tectonic ou Overleaf)'}
                className={cx('rounded-lg px-2.5 py-1 text-xs font-medium', engine === id ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900')}>
                {label}
              </button>
            ))}
          </div>
          {(engine === 'web' || compilerAvailable) && (
            <Button size="sm" variant="secondary" onClick={handleCompilePdf} disabled={(engine === 'latex' && !latexCode) || isCompiling} title="Télécharger le CV en PDF">
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {isCompiling ? 'Compilation…' : 'PDF'}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={handleOpenOverleaf} disabled={!latexCode} title="Ouvre ce code dans Overleaf">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Ouvrir dans Overleaf
          </Button>
        </div>
      </div>

      <Tabs tabs={tabs} value={currentTab} onChange={(id) => setActiveTab(id as StudioTab)} />

      <div className="space-y-4 px-5 py-5 sm:px-6">
        {errorMessage && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{errorMessage}</div>
        )}
        {notice && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">{notice}</div>
        )}
        {restoredNotice && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700">
            <RotateCcw className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{restoredNotice}</span>
          </div>
        )}
        {isGenerating && !latexCode && (
          <div role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">Génération du CV et de la lettre en cours…</div>
        )}

        {/* Contenu adapté (fond) */}
        {currentTab === 'content' && tailored && (
          <CvContentEditor value={tailored} onChange={handleContentChange} userProfile={userProfile} job={job} disabled={isGenerating} />
        )}

        {/* Aperçu PDF */}
        {currentTab === 'preview' && engine === 'web' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">Aperçu identique au PDF (format A4). Les couleurs s’adaptent au secteur de l’offre.</p>
            {previewError ? (
              <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">{previewError}</div>
            ) : webHtml ? (
              <div className="overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-3 sm:p-6">
                <iframe ref={webFrameRef} title="Aperçu du CV" srcDoc={webHtml} sandbox="allow-same-origin allow-modals"
                  className={cx('mx-auto block h-[1123px] w-[794px] max-w-full origin-top rounded bg-white shadow-lg', isRendering && 'opacity-60')} />
              </div>
            ) : (
              <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-500" role="status">Préparation de l’aperçu…</div>
            )}
          </div>
        )}
        {currentTab === 'preview' && engine === 'latex' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500">Rendu réel du CV (compilé par pdfLaTeX / Tectonic sur le serveur).</p>
              <Button size="sm" variant="secondary" onClick={refreshPreview} disabled={!latexCode || isCompiling || isRendering}>
                <Eye className="h-3.5 w-3.5" aria-hidden="true" /> {isCompiling ? 'Compilation…' : 'Mettre à jour l’aperçu'}
              </Button>
            </div>
            {previewError ? (
              <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
                {previewError} Vous pouvez aussi ouvrir le code dans Overleaf.
              </div>
            ) : previewUrl ? (
              <iframe title="Aperçu du CV (PDF)" src={previewUrl} className={cx('h-[70vh] w-full rounded-xl border border-slate-200 bg-white', (isCompiling || latexCode !== previewedCode) && 'opacity-60')} />
            ) : (
              <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-500" role="status">
                {isCompiling ? 'Compilation du PDF…' : 'L’aperçu apparaîtra ici.'}
              </div>
            )}
          </div>
        )}

        {/* CV LaTeX */}
        {currentTab === 'latex' && (
          <div className="space-y-3">
            {tailored && (
              <p className="rounded-xl bg-slate-50 px-3.5 py-2 text-xs text-slate-600">
                Modifier le Contenu régénère ce code : faites vos retouches de fond dans l’onglet Contenu, et gardez ce code pour les réglages de mise en forme.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-500">
                Modèle {templateLabel(template)} · pdfLaTeX · {latexCode ? latexCode.split('\n').length : 0} lignes
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={handleCopyLatex} disabled={!latexCode}>
                  {copiedLatex ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                  {copiedLatex ? 'Copié' : 'Copier'}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleDownloadTex} disabled={!latexCode}>
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Télécharger .tex
                </Button>
              </div>
            </div>
            <textarea
              aria-label="Code source LaTeX du CV"
              value={latexCode}
              onChange={(e) => setLatexCode(e.target.value)}
              rows={20}
              spellCheck={false}
              className="block w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-[13px] leading-relaxed text-slate-800 focus:border-brand-500"
            />
          </div>
        )}

        {/* Lettre */}
        {currentTab === 'letter' && (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-500">Lettre personnalisée pour {job.company}. Relisez-la avant l'envoi.</p>
              <Button size="sm" variant="ghost" onClick={handleCopyLetter} disabled={!coverLetter}>
                {copiedLetter ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                {copiedLetter ? 'Copié' : 'Copier la lettre'}
              </Button>
            </div>
            <textarea
              aria-label="Lettre de motivation"
              value={coverLetter}
              onChange={(e) => setCoverLetter(e.target.value)}
              rows={18}
              className="block w-full resize-y rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-800 focus:border-brand-500 sm:p-6"
            />
          </div>
        )}

        {/* Compétences */}
        {currentTab === 'ats' && (
          <Card className="space-y-5 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold text-slate-900">Compétences demandées par l'offre</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Comparaison entre l'offre et votre profil. Ce n'est pas un score ATS officiel.
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <MatchRing score={matchScore} size={52} />
                {matchScore === null ? (
                  <span className="text-xs text-slate-500">Compatibilité non évaluable</span>
                ) : (
                  <span className="text-xs text-slate-500">{matchedKeywords.length} / {matchedKeywords.length + missingKeywords.length} couvertes</span>
                )}
              </div>
            </div>

            {matchScore === null ? (
              <p className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
                L'offre ne liste pas de compétences : la compatibilité ne peut pas être calculée.
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-slate-700">Présentes dans votre profil</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {matchedKeywords.length === 0 && <span className="text-sm text-slate-400">Aucune</span>}
                    {matchedKeywords.map((kw, i) => (
                      <Badge key={i} tone="green"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />{kw}</Badge>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-slate-700">Absentes de votre profil <span className="font-normal text-slate-500">(non ajoutées au CV)</span></h4>
                  <div className="flex flex-wrap gap-1.5">
                    {missingKeywords.length === 0 && <span className="text-sm text-slate-400">Aucune</span>}
                    {missingKeywords.map((kw, i) => (
                      <Badge key={i} tone="neutral">{kw}</Badge>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500">
                    Si vous possédez réellement l'une de ces compétences, ajoutez-la à votre profil puis régénérez le CV.
                  </p>
                </div>
              </>
            )}
          </Card>
        )}
        {currentTab === 'ats' && analysis && (
          <Card className="space-y-4 p-5">
            <div>
              <h3 className="text-[15px] font-semibold text-slate-900">Analyse de l'offre</h3>
              <p className="mt-1 text-sm text-slate-500">
                {[analysis.domain, analysis.seniority !== 'non précisé' ? analysis.seniority : '', analysis.tone ? `ton ${analysis.tone}` : ''].filter(Boolean).join(' · ') || 'Analyse basée sur les compétences listées par la source.'}
              </p>
              {analysis.roleSummary && <p className="mt-2 text-sm text-slate-700">{analysis.roleSummary}</p>}
            </div>
            {analysis.mustHave.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-slate-700">Exigences</h4>
                <div className="flex flex-wrap gap-1.5">
                  {analysis.mustHave.map((k, i) => {
                    const has = candidateHasSkill(userProfile.skills, k);
                    return <Badge key={i} tone={has ? 'green' : 'neutral'} title={has ? 'Dans votre profil' : 'Absente de votre profil'}>{has && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}{k}</Badge>;
                  })}
                </div>
              </div>
            )}
            {analysis.missions.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-sm font-medium text-slate-700">Missions principales</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{analysis.missions.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}
            {analysis.softSkills.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <h4 className="mr-1 text-sm font-medium text-slate-700">Qualités recherchées</h4>
                {analysis.softSkills.map((k, i) => <Badge key={i}>{k}</Badge>)}
              </div>
            )}
            {(tailored?.highlights?.length || 0) > 0 && (
              <div className="rounded-xl bg-brand-50 p-3.5">
                <h4 className="text-sm font-semibold text-brand-900">Vos atouts pour ce poste</h4>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-brand-800">{tailored!.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
              </div>
            )}
          </Card>
        )}

        {/* Historique */}
        {currentTab === 'history' && (
          hasHistory ? (
            <ul className="space-y-2.5">
              {history.map(v => (
                <li key={v.id}>
                  <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{formatDateTime(v.createdAt)}</span>
                        {v.template && <Badge tone="brand">{templateLabel(v.template)}</Badge>}
                      </div>
                      {v.label && <p className="mt-0.5 truncate text-sm text-slate-500">{v.label}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => handleRestoreVersion(v)} aria-label={`Restaurer la version du ${formatDateTime(v.createdAt)}`}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        Restaurer
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDownloadVersion(v)} disabled={!v.latexResumeCode} aria-label={`Télécharger le .tex de la version du ${formatDateTime(v.createdAt)}`}>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        Télécharger .tex
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<History className="h-5 w-5" />} title="Aucune version précédente" />
          )
        )}
      </div>
    </Modal>
  );
};

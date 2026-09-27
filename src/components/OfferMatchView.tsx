import React, { useState } from 'react';
import { ArrowRight, CheckCircle2, ClipboardPaste, Loader2, PlusCircle, Sparkles, Upload, XCircle } from 'lucide-react';
import type { JobOffer, OfferAnalysis, TailoredCv, UserProfile } from '../types';
import type { JobFit } from '../utils/skillMatcher';
import { apiFetch, readJson } from '../utils/api';
import { track } from '../utils/monitoring';
import { Badge, Button, FitBadge, cx } from './ui';

interface OfferMatchResult {
  job: JobOffer;
  analysis: OfferAnalysis;
  fit: JobFit;
  keywords: { present: string[]; implicit: string[]; absent: string[] };
  changes: { where: string; kind: 'headline' | 'summary' | 'bullet' | 'hide'; before: string; after: string }[];
  skillsOrder: string[];
  tailored: TailoredCv;
  notice?: string;
}

interface OfferMatchViewProps {
  userProfile: UserProfile;
  signedIn: boolean;
  onOpenCvUpload: () => void;
  /** Ouvre le Studio sur l'offre collée, avec le contenu adapté déjà prêt. */
  onOpenStudio: (job: JobOffer, tailored: TailoredCv, analysis: OfferAnalysis) => void;
}

const KIND_LABEL = { headline: 'Titre', summary: 'Accroche', bullet: 'Point reformulé', hide: 'À retirer pour cette offre' } as const;

/** « Adapter mon CV à une offre » : n'importe quelle offre collée (LinkedIn, Indeed, site d'entreprise…). */
export const OfferMatchView: React.FC<OfferMatchViewProps> = ({ userProfile, signedIn, onOpenCvUpload, onOpenStudio }) => {
  const [offerText, setOfferText] = useState('');
  const [offerTitle, setOfferTitle] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OfferMatchResult | null>(null);
  const hasProfile = userProfile.experiences.length > 0;

  const analyze = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    track('offer_match_started');
    try {
      const data = await readJson<OfferMatchResult>(await apiFetch('/api/tools/offer-match', { candidate: userProfile, offerText, offerTitle, company }));
      setResult(data);
      track('offer_match_done', { changes: data.changes.length, fit: data.fit.level });
    } catch (e: any) {
      setError(e?.message || 'Analyse impossible. Réessayez.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="offer-match-title">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><ClipboardPaste className="h-4 w-4" aria-hidden="true" /></span>
        <div>
          <h2 id="offer-match-title" className="text-base font-bold text-slate-900">Adapter mon CV à une offre trouvée ailleurs</h2>
          <p className="mt-0.5 text-sm text-slate-600">Collez une offre (LinkedIn, Indeed, site d’une entreprise…) : vous voyez ce qu’il faut changer dans votre CV, sans rien inventer.</p>
        </div>
      </div>

      {!hasProfile ? (
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 p-4">
          <p className="text-sm text-slate-600">Importez d’abord votre CV : l’analyse compare l’offre à votre parcours réel.</p>
          <Button variant="secondary" size="sm" onClick={onOpenCvUpload}><Upload className="h-3.5 w-3.5" aria-hidden="true" /> Importer mon CV</Button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Intitulé du poste <span className="font-normal text-slate-400">(facultatif)</span>
              <input value={offerTitle} onChange={(e) => setOfferTitle(e.target.value)} placeholder="ex. Assistant(e) RH en alternance"
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Entreprise <span className="font-normal text-slate-400">(facultatif)</span>
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="ex. Decathlon"
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
            </label>
          </div>
          <label className="block text-sm font-medium text-slate-700">
            Texte de l’offre
            <textarea value={offerText} onChange={(e) => setOfferText(e.target.value)} rows={7}
              placeholder="Collez ici le texte complet de l’annonce : missions, profil recherché, compétences…"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={analyze} disabled={busy || offerText.trim().length < 80}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {busy ? 'Analyse en cours (≈ 20 s)…' : 'Voir quoi changer dans mon CV'}
            </Button>
            {offerText.trim().length > 0 && offerText.trim().length < 80 && <span className="text-xs text-slate-500">Collez le texte complet de l’offre.</span>}
          </div>
          {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{error}</p>}
        </div>
      )}

      {result && (
        <div className="mt-6 space-y-6 border-t border-slate-100 pt-6" aria-live="polite">
          {result.notice && <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">{result.notice}</p>}

          {signedIn && result.fit.level && (
            <div className="flex flex-wrap items-center gap-3">
              <FitBadge level={result.fit.level} className="text-sm" />
              <span className="text-sm text-slate-600">{result.fit.reasons.join(' · ')}</span>
            </div>
          )}

          <div>
            <h3 className="text-sm font-bold text-slate-900">Mots-clés de l’offre</h3>
            <p className="mt-0.5 text-xs text-slate-500">Les logiciels de tri des recruteurs (ATS) cherchent ces termes exacts.</p>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              <KeywordList icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />} title="Déjà dans votre CV" items={result.keywords.present} tone="green" empty="Aucun" />
              <KeywordList icon={<PlusCircle className="h-4 w-4 text-brand-600" aria-hidden="true" />} title="Dans votre parcours : à nommer tel quel" items={result.keywords.implicit} tone="brand" empty="Aucun"
                hint="Vous l’avez fait : ajoutez le terme exact dans vos compétences." />
              <KeywordList icon={<XCircle className="h-4 w-4 text-slate-400" aria-hidden="true" />} title="Absents de votre profil" items={result.keywords.absent} tone="neutral" empty="Aucun"
                hint="À n’ajouter que si vous le maîtrisez vraiment." />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-bold text-slate-900">Modifications proposées ({result.changes.length})</h3>
            {result.changes.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">Aucune reformulation nécessaire : votre CV met déjà en avant ce que l’offre demande.</p>
            ) : (
              <ol className="mt-3 space-y-3">
                {result.changes.map((c, i) => (
                  <li key={i} className="rounded-xl border border-slate-200 p-3.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{KIND_LABEL[c.kind]}{c.kind === 'bullet' || c.kind === 'hide' ? ` · ${c.where}` : ''}</p>
                    {c.kind === 'hide' ? (
                      <p className="mt-1.5 text-sm text-slate-700">Peu utile pour ce poste : à masquer ou résumer pour gagner de la place.</p>
                    ) : (
                      <div className="mt-1.5 space-y-1 text-sm">
                        {c.before && <p className="text-slate-500 line-through decoration-slate-300">{c.before}</p>}
                        <p className="flex gap-1.5 text-slate-900"><ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />{c.after}</p>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          {result.skillsOrder.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-slate-900">Compétences à placer en tête</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">{result.skillsOrder.map((s) => <Badge key={s} tone="brand">{s}</Badge>)}</div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => { track('offer_match_open_studio'); onOpenStudio(result.job, result.tailored, result.analysis); }}>
              Appliquer dans le Studio (CV + lettre) <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};

const KeywordList: React.FC<{ icon: React.ReactNode; title: string; items: string[]; tone: 'green' | 'brand' | 'neutral'; empty: string; hint?: string }> = ({ icon, title, items, tone, empty, hint }) => (
  <div className={cx('rounded-xl border p-3.5', tone === 'green' ? 'border-emerald-200' : tone === 'brand' ? 'border-brand-200' : 'border-slate-200')}>
    <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">{icon}{title} <span className="font-normal text-slate-400">({items.length})</span></p>
    {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.length ? items.map((k) => <Badge key={k} tone={tone}>{k}</Badge>) : <span className="text-sm text-slate-400">{empty}</span>}
    </div>
  </div>
);

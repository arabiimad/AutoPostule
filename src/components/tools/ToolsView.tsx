import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck, Sparkles, XCircle, RotateCcw, Target, ScanSearch } from 'lucide-react';
import { Badge, Button, Card, cx } from '../ui';
import { BrandLoader } from '../BrandLoader';
import { CvSourceInput, DocumentInput, OFFER_LABELS, cvSourceBody, offerSourceBody, type CvSource, type DocSource } from './CvSourceInput';

export type ToolId = 'ats' | 'match';

interface AtsCheck { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; advice?: string }
interface AtsResult { score: number; level: string; checks: AtsCheck[]; stats: { words: number; pages: number | null; sections: string[]; skills: string[] }; preview: string }
interface MatchResult { score: number | null; matched: string[]; missing: string[]; keywords: string[]; ats: { score: number; level: string } }

const STATUS_META = {
  ok: { icon: CheckCircle2, className: 'text-emerald-600', label: 'Conforme' },
  warn: { icon: AlertTriangle, className: 'text-amber-600', label: 'À améliorer' },
  fail: { icon: XCircle, className: 'text-rose-600', label: 'Bloquant' }
} as const;

/** Anneau de score (0–100) avec libellé accessible. */
const ScoreRing: React.FC<{ score: number; label: string }> = ({ score, label }) => {
  const size = 104, r = size / 2 - 7, c = 2 * Math.PI * r;
  const color = score >= 70 ? '#059669' : score >= 45 ? '#d97706' : '#e11d48';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} : ${score} sur 100`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: 'var(--color-slate-200)' }} strokeWidth="8" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={`${(score / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="47%" dominantBaseline="central" textAnchor="middle" fontSize="28" fontWeight="800" style={{ fill: 'var(--color-slate-900)' }}>{score}</text>
      <text x="50%" y="70%" dominantBaseline="central" textAnchor="middle" fontSize="11" style={{ fill: 'var(--color-slate-500)' }}>/ 100</text>
    </svg>
  );
};

async function postTool<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Connexion impossible : vérifiez votre réseau puis réessayez.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || (res.status === 429 ? 'Trop de requêtes : réessayez dans une minute.' : 'Une erreur est survenue. Réessayez dans un instant.'));
  }
  return data as T;
}

export const ToolsView: React.FC<{ tool: ToolId; onToolChange: (t: ToolId) => void; onCreateCv?: () => void }> = ({ tool, onToolChange, onCreateCv }) => {
  // Le même CV sert aux deux outils (vérifier, puis comparer à une offre)
  const [cv, setCv] = useState<CvSource | null>(null);
  const [offer, setOffer] = useState<DocSource | null>(null);
  // Offre collée trop courte : il manque les missions et le profil recherché
  const offerTooShort = offer?.kind === 'text' && offer.text.trim().length < 40;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ats, setAts] = useState<AtsResult | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);

  // Chargement puis résultat : amenés à l'écran (sur mobile, ils sont sous le formulaire)
  const outputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!busy && !ats && !match) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    outputRef.current?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, [busy, ats, match]);

  const changeCv = (s: CvSource | null) => { setCv(s); setAts(null); setMatch(null); setError(null); };

  const runAts = async () => {
    if (!cv) return;
    setBusy(true); setError(null); setAts(null);
    try { setAts(await postTool<AtsResult>('/api/tools/ats-check', cvSourceBody(cv))); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const runMatch = async () => {
    if (!cv || !offer || offerTooShort) return;
    setBusy(true); setError(null); setMatch(null);
    try { setMatch(await postTool<MatchResult>('/api/tools/match', { ...cvSourceBody(cv), ...offerSourceBody(offer) })); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const toolTabs: { id: ToolId; label: string; icon: React.ElementType }[] = [
    { id: 'ats', label: 'Vérificateur de CV ATS', icon: ScanSearch },
    { id: 'match', label: 'Comparer mon CV à une offre', icon: Target }
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="text-center">
        <p className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Gratuit, sans inscription
        </p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          {tool === 'ats' ? 'Votre CV passe-t-il les logiciels de recrutement\u00a0?' : 'Votre CV correspond-il à cette offre\u00a0?'}
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-[15px] text-slate-600">
          {tool === 'ats'
            ? 'Déposez votre CV : nous vérifions ce qu’un logiciel de tri des candidatures (ATS) lit vraiment, et ce qu’il faut corriger.'
            : 'Déposez votre CV et l’offre (fichier ou texte) : nous indiquons les mots-clés de l’offre présents et absents de votre CV.'}
        </p>
        <p className="mt-1 text-xs text-slate-500">Votre CV n’est ni conservé ni envoyé à une IA : l’analyse se fait sur notre serveur, puis il est oublié.</p>
      </div>

      <div role="tablist" aria-label="Outils" className="grid grid-cols-2 gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1">
        {toolTabs.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" type="button" aria-selected={tool === id} onClick={() => { onToolChange(id); setError(null); }}
            className={cx('flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold', tool === id ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900')}>
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      <Card className="space-y-4 p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-slate-900">1. Votre CV</h2>
        <CvSourceInput value={cv} onChange={changeCv} idPrefix={`outil-${tool}`} />

        {tool === 'match' && (
          <div className="space-y-2">
            <h2 className="text-[15px] font-semibold text-slate-900">2. L’offre d’emploi</h2>
            <DocumentInput value={offer} onChange={(s) => { setOffer(s); setMatch(null); setError(null); }} idPrefix="outil-offre" labels={OFFER_LABELS} />
            {offerTooShort && <p className="text-xs text-slate-500">Collez l’offre complète (missions et profil recherché).</p>}
          </div>
        )}

        <Button type="button" variant="primary" size="lg" className="w-full"
          onClick={tool === 'ats' ? runAts : runMatch}
          disabled={busy || !cv || (tool === 'match' && (!offer || offerTooShort))}>
          {tool === 'ats' ? 'Analyser mon CV' : 'Comparer'}
        </Button>
        {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{error}</div>}
      </Card>

      <div ref={outputRef} className="scroll-mt-20" aria-hidden="true" />
      {busy && <BrandLoader label={tool === 'ats' ? 'Lecture de votre CV comme un logiciel de recrutement…' : 'Comparaison de votre CV avec l’offre…'} />}

      {tool === 'ats' && ats && !busy && (
        <section aria-labelledby="resultat-ats" className="space-y-4">
          <Card className="flex flex-col items-center gap-4 p-5 text-center sm:flex-row sm:text-left">
            <ScoreRing score={ats.score} label="Compatibilité ATS" />
            <div className="min-w-0">
              <h2 id="resultat-ats" className="text-lg font-bold text-slate-900">Compatibilité ATS : {ats.level}</h2>
              <p className="mt-1 text-sm text-slate-600">
                {ats.stats.words} mots lus{ats.stats.pages ? ` sur ${ats.stats.pages} page${ats.stats.pages > 1 ? 's' : ''}` : ''}
                {ats.stats.sections.length ? ` · sections : ${ats.stats.sections.join(', ')}` : ''}.
              </p>
              <p className="mt-1 text-xs text-slate-500">Estimation fondée sur les règles communes des ATS ; chaque logiciel a ses particularités.</p>
            </div>
          </Card>

          <Card className="divide-y divide-slate-100">
            {[...ats.checks].sort((a, b) => ['fail', 'warn', 'ok'].indexOf(a.status) - ['fail', 'warn', 'ok'].indexOf(b.status)).map((c) => {
              const meta = STATUS_META[c.status];
              const Icon = meta.icon;
              return (
                <div key={c.id} className="flex gap-3 p-4">
                  <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', meta.className)} aria-label={meta.label} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{c.label}</p>
                    <p className="text-sm text-slate-600">{c.detail}</p>
                    {c.advice && <p className="mt-1 text-sm text-slate-800"><span className="font-medium">Conseil : </span>{c.advice}</p>}
                  </div>
                </div>
              );
            })}
          </Card>

          <details className="rounded-2xl border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">Voir le texte tel qu’un logiciel de recrutement le lit</summary>
            <pre className="thin-scroll mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">{ats.preview || '(aucun texte)'}</pre>
          </details>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="secondary" onClick={() => onToolChange('match')}><Target className="h-4 w-4" aria-hidden="true" /> Comparer ce CV à une offre</Button>
            {onCreateCv && <Button type="button" variant="primary" onClick={onCreateCv}><Sparkles className="h-4 w-4" aria-hidden="true" /> Créer un CV compatible</Button>}
            <Button type="button" variant="ghost" onClick={() => changeCv(null)}><RotateCcw className="h-4 w-4" aria-hidden="true" /> Analyser un autre CV</Button>
          </div>
        </section>
      )}

      {tool === 'match' && match && !busy && (
        <section aria-labelledby="resultat-match" className="space-y-4">
          <Card className="flex flex-col items-center gap-4 p-5 text-center sm:flex-row sm:text-left">
            {match.score !== null ? <ScoreRing score={match.score} label="Correspondance avec l’offre" /> : null}
            <div className="min-w-0">
              <h2 id="resultat-match" className="text-lg font-bold text-slate-900">
                {match.score === null ? 'Aucun mot-clé reconnu dans l’offre' : `${match.matched.length} mot${match.matched.length > 1 ? 's' : ''}-clé${match.matched.length > 1 ? 's' : ''} sur ${match.keywords.length} présents dans votre CV`}
              </h2>
              <p className="mt-1 text-sm text-slate-600">Compatibilité ATS de votre CV : {match.ats.score} / 100 ({match.ats.level}).</p>
            </div>
          </Card>
          {match.score !== null && (
            <Card className="space-y-4 p-5">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Présents dans votre CV</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {match.matched.length ? match.matched.map((k) => <Badge key={k} tone="green"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />{k}</Badge>) : <span className="text-sm text-slate-500">Aucun</span>}
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Absents de votre CV</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {match.missing.length ? match.missing.map((k) => <Badge key={k}>{k}</Badge>) : <span className="text-sm text-slate-500">Aucun</span>}
                </div>
                {match.missing.length > 0 && (
                  <p className="mt-2 text-sm text-slate-700">
                    Si vous avez réellement ces compétences, écrivez-les avec les mots de l’offre. N’ajoutez jamais une compétence que vous n’avez pas : le recruteur la vérifiera en entretien.
                  </p>
                )}
              </div>
            </Card>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="secondary" onClick={() => onToolChange('ats')}><ScanSearch className="h-4 w-4" aria-hidden="true" /> Vérifier la lisibilité ATS</Button>
            {onCreateCv && <Button type="button" variant="primary" onClick={onCreateCv}><Sparkles className="h-4 w-4" aria-hidden="true" /> Adapter mon CV à l’offre</Button>}
          </div>
        </section>
      )}
    </div>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, MapPin, SlidersHorizontal, X, Info, AlertTriangle, SearchX, Upload, ChevronDown, Bell, BellRing, RefreshCw, FileText, Sparkles } from 'lucide-react';
import type { Application, JobOffer, SavedSearch, UserProfile } from '../../types';
import { readSearch, readSelectedJob, writeUrl, jobShareUrl, type SearchUrlState } from '../../utils/url';
import type { JobsMeta } from '../../App';
import { assessFit, type JobFit } from '../../utils/skillMatcher';
import { filterJobs } from '../../utils/jobFilter';
import { ageInDays, sourceShortName } from '../../utils/format';
import { Button, EmptyState, cx } from '../ui';
import { accountsRequired } from '../../data/cloud';
import { JobCard, JobCardSkeleton } from './JobCard';
import { JobDetail } from './JobDetail';

interface JobSearchViewProps {
  jobs: JobOffer[];
  jobsMeta?: JobsMeta;
  userProfile: UserProfile;
  applications: Application[];
  isLoading: boolean;
  onSearch: (query: string, contractType: string, location: string, radius?: number) => Promise<void>;
  onToggleSave: (job: JobOffer) => void;
  onPrepare: (job: JobOffer) => void;
  onExpressApply: (job: JobOffer) => void;
  onOpenCvUpload?: () => void;
  /** Compte en ligne : l'adéquation n'est montrée qu'aux utilisateurs connectés. */
  signedIn?: boolean;
  onOpenAuthModal?: (mode: 'login' | 'register') => void;
  busy?: boolean;
  /** Recherche à afficher au montage (URL ou dernière recherche). */
  initialSearch?: SearchUrlState;
  /** Charge la page suivante auprès des sources. */
  onLoadMore?: () => void;
  loadingMore?: boolean;
  savedSearches?: SavedSearch[];
  onSaveSearch?: () => void;
  onOpenSavedSearch?: (s: SavedSearch) => void;
  onRemoveSavedSearch?: (id: string) => void;
  onCheckAlerts?: () => void;
  checkingAlerts?: boolean;
  notificationsOn?: boolean;
  onEnableNotifications?: () => void;
}

const WELCOME_KEY = 'autopostule_welcome_dismissed';
const readFlag = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const writeFlag = (k: string) => { try { localStorage.setItem(k, '1'); } catch { /* ignore */ } };

const CONTRACTS = [
  { id: 'tous', label: 'Tous contrats' },
  { id: 'alternance', label: 'Alternance' },
  { id: 'stage', label: 'Stage' },
  { id: 'cdi', label: 'CDI' },
  { id: 'cdd', label: 'CDD' },
  { id: 'freelance', label: 'Freelance' }
];
const DATES = [
  { id: 0, label: 'Toutes les dates' },
  { id: 1, label: 'Moins de 24 h' },
  { id: 7, label: 'Moins d’une semaine' },
  { id: 30, label: 'Moins d’un mois' }
];
const REMOTES = [
  { id: 'tous', label: 'Tous modes' },
  { id: 'total', label: 'Télétravail complet' },
  { id: 'hybride', label: 'Télétravail partiel' },
  { id: 'sur-site', label: 'Sur site' }
];
const KINDS = [
  { id: 'toutes', label: 'Offres et entreprises' },
  { id: 'offres', label: 'Offres publiées' },
  { id: 'spontanees', label: 'Candidatures spontanées' }
];
const SORTS = [
  { id: 'relevance', label: 'Pertinence' },
  { id: 'date', label: 'Plus récentes' },
  { id: 'match', label: 'Compatibilité' }
];
const PAGE = 20;

const useIsDesktop = () => {
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setDesktop(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desktop;
};

/** Menu déroulant compact (filtres). */
const FilterSelect: React.FC<{ value: string | number; onChange: (v: string) => void; options: { id: string | number; label: string }[]; label: string; active?: boolean }> = ({ value, onChange, options, label, active }) => (
  <label className={cx('relative inline-flex items-center rounded-full border h-9 pl-3.5 pr-8 text-sm font-medium transition-colors cursor-pointer',
    active ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400')}>
    <span className="sr-only">{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className="appearance-none bg-transparent outline-none cursor-pointer pr-1">
      {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
    <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 opacity-60" />
  </label>
);

export const JobSearchView: React.FC<JobSearchViewProps> = ({
  jobs, jobsMeta, userProfile, applications, isLoading, onSearch, onToggleSave, onPrepare, onExpressApply, onOpenCvUpload, signedIn = false, onOpenAuthModal, busy,
  initialSearch, onLoadMore, loadingMore, savedSearches = [], onSaveSearch, onOpenSavedSearch, onRemoveSavedSearch,
  onCheckAlerts, checkingAlerts, notificationsOn, onEnableNotifications
}) => {
  const isDesktop = useIsDesktop();
  const isLive = jobsMeta?.mode === 'live';
  const hasProfile = signedIn && userProfile.skills.length > 0;
  const init = initialSearch || { query: '', location: '', radius: 30, contractType: 'tous' };

  const [query, setQuery] = useState(init.query);
  const [location, setLocation] = useState(init.location);
  const [radius, setRadius] = useState(init.radius);
  const [contract, setContract] = useState(init.contractType || 'tous');
  const [kind, setKind] = useState('toutes');
  const [welcomeHidden, setWelcomeHidden] = useState(() => readFlag(WELCOME_KEY));
  const [remote, setRemote] = useState('tous');
  const [maxAge, setMaxAge] = useState(0);
  const [minFit, setMinFit] = useState('toutes');
  const [source, setSource] = useState('toutes');
  const [sort, setSort] = useState('relevance');
  const [visible, setVisible] = useState(PAGE);
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedJob());
  const [mobileDetail, setMobileDetail] = useState(() => !!readSelectedJob());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [submitted, setSubmitted] = useState({ query: init.query, location: init.location });
  const detailRef = useRef<HTMLDivElement>(null);

  const runSearch = (q = query, c = contract, loc = location, r = radius) => {
    setSubmitted({ query: q, location: loc });
    setVisible(PAGE);
    setSelectedId(null);
    // La recherche est inscrite dans l'URL : lien partageable, bouton Précédent
    writeUrl({ q, lieu: loc, rayon: r, contrat: c, offre: null }, true);
    onSearch(q, c, loc, r);
  };

  // Précédent / Suivant : champs et offre ouverte resynchronisés avec l'URL
  useEffect(() => {
    const onPop = () => {
      const s = readSearch();
      setQuery(s.query); setLocation(s.location); setRadius(s.radius); setContract(s.contractType);
      setSubmitted({ query: s.query, location: s.location });
      const id = readSelectedJob();
      setSelectedId(id);
      setMobileDetail(!!id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Une nouvelle recherche lancée ailleurs (alerte, historique) met à jour les champs
  useEffect(() => {
    if (!initialSearch) return;
    setQuery(initialSearch.query); setLocation(initialSearch.location); setRadius(initialSearch.radius); setContract(initialSearch.contractType || 'tous');
    setSubmitted({ query: initialSearch.query, location: initialSearch.location });
  }, [initialSearch?.query, initialSearch?.location, initialSearch?.radius, initialSearch?.contractType]);

  // En mode réel, le contrat est filtré par les sources elles-mêmes : on relance la recherche
  const changeContract = (c: string) => {
    setContract(c);
    if (isLive) runSearch(submitted.query, c, submitted.location);
  };

  const applicationFor = useMemo(() => {
    const norm = (v: string) => (v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return (job: JobOffer) => applications.find(a => a.jobId === job.id || (norm(a.company) === norm(job.company) && norm(a.jobTitle) === norm(job.title)));
  }, [applications]);

  const sourceOptions = useMemo(() => {
    const set = new Map<string, number>();
    jobs.forEach(j => { const s = j.origin === 'demo' ? 'Démo' : sourceShortName(j.source); set.set(s, (set.get(s) || 0) + 1); });
    return [{ id: 'toutes', label: 'Toutes les sources' }, ...[...set.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => ({ id: s, label: `${s} (${n})` }))];
  }, [jobs]);

  const results = useMemo(() => {
    const base = filterJobs(jobs, {
      // En mode réel, le serveur a déjà filtré sur la requête et le lieu soumis
      query: isLive && query.trim() === submitted.query.trim() ? '' : query,
      location,
      skipLocation: isLive,
      contractType: contract,
      remote,
      onlyActive: true
    })
      // Date inconnue : exclue d'un filtre de fraîcheur (jamais considérée comme récente)
      .filter(j => !maxAge || (ageInDays(j.publishedAt) ?? Infinity) <= maxAge)
      .filter(j => source === 'toutes' || (j.origin === 'demo' ? 'Démo' : sourceShortName(j.source)) === source)
      .filter(j => kind === 'toutes' || (kind === 'spontanees' ? !!j.isSpontaneous : !j.isSpontaneous))
      .map(job => ({ job, match: assessFit(userProfile, job) as JobFit }))
      .filter(({ match }) => !hasProfile || minFit === 'toutes' || match.level === 'forte' || (minFit === 'moyenne' && match.level === 'moyenne'));

    // Les candidatures spontanées (sans date) restent après les offres publiées
    const byDate = (a: JobOffer, b: JobOffer) => (Number(!!a.isSpontaneous) - Number(!!b.isSpontaneous)) || ((ageInDays(a.publishedAt) ?? 999) - (ageInDays(b.publishedAt) ?? 999));
    if (sort === 'date' || (sort === 'relevance' && !hasProfile)) base.sort((a, b) => byDate(a.job, b.job));
    else if (sort === 'match') base.sort((a, b) => b.match.rank - a.match.rank || byDate(a.job, b.job));
    // Pertinence : adéquation par tranches, puis fraîcheur de l'offre
    else base.sort((a, b) => (Number(!!a.job.isSpontaneous) - Number(!!b.job.isSpontaneous)) || (Math.floor(b.match.rank / 20) - Math.floor(a.match.rank / 20)) || byDate(a.job, b.job));
    return base;
  }, [jobs, isLive, query, submitted, location, contract, remote, maxAge, source, kind, userProfile, hasProfile, minFit, sort]);
  const hasSpontaneous = useMemo(() => jobs.some(j => j.isSpontaneous), [jobs]);

  // Sélection par défaut (bureau) : première offre ; conservée si toujours présente
  useEffect(() => {
    if (!isDesktop) return;
    if (!results.length) { setSelectedId(null); return; }
    if (!selectedId || !results.some(r => r.job.id === selectedId)) setSelectedId(results[0].job.id);
  }, [results, isDesktop, selectedId]);

  const selected = results.find(r => r.job.id === selectedId) || null;

  const select = (id: string) => {
    setSelectedId(id);
    writeUrl({ offre: id }, !isDesktop);
    if (!isDesktop) setMobileDetail(true);
    else detailRef.current?.scrollTo({ top: 0 });
  };
  const closeMobileDetail = () => {
    setMobileDetail(false);
    writeUrl({ offre: null }, false);
  };

  // Navigation clavier ↑ / ↓ dans la liste (bureau)
  useEffect(() => {
    if (!isDesktop) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const i = results.findIndex(r => r.job.id === selectedId);
      const next = results[Math.min(results.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { e.preventDefault(); select(next.job.id); document.getElementById(`job-${next.job.id}`)?.scrollIntoView({ block: 'nearest' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Bloque le défilement de la page quand la fiche mobile est ouverte
  useEffect(() => {
    if (mobileDetail && !isDesktop) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [mobileDetail, isDesktop]);

  const activeFilters = (contract !== 'tous' ? 1 : 0) + (remote !== 'tous' ? 1 : 0) + (maxAge ? 1 : 0) + (minFit !== 'toutes' ? 1 : 0) + (source !== 'toutes' ? 1 : 0) + (kind !== 'toutes' ? 1 : 0);
  const resetFilters = () => { setRemote('tous'); setMaxAge(0); setMinFit('toutes'); setSource('toutes'); setKind('toutes'); if (contract !== 'tous') changeContract('tous'); };
  const currentSearch: SearchUrlState = { query: submitted.query, location: submitted.location, radius, contractType: contract };
  const isSaved = savedSearches.some(s => s.query.trim().toLowerCase() === submitted.query.trim().toLowerCase() && s.location.trim().toLowerCase() === submitted.location.trim().toLowerCase() && (s.contractType || 'tous') === contract && Number(s.radius) === Number(radius));
  const showWelcome = userProfile.skills.length === 0 && applications.length === 0 && !welcomeHidden;

  const sourceSummary = isLive && jobsMeta?.sources
    ? Object.entries(jobsMeta.sources).filter(([, s]) => s?.enabled && s.count > 0).map(([k, s]) => `${SOURCE_NAMES[k] || k} ${s!.count}`).join(' · ')
    : '';

  const detail = selected && (
    <JobDetail
      key={selected.job.id}
      job={selected.job}
      match={selected.match}
      signedIn={signedIn}
      onOpenAuthModal={onOpenAuthModal}
      userProfile={userProfile}
      application={applicationFor(selected.job)}
      onToggleSave={() => onToggleSave(selected.job)}
      onPrepare={() => onPrepare(selected.job)}
      onExpressApply={() => onExpressApply(selected.job)}
      onOpenCvUpload={onOpenCvUpload}
      onBack={!isDesktop ? closeMobileDetail : undefined}
      busy={busy}
      shareUrl={jobShareUrl(selected.job.id, currentSearch)}
    />
  );

  return (
    <div className="-mt-2">
      {/* Recherche */}
      <section className="rounded-3xl bg-white border border-slate-200 p-4 sm:p-6 shadow-[0_1px_2px_rgba(15,23,42,.04)]">
        <h1 className="text-2xl sm:text-[28px] font-extrabold tracking-tight text-slate-900">Trouvez votre prochaine offre</h1>
        <p className="mt-1 text-sm text-slate-500">
          {isLive
            ? 'Offres réelles regroupées depuis plusieurs plateformes, triées selon votre profil.'
            : 'Mode démonstration : les offres affichées sont indicatives.'}
        </p>

        <form
          onSubmit={(e) => { e.preventDefault(); runSearch(); }}
          className="mt-5 grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] gap-2 md:gap-0 md:rounded-2xl md:border md:border-slate-300 md:bg-white md:p-1.5 md:shadow-sm"
          role="search"
        >
          <label className="flex items-center gap-2.5 rounded-xl border border-slate-300 md:border-0 px-3.5 h-12 focus-within:ring-2 focus-within:ring-brand-500/30">
            <Search className="h-5 w-5 text-slate-400 shrink-0" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Métier, compétence, entreprise…" aria-label="Métier ou mot-clé"
              className="w-full bg-transparent text-[15px] outline-none placeholder:text-slate-400" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Effacer" className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>}
          </label>
          <label className="flex items-center gap-2.5 rounded-xl border border-slate-300 md:border-0 md:border-l md:rounded-none px-3.5 h-12 focus-within:ring-2 focus-within:ring-brand-500/30">
            <MapPin className="h-5 w-5 text-slate-400 shrink-0" />
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Ville, département (84) ou « Remote »" aria-label="Lieu"
              className="w-full bg-transparent text-[15px] outline-none placeholder:text-slate-400" />
          </label>
          <label className="flex items-center rounded-xl border border-slate-300 md:border-0 md:border-l md:rounded-none px-3 h-12">
            <span className="sr-only">Rayon</span>
            <select value={radius} onChange={(e) => { const r = Number(e.target.value); setRadius(r); if (submitted.location || location) runSearch(query, contract, location, r); }}
              className="bg-transparent text-sm font-medium text-slate-700 outline-none cursor-pointer">
              {[10, 20, 30, 50, 100, 200].map(r => <option key={r} value={r}>{r} km</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" size="lg" className="md:ml-1.5" disabled={isLoading}>
            {isLoading ? 'Recherche…' : 'Rechercher'}
          </Button>
        </form>

        {/* Filtres */}
        <div className="mt-4 flex items-center gap-2">
          <button onClick={() => setFiltersOpen(o => !o)} className="md:hidden inline-flex items-center gap-2 rounded-full border border-slate-300 h-9 px-3.5 text-sm font-medium text-slate-700">
            <SlidersHorizontal className="h-4 w-4" /> Filtres{activeFilters ? ` (${activeFilters})` : ''}
          </button>
          <div className={cx('flex-wrap items-center gap-2', filtersOpen ? 'flex' : 'hidden md:flex')}>
            <FilterSelect label="Contrat" value={contract} onChange={changeContract} options={CONTRACTS} active={contract !== 'tous'} />
            <FilterSelect label="Télétravail" value={remote} onChange={setRemote} options={REMOTES} active={remote !== 'tous'} />
            <FilterSelect label="Date de publication" value={maxAge} onChange={(v) => setMaxAge(Number(v))} options={DATES} active={!!maxAge} />
            {sourceOptions.length > 2 && <FilterSelect label="Source" value={source} onChange={setSource} options={sourceOptions} active={source !== 'toutes'} />}
            {hasSpontaneous && <FilterSelect label="Type" value={kind} onChange={setKind} options={KINDS} active={kind !== 'toutes'} />}
            {hasProfile && (
              <FilterSelect label="Adéquation" value={minFit} onChange={(v) => setMinFit(String(v))} active={minFit !== 'toutes'}
                options={[{ id: 'toutes', label: 'Toutes les offres' }, { id: 'moyenne', label: 'Moyenne ou forte' }, { id: 'forte', label: 'Forte uniquement' }]} />
            )}
            {activeFilters > 0 && <Button variant="ghost" size="sm" onClick={resetFilters}>Effacer les filtres</Button>}
          </div>
        </div>
      </section>

      {/* Premiers pas */}
      {showWelcome && (
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="welcome-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="welcome-title" className="flex items-center gap-2 text-base font-semibold text-slate-900"><Sparkles className="h-4 w-4 text-brand-600" /> Bienvenue sur Kareer</h2>
              <p className="mt-0.5 text-sm text-slate-500">Trois étapes pour postuler plus vite, sans rien inventer sur votre profil.</p>
            </div>
            <button onClick={() => { writeFlag(WELCOME_KEY); setWelcomeHidden(true); }} aria-label="Masquer les premiers pas" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
          </div>
          <ol className="mt-4 grid gap-3 sm:grid-cols-3">
            {[
              accountsRequired && !signedIn
                ? { n: 1, title: 'Créez votre compte gratuit', text: 'Puis importez votre CV (PDF, Word ou image) : vos compétences et expériences sont extraites.', action: onOpenAuthModal && <Button variant="primary" size="sm" onClick={() => onOpenAuthModal('register')}>Créer un compte</Button> }
                : { n: 1, title: 'Importez votre CV', text: 'PDF, Word ou image : vos compétences et expériences sont extraites.', action: onOpenCvUpload && <Button variant="primary" size="sm" onClick={onOpenCvUpload}><Upload className="h-3.5 w-3.5" /> Importer</Button> },
              { n: 2, title: 'Trouvez des offres', text: 'France Travail, La bonne alternance, LinkedIn, Indeed… réunis et triés selon votre profil.' },
              { n: 3, title: 'Préparez chaque dossier', text: 'CV LaTeX et lettre adaptés à l’offre, puis suivi, relances et entretiens.', icon: FileText }
            ].map(step => (
              <li key={step.n} className="rounded-xl border border-slate-200 p-4">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-700">{step.n}</span>
                <p className="mt-2.5 text-sm font-semibold text-slate-900">{step.title}</p>
                <p className="mt-1 text-sm text-slate-500">{step.text}</p>
                {step.action && <div className="mt-3">{step.action}</div>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Alertes (recherches enregistrées) */}
      {savedSearches.length > 0 && (
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3" aria-label="Mes alertes">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900"><BellRing className="h-4 w-4 text-brand-600" /> Mes alertes</span>
            {savedSearches.map(s => (
              <span key={s.id} className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 text-sm">
                <button onClick={() => onOpenSavedSearch?.(s)} className="flex items-center gap-1.5 rounded-l-full py-1 pl-3 pr-2 text-slate-700 hover:text-brand-700" title="Afficher les offres de cette alerte">
                  {s.query || 'Toutes offres'}{s.location ? ` · ${s.location}` : ''}{s.contractType && s.contractType !== 'tous' ? ` · ${s.contractType}` : ''}
                  {(s.newCount || 0) > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-bold leading-4 text-white">{s.newCount} nouv.</span>}
                </button>
                <button onClick={() => onRemoveSavedSearch?.(s.id)} aria-label={`Supprimer l’alerte ${s.query || s.location}`} className="rounded-r-full py-1 pl-1 pr-2.5 text-slate-400 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            <span className="ml-auto flex items-center gap-1">
              {onCheckAlerts && <Button variant="ghost" size="sm" onClick={onCheckAlerts} disabled={checkingAlerts}><RefreshCw className={cx('h-3.5 w-3.5', checkingAlerts && 'animate-spin')} /> {checkingAlerts ? 'Vérification…' : 'Vérifier'}</Button>}
              {!notificationsOn && onEnableNotifications && <Button variant="ghost" size="sm" onClick={onEnableNotifications}><Bell className="h-3.5 w-3.5" /> Activer les notifications</Button>}
            </span>
          </div>
        </section>
      )}

      {/* Bandeaux */}
      {!hasProfile && !showWelcome && (signedIn ? onOpenCvUpload : onOpenAuthModal) && (
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-brand-900">Voyez quelles offres vous correspondent vraiment</p>
            <p className="text-sm text-brand-800/80">
              {signedIn
                ? 'Importez votre CV : votre métier et vos compétences sont comparés à chaque annonce, sans rien inventer.'
                : 'Créez un compte gratuit et importez votre CV : chaque annonce indique son adéquation avec votre parcours, et pourquoi.'}
            </p>
          </div>
          {signedIn
            ? <Button variant="primary" size="md" onClick={onOpenCvUpload}><Upload className="h-4 w-4" /> Importer mon CV</Button>
            : <Button variant="primary" size="md" onClick={() => onOpenAuthModal?.('register')}>Créer un compte gratuit</Button>}
        </div>
      )}
      {(jobsMeta?.warnings?.length ?? 0) > 0 && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900 space-y-1">
          {jobsMeta!.warnings.map((w, i) => <p key={i} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}</p>)}
        </div>
      )}

      {/* Résultats */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600" aria-live="polite">
          {isLoading ? 'Recherche en cours…' : (
            <>
              <span className="font-semibold text-slate-900">{results.length.toLocaleString('fr-FR')}</span> offre{results.length > 1 ? 's' : ''}
              {jobsMeta?.resolvedLocation ? <> autour de <span className="font-medium text-slate-900">{jobsMeta.resolvedLocation}</span> ({radius} km)</> : ''}
              {sourceSummary && <span className="hidden sm:inline text-slate-400"> · {sourceSummary}</span>}
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
        {onSaveSearch && (submitted.query || submitted.location) && (
          <Button variant={isSaved ? 'ghost' : 'secondary'} size="sm" onClick={onSaveSearch} disabled={isSaved} title="Être prévenu(e) des nouvelles offres pour cette recherche">
            {isSaved ? <BellRing className="h-3.5 w-3.5 text-brand-600" /> : <Bell className="h-3.5 w-3.5" />} {isSaved ? 'Alerte active' : 'Créer une alerte'}
          </Button>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Trier par
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-medium text-slate-800">
            {SORTS.filter(s => hasProfile || s.id !== 'match').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-5 items-start">
        {/* Liste */}
        <div className="space-y-3" role="list" aria-label="Offres">
          {isLoading && !jobs.length ? (
            Array.from({ length: 6 }).map((_, i) => <JobCardSkeleton key={i} />)
          ) : results.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white">
              <EmptyState icon={<SearchX className="h-6 w-6" />} title="Aucune offre ne correspond"
                action={<Button variant="secondary" onClick={() => { resetFilters(); setQuery(''); setLocation(''); runSearch('', 'tous', ''); }}>Réinitialiser la recherche</Button>}>
                Essayez un mot-clé plus large, un rayon plus grand ou retirez des filtres.
              </EmptyState>
            </div>
          ) : (
            <>
              {results.slice(0, visible).map(({ job, match }) => (
                <div key={job.id} id={`job-${job.id}`} role="listitem">
                  <JobCard job={job} match={match} showMatch={hasProfile} selected={isDesktop && job.id === selectedId}
                    application={applicationFor(job)} onSelect={() => select(job.id)} onToggleSave={() => onToggleSave(job)} />
                </div>
              ))}
              {visible < results.length ? (
                <Button variant="secondary" className="w-full" onClick={() => setVisible(v => v + PAGE)}>
                  Afficher plus d’offres ({results.length - visible} restantes)
                </Button>
              ) : jobsMeta?.hasMore && onLoadMore ? (
                <Button variant="secondary" className="w-full" onClick={() => { setVisible(v => v + PAGE); onLoadMore(); }} disabled={loadingMore}>
                  <RefreshCw className={cx('h-4 w-4', loadingMore && 'animate-spin')} /> {loadingMore ? 'Chargement des offres suivantes…' : 'Charger plus d’offres depuis les sources'}
                </Button>
              ) : null}
              {isLoading && <p className="text-center text-xs text-slate-400">Mise à jour…</p>}
            </>
          )}
        </div>

        {/* Détail (bureau) */}
        <aside className="hidden lg:block sticky top-20">
          <div ref={detailRef} className="thin-scroll max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            {detail || (
              <EmptyState icon={<Info className="h-6 w-6" />} title="Sélectionnez une offre">Son descriptif complet s’affichera ici.</EmptyState>
            )}
          </div>
        </aside>
      </div>

      {/* Détail (mobile, plein écran) */}
      {!isDesktop && mobileDetail && selected && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-white" role="dialog" aria-modal="true" aria-label={selected.job.title}>
          {detail}
        </div>
      )}
    </div>
  );
};

const SOURCE_NAMES: Record<string, string> = {
  laBonneAlternance: 'La bonne alternance',
  franceTravail: 'France Travail',
  sitesCarriere: 'Sites carrière',
  jsearch: 'Google Jobs',
  adzuna: 'Adzuna',
  jooble: 'Jooble'
};

import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as cloud from './data/cloud';
import { accountsRequired, isCloudUser, type AppUser as User } from './data/cloud';
import { Outbox, overlayPending, changedKeys, type SyncState } from './data/outbox';
import { AccountGate } from './components/AccountGate';
import { Header } from './components/Header';
import { JobSearchView } from './components/jobs/JobSearchView';
import { LatexStudioModal } from './components/LatexStudioModal';
import { AgentAutomationView } from './components/AgentAutomationView';
import { AutoApplyPanel } from './components/AutoApplyPanel';
import { KanbanCrmView } from './components/KanbanCrmView';
import { InterviewCockpitModal } from './components/InterviewCockpitModal';
import { MasterProfileView } from './components/MasterProfileView';
import { AuthModal } from './components/AuthModal';
import { PricingView } from './components/PricingView';
import { OfferMatchView } from './components/OfferMatchView';
import { UpgradeModal } from './components/UpgradeModal';
import { track, identifyUser } from './utils/monitoring';
import { fetchUsage, QUOTA_EVENT, type AccountUsage, type QuotaEventDetail } from './data/account';
import { CvUploadModal } from './components/CvUploadModal';
import { EMPTY_PROFILE } from './mockData';
import { UserProfile, JobOffer, Application, AgentLog, ApplicationStatus, InterviewPrepKit, CvTemplate, SavedSearch, DossierVersion, TailoredCv, OfferAnalysis } from './types';
import { apiFetch, readJson as readApiJson } from './utils/api';
import { Badge, Button, CompanyAvatar, EmptyState, FitBadge, PageHeader } from './components/ui';
import { CONTRACT_LABELS, sourceShortName } from './utils/format';
import { isGatedForVisitor, readTab, readSearch, writeTab, writeUrl, type TabId, type SearchUrlState } from './utils/url';
import { FollowUpModal } from './components/FollowUpModal';
import { assessFit, calculateCandidateMatch } from './utils/skillMatcher';
import { getApplyUrl } from './utils/jobLinks';
import { normalizeCvTemplate } from './utils/templates';
import { ToolsView } from './components/tools/ToolsView';

const isPublicTool = (t: TabId) => t === 'ats' || t === 'match';
const PUBLIC_TOOL_META: Record<'ats' | 'match', { title: string; description: string }> = {
  ats: { title: 'Vérificateur de CV ATS gratuit — Kareer', description: 'Testez gratuitement et sans inscription si votre CV est lisible par les logiciels de recrutement (ATS) : texte, sections, coordonnées, mise en page.' },
  match: { title: 'Comparer son CV à une offre d’emploi, gratuit — Kareer', description: 'Collez une offre et déposez votre CV : découvrez gratuitement les mots-clés de l’offre présents et absents de votre CV.' }
};
import {
  FileCode2,
  Award,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Stockage local : une clé PAR utilisateur (avant, toutes les sessions du navigateur partageaient les mêmes données)
// ---------------------------------------------------------------------------
const LOCAL_USER_KEY = 'autopostule_local_user';
const appsKey = (uid: string) => `autopostule_applications_${uid}`;
const profileKey = (uid: string) => `autopostule_user_profile_${uid}`;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // stockage indisponible (navigation privée…)
  }
}

/** Complète un profil partiel avec des valeurs VIDES (jamais avec les données de quelqu'un d'autre). */
function withProfileDefaults(p: Partial<UserProfile>): UserProfile {
  return {
    ...EMPTY_PROFILE,
    ...p,
    skills: Array.isArray(p.skills) ? p.skills : [],
    experiences: Array.isArray(p.experiences) ? p.experiences : [],
    education: Array.isArray(p.education) ? p.education : [],
    projects: Array.isArray(p.projects) ? p.projects : [],
    languages: Array.isArray(p.languages) ? p.languages : [],
    targetRoles: Array.isArray(p.targetRoles) ? p.targetRoles : [],
    preferredContracts: Array.isArray(p.preferredContracts) ? p.preferredContracts : EMPTY_PROFILE.preferredContracts
  };
}

const nowTime = () => new Date().toLocaleTimeString('fr-FR');

/**
 * Copie synchrone (pendant le clic, avant d'ouvrir un portail) : ne consomme pas l'autorisation d'ouvrir une fenêtre,
 * contrairement à navigator.clipboard. Renvoie false si le navigateur refuse.
 */
const copyToClipboardSync = (text: string): boolean => {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus?.();
  }
};

/** Copie un texte ; renvoie false si le navigateur refuse ou ne répond pas (2 s). */
const copyToClipboard = (text: string): Promise<boolean> => {
  try {
    const write = navigator.clipboard?.writeText(text);
    if (!write) return Promise.resolve(false);
    return Promise.race([
      write.then(() => true, () => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))
    ]);
  } catch {
    return Promise.resolve(false);
  }
};

export interface JobsMeta {
  mode: 'live' | 'demo' | null;
  warnings: string[];
  resolvedLocation?: string;
  sources?: Record<string, { enabled: boolean; count: number; error?: string; skipped?: string } | undefined>;
  /** Pagination côté serveur. */
  page?: number;
  hasMore?: boolean;
}

/** Nombre maximal de versions archivées par dossier. */
const MAX_VERSIONS = 10;
/** Délai minimal entre deux vérifications automatiques des alertes. */
const ALERT_CHECK_INTERVAL_MS = 3 * 3600_000;
const NOTIFIED_KEY = 'autopostule_last_followup_notice';

const notificationsAllowed = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';
function notify(title: string, body: string) {
  if (!notificationsAllowed()) return;
  try {
    new Notification(title, { body, icon: '/favicon.svg', tag: title });
  } catch {
    /* certains navigateurs mobiles exigent un service worker : on ignore */
  }
}

/** Délai avant relance après dépôt d'une candidature (jours). */
const FOLLOW_UP_DAYS = 7;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  detected: 'Repérée',
  prepared: 'Dossier prêt',
  applied: 'Déposée',
  interview: 'Entretien',
  rejected: 'Refusée',
  offer: 'Offre reçue'
};

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentTab, setCurrentTabState] = useState<TabId>(() => readTab());
  // Recherche initiale lue dans l'URL (lien partagé, rechargement de page)
  const initialSearch = useRef<SearchUrlState>(readSearch());
  const [loadingMore, setLoadingMore] = useState(false);
  const [checkingAlerts, setCheckingAlerts] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(notificationsAllowed());
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('register');
  const [authReason, setAuthReason] = useState<string | undefined>(undefined);
  const [cvUploadModalOpen, setCvUploadModalOpen] = useState(false);
  const [isMandatoryOnboarding, setIsMandatoryOnboarding] = useState(false);

  const [userProfile, setUserProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [jobs, setJobs] = useState<JobOffer[]>([]);
  // Métadonnées de la dernière recherche : mode (réel / démo), avertissements, sources interrogées
  const [jobsMeta, setJobsMeta] = useState<JobsMeta>({ mode: null, warnings: [] });
  const [followUpApp, setFollowUpApp] = useState<Application | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);

  const [selectedJobForLatex, setSelectedJobForLatex] = useState<JobOffer | null>(null);
  const [selectedAppForLatex, setSelectedAppForLatex] = useState<Application | null>(null);
  const [selectedAppForInterview, setSelectedAppForInterview] = useState<Application | null>(null);

  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  // Référence synchrone (un double clic ne lance pas deux préparations) + demande d'arrêt d'une série
  const agentBusyRef = useRef(false);
  const agentStopRef = useRef(false);
  const [agentProgress, setAgentProgress] = useState<{ done: number; total: number } | null>(null);
  const setAgentBusy = (busy: boolean) => {
    agentBusyRef.current = busy;
    setIsAgentRunning(busy);
  };
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ title: string; desc: string; error?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [agentLogs, setAgentLogs] = useState<AgentLog[]>([]);

  // Références à jour pour les callbacks asynchrones
  const currentUserRef = useRef<User | null>(null);
  currentUserRef.current = currentUser;
  const profileRef = useRef<UserProfile>(userProfile);
  profileRef.current = userProfile;
  // File d'enregistrement en ligne (comptes) : rien n'est perdu hors connexion, aucun écrasement entre appareils
  const outboxRef = useRef<Outbox | null>(null);
  const savedProfileRef = useRef<UserProfile | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('saved');
  const jobsMetaRef = useRef<JobsMeta>(jobsMeta);
  jobsMetaRef.current = jobsMeta;
  const loadingMoreRef = useRef(false);
  const jobsRef = useRef<JobOffer[]>(jobs);
  jobsRef.current = jobs;
  const applicationsRef = useRef<Application[]>(applications);
  applicationsRef.current = applications;

  // Offre collée (« Adapter mon CV ») : contenu adapté transmis au Studio
  const [pastedDossier, setPastedDossier] = useState<{ jobId: string; tailored: TailoredCv; analysis: OfferAnalysis } | null>(null);

  // Forfait et consommation (freemium)
  const [accountUsage, setAccountUsage] = useState<AccountUsage | null>(null);
  const [quotaDetail, setQuotaDetail] = useState<QuotaEventDetail | null>(null);
  const [paymentStatus] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get('paiement');
    if (v) {
      p.delete('paiement');
      const qs = p.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    return v;
  });
  const refreshUsage = () => fetchUsage().then(setAccountUsage).catch(() => {});
  useEffect(() => {
    refreshUsage();
  }, [currentUser?.uid]);
  useEffect(() => {
    if (currentTab === 'pricing') {
      refreshUsage();
      track('pricing_viewed');
    }
  }, [currentTab]);
  useEffect(() => {
    identifyUser(isCloudUser(currentUser) ? currentUser.uid : null, accountUsage?.plan);
  }, [currentUser?.uid, accountUsage?.plan]);
  useEffect(() => {
    // Après un paiement, le webhook Stripe active Premium en quelques secondes
    if (paymentStatus !== 'ok') return;
    const t = [3000, 8000, 15000].map((ms) => setTimeout(refreshUsage, ms));
    return () => t.forEach(clearTimeout);
  }, [paymentStatus]);
  useEffect(() => {
    const onQuota = (e: Event) => {
      const detail = (e as CustomEvent<QuotaEventDetail>).detail;
      setQuotaDetail(detail);
      track('quota_exceeded', { kind: detail?.kind, plan: detail?.plan });
      refreshUsage();
    };
    window.addEventListener(QUOTA_EVENT, onQuota);
    return () => window.removeEventListener(QUOTA_EVENT, onQuota);
  }, []);

  /** Change d'onglet et l'inscrit dans l'historique du navigateur (bouton Précédent). */
  const setCurrentTab = (tab: TabId) => {
    setCurrentTabState(tab);
    writeTab(tab, true);
    window.scrollTo({ top: 0 });
  };

  const showToast = (title: string, desc: string, error = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastMessage({ title, desc, error });
    toastTimer.current = setTimeout(() => setToastMessage(null), error ? 7000 : 5000);
  };

  const signedIn = isCloudUser(currentUser);
  /** Visiteur sur un service qui exige un compte (production). */
  const gated = accountsRequired && !signedIn;
  /** Onglets ouverts aux visiteurs : la recherche d'offres et les tarifs. */
  // Offres, tarifs et outils publics (vérificateur ATS, comparaison CV / offre) restent ouverts aux visiteurs
  const showGate = isGatedForVisitor(currentTab, gated);
  const openAuth = (mode: 'login' | 'register', reason?: string) => {
    setAuthReason(reason);
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  };
  /** Renvoie true (et ouvre l'inscription) si l'action exige un compte. */
  const needAccount = (reason: string) => {
    if (!accountsRequired || isCloudUser(currentUserRef.current)) return false;
    track('account_gate', { reason });
    openAuth('register', reason);
    return true;
  };
  const openCvUpload = () => {
    if (needAccount('Créez votre compte pour importer votre CV : il sert de base à toutes vos candidatures.')) return;
    setIsMandatoryOnboarding(false);
    setCvUploadModalOpen(true);
  };

  const addLog = (log: Omit<AgentLog, 'id' | 'timestamp'>) => {
    setAgentLogs(prev => [{ id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: nowTime(), ...log }, ...prev].slice(0, 100));
  };

  /** Charge une session locale (sans compte en ligne) à partir du stockage du navigateur. */
  const loadLocalSession = () => {
    if (accountsRequired) {
      // Production : aucune donnée personnelle hors compte
      setCurrentUser(null);
      setUserProfile(EMPTY_PROFILE);
      setApplications([]);
      return;
    }
    const stored = readJson<{ uid: string; displayName?: string; email?: string }>(LOCAL_USER_KEY);
    if (stored?.uid) {
      const localUser = { uid: stored.uid, displayName: stored.displayName || '', email: stored.email || '' } as unknown as User;
      setCurrentUser(localUser);
      const profile = readJson<UserProfile>(profileKey(stored.uid));
      setUserProfile(withProfileDefaults(profile || { userId: stored.uid, fullName: stored.displayName || '', email: stored.email || '' }));
      const apps = readJson<Application[]>(appsKey(stored.uid));
      setApplications(Array.isArray(apps) ? apps : []);
    } else {
      setCurrentUser(null);
      const guestProfile = readJson<UserProfile>(profileKey('guest'));
      setUserProfile(guestProfile ? withProfileDefaults(guestProfile) : EMPTY_PROFILE);
      setApplications(readJson<Application[]>(appsKey('guest')) || []);
    }
  };

  // Enregistrements en attente : nouvel essai au retour du réseau, au retour sur l'onglet et toutes les 30 s
  useEffect(() => {
    const retry = () => { outboxRef.current?.flush(); };
    const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    const t = setInterval(() => { if (outboxRef.current?.size) retry(); }, 30_000);
    return () => { window.removeEventListener('online', retry); document.removeEventListener('visibilitychange', onVisible); clearInterval(t); };
  }, []);

  // Précédent / Suivant du navigateur : onglet et recherche restaurés depuis l'URL
  useEffect(() => {
    const onPop = () => {
      setCurrentTabState(readTab());
      const s = readSearch();
      const last = lastParams.current;
      if (s.query !== last.query || s.location !== last.location || s.contractType !== last.contractType || s.radius !== last.radius) {
        handleFetchLiveJobs(s.query, s.contractType, s.location, s.radius);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Première recherche d'offres : pas sur les outils publics (chaque visite consommerait les quotas des API d'offres)
  const initialSearchDone = useRef(false);
  useEffect(() => {
    if (initialSearchDone.current || isPublicTool(currentTab)) return;
    initialSearchDone.current = true;
    const s = initialSearch.current;
    handleFetchLiveJobs(s.query, s.contractType, s.location, s.radius);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTab]);

  // Titre et description de page (partage, moteurs de recherche) pour les outils publics
  useEffect(() => {
    const meta = PUBLIC_TOOL_META[currentTab as 'ats' | 'match'];
    const title = meta?.title || 'Kareer — Offres, CV sur mesure et suivi de candidatures';
    document.title = title;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) {
      if (!desc.getAttribute('data-default')) desc.setAttribute('data-default', desc.getAttribute('content') || '');
      desc.setAttribute('content', meta?.description || desc.getAttribute('data-default') || '');
    }
  }, [currentTab]);

  useEffect(() => {
    // Affichage immédiat des données locales (session locale / invité) sans attendre le service de comptes
    loadLocalSession();

    let unsubApps: (() => void) | null = null;

    const unsubscribe = cloud.onAuthChange(async (user) => {
      if (unsubApps) {
        unsubApps();
        unsubApps = null;
      }

      if (!user) {
        loadLocalSession();
        return;
      }

      setCurrentUser(user);

      // File d'enregistrement de ce compte (reprend les modifications restées en attente sur cet appareil)
      const box = new Outbox(user.uid, {
        saveApplication: cloud.saveApplication,
        patchApplication: cloud.patchApplicationRemote,
        deleteApplication: cloud.deleteApplication,
        saveProfile: cloud.saveProfileVersioned
      }, typeof localStorage !== 'undefined' ? localStorage : null);
      box.onProfileMerged = (merged) => {
        const p = withProfileDefaults(merged);
        savedProfileRef.current = p;
        setUserProfile(p);
        showToast('Profil synchronisé', 'Votre profil avait été modifié sur un autre appareil : les deux versions ont été réunies.');
      };
      outboxRef.current = box;
      box.subscribe((st) => setSyncState(st));
      box.flush();

      // App est le SEUL à créer le profil en ligne
      try {
        const { profile: stored, version } = await cloud.loadProfileVersioned(user.uid);
        box.profileVersion = version;
        let profile: UserProfile;
        if (stored) {
          profile = withProfileDefaults(stored);
        } else {
          profile = withProfileDefaults({
            userId: user.uid,
            fullName: user.displayName || '',
            title: user.title || '',
            email: user.email || ''
          });
          await cloud.saveProfile(user.uid, profile);
          box.profileVersion = 1;
        }
        savedProfileRef.current = profile;
        setUserProfile(profile);
        // Profil vide : import du CV proposé, sauf sur un outil public (la page doit rester utilisable)
        if ((!profile.fullName || profile.skills.length === 0 || profile.experiences.length === 0) && !isPublicTool(readTab())) {
          setIsMandatoryOnboarding(!stored);
          setCvUploadModalOpen(true);
        }
      } catch (e) {
        console.error('Profile sync error:', e);
        showToast('Profil non chargé', 'Impossible de lire votre profil en ligne. Vérifiez votre connexion.', true);
      }

      unsubApps = cloud.subscribeApplications(user.uid, (apps) => setApplications(overlayPending(apps, outboxRef.current)), (err) => {
        console.error('Applications sync error:', err);
      });
    });

    return () => {
      unsubscribe();
      if (unsubApps) unsubApps();
    };
  }, []);

  const handleLogout = async () => {
    try {
      localStorage.removeItem(LOCAL_USER_KEY);
    } catch {}
    // Dernier envoi des modifications en attente (sinon elles restent sur cet appareil et partiront à la prochaine connexion)
    await outboxRef.current?.flush().catch(() => {});
    outboxRef.current = null;
    setSyncState('saved');
    try {
      if (isCloudUser(currentUserRef.current)) await cloud.signOut();
    } catch (e) {
      console.error('Logout error:', e);
    }
    // Réinitialisation complète : le prochain utilisateur ne voit rien de la session précédente
    setCurrentUser(null);
    setUserProfile(EMPTY_PROFILE);
    setApplications([]);
    setAgentLogs([]);
    setSelectedJobForLatex(null);
    setSelectedAppForLatex(null);
    setSelectedAppForInterview(null);
    showToast('Déconnexion', 'Session fermée.');
  };

  const lastSearchId = useRef(0);
  const lastParams = useRef<SearchUrlState>({ query: '', contractType: 'tous', location: '', radius: 30 });
  const handleFetchLiveJobs = async (query: string, contractType: string, location: string, radius = 30) => {
    const searchId = ++lastSearchId.current;
    lastParams.current = { query, contractType, location, radius };
    setIsLoadingJobs(true);
    try {
      const res = await apiFetch('/api/jobs/search', { query, contractType, location, radius, page: 1 });
      const data = await readApiJson<any>(res);
      if (searchId !== lastSearchId.current) return; // une recherche plus récente a été lancée
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setJobsMeta({
        mode: data.mode === 'live' ? 'live' : 'demo',
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        resolvedLocation: data.resolvedLocation,
        sources: data.sources,
        page: 1,
        hasMore: !!data.hasMore
      });
      markSavedSearchSeen({ query, contractType, location, radius }, Array.isArray(data.jobs) ? data.jobs : []);
      if (query) track('job_search', { results: Array.isArray(data.jobs) ? data.jobs.length : 0, contract: contractType, hasLocation: !!location });
    } catch (e: any) {
      if (searchId === lastSearchId.current) {
        showToast('Recherche indisponible', e?.message || 'La recherche a échoué. Réessayez.', true);
      }
    } finally {
      if (searchId === lastSearchId.current) setIsLoadingJobs(false);
    }
  };

  /** Page suivante des sources (France Travail, Adzuna, Google Jobs, Jooble). Renvoie les offres ajoutées. */
  const handleLoadMore = async (options: { quiet?: boolean } = {}): Promise<JobOffer[]> => {
    const meta = jobsMetaRef.current;
    if (loadingMoreRef.current || !meta.hasMore) return [];
    const searchId = lastSearchId.current;
    const nextPage = (meta.page || 1) + 1;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await apiFetch('/api/jobs/search', { ...lastParams.current, page: nextPage });
      const data = await readApiJson<any>(res);
      if (searchId !== lastSearchId.current) return [];
      const incoming: JobOffer[] = Array.isArray(data.jobs) ? data.jobs : [];
      const known = new Set(jobsRef.current.map(j => j.id));
      const added = incoming.filter(j => !known.has(j.id));
      setJobs(prev => {
        const seen = new Set(prev.map(j => j.id));
        return [...prev, ...incoming.filter(j => !seen.has(j.id))];
      });
      jobsMetaRef.current = { ...jobsMetaRef.current, page: nextPage, hasMore: !!data.hasMore && incoming.length > 0 };
      setJobsMeta(prev => ({
        ...prev,
        page: nextPage,
        hasMore: !!data.hasMore && incoming.length > 0,
        warnings: Array.from(new Set([...(prev.warnings || []), ...(Array.isArray(data.warnings) ? data.warnings : [])]))
      }));
      if (!incoming.length && !options.quiet) showToast('Fin des résultats', 'Les sources n’ont pas d’autres offres pour cette recherche.');
      return added;
    } catch (e: any) {
      if (!options.quiet) showToast('Chargement impossible', e?.message || 'Réessayez dans un instant.', true);
      return [];
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  // -------------------------------------------------------------------------
  // Alertes : recherches enregistrées, relancées pour signaler les nouvelles offres
  // -------------------------------------------------------------------------
  const sameSearch = (a: Pick<SavedSearch, 'query' | 'location' | 'contractType' | 'radius'>, b: SearchUrlState) =>
    a.query.trim().toLowerCase() === b.query.trim().toLowerCase() &&
    a.location.trim().toLowerCase() === b.location.trim().toLowerCase() &&
    (a.contractType || 'tous') === (b.contractType || 'tous') &&
    Number(a.radius) === Number(b.radius);

  const saveSearches = (next: SavedSearch[]) => {
    handleSaveProfile({ ...profileRef.current, savedSearches: next }, { silent: true }).catch(() => {});
  };

  /** Les offres affichées pour une recherche enregistrée sont considérées comme vues. */
  const markSavedSearchSeen = (params: SearchUrlState, list: JobOffer[]) => {
    const saved = profileRef.current.savedSearches || [];
    const target = saved.find(s => sameSearch(s, params));
    if (!target) return;
    const ids = Array.from(new Set([...list.map(j => j.id), ...target.seenIds])).slice(0, 300);
    saveSearches(saved.map(s => (s.id === target.id ? { ...s, seenIds: ids, newCount: 0, lastCheckedAt: new Date().toISOString() } : s)));
  };

  const handleSaveSearch = () => {
    if (needAccount('Créez votre compte pour enregistrer cette recherche et être prévenu(e) des nouvelles offres.')) return;
    const params = lastParams.current;
    const saved = profileRef.current.savedSearches || [];
    if (!params.query.trim() && !params.location.trim()) {
      showToast('Recherche trop large', 'Indiquez un métier ou un lieu avant de créer une alerte.', true);
      return;
    }
    if (saved.some(s => sameSearch(s, params))) {
      showToast('Alerte déjà créée', 'Cette recherche est déjà dans vos alertes.');
      return;
    }
    if (saved.length >= 10) {
      showToast('10 alertes au maximum', 'Supprimez une alerte avant d’en créer une nouvelle.', true);
      return;
    }
    const entry: SavedSearch = {
      id: `alert-${Date.now()}`,
      ...params,
      createdAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      seenIds: jobs.map(j => j.id).slice(0, 300),
      newCount: 0
    };
    saveSearches([entry, ...saved]);
    showToast('Alerte créée', notificationsAllowed()
      ? 'Vous serez prévenu(e) des nouvelles offres à l’ouverture de l’application.'
      : 'Les nouvelles offres seront signalées ici. Activez les notifications pour être prévenu(e).');
  };

  const handleRemoveSearch = (id: string) => saveSearches((profileRef.current.savedSearches || []).filter(s => s.id !== id));

  const handleOpenSearch = (s: SavedSearch) => {
    setCurrentTab('radar');
    writeUrl({ q: s.query, lieu: s.location, rayon: s.radius, contrat: s.contractType, offre: null }, false);
    handleFetchLiveJobs(s.query, s.contractType, s.location, s.radius);
  };

  /** Relance chaque alerte (résultats mis en cache côté serveur) et compte les offres jamais vues. */
  const checkSavedSearches = async (force = false) => {
    const saved = profileRef.current.savedSearches || [];
    if (!saved.length || checkingAlerts) return;
    const due = saved.filter(s => force || !s.lastCheckedAt || Date.now() - new Date(s.lastCheckedAt).getTime() > ALERT_CHECK_INTERVAL_MS);
    if (!due.length) return;
    setCheckingAlerts(true);
    const updates = new Map<string, Partial<SavedSearch>>();
    for (const s of due) {
      try {
        const res = await apiFetch('/api/jobs/search', { query: s.query, contractType: s.contractType, location: s.location, radius: s.radius, page: 1 });
        const data = await readApiJson<any>(res);
        const list: JobOffer[] = Array.isArray(data.jobs) ? data.jobs : [];
        const seen = new Set(s.seenIds);
        updates.set(s.id, { newCount: list.filter(j => !seen.has(j.id) && !j.isSpontaneous).length, lastCheckedAt: new Date().toISOString() });
      } catch {
        /* on réessaiera à la prochaine ouverture */
      }
    }
    setCheckingAlerts(false);
    if (!updates.size) return;
    const latest = profileRef.current.savedSearches || [];
    const next = latest.map(s => (updates.has(s.id) ? { ...s, ...updates.get(s.id) } : s));
    saveSearches(next);
    const fresh = next.filter(s => (s.newCount || 0) > 0);
    const total = fresh.reduce((n, s) => n + (s.newCount || 0), 0);
    if (total > 0) {
      notify('Nouvelles offres', `${total} nouvelle(s) offre(s) pour ${fresh.map(s => s.query || s.location).join(', ')}.`);
    } else if (force) {
      showToast('Alertes à jour', 'Aucune nouvelle offre pour vos recherches enregistrées.');
    }
  };

  const handleEnableNotifications = async () => {
    if (typeof Notification === 'undefined') {
      showToast('Notifications indisponibles', 'Votre navigateur ne permet pas les notifications.', true);
      return;
    }
    const perm = await Notification.requestPermission();
    setNotificationsOn(perm === 'granted');
    if (perm === 'granted') notify('Notifications activées', 'Vous serez prévenu(e) des nouvelles offres et des relances à faire.');
    else showToast('Notifications refusées', 'Vous pouvez les autoriser dans les réglages du navigateur.', true);
  };

  // Vérification automatique des alertes une fois le profil chargé
  const alertsCheckedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = userProfile.userId || 'guest';
    if (alertsCheckedFor.current === key || !(userProfile.savedSearches || []).length) return;
    alertsCheckedFor.current = key;
    const t = setTimeout(() => checkSavedSearches(false), 2500);
    return () => clearTimeout(t);
  }, [userProfile.userId, userProfile.savedSearches?.length]);

  // -------------------------------------------------------------------------
  // Persistance
  // -------------------------------------------------------------------------
  const storageUid = (u: User | null) => u?.uid || 'guest';

  /** Enregistre le profil. Lève une erreur si la sauvegarde en ligne échoue (l'appelant peut l'afficher). */
  const handleSaveProfile = async (updated: UserProfile, options: { silent?: boolean } = {}) => {
    const user = currentUserRef.current;
    const toSave = withProfileDefaults({ ...updated, userId: user?.uid || updated.userId || '' });
    setIsSavingProfile(true);
    setUserProfile(toSave);
    try {
      const box = outboxRef.current;
      if (isCloudUser(user) && box) {
        const changed = changedKeys(savedProfileRef.current, toSave);
        savedProfileRef.current = toSave;
        await box.enqueue({ kind: 'saveProfile', profile: toSave, baseVersion: null, changed });
        if (!options.silent) {
          if (box.state === 'saved') showToast('Profil enregistré', 'Votre profil est à jour.');
          else showToast('Profil enregistré sur cet appareil', 'Il sera envoyé en ligne automatiquement dès que la connexion reviendra.');
        }
        return;
      } else if (!accountsRequired) {
        writeJson(profileKey(storageUid(user)), toSave);
      }
      if (!options.silent) {
        showToast('Profil enregistré', 'Votre profil est à jour.');
      }
    } catch (e: any) {
      console.error('Save profile error:', e);
      showToast('Échec de l\'enregistrement', 'Le profil n\'a pas pu être sauvegardé en ligne. Réessayez.', true);
      throw e;
    } finally {
      setIsSavingProfile(false);
    }
  };

  const saveApplicationsLocally = (user: User | null, apps: Application[]) => {
    if (!accountsRequired && !isCloudUser(user)) writeJson(appsKey(storageUid(user)), apps);
  };

  const persistApplication = async (app: Application) => {
    const user = currentUserRef.current;
    setApplications(prev => {
      const updated = [app, ...prev.filter(a => a.id !== app.id)];
      saveApplicationsLocally(user, updated);
      return updated;
    });
    if (isCloudUser(user)) await outboxRef.current?.enqueue({ kind: 'saveApp', id: app.id, app });
  };

  const patchApplication = async (appId: string, patch: Partial<Application>) => {
    const user = currentUserRef.current;
    const current = applicationsRef.current.find(a => a.id === appId);
    setApplications(prev => {
      const updated = prev.map(a => (a.id === appId ? { ...a, ...patch } : a));
      saveApplicationsLocally(user, updated);
      return updated;
    });
    // Seuls les champs modifiés partent : ce qu'un autre appareil ou la candidature automatique a écrit est préservé
    if (isCloudUser(user) && current) await outboxRef.current?.enqueue({ kind: 'patchApp', id: appId, patch });
  };

  const handleUpdateAppStatus = async (appId: string, newStatus: ApplicationStatus) => {
    const app = applications.find(a => a.id === appId);
    track('application_status', { status: newStatus });
    const patch: Partial<Application> = {
      status: newStatus,
      logEvents: [...(app?.logEvents || []), { timestamp: new Date().toLocaleString('fr-FR'), message: `Statut : ${STATUS_LABELS[newStatus]}` }]
    };
    if (newStatus === 'applied') {
      if (!app?.appliedAt) patch.appliedAt = new Date().toISOString();
      // Relance programmée automatiquement si l'entreprise ne répond pas
      if (!app?.followUpAt) patch.followUpAt = inDays(FOLLOW_UP_DAYS);
    }
    if (newStatus === 'interview' || newStatus === 'offer' || newStatus === 'rejected') {
      // Plus de relance à faire une fois la réponse obtenue
      patch.followUpAt = '';
      if (!app?.respondedAt) patch.respondedAt = new Date().toISOString();
      if (!app?.appliedAt) patch.appliedAt = app?.createdAt || new Date().toISOString();
    }
    await patchApplication(appId, patch);
    showToast('Statut mis à jour', `Candidature déplacée dans « ${STATUS_LABELS[newStatus]} ».`);
  };

  // -------------------------------------------------------------------------
  // Préparation d'un dossier (CV + lettre) et ouverture du portail
  // -------------------------------------------------------------------------
  const preferredTemplate = (): CvTemplate =>
    normalizeCvTemplate(userProfile.preferredTemplate);

  const generateDossier = async (job: JobOffer) => {
    // CV et lettre générés en parallèle (avant : l'un après l'autre)
    const [resLatex, resLetter] = await Promise.all([
      apiFetch('/api/tailor/latex', { candidate: userProfile, job, template: preferredTemplate() }),
      apiFetch('/api/tailor/letter', { candidate: userProfile, job })
    ]);
    const dataLatex = await resLatex.json().catch(() => null);
    const dataLetter = await resLetter.json().catch(() => null);
    // Limite de débit du serveur : l'erreur indique quand réessayer (utilisé par la série de l'assistant)
    // Quota du forfait atteint : inutile de poursuivre une série
    const overQuota = [[resLatex, dataLatex], [resLetter, dataLetter]].find(([r]) => (r as Response).status === 402);
    if (overQuota) {
      const d: any = overQuota[1];
      throw Object.assign(new Error(d?.message || 'Quota mensuel atteint.'), { quotaExceeded: true });
    }
    const limited = [resLatex, resLetter].find(r => r.status === 429);
    if (limited) {
      const retryAfter = Math.min(120, Math.max(1, Number(limited.headers.get('Retry-After')) || 60));
      throw Object.assign(new Error(`Trop de requêtes : nouvel essai possible dans ${retryAfter} s.`), { retryAfter });
    }
    if (!resLatex.ok || !dataLatex?.latexCode) {
      throw new Error(dataLatex?.message || dataLatex?.error || `Génération du CV impossible (${resLatex.status}).`);
    }
    if (!resLetter.ok || !dataLetter?.letter) {
      throw new Error(dataLetter?.error || `Génération de la lettre impossible (${resLetter.status}).`);
    }
    return { dataLatex, dataLetter };
  };

  const buildApplication = (job: JobOffer, latexCode: string, coverLetter: string, source: string, template: CvTemplate = preferredTemplate()): Application => {
    const match = calculateCandidateMatch(userProfile.skills, job.skillsRequired);
    return {
      id: `app-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: currentUser?.uid || 'guest',
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      location: job.location,
      contractType: job.contractType,
      jobUrl: getApplyUrl(job),
      jobDescription: job.description || '',
      skillsRequired: job.skillsRequired || [],
      matchScore: match.score,
      jobSource: job.origin === 'demo' ? 'Démo' : sourceShortName(job.source),
      isSpontaneous: !!job.isSpontaneous,
      matchedKeywords: match.matchedKeywords,
      missingKeywords: match.missingKeywords,
      status: 'prepared',
      createdAt: new Date().toISOString(),
      latexResumeCode: latexCode,
      coverLetter,
      ...(latexCode ? { dossierUpdatedAt: new Date().toISOString() } : {}),
      overleafSnippetUrl: 'https://www.overleaf.com/docs',
      template,
      logEvents: [{ timestamp: new Date().toLocaleString('fr-FR'), message: source }]
    };
  };

  /** Dossier déjà créé pour cette offre (même id, ou même entreprise + même intitulé). */
  const findExistingApplication = (job: JobOffer, list: Application[] = applications): Application | undefined => {
    const norm = (v: string) => (v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return list.find(a => a.jobId === job.id
      || (norm(a.company) === norm(job.company) && norm(a.jobTitle) === norm(job.title)));
  };

  /**
   * Génère le CV et la lettre d'une offre et enregistre le dossier (complète une offre sauvegardée au lieu d'en créer un second).
   * Lève une erreur si la génération échoue.
   */
  const prepareDossier = async (job: JobOffer, existing: Application | undefined, origin: string) => {
    addLog({ type: 'latex', message: `Génération du CV et de la lettre pour ${job.title} — ${job.company}…` });
    const { dataLatex, dataLetter } = await generateDossier(job);
    const app: Application = {
      ...buildApplication(job, dataLatex.latexCode, dataLetter.letter, origin),
      ...(dataLatex.tailored ? { tailoredContent: dataLatex.tailored } : {}),
      ...(dataLatex.analysis ? { offerAnalysis: dataLatex.analysis } : {})
    };
    if (existing) {
      await patchApplication(existing.id, {
        status: 'prepared',
        dossierUpdatedAt: new Date().toISOString(),
        latexResumeCode: app.latexResumeCode,
        coverLetter: app.coverLetter,
        template: app.template,
        ...(app.tailoredContent ? { tailoredContent: app.tailoredContent } : {}),
        ...(app.offerAnalysis ? { offerAnalysis: app.offerAnalysis } : {}),
        logEvents: [...(existing.logEvents || []), ...app.logEvents]
      });
    } else {
      await persistApplication(app);
    }
    const notices = [dataLatex.notice, dataLetter.notice].filter(Boolean).join(' ');
    addLog({ type: 'success', message: `Dossier prêt : ${job.title} — ${job.company}.`, company: job.company, score: app.matchScore ?? undefined });
    return { letter: dataLetter.letter as string, notices, appId: existing?.id || app.id };
  };

  /** Doit être appelé directement dans un gestionnaire de clic (ouverture du portail non bloquée). */
  const handleInstantAutoApply = async (job: JobOffer) => {
    if (!job || agentBusyRef.current) return;
    if (needAccount('Créez votre compte pour préparer votre CV et votre lettre pour cette offre.')) return;
    track('express_apply', { spontaneous: !!job.isSpontaneous });

    // Contrôles synchrones AVANT toute attente
    const existing = findExistingApplication(job);
    const savedOnly = !!existing && existing.status === 'detected' && !existing.latexResumeCode;
    if (existing && !savedOnly) {
      showToast('Dossier déjà préparé', `Un dossier existe déjà pour ${job.company}. Retrouvez-le dans Candidatures.`);
      setCurrentTab('kanban');
      return;
    }
    if (userProfile.experiences.length === 0) {
      showToast('Profil incomplet', 'Importez votre CV ou ajoutez au moins une expérience avant de préparer un dossier.', true);
      setCurrentTab('profile');
      return;
    }

    // Ouverture immédiate du portail, pendant le clic (sinon le navigateur bloque la fenêtre)
    const portal = window.open(getApplyUrl(job), '_blank');
    if (portal) portal.opener = null;

    setAgentBusy(true);
    try {
      const { letter, notices } = await prepareDossier(job, savedOnly ? existing : undefined, 'Dossier préparé (CV + lettre). Portail de l\'entreprise ouvert.');

      // Peut échouer (portail ouvert au premier plan, clic trop ancien) : la lettre reste disponible dans Candidatures
      const copied = await copyToClipboard(letter);

      showToast(
        'Dossier prêt',
        `${portal ? 'Le portail est ouvert. ' : 'Votre navigateur a bloqué l\'ouverture du portail : utilisez « Postuler en ligne ». '}${copied ? 'La lettre est copiée. ' : 'La lettre est disponible dans Candidatures. '}${notices}`
      );
    } catch (e: any) {
      console.error('Dossier preparation error:', e);
      addLog({ type: 'alert', message: `Échec pour ${job.company} : ${e?.message || 'erreur inconnue'}` });
      showToast('Dossier non préparé', e?.message || 'Une erreur est survenue lors de la préparation du dossier.', true);
    } finally {
      setAgentBusy(false);
    }
  };

  /**
   * Offres que l'assistant peut traiter, de la plus compatible à la moins compatible,
   * avec le détail des offres écartées (affiché dans le journal).
   */
  const selectAgentCandidates = (list: JobOffer[], exclude: Set<string> = new Set()) => {
    const profile = profileRef.current;
    const threshold = profile.minMatchScore ?? 60;
    const contracts = profile.preferredContracts || [];
    const skipped = { treated: 0, contract: 0, unscored: 0, below: 0 };
    const picked: { job: JobOffer; score: number; existing?: Application }[] = [];
    for (const job of list) {
      if (exclude.has(job.id)) continue;
      const existing = findExistingApplication(job, applicationsRef.current);
      // Une offre simplement sauvegardée reste éligible : son dossier sera complété
      if (existing && !(existing.status === 'detected' && !existing.latexResumeCode)) { skipped.treated++; continue; }
      if (contracts.length && !contracts.includes(job.contractType)) { skipped.contract++; continue; }
      const score = calculateCandidateMatch(profile.skills, job.skillsRequired).score;
      if (score === null) { skipped.unscored++; continue; }
      if (score < threshold) { skipped.below++; continue; }
      picked.push({ job, score, existing });
    }
    picked.sort((a, b) => b.score - a.score);
    return { picked, skipped, threshold, contracts };
  };

  const describeSkipped = (sk: { treated: number; contract: number; unscored: number; below: number }, threshold: number) => {
    const parts = [
      sk.treated && `${sk.treated} déjà dans vos candidatures`,
      sk.contract && `${sk.contract} hors des contrats choisis`,
      sk.below && `${sk.below} sous ${threshold} %`,
      sk.unscored && `${sk.unscored} sans compétences détectées (dont candidatures spontanées)`
    ].filter(Boolean);
    return parts.length ? `Écartées : ${parts.join(', ')}.` : '';
  };

  /**
   * Trouve les prochaines offres à traiter : offres affichées, puis pages suivantes des sources si besoin.
   * `wanted` : nombre d'offres souhaitées.
   */
  const findAgentTargets = async (wanted: number, exclude: Set<string> = new Set()) => {
    let pool = jobsRef.current;
    let sel = selectAgentCandidates(pool, exclude);
    addLog({ type: 'scan', message: `Analyse de ${pool.length} offres (seuil ${sel.threshold} %, contrats : ${sel.contracts.length ? sel.contracts.map(c => CONTRACT_LABELS[c] || c).join(', ') : 'tous'}). ${describeSkipped(sel.skipped, sel.threshold)}` });
    // Pas assez d'offres retenues : jusqu'à 3 pages supplémentaires des sources
    for (let i = 0; i < 3 && sel.picked.length < wanted && jobsMetaRef.current.hasMore && !agentStopRef.current; i++) {
      addLog({ type: 'scan', message: 'Recherche d’offres supplémentaires auprès des sources…' });
      const added = await handleLoadMore({ quiet: true });
      if (!added.length) break;
      pool = [...pool, ...added];
      sel = selectAgentCandidates(pool, exclude);
      addLog({ type: 'scan', message: `${added.length} nouvelle(s) offre(s) chargée(s).` });
    }
    return sel.picked.slice(0, wanted);
  };

  /** Cycle de l'assistant : meilleure offre non traitée, dossier préparé et portail ouvert. */
  const handleTriggerAgentCycle = async () => {
    if (agentBusyRef.current) return;
    if (needAccount('Créez votre compte pour utiliser l’assistant de candidature.')) return;
    if (userProfile.skills.length === 0) {
      showToast('Profil incomplet', 'Importez votre CV pour que l\'assistant puisse évaluer les offres.', true);
      return;
    }
    agentStopRef.current = false;
    // Offres déjà chargées : le portail s'ouvre pendant le clic (sinon le navigateur le bloque)
    const sel = selectAgentCandidates(jobsRef.current);
    const immediate = sel.picked[0];
    if (immediate) {
      addLog({ type: 'scan', message: `Analyse de ${jobsRef.current.length} offres (seuil ${sel.threshold} %). ${describeSkipped(sel.skipped, sel.threshold)}` });
      addLog({ type: 'match', message: `Offre retenue : ${immediate.job.title} — ${immediate.job.company}.`, score: immediate.score });
      await handleInstantAutoApply(immediate.job);
      return;
    }
    setAgentBusy(true);
    let target: { job: JobOffer; score: number; existing?: Application } | undefined;
    try {
      target = (await findAgentTargets(1))[0];
    } finally {
      setAgentBusy(false);
    }
    if (!target) {
      const threshold = profileRef.current.minMatchScore ?? 60;
      addLog({ type: 'match', message: 'Aucune nouvelle offre ne respecte vos critères. Lancez une autre recherche ou baissez le seuil.' });
      showToast('Aucune offre retenue', `Aucune nouvelle offre n'atteint ${threshold} % de compatibilité avec vos critères.`);
      return;
    }
    // Offre trouvée sur une page suivante : le dossier est préparé, le portail s'ouvrira depuis la file d'envoi
    addLog({ type: 'match', message: `Offre retenue : ${target.job.title} — ${target.job.company}.`, score: target.score });
    setAgentBusy(true);
    try {
      await prepareDossier(target.job, target.existing, 'Dossier préparé par l\'assistant.');
      showToast('Dossier prêt', 'Retrouvez-le dans « Dossiers prêts à envoyer » pour ouvrir le portail.');
    } catch (e: any) {
      addLog({ type: 'alert', message: `Échec pour ${target.job.company} : ${e?.message || 'erreur inconnue'}` });
      showToast('Dossier non préparé', e?.message || 'Une erreur est survenue.', true);
    } finally {
      setAgentBusy(false);
    }
  };

  /**
   * Série : prépare jusqu'à `count` dossiers d'affilée (CV + lettre), sans ouvrir de portail.
   * Les dossiers rejoignent la file « prêts à envoyer ». Rien n'est envoyé à la place de l'utilisateur.
   */
  const handleAgentBatch = async (count: number) => {
    if (agentBusyRef.current) return;
    if (needAccount('Créez votre compte pour utiliser l’assistant de candidature.')) return;
    track('agent_batch', { count });
    if (userProfile.skills.length === 0 || userProfile.experiences.length === 0) {
      showToast('Profil incomplet', 'Importez votre CV (compétences et expériences) avant de lancer l\'assistant.', true);
      return;
    }
    agentStopRef.current = false;
    setAgentBusy(true);
    setAgentProgress({ done: 0, total: count });
    let done = 0;
    let failed = 0;
    let quotaReached = false;
    const tried = new Set<string>();
    try {
      addLog({ type: 'scan', message: `Série lancée : jusqu'à ${count} dossier(s).` });
      const targets = await findAgentTargets(count, tried);
      if (!targets.length) {
        addLog({ type: 'match', message: 'Aucune nouvelle offre ne respecte vos critères. Lancez une autre recherche ou baissez le seuil.' });
        showToast('Aucune offre retenue', 'Aucune nouvelle offre ne respecte vos critères.');
        return;
      }
      setAgentProgress({ done: 0, total: targets.length });
      for (const t of targets) {
        if (agentStopRef.current) {
          addLog({ type: 'alert', message: 'Série interrompue à votre demande.' });
          break;
        }
        tried.add(t.job.id);
        addLog({ type: 'match', message: `Offre retenue : ${t.job.title} — ${t.job.company}.`, score: t.score });
        let ok = false;
        let waited = false;
        while (!ok && !agentStopRef.current) {
          try {
            await prepareDossier(t.job, t.existing, 'Dossier préparé par l\'assistant (série).');
            ok = true;
          } catch (e: any) {
            // Limite de débit : pause puis nouvel essai (une seule fois par offre)
            if (typeof e?.retryAfter === 'number' && !waited) {
              waited = true;
              addLog({ type: 'scan', message: `Limite de requêtes atteinte : reprise automatique dans ${e.retryAfter} s.` });
              for (let s = 0; s < e.retryAfter && !agentStopRef.current; s++) await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            addLog({ type: 'alert', message: `Échec pour ${t.job.company} : ${e?.message || 'erreur inconnue'}` });
            if (e?.quotaExceeded) quotaReached = true;
            break;
          }
        }
        if (quotaReached) {
          addLog({ type: 'alert', message: 'Série arrêtée : quota mensuel de votre forfait atteint.' });
          break;
        }
        if (ok) done++;
        else if (!agentStopRef.current) failed++;
        // Deux échecs d'affilée hors limite de débit (service IA indisponible…) : inutile d'insister
        if (!ok && failed >= 2 && done === 0) {
          addLog({ type: 'alert', message: 'Série arrêtée : la génération échoue. Réessayez plus tard.' });
          break;
        }
        setAgentProgress({ done: done + failed, total: targets.length });
      }
      showToast(
        done ? `${done} dossier(s) prêt(s)` : 'Aucun dossier préparé',
        done
          ? `Ouvrez chaque portail depuis « Dossiers prêts à envoyer ».${failed ? ` ${failed} échec(s) : voir le journal.` : ''}`
          : 'Consultez le journal de l’assistant.',
        !done
      );
    } finally {
      setAgentBusy(false);
      setAgentProgress(null);
    }
  };

  const handleStopAgent = () => {
    agentStopRef.current = true;
    addLog({ type: 'alert', message: 'Arrêt demandé : la série s’arrête après le dossier en cours.' });
  };

  /**
   * File d'envoi : ouvre le portail (pendant le clic), copie la lettre et télécharge le CV en PDF si possible.
   * La candidature est marquée « envoyée » par l'utilisateur, une fois qu'il a réellement postulé.
   */
  const handleOpenQueuedApplication = async (app: Application) => {
    const portal = app.jobUrl ? window.open(app.jobUrl, '_blank') : null;
    if (portal) portal.opener = null;
    // Copie dans la même tâche que l'ouverture : la page a encore le focus
    const copiedNow = !!app.coverLetter && copyToClipboardSync(app.coverLetter);
    const [copiedLater, pdf] = await Promise.all([
      !copiedNow && app.coverLetter ? copyToClipboard(app.coverLetter) : Promise.resolve(false),
      downloadApplicationPdf(app).catch(() => false)
    ]);
    const copied = copiedNow || copiedLater;
    await patchApplication(app.id, {
      logEvents: [...(app.logEvents || []), { timestamp: new Date().toLocaleString('fr-FR'), message: 'Portail de candidature ouvert (lettre copiée, CV PDF).' }]
    });
    showToast(
      portal ? 'Portail ouvert' : (app.jobUrl ? 'Portail bloqué' : 'Pas de lien de candidature'),
      [
        !portal && app.jobUrl ? 'Autorisez l’ouverture des fenêtres pour ce site, puis réessayez.' : '',
        copied ? 'La lettre est copiée.' : '',
        pdf ? 'Le CV (PDF) est téléchargé.' : 'CV PDF indisponible ici : ouvrez le dossier pour l’exporter.',
        'Cliquez sur « J’ai postulé » une fois la candidature envoyée.'
      ].filter(Boolean).join(' '),
      !portal && !!app.jobUrl
    );
  };

  /** Télécharge le CV du dossier en PDF (rendu Web Chromium ou LaTeX côté serveur). Renvoie false si impossible. */
  const downloadApplicationPdf = async (app: Application): Promise<boolean> => {
    if (!app.latexResumeCode && !app.tailoredContent) return false;
    const job = { title: app.jobTitle, company: app.company, skillsRequired: app.skillsRequired || [] };
    const payload = { candidate: profileRef.current, job, template: app.template || preferredTemplate(), tailored: app.tailoredContent };
    // Rendu Web (Chromium), sinon compilation LaTeX du code enregistré
    let res = await apiFetch('/api/cv/pdf', payload);
    if (!res.ok && app.latexResumeCode) res = await apiFetch('/api/latex/compile', { latexCode: app.latexResumeCode });
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CV_${(profileRef.current.fullName || 'Candidat').replace(/\s+/g, '_')}_${(app.company || 'Poste').replace(/[^\p{L}\p{N}]+/gu, '_')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  };

  const handleDeleteApplication = async (appId: string) => {
    const user = currentUserRef.current;
    setApplications(prev => {
      const updated = prev.filter(a => a.id !== appId);
      saveApplicationsLocally(user, updated);
      return updated;
    });
    if (isCloudUser(user)) await outboxRef.current?.enqueue({ kind: 'deleteApp', id: appId });
  };

  /** Sauvegarder / retirer une offre (colonne « Sauvegardées » du suivi). */
  const handleToggleSaveJob = async (job: JobOffer) => {
    if (needAccount('Créez votre compte pour sauvegarder des offres et suivre vos candidatures.')) return;
    const existing = findExistingApplication(job);
    if (existing) {
      if (existing.status === 'detected' && !existing.latexResumeCode) {
        await handleDeleteApplication(existing.id);
        showToast('Offre retirée', `${job.title} n'est plus dans vos offres sauvegardées.`);
      } else {
        showToast('Déjà dans vos candidatures', 'Retrouvez ce dossier dans l’onglet Candidatures.');
      }
      return;
    }
    const app = buildApplication(job, '', '', 'Offre sauvegardée.');
    await persistApplication({ ...app, status: 'detected' });
    track('job_saved', { spontaneous: !!job.isSpontaneous });
    showToast('Offre sauvegardée', 'Retrouvez-la dans l’onglet Candidatures.');
  };

  /** Relance envoyée : prochaine relance dans 7 jours (au plus 3 relances). */
  const handleMarkFollowedUp = async (app: Application) => {
    const count = (app.followUpCount || 0) + 1;
    await patchApplication(app.id, {
      followUpCount: count,
      followUpAt: count >= 3 ? '' : inDays(FOLLOW_UP_DAYS),
      logEvents: [...(app.logEvents || []), { timestamp: new Date().toLocaleString('fr-FR'), message: `Relance n°${count} envoyée.` }]
    });
    showToast('Relance enregistrée', count >= 3 ? 'Trois relances envoyées : plus de rappel pour ce dossier.' : `Prochain rappel dans ${FOLLOW_UP_DAYS} jours si pas de réponse.`);
  };

  const isFollowUpDue = (a: Application) => a.status === 'applied' && !!a.followUpAt && new Date(a.followUpAt).getTime() <= Date.now();
  const followUpDueCount = applications.filter(isFollowUpDue).length;

  // Rappel des relances : une notification par jour au plus
  useEffect(() => {
    if (!followUpDueCount || !notificationsOn) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (localStorage.getItem(NOTIFIED_KEY) === today) return;
      localStorage.setItem(NOTIFIED_KEY, today);
    } catch { /* ignore */ }
    notify('Relances à faire', `${followUpDueCount} candidature(s) sans réponse attendent une relance.`);
  }, [followUpDueCount, notificationsOn]);

  /** Restaure une sauvegarde JSON : les dossiers de même identifiant sont remplacés. */
  const handleImportApplications = async (imported: Application[]) => {
    if (!imported.length) {
      showToast('Rien à importer', 'Le fichier ne contient aucune candidature.', true);
      return;
    }
    const user = currentUserRef.current;
    const owned = imported.map(a => ({ ...a, userId: user?.uid || 'guest' }));
    setApplications(prev => {
      const ids = new Set(owned.map(a => a.id));
      const merged = [...owned, ...prev.filter(a => !ids.has(a.id))]
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      saveApplicationsLocally(user, merged);
      return merged;
    });
    if (isCloudUser(user)) {
      for (const a of owned) await outboxRef.current?.enqueue({ kind: 'saveApp', id: a.id, app: a });
    }
    showToast('Sauvegarde importée', `${owned.length} candidature(s) restaurée(s).`);
  };

  const handleSaveInterviewPrep = (appId: string, kit: InterviewPrepKit) => {
    patchApplication(appId, { interviewPrep: kit });
  };

  const submittedCount = applications.filter(a => ['applied', 'interview', 'offer'].includes(a.status)).length;
  const interviewCount = applications.filter(a => a.status === 'interview').length;
  const preparedCount = applications.length;

  // Onglet Studio : 60 offres max (les plus compatibles) au lieu d'afficher 808 cartes
  const studioJobs = useMemo(() => {
    if (userProfile.skills.length === 0) return jobs.slice(0, 60);
    return jobs
      .map(j => ({ j, s: assessFit(userProfile, j).rank }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map(x => x.j);
  }, [jobs, userProfile]);

  const openLatexForApplication = (app: Application) => {
    const matchedJob = jobs.find(j => j.id === app.jobId) || {
      id: app.jobId,
      title: app.jobTitle,
      company: app.company,
      location: app.location,
      contractType: app.contractType,
      remote: 'hybride' as const,
      description: app.jobDescription || '',
      skillsRequired: app.skillsRequired || app.matchedKeywords || [],
      source: 'Candidature enregistrée',
      applyUrl: app.jobUrl,
      publishedAt: ''
    };
    setSelectedAppForLatex(app);
    setSelectedJobForLatex(matchedJob);
  };

  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col font-sans antialiased">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[80] focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white">
        Aller au contenu
      </a>

      {/* Global Header */}
      <Header
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        currentUser={currentUser}
        onOpenAuthModal={(mode) => openAuth(mode)}
        onLogout={handleLogout}
        onOpenCvUpload={gated ? undefined : openCvUpload}
        visibleTabs={gated ? ['radar', 'latex'] : undefined}
        autoApplyActive={!!currentUser}
        appliedCount={submittedCount}
        interviewCount={interviewCount}
        followUpDueCount={followUpDueCount}
        applicationsCount={applications.length}
        alertsNewCount={(userProfile.savedSearches || []).reduce((n, s) => n + (s.newCount || 0), 0)}
        plan={accountUsage?.plan ?? null}
      />

      {/* Main Content Area */}
      <main id="contenu" tabIndex={-1} className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-28 lg:pb-12 outline-none">
        
        {showGate && <AccountGate tab={currentTab} onOpenAuthModal={(mode) => openAuth(mode)} />}

        {/* SUB-VIEW 1: LIVE RADAR (CHASSEUR D'OFFRES TEMPS RÉEL) */}
        {currentTab === 'radar' && (
          <JobSearchView
            signedIn={signedIn}
            onOpenAuthModal={(mode) => openAuth(mode)}
            jobs={jobs}
            jobsMeta={jobsMeta}
            initialSearch={lastParams.current}
            onLoadMore={() => { handleLoadMore(); }}
            loadingMore={loadingMore}
            savedSearches={userProfile.savedSearches || []}
            onSaveSearch={handleSaveSearch}
            onOpenSavedSearch={handleOpenSearch}
            onRemoveSavedSearch={handleRemoveSearch}
            onCheckAlerts={() => checkSavedSearches(true)}
            checkingAlerts={checkingAlerts}
            notificationsOn={notificationsOn}
            onEnableNotifications={handleEnableNotifications}
            userProfile={userProfile}
            applications={applications}
            isLoading={isLoadingJobs}
            onSearch={handleFetchLiveJobs}
            onToggleSave={handleToggleSaveJob}
            onPrepare={(job) => {
              if (needAccount('Créez votre compte pour adapter votre CV et votre lettre à cette offre.')) return;
              setSelectedAppForLatex(findExistingApplication(job) || null);
              setSelectedJobForLatex(job);
            }}
            onExpressApply={handleInstantAutoApply}
            busy={isAgentRunning}
            onOpenCvUpload={openCvUpload}
          />
        )}

        {/* SUB-VIEW 2: AGENT AUTOMATION (LE PILOTE AUTOMATIQUE) */}
        {!showGate && currentTab === 'agent' && (
          <AgentAutomationView
            userProfile={userProfile}
            onSaveSettings={(patch) => { handleSaveProfile({ ...userProfile, ...patch }, { silent: true }).catch(() => {}); }}
            onTriggerAgentCycle={handleTriggerAgentCycle}
            onTriggerBatch={handleAgentBatch}
            onStop={handleStopAgent}
            progress={agentProgress}
            isAgentRunning={isAgentRunning}
            agentLogs={agentLogs}
            onGoToInterviews={() => setCurrentTab('interview')}
            onGoToOffers={() => setCurrentTab('radar')}
            preparedCount={preparedCount}
            jobsCount={jobs.length}
            searchLabel={[lastParams.current.query, jobsMeta.resolvedLocation || lastParams.current.location].filter(Boolean).join(' · ')}
            queue={applications.filter(a => a.status === 'prepared' && !!(a.latexResumeCode || a.tailoredContent))}
            onOpenQueued={handleOpenQueuedApplication}
            onMarkApplied={(app) => handleUpdateAppStatus(app.id, 'applied')}
            onOpenDossier={openLatexForApplication}
            autoApplyPanel={(
              <AutoApplyPanel
                defaultRoles={[userProfile.title, ...(userProfile.targetRoles || [])].filter(Boolean).slice(0, 3) as string[]}
                defaultLocation={lastParams.current.location || undefined}
                onNotify={showToast}
              />
            )}
          />
        )}

        {/* SUB-VIEW 3: STUDIO LATEX & OVERLEAF (DIRECT VIEW) */}
        {!showGate && currentTab === 'latex' && (
          <div>
            <PageHeader
              title="Studio CV"
              subtitle="Adaptez votre CV et votre lettre à une offre : collez une annonce trouvée ailleurs, ou choisissez parmi vos résultats de recherche."
            />
            <div className="mb-6">
              <OfferMatchView
                userProfile={userProfile}
                signedIn={signedIn}
                onOpenCvUpload={openCvUpload}
                onOpenStudio={(job, tailored, analysis) => {
                  setPastedDossier({ jobId: job.id, tailored, analysis });
                  setSelectedAppForLatex(findExistingApplication(job) || null);
                  setSelectedJobForLatex(job);
                }}
              />
            </div>
            {studioJobs.length > 0 && (
              <h2 className="mb-3 text-base font-bold text-slate-900">
                {studioJobs.length < jobs.length ? `Les ${studioJobs.length} offres de votre recherche qui vous correspondent le mieux` : 'Offres de votre recherche'}
              </h2>
            )}
            {studioJobs.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white">
                <EmptyState icon={<FileCode2 className="h-6 w-6" />} title="Aucune offre de recherche" action={<Button variant="primary" onClick={() => setCurrentTab('radar')}>Rechercher des offres</Button>}>
                  Collez une offre ci-dessus, ou lancez une recherche dans l’onglet Offres.
                </EmptyState>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {studioJobs.map((job) => {
                  const m = assessFit(userProfile, job);
                  const existing = findExistingApplication(job);
                  return (
                    <div key={job.id} className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 hover:border-slate-300 hover:shadow-sm transition-all">
                      <div className="flex gap-3">
                        <CompanyAvatar name={job.company} logo={job.companyLogo} size={44} />
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[15px] font-semibold leading-snug text-slate-900 line-clamp-2">{job.title}</h3>
                          <p className="truncate text-sm text-slate-600">{job.company}</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <Badge tone="brand">{CONTRACT_LABELS[job.contractType] || job.contractType}</Badge>
                            {existing?.latexResumeCode && <Badge tone="green">CV déjà généré</Badge>}
                            {signedIn && <FitBadge level={m.level} />}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant={existing?.latexResumeCode ? 'secondary' : 'primary'}
                        size="md"
                        onClick={() => { setSelectedAppForLatex(existing || null); setSelectedJobForLatex(job); }}
                      >
                        <FileCode2 className="h-4 w-4" /> {existing?.latexResumeCode ? 'Ouvrir le CV enregistré' : 'Générer le CV + la lettre'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* SUB-VIEW 4: KANBAN CRM */}
        {!showGate && currentTab === 'kanban' && (
          <KanbanCrmView
            applications={applications}
            onOpenLatexForApp={openLatexForApplication}
            onOpenInterviewPrep={(app) => setSelectedAppForInterview(app)}
            onUpdateAppStatus={handleUpdateAppStatus}
            onApply={handleOpenQueuedApplication}
            onFollowUp={(app) => setFollowUpApp(app)}
            onDelete={async (id) => { await handleDeleteApplication(id); showToast('Candidature supprimée', 'Le dossier a été retiré de votre suivi.'); }}
            onGoToOffers={() => setCurrentTab('radar')}
            onImport={handleImportApplications}
            onError={(m) => showToast('Import impossible', m, true)}
          />
        )}

        {/* SUB-VIEW 5: COCKPIT ENTRETIENS */}
        {!showGate && currentTab === 'interview' && (() => {
          const interviewApps = applications
            .filter(a => a.status !== 'rejected' && a.status !== 'detected')
            .sort((a, b) => (a.status === 'interview' ? -1 : 0) - (b.status === 'interview' ? -1 : 0));
          return (
            <div>
              <PageHeader
                title="Préparation aux entretiens"
                subtitle="Pour chaque dossier : questions probables, pitch de 90 secondes et évaluation de vos réponses avec la méthode STAR."
              />
              {interviewApps.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white">
                  <EmptyState icon={<Award className="h-6 w-6" />} title="Aucun dossier à préparer" action={<Button variant="primary" onClick={() => setCurrentTab('radar')}>Parcourir les offres</Button>}>
                    Préparez d’abord un dossier (CV + lettre) pour une offre : vous pourrez ensuite vous entraîner ici.
                  </EmptyState>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {interviewApps.map((app) => (
                    <div key={app.id} className={`flex flex-col justify-between gap-4 rounded-2xl border bg-white p-5 ${app.status === 'interview' ? 'border-emerald-300' : 'border-slate-200'}`}>
                      <div className="flex gap-3">
                        <CompanyAvatar name={app.company} size={44} />
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[15px] font-semibold leading-snug text-slate-900 line-clamp-2">{app.jobTitle}</h3>
                          <p className="truncate text-sm text-slate-600">{app.company}</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <Badge tone={app.status === 'interview' ? 'green' : 'neutral'}>{STATUS_LABELS[app.status]}</Badge>
                            {app.interviewPrep && <Badge tone="brand">Kit prêt</Badge>}
                          </div>
                        </div>
                      </div>
                      <Button variant={app.status === 'interview' ? 'primary' : 'secondary'} onClick={() => setSelectedAppForInterview(app)}>
                        <Award className="h-4 w-4" /> {app.interviewPrep ? 'Reprendre la préparation' : 'Préparer l’entretien'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* SUB-VIEW 6: MASTER PROFILE */}
        {!showGate && currentTab === 'profile' && (
          <MasterProfileView
            userProfile={userProfile}
            onSaveProfile={(p) => handleSaveProfile(p)}
            isSaving={isSavingProfile}
            currentUser={currentUser}
            onOpenAuthModal={(mode) => openAuth(mode)}
            onOpenCvUpload={openCvUpload}
            showToast={showToast}
            onAccountDeleted={async () => {
              await cloud.signOut().catch(() => {});
              setCurrentUser(null);
              setUserProfile(EMPTY_PROFILE);
              setApplications([]);
              setCurrentTab('radar');
            }}
          />
        )}

        {isPublicTool(currentTab) && (
          <ToolsView
            tool={currentTab as 'ats' | 'match'}
            onToolChange={(t) => setCurrentTab(t)}
            onCreateCv={() => {
              setIsMandatoryOnboarding(false);
              setCvUploadModalOpen(true);
            }}
          />
        )}

        {currentTab === 'pricing' && (
          <PricingView
            usage={accountUsage}
            signedIn={signedIn}
            onOpenAuthModal={(mode) => openAuth(mode)}
            showToast={showToast}
            paymentStatus={paymentStatus}
          />
        )}

      </main>


      {/* AUTHENTICATION & ACCOUNT CREATION MODAL */}
      <AuthModal
        isOpen={authModalOpen}
        onClose={() => { setAuthModalOpen(false); setAuthReason(undefined); }}
        defaultMode={authModalMode}
        reason={authReason}
        onSuccess={(user, isNewAccount, extra) => {
          if (!isCloudUser(user)) {
            // Session locale : on charge son propre espace de stockage
            loadLocalSession();
            if (extra?.fullName) {
              setUserProfile(prev => ({ ...prev, fullName: prev.fullName || extra.fullName || '' }));
            }
            setIsMandatoryOnboarding(false);
            setCvUploadModalOpen(true);
            showToast('Session locale', 'Vos données restent dans ce navigateur. Importez votre CV pour commencer.');
            return;
          }
          if (isNewAccount) {
            // Le profil en ligne est créé au premier chargement du compte (nom et titre : métadonnées du compte)
            track('signup');
            showToast('Compte créé', 'Déposez maintenant votre CV pour que vos informations soient extraites.');
          } else {
            showToast('Connexion réussie', 'Vos données sont synchronisées.');
          }
        }}
      />

      {/* CV UPLOAD & ONBOARDING ANALYSIS MODAL */}
      <CvUploadModal
        isOpen={cvUploadModalOpen}
        onClose={() => {
          setCvUploadModalOpen(false);
          setIsMandatoryOnboarding(false);
        }}
        currentProfile={userProfile}
        isMandatoryOnboarding={isMandatoryOnboarding}
        onSaveProfile={async (updated) => {
          await handleSaveProfile(updated, { silent: true });
          showToast('Profil actualisé', 'Les informations extraites de votre CV ont été enregistrées.');
        }}
      />

      {/* LATEX STUDIO MODAL */}
      {selectedJobForLatex && (
        <LatexStudioModal
          key={`${selectedJobForLatex.id}-${selectedAppForLatex?.id || 'new'}`}
          signedIn={signedIn}
          job={selectedJobForLatex}
          userProfile={userProfile}
          initialLatexCode={selectedAppForLatex?.latexResumeCode}
          initialLetter={selectedAppForLatex?.coverLetter}
          initialTemplate={selectedAppForLatex?.template}
          versions={selectedAppForLatex?.versions}
          initialTailored={pastedDossier?.jobId === selectedJobForLatex.id ? pastedDossier.tailored : selectedAppForLatex?.tailoredContent}
          initialAnalysis={pastedDossier?.jobId === selectedJobForLatex.id ? pastedDossier.analysis : selectedAppForLatex?.offerAnalysis}
          onTemplateChange={(t) => {
            if (t !== userProfile.preferredTemplate) {
              handleSaveProfile({ ...userProfile, preferredTemplate: t }, { silent: true }).catch(() => {});
            }
          }}
          onClose={() => { setSelectedJobForLatex(null); setSelectedAppForLatex(null); setPastedDossier(null); }}
          onApplyWithLatex={async (job, latexCode, coverLetter, template, tailored, analysis) => {
            track('dossier_validated', { template, tailored: !!tailored });
            const existing = findExistingApplication(job);
            if (existing) {
              // Mise à jour du dossier existant (pas de doublon) ; l'ancienne version est archivée
              const changed = existing.latexResumeCode && (existing.latexResumeCode !== latexCode || existing.coverLetter !== coverLetter);
              const archived: DossierVersion[] = changed
                ? [{
                    id: `v-${Date.now()}`,
                    createdAt: existing.dossierUpdatedAt || existing.createdAt,
                    label: `Version ${((existing.versions?.length || 0) + 1)}`,
                    template: existing.template,
                    latexResumeCode: existing.latexResumeCode,
                    coverLetter: existing.coverLetter
                  }, ...(existing.versions || [])].slice(0, MAX_VERSIONS)
                : existing.versions || [];
              await patchApplication(existing.id, {
                status: existing.status === 'detected' ? 'prepared' : existing.status,
                latexResumeCode: latexCode,
                coverLetter,
                template,
                versions: archived,
                dossierUpdatedAt: new Date().toISOString(),
                ...(tailored ? { tailoredContent: tailored } : {}),
                ...(analysis ? { offerAnalysis: analysis } : {}),
                logEvents: [...(existing.logEvents || []), { timestamp: new Date().toLocaleString('fr-FR'), message: changed ? 'CV / lettre mis à jour (version précédente archivée).' : 'CV / lettre enregistrés via le Studio LaTeX.' }]
              });
              showToast('Dossier mis à jour', `CV et lettre enregistrés pour ${job.company}.`);
            } else {
              await persistApplication({
                ...buildApplication(job, latexCode, coverLetter, 'Dossier préparé via le Studio LaTeX. Portail de l\'entreprise ouvert.', template),
                ...(tailored ? { tailoredContent: tailored } : {}),
                ...(analysis ? { offerAnalysis: analysis } : {})
              });
              showToast('Dossier enregistré', `Dossier prêt pour ${job.company}. Déposez votre candidature sur leur site.`);
            }
          }}
        />
      )}

      {/* INTERVIEW COCKPIT MODAL */}
      {selectedAppForInterview && (
        <InterviewCockpitModal
          application={selectedAppForInterview}
          userProfile={userProfile}
          onSavePrepKit={(kit) => handleSaveInterviewPrep(selectedAppForInterview.id, kit)}
          onClose={() => setSelectedAppForInterview(null)}
        />
      )}

      {/* RELANCE */}
      {followUpApp && (
        <FollowUpModal
          application={followUpApp}
          userProfile={userProfile}
          onClose={() => setFollowUpApp(null)}
          onMarkSent={async () => {
            await handleMarkFollowedUp(followUpApp);
            setFollowUpApp(null);
          }}
        />
      )}

      {/* FLOATING TOAST NOTIFICATION */}
      {/* État de l'enregistrement en ligne (seulement quand ce n'est pas « tout est enregistré ») */}
      {syncState !== 'saved' && (
        <div role="status" aria-live="polite" className={`fixed z-[55] bottom-20 lg:bottom-6 left-4 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm ${syncState === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {syncState === 'error' ? (
            <>
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Une modification n’a pas été enregistrée.
              <button type="button" className="underline" onClick={() => window.location.reload()}>Recharger</button>
            </>
          ) : (
            <>
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
              {typeof navigator !== 'undefined' && navigator.onLine === false ? 'Hors connexion : modifications gardées, envoi automatique au retour' : 'Enregistrement en cours…'}
            </>
          )}
        </div>
      )}

      {toastMessage && (
        <div role="status" aria-live="polite" className="fixed z-[60] bottom-20 lg:bottom-6 left-4 right-4 sm:left-auto sm:right-6 sm:w-[380px] bg-white border border-slate-200 px-4 py-3.5 rounded-2xl shadow-xl flex items-start gap-3">
          {toastMessage.error
            ? <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
            : <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />}
          <div className="text-sm min-w-0 flex-1">
            <p className="font-semibold text-slate-900">{toastMessage.title}</p>
            <p className="text-slate-600 mt-0.5 leading-snug">{toastMessage.desc}</p>
          </div>
          <button onClick={() => setToastMessage(null)} aria-label="Fermer" className="text-slate-400 hover:text-slate-600 -mr-1">×</button>
        </div>
      )}


      {/* Toujours au premier plan (y compris au-dessus du Studio) */}
      <UpgradeModal
        detail={quotaDetail}
        onClose={() => setQuotaDetail(null)}
        onSeePlans={() => {
          setQuotaDetail(null);
          // Les fenêtres ouvertes (Studio, entretien) masqueraient la page Tarifs
          setSelectedJobForLatex(null);
          setSelectedAppForLatex(null);
          setSelectedAppForInterview(null);
          setCurrentTab('pricing');
        }}
      />
    </div>
  );
}

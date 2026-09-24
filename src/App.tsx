import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as cloud from './data/cloud';
import { isCloudUser, type AppUser as User } from './data/cloud';
import { Header } from './components/Header';
import { JobSearchView } from './components/jobs/JobSearchView';
import { LatexStudioModal } from './components/LatexStudioModal';
import { AgentAutomationView } from './components/AgentAutomationView';
import { KanbanCrmView } from './components/KanbanCrmView';
import { InterviewCockpitModal } from './components/InterviewCockpitModal';
import { MasterProfileView } from './components/MasterProfileView';
import { AuthModal } from './components/AuthModal';
import { CvUploadModal } from './components/CvUploadModal';
import { EMPTY_PROFILE } from './mockData';
import { UserProfile, JobOffer, Application, AgentLog, ApplicationStatus, InterviewPrepKit, CvTemplate, SavedSearch, DossierVersion } from './types';
import { apiFetch, readJson as readApiJson } from './utils/api';
import { Badge, Button, CompanyAvatar, EmptyState, MatchRing, PageHeader } from './components/ui';
import { CONTRACT_LABELS, sourceShortName } from './utils/format';
import { readTab, readSearch, writeTab, writeUrl, type TabId, type SearchUrlState } from './utils/url';
import { FollowUpModal } from './components/FollowUpModal';
import { calculateCandidateMatch } from './utils/skillMatcher';
import { getApplyUrl } from './utils/jobLinks';
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
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ title: string; desc: string; error?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [agentLogs, setAgentLogs] = useState<AgentLog[]>([]);

  // Références à jour pour les callbacks asynchrones
  const currentUserRef = useRef<User | null>(null);
  currentUserRef.current = currentUser;
  const profileRef = useRef<UserProfile>(userProfile);
  profileRef.current = userProfile;
  const applicationsRef = useRef<Application[]>(applications);
  applicationsRef.current = applications;

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

  const addLog = (log: Omit<AgentLog, 'id' | 'timestamp'>) => {
    setAgentLogs(prev => [{ id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: nowTime(), ...log }, ...prev].slice(0, 100));
  };

  /** Charge une session locale (sans compte en ligne) à partir du stockage du navigateur. */
  const loadLocalSession = () => {
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

  useEffect(() => {
    const s = initialSearch.current;
    handleFetchLiveJobs(s.query, s.contractType, s.location, s.radius);
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

      // App est le SEUL à créer le profil en ligne
      try {
        const stored = await cloud.loadProfile(user.uid);
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
        }
        setUserProfile(profile);
        if (!profile.fullName || profile.skills.length === 0 || profile.experiences.length === 0) {
          setIsMandatoryOnboarding(!stored);
          setCvUploadModalOpen(true);
        }
      } catch (e) {
        console.error('Profile sync error:', e);
        showToast('Profil non chargé', 'Impossible de lire votre profil en ligne. Vérifiez votre connexion.', true);
      }

      unsubApps = cloud.subscribeApplications(user.uid, setApplications, (err) => {
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
    } catch (e: any) {
      if (searchId === lastSearchId.current) {
        showToast('Recherche indisponible', e?.message || 'La recherche a échoué. Réessayez.', true);
      }
    } finally {
      if (searchId === lastSearchId.current) setIsLoadingJobs(false);
    }
  };

  /** Page suivante des sources (France Travail, Adzuna, Google Jobs, Jooble). */
  const handleLoadMore = async () => {
    if (loadingMore || !jobsMeta.hasMore) return;
    const searchId = lastSearchId.current;
    const nextPage = (jobsMeta.page || 1) + 1;
    setLoadingMore(true);
    try {
      const res = await apiFetch('/api/jobs/search', { ...lastParams.current, page: nextPage });
      const data = await readApiJson<any>(res);
      if (searchId !== lastSearchId.current) return;
      const incoming: JobOffer[] = Array.isArray(data.jobs) ? data.jobs : [];
      setJobs(prev => {
        const seen = new Set(prev.map(j => j.id));
        return [...prev, ...incoming.filter(j => !seen.has(j.id))];
      });
      setJobsMeta(prev => ({
        ...prev,
        page: nextPage,
        hasMore: !!data.hasMore && incoming.length > 0,
        warnings: Array.from(new Set([...(prev.warnings || []), ...(Array.isArray(data.warnings) ? data.warnings : [])]))
      }));
      if (!incoming.length) showToast('Fin des résultats', 'Les sources n’ont pas d’autres offres pour cette recherche.');
    } catch (e: any) {
      showToast('Chargement impossible', e?.message || 'Réessayez dans un instant.', true);
    } finally {
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
      if (isCloudUser(user)) {
        await cloud.saveProfile(user.uid, toSave);
      } else {
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
    if (!isCloudUser(user)) writeJson(appsKey(storageUid(user)), apps);
  };

  const persistApplication = async (app: Application) => {
    const user = currentUserRef.current;
    setApplications(prev => {
      const updated = [app, ...prev.filter(a => a.id !== app.id)];
      saveApplicationsLocally(user, updated);
      return updated;
    });
    if (isCloudUser(user)) {
      try {
        await cloud.saveApplication(user.uid, app);
      } catch (err) {
        console.error('App save error:', err);
        showToast('Sauvegarde en ligne échouée', 'Le dossier est visible ici mais n\'a pas été enregistré en ligne.', true);
      }
    }
  };

  const patchApplication = async (appId: string, patch: Partial<Application>) => {
    const user = currentUserRef.current;
    const current = applicationsRef.current.find(a => a.id === appId);
    setApplications(prev => {
      const updated = prev.map(a => (a.id === appId ? { ...a, ...patch } : a));
      saveApplicationsLocally(user, updated);
      return updated;
    });
    if (isCloudUser(user)) {
      try {
        if (current) await cloud.saveApplication(user.uid, { ...current, ...patch });
      } catch (err) {
        console.error('App update error:', err);
        showToast('Mise à jour en ligne échouée', 'Réessayez dans un instant.', true);
      }
    }
  };

  const handleUpdateAppStatus = async (appId: string, newStatus: ApplicationStatus) => {
    const app = applications.find(a => a.id === appId);
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
    userProfile.preferredTemplate === 'moderncv' || userProfile.preferredTemplate === 'compact' ? userProfile.preferredTemplate : 'article';

  const generateDossier = async (job: JobOffer) => {
    // CV et lettre générés en parallèle (avant : l'un après l'autre)
    const [resLatex, resLetter] = await Promise.all([
      apiFetch('/api/tailor/latex', { candidate: userProfile, job, template: preferredTemplate() }),
      apiFetch('/api/tailor/letter', { candidate: userProfile, job })
    ]);
    const dataLatex = await resLatex.json().catch(() => null);
    const dataLetter = await resLetter.json().catch(() => null);
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
      id: `app-${Date.now()}`,
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
  const findExistingApplication = (job: JobOffer): Application | undefined => {
    const norm = (v: string) => (v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return applications.find(a => a.jobId === job.id
      || (norm(a.company) === norm(job.company) && norm(a.jobTitle) === norm(job.title)));
  };

  /** Doit être appelé directement dans un gestionnaire de clic (ouverture du portail non bloquée). */
  const handleInstantAutoApply = async (job: JobOffer) => {
    if (!job || isAgentRunning) return;

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

    setIsAgentRunning(true);
    addLog({ type: 'latex', message: `Génération du CV et de la lettre pour ${job.title} — ${job.company}…` });

    try {
      const { dataLatex, dataLetter } = await generateDossier(job);
      const app: Application = {
        ...buildApplication(job, dataLatex.latexCode, dataLetter.letter, 'Dossier préparé (CV + lettre). Portail de l\'entreprise ouvert.'),
        ...(dataLatex.tailored ? { tailoredContent: dataLatex.tailored } : {}),
        ...(dataLatex.analysis ? { offerAnalysis: dataLatex.analysis } : {})
      };
      if (savedOnly && existing) {
        // Offre déjà sauvegardée : on complète le même dossier au lieu d'en créer un second
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

      let copied = false;
      try {
        await navigator.clipboard.writeText(dataLetter.letter);
        copied = true;
      } catch {
        // le presse-papiers peut être refusé hors clic : la lettre reste disponible dans Candidatures
      }

      const notices = [dataLatex.notice, dataLetter.notice].filter(Boolean).join(' ');
      addLog({ type: 'success', message: `Dossier prêt : ${job.title} — ${job.company}.`, company: job.company, score: app.matchScore ?? undefined });
      showToast(
        'Dossier prêt',
        `${portal ? 'Le portail est ouvert. ' : 'Votre navigateur a bloqué l\'ouverture du portail : utilisez « Postuler en ligne ». '}${copied ? 'La lettre est copiée. ' : 'La lettre est disponible dans Candidatures. '}${notices}`
      );
    } catch (e: any) {
      console.error('Dossier preparation error:', e);
      addLog({ type: 'alert', message: `Échec pour ${job.company} : ${e?.message || 'erreur inconnue'}` });
      showToast('Dossier non préparé', e?.message || 'Une erreur est survenue lors de la préparation du dossier.', true);
    } finally {
      setIsAgentRunning(false);
    }
  };

  /** Cycle de l'assistant : meilleure offre non traitée respectant le seuil et les contrats préférés. */
  const handleTriggerAgentCycle = async () => {
    if (userProfile.skills.length === 0) {
      showToast('Profil incomplet', 'Importez votre CV pour que l\'assistant puisse évaluer les offres.', true);
      return;
    }
    const threshold = userProfile.minMatchScore ?? 60;
    const contracts = userProfile.preferredContracts || [];
    const best = jobs
      .filter(j => !findExistingApplication(j))
      .filter(j => contracts.length === 0 || contracts.includes(j.contractType))
      .map(j => ({ job: j, score: calculateCandidateMatch(userProfile.skills, j.skillsRequired).score }))
      .filter(x => x.score !== null && x.score >= threshold)
      .sort((a, b) => (b.score as number) - (a.score as number))[0];

    addLog({ type: 'scan', message: `Analyse de ${jobs.length} offres (seuil ${threshold} %, contrats : ${contracts.length ? contracts.join(', ') : 'tous'}).` });

    if (!best) {
      addLog({ type: 'match', message: 'Aucune nouvelle offre ne respecte vos critères.' });
      showToast('Aucune offre retenue', `Aucune nouvelle offre n'atteint ${threshold} % de compatibilité avec vos critères.`);
      return;
    }
    addLog({ type: 'match', message: `Offre retenue : ${best.job.title} — ${best.job.company}.`, score: best.score as number });
    await handleInstantAutoApply(best.job);
  };

  const handleDeleteApplication = async (appId: string) => {
    const user = currentUserRef.current;
    setApplications(prev => {
      const updated = prev.filter(a => a.id !== appId);
      saveApplicationsLocally(user, updated);
      return updated;
    });
    if (isCloudUser(user)) {
      try {
        await cloud.deleteApplication(user.uid, appId);
      } catch (err) {
        console.error('App delete error:', err);
        showToast('Suppression en ligne échouée', 'Réessayez dans un instant.', true);
      }
    }
  };

  /** Sauvegarder / retirer une offre (colonne « Sauvegardées » du suivi). */
  const handleToggleSaveJob = async (job: JobOffer) => {
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
      try {
        await cloud.saveApplications(user.uid, owned);
      } catch {
        showToast('Import partiel', 'Les dossiers importés n’ont pas pu être enregistrés en ligne. Réessayez.', true);
      }
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
      .map(j => ({ j, s: calculateCandidateMatch(userProfile.skills, j.skillsRequired).score ?? -1 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map(x => x.j);
  }, [jobs, userProfile.skills]);

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
      publishedAt: app.createdAt
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
        onOpenAuthModal={(mode) => {
          setAuthModalMode(mode);
          setAuthModalOpen(true);
        }}
        onLogout={handleLogout}
        onOpenCvUpload={() => {
          setIsMandatoryOnboarding(false);
          setCvUploadModalOpen(true);
        }}
        autoApplyActive={!!currentUser}
        appliedCount={submittedCount}
        interviewCount={interviewCount}
        followUpDueCount={followUpDueCount}
        applicationsCount={applications.length}
        alertsNewCount={(userProfile.savedSearches || []).reduce((n, s) => n + (s.newCount || 0), 0)}
      />

      {/* Main Content Area */}
      <main id="contenu" tabIndex={-1} className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-28 lg:pb-12 outline-none">
        
        {/* SUB-VIEW 1: LIVE RADAR (CHASSEUR D'OFFRES TEMPS RÉEL) */}
        {currentTab === 'radar' && (
          <JobSearchView
            jobs={jobs}
            jobsMeta={jobsMeta}
            initialSearch={lastParams.current}
            onLoadMore={handleLoadMore}
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
              setSelectedAppForLatex(findExistingApplication(job) || null);
              setSelectedJobForLatex(job);
            }}
            onExpressApply={handleInstantAutoApply}
            busy={isAgentRunning}
            onOpenCvUpload={() => {
              setIsMandatoryOnboarding(false);
              setCvUploadModalOpen(true);
            }}
          />
        )}

        {/* SUB-VIEW 2: AGENT AUTOMATION (LE PILOTE AUTOMATIQUE) */}
        {currentTab === 'agent' && (
          <AgentAutomationView
            userProfile={userProfile}
            onSaveSettings={(patch) => { handleSaveProfile({ ...userProfile, ...patch }, { silent: true }).catch(() => {}); }}
            onTriggerAgentCycle={handleTriggerAgentCycle}
            isAgentRunning={isAgentRunning}
            agentLogs={agentLogs}
            onGoToInterviews={() => setCurrentTab('interview')}
            preparedCount={preparedCount}
          />
        )}

        {/* SUB-VIEW 3: STUDIO LATEX & OVERLEAF (DIRECT VIEW) */}
        {currentTab === 'latex' && (
          <div>
            <PageHeader
              title="Studio CV"
              subtitle={studioJobs.length < jobs.length
                ? `Les ${studioJobs.length} offres les plus compatibles avec votre profil. Choisissez-en une pour générer un CV LaTeX et une lettre adaptés.`
                : 'Choisissez une offre pour générer un CV LaTeX et une lettre adaptés, à relire puis compiler en PDF.'}
            />
            {studioJobs.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white">
                <EmptyState icon={<FileCode2 className="h-6 w-6" />} title="Aucune offre chargée" action={<Button variant="primary" onClick={() => setCurrentTab('radar')}>Rechercher des offres</Button>}>
                  Lancez une recherche dans l’onglet Offres pour préparer un CV adapté.
                </EmptyState>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {studioJobs.map((job) => {
                  const m = calculateCandidateMatch(userProfile.skills, job.skillsRequired);
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
                          </div>
                        </div>
                        {userProfile.skills.length > 0 && <MatchRing score={m.score} size={40} />}
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
        {currentTab === 'kanban' && (
          <KanbanCrmView
            applications={applications}
            onOpenLatexForApp={openLatexForApplication}
            onOpenInterviewPrep={(app) => setSelectedAppForInterview(app)}
            onUpdateAppStatus={handleUpdateAppStatus}
            onFollowUp={(app) => setFollowUpApp(app)}
            onDelete={async (id) => { await handleDeleteApplication(id); showToast('Candidature supprimée', 'Le dossier a été retiré de votre suivi.'); }}
            onGoToOffers={() => setCurrentTab('radar')}
            onImport={handleImportApplications}
            onError={(m) => showToast('Import impossible', m, true)}
          />
        )}

        {/* SUB-VIEW 5: COCKPIT ENTRETIENS */}
        {currentTab === 'interview' && (() => {
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
        {currentTab === 'profile' && (
          <MasterProfileView
            userProfile={userProfile}
            onSaveProfile={(p) => handleSaveProfile(p)}
            isSaving={isSavingProfile}
            currentUser={currentUser}
            onOpenAuthModal={(mode) => {
              setAuthModalMode(mode);
              setAuthModalOpen(true);
            }}
            onOpenCvUpload={() => {
              setIsMandatoryOnboarding(false);
              setCvUploadModalOpen(true);
            }}
          />
        )}

      </main>

      {/* AUTHENTICATION & ACCOUNT CREATION MODAL */}
      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        defaultMode={authModalMode}
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
          job={selectedJobForLatex}
          userProfile={userProfile}
          initialLatexCode={selectedAppForLatex?.latexResumeCode}
          initialLetter={selectedAppForLatex?.coverLetter}
          initialTemplate={selectedAppForLatex?.template}
          versions={selectedAppForLatex?.versions}
          initialTailored={selectedAppForLatex?.tailoredContent}
          initialAnalysis={selectedAppForLatex?.offerAnalysis}
          onTemplateChange={(t) => {
            if (t !== userProfile.preferredTemplate) {
              handleSaveProfile({ ...userProfile, preferredTemplate: t }, { silent: true }).catch(() => {});
            }
          }}
          onClose={() => { setSelectedJobForLatex(null); setSelectedAppForLatex(null); }}
          onApplyWithLatex={async (job, latexCode, coverLetter, template, tailored, analysis) => {
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

    </div>
  );
}

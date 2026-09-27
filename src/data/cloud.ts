/**
 * Comptes et données en ligne (Supabase : PostgreSQL hébergé dans l'UE).
 *
 * Tables (voir supabase/migrations) :
 *  - profiles(id, data jsonb)                       → profil du candidat
 *  - applications(user_id, id, data jsonb)          → dossiers de candidature
 *  - subscriptions / usage                          → forfait et compteurs (écrits par le serveur)
 * Chaque utilisateur ne lit et n'écrit que ses lignes (règles RLS).
 *
 * Sans VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, `cloudEnabled` vaut false :
 * l'application fonctionne en session locale (données dans le navigateur).
 */
import { createClient, type SupabaseClient, type User as SbUser } from '@supabase/supabase-js';
import type { Application, UserProfile } from '../types';

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  /** Titre saisi à l'inscription (métadonnées du compte). */
  title?: string;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const cloudEnabled = !!(url && key);
/** Comptes en ligne configurés : pas de session locale, les fonctions personnelles exigent un compte. */
export const accountsRequired = cloudEnabled;
/** Connexion Google : à activer dans Supabase (Authentication → Providers) puis VITE_AUTH_GOOGLE=on. */
export const googleAuthEnabled = cloudEnabled && import.meta.env.VITE_AUTH_GOOGLE === 'on';

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!cloudEnabled) throw new Error('CLOUD_DISABLED');
  client ||= createClient(url!, key!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return client;
}

const toAppUser = (u: SbUser): AppUser => ({
  uid: u.id,
  email: u.email || '',
  displayName: String(u.user_metadata?.full_name || u.user_metadata?.name || ''),
  title: u.user_metadata?.title ? String(u.user_metadata.title) : undefined
});

/** Un compte en ligne (≠ session locale « local-… » ou invité). */
export const isCloudUser = (u: AppUser | null | undefined): u is AppUser => !!u && !u.uid.startsWith('local-');

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

/** Appelle `cb` avec l'utilisateur connecté (ou null) au démarrage puis à chaque changement. */
export function onAuthChange(cb: (user: AppUser | null) => void): () => void {
  if (!cloudEnabled) {
    cb(null);
    return () => {};
  }
  let last: string | null | undefined;
  const emit = (u: SbUser | null | undefined) => {
    const id = u?.id || null;
    if (id === last) return; // rafraîchissement du jeton : pas de rechargement des données
    last = id;
    cb(u ? toAppUser(u) : null);
  };
  const { data } = sb().auth.onAuthStateChange((_event, session) => emit(session?.user));
  return () => data.subscription.unsubscribe();
}

export async function getAccessToken(): Promise<string | null> {
  if (!cloudEnabled) return null;
  const { data } = await sb().auth.getSession();
  return data.session?.access_token || null;
}

const redirectTo = () => (typeof window !== 'undefined' ? window.location.origin : undefined);

export async function signUp(email: string, password: string, meta: { fullName: string; title?: string }) {
  const { data, error } = await sb().auth.signUp({
    email,
    password,
    options: { data: { full_name: meta.fullName, title: meta.title || '' }, emailRedirectTo: redirectTo() }
  });
  if (error) throw error;
  // Confirmation par e-mail activée : pas de session tant que le lien n'est pas cliqué
  return { user: data.user ? toAppUser(data.user) : null, needsConfirmation: !data.session };
}

export async function signIn(email: string, password: string): Promise<AppUser> {
  const { data, error } = await sb().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return toAppUser(data.user);
}

export async function signInWithGoogle(): Promise<void> {
  const { error } = await sb().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });
  if (error) throw error;
}

export async function resetPassword(email: string): Promise<void> {
  const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (!cloudEnabled) return;
  await sb().auth.signOut();
}

/** Messages d'erreur d'authentification en français. */
export function authErrorMessage(err: any): string {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  if (code === 'user_already_exists' || /already registered/i.test(msg)) return 'Un compte existe déjà avec cette adresse e-mail. Connectez-vous.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'E-mail ou mot de passe incorrect.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'Adresse e-mail non confirmée : cliquez sur le lien reçu par e-mail (pensez aux indésirables).';
  if (code === 'weak_password' || /password should be/i.test(msg)) return 'Mot de passe trop faible : 8 caractères minimum, avec lettres et chiffres.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || /rate limit/i.test(msg)) return 'Trop de tentatives : patientez quelques minutes avant de réessayer.';
  if (code === 'validation_failed' || /invalid.*email|email.*invalid/i.test(msg)) return 'Adresse e-mail invalide.';
  if (/provider is not enabled/i.test(msg)) return 'La connexion Google n’est pas encore activée : utilisez votre e-mail.';
  if (/fetch|network/i.test(msg)) return 'Connexion au service de comptes impossible. Vérifiez votre connexion Internet.';
  return msg || 'Une erreur est survenue lors de l’authentification.';
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

export async function loadProfile(uid: string): Promise<UserProfile | null> {
  const { data, error } = await sb().from('profiles').select('data').eq('id', uid).maybeSingle();
  if (error) throw error;
  return (data?.data as UserProfile) || null;
}

/** JSONB n'accepte pas `undefined` : on le retire (évite l'échec de toute la sauvegarde). */
const clean = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Profil et sa version (base de l'enregistrement conditionnel). */
export async function loadProfileVersioned(uid: string): Promise<{ profile: UserProfile | null; version: number | null }> {
  const { data, error } = await sb().from('profiles').select('data, version').eq('id', uid).maybeSingle();
  if (error) throw error;
  return { profile: (data?.data as UserProfile) || null, version: data?.version ?? null };
}

/** Enregistrement conditionnel : ok=false si le profil a été modifié ailleurs depuis `expected` (renvoie la dernière version). */
export async function saveProfileVersioned(_uid: string, profile: UserProfile, expected: number | null): Promise<{ ok: boolean; version: number; data: any }> {
  const { data, error } = await sb().rpc('save_profile', { p_data: clean(profile), p_expected: expected });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !!row?.ok, version: Number(row?.version), data: row?.data };
}

/** Modifie seulement les champs donnés d'un dossier (fusion côté serveur ; null retire le champ). */
export async function patchApplicationRemote(_uid: string, id: string, patch: Partial<Application>): Promise<{ found: boolean }> {
  const { data, error } = await sb().rpc('patch_application', { p_id: id, p_patch: JSON.parse(JSON.stringify(patch, (_k, v) => (v === undefined ? null : v))) });
  if (error) throw error;
  return { found: Array.isArray(data) ? data.length > 0 : !!data };
}

export async function saveProfile(uid: string, profile: UserProfile): Promise<void> {
  const { error } = await sb().from('profiles').upsert({ id: uid, data: clean(profile) });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Candidatures
// ---------------------------------------------------------------------------

const byNewest = (a: Application, b: Application) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();

export async function loadApplications(uid: string): Promise<Application[]> {
  const { data, error } = await sb().from('applications').select('data').eq('user_id', uid);
  if (error) throw error;
  return (data || []).map((r: any) => r.data as Application).sort(byNewest);
}

/**
 * Candidatures de l'utilisateur, puis mises à jour en temps réel (autre onglet, autre appareil).
 * Retourne la fonction de désabonnement.
 */
export function subscribeApplications(uid: string, cb: (apps: Application[]) => void, onError?: (e: unknown) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => loadApplications(uid).then((apps) => active && cb(apps)).catch((e) => onError?.(e));
  refresh();
  const channel = sb()
    .channel(`applications:${uid}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'applications', filter: `user_id=eq.${uid}` }, () => {
      // Plusieurs écritures rapprochées (import) : un seul rechargement
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    })
    .subscribe();
  // Filet de sécurité si le temps réel est bloqué (réseau d'entreprise, proxy) : rechargement au retour sur l'onglet
  let lastFocus = 0;
  const onFocus = () => {
    if (document.visibilityState === 'hidden' || Date.now() - lastFocus < 5000) return;
    lastFocus = Date.now();
    refresh();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  return () => {
    active = false;
    clearTimeout(timer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    sb().removeChannel(channel);
  };
}

export async function saveApplication(uid: string, app: Application): Promise<void> {
  const { error } = await sb().from('applications').upsert({ user_id: uid, id: app.id, data: clean(app) });
  if (error) throw error;
}

export async function saveApplications(uid: string, apps: Application[]): Promise<void> {
  if (!apps.length) return;
  const { error } = await sb().from('applications').upsert(apps.map((a) => ({ user_id: uid, id: a.id, data: clean(a) })));
  if (error) throw error;
}

export async function deleteApplication(uid: string, id: string): Promise<void> {
  const { error } = await sb().from('applications').delete().eq('user_id', uid).eq('id', id);
  if (error) throw error;
}

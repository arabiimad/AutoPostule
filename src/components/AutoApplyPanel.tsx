import React, { useEffect, useId, useState } from 'react';
import { Mail, Pause, Play, ShieldCheck, Zap, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { Button, cx } from './ui';

interface AutomationState {
  available: boolean;
  maxDaily: number;
  oauth: { gmail: boolean; outlook: boolean };
  policy: null | {
    enabled: boolean; paused: boolean; roles: string[]; contracts: string[]; locations: string[]; remote: string[];
    minSalary: number | null; minFit: number; excludedCompanies: string[]; excludedKeywords: string[]; channels: string[]; dailyLimit: number; consentedAt?: string;
  };
  connections: { provider: 'gmail' | 'outlook'; email: string; status: string }[];
  today: { sent: number; uncertain: number; limit: number | null };
  pending: number;
  needsUser: number;
  events: { type: string; message: string; at: string }[];
}

const CONTRACTS = [['cdi', 'CDI'], ['cdd', 'CDD'], ['alternance', 'Alternance'], ['stage', 'Stage'], ['freelance', 'Freelance']] as const;
const splitList = (s: string) => s.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
const PROVIDER_LABEL = { gmail: 'Gmail', outlook: 'Outlook' } as const;

/**
 * Candidature automatique : l'assistant cherche en continu (dans le cloud, ordinateur éteint),
 * prépare CV et lettre, et envoie depuis la messagerie du candidat quand l'offre publie une adresse de candidature.
 * Les offres LinkedIn, Indeed, Welcome to the Jungle… restent à valider par le candidat.
 */
export const AutoApplyPanel: React.FC<{ defaultRoles: string[]; defaultLocation?: string; onNotify: (title: string, desc: string, error?: boolean) => void }> = ({ defaultRoles, defaultLocation, onNotify }) => {
  const uid = useId();
  const [state, setState] = useState<AutomationState | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [form, setForm] = useState({ roles: '', locations: '', contracts: [] as string[], email: true, form: false, minFit: 60, dailyLimit: 5, excludedCompanies: '', excludedKeywords: '' });

  const load = async () => {
    try {
      const res = await apiFetch('/api/automation');
      const data = await res.json().catch(() => null);
      if (res.status === 501) return setUnavailable('La candidature automatique n’est pas encore activée sur ce serveur.');
      if (res.status === 401) return setUnavailable('Créez un compte ou connectez-vous pour activer la candidature automatique.');
      if (!res.ok) return setUnavailable(data?.error || 'Candidature automatique momentanément indisponible.');
      setUnavailable(null);
      setState(data);
      const p = data.policy;
      setForm({
        roles: (p?.roles?.length ? p.roles : defaultRoles).join(', '),
        locations: (p?.locations?.length ? p.locations : defaultLocation ? [defaultLocation] : []).join(', '),
        contracts: p?.contracts || [],
        email: p ? p.channels.includes('email') : true,
        form: p ? p.channels.includes('form') : false,
        minFit: p?.minFit ?? 60,
        dailyLimit: Math.min(p?.dailyLimit ?? data.maxDaily, data.maxDaily),
        excludedCompanies: (p?.excludedCompanies || []).join(', '),
        excludedKeywords: (p?.excludedKeywords || []).join(', ')
      });
    } catch {
      setUnavailable('Serveur injoignable : réessayez dans un instant.');
    }
  };

  useEffect(() => {
    load();
    // Retour de Google / Microsoft après la connexion de la messagerie
    const params = new URLSearchParams(window.location.search);
    const m = params.get('messagerie');
    if (m) {
      const msg: Record<string, [string, string, boolean]> = {
        connectee: ['Messagerie connectée', 'Vos candidatures partiront depuis votre adresse.', false],
        annulee: ['Connexion annulée', 'Aucune autorisation n’a été donnée.', true],
        permission: ['Autorisation incomplète', 'Acceptez l’envoi d’emails pour que les candidatures puissent partir.', true],
        refusee: ['Connexion refusée', 'Le lien a expiré : recommencez la connexion.', true]
      };
      const [t, d, e] = msg[m] || ['Connexion impossible', 'Réessayez dans un instant.', true];
      onNotify(t, d, e);
      params.delete('messagerie');
      window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payload = (enabled: boolean) => ({
    enabled,
    consent: enabled ? consent : undefined,
    roles: splitList(form.roles),
    locations: splitList(form.locations),
    contracts: form.contracts,
    channels: [form.email && 'email', form.form && 'form'].filter(Boolean),
    minFit: form.minFit,
    dailyLimit: form.dailyLimit,
    excludedCompanies: splitList(form.excludedCompanies),
    excludedKeywords: splitList(form.excludedKeywords)
  });

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/automation/policy', payload(enabled), { method: 'PUT' });
      const data = await res.json().catch(() => null);
      if (!res.ok) return onNotify('Réglages non enregistrés', data?.error || 'Réessayez.', true);
      onNotify(enabled ? 'Candidature automatique activée' : 'Réglages enregistrés', enabled ? 'Une première recherche démarre ; vous serez informé(e) de chaque envoi.' : 'La candidature automatique est désactivée.');
      setConsentOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const post = async (path: string, method = 'POST') => {
    setBusy(true);
    try {
      const res = await apiFetch(path, method === 'POST' ? {} : undefined, { method });
      const data = await res.json().catch(() => null);
      if (!res.ok) onNotify('Action impossible', data?.error || 'Réessayez.', true);
      return data;
    } finally {
      setBusy(false);
    }
  };

  const connect = async (provider: 'gmail' | 'outlook') => {
    const data = await post(`/api/automation/connect/${provider}`);
    if (data?.url) window.location.assign(data.url);
  };

  if (unavailable) {
    return (
      <section aria-labelledby={`${uid}-t`} className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 id={`${uid}-t`} className="flex items-center gap-2 text-[15px] font-semibold text-slate-900"><Zap className="h-4 w-4 text-brand-600" aria-hidden="true" /> Candidature automatique</h2>
        <p className="mt-2 text-sm text-slate-500">{unavailable}</p>
      </section>
    );
  }
  if (!state) {
    return <div role="status" className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white" aria-label="Chargement de la candidature automatique" />;
  }

  const p = state.policy;
  const active = !!p?.enabled && !p.paused;
  const mail = state.connections.find(c => c.status === 'active');
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));

  return (
    <section aria-labelledby={`${uid}-t`} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${uid}-t`} className="flex items-center gap-2 text-[15px] font-semibold text-slate-900"><Zap className="h-4 w-4 text-brand-600" aria-hidden="true" /> Candidature automatique</h2>
          <p className="mt-1 text-xs text-slate-500">Recherche en continu, même ordinateur éteint. Envoi depuis votre messagerie quand l’offre publie une adresse de candidature ; LinkedIn, Indeed ou Welcome to the Jungle restent à valider par vous (leurs règles interdisent l’envoi automatique).</p>
        </div>
        <span role="status" className={cx('rounded-full px-2.5 py-1 text-xs font-semibold', active ? 'bg-emerald-50 text-emerald-700' : p?.enabled ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600')}>
          {active ? 'Active' : p?.enabled ? 'En pause' : 'Désactivée'}
        </span>
      </div>

      {p?.enabled && (
        <dl className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 p-2"><dt className="text-[11px] text-slate-500">Envoyées aujourd’hui</dt><dd className="text-lg font-semibold text-slate-900">{state.today.sent}/{p.dailyLimit}</dd></div>
          <div className="rounded-xl bg-slate-50 p-2"><dt className="text-[11px] text-slate-500">En préparation</dt><dd className="text-lg font-semibold text-slate-900">{state.pending}</dd></div>
          <div className="rounded-xl bg-slate-50 p-2"><dt className="text-[11px] text-slate-500">À valider par vous</dt><dd className="text-lg font-semibold text-slate-900">{state.needsUser}</dd></div>
        </dl>
      )}
      {state.today.uncertain > 0 && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {state.today.uncertain} envoi(s) au résultat incertain : vérifiez vos messages envoyés avant de renvoyer. Kareer ne renverra jamais automatiquement.
        </p>
      )}

      <div className="space-y-2 border-t border-slate-200 pt-4">
        <p className="text-sm font-medium text-slate-700">Messagerie d’envoi</p>
        {mail ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {PROVIDER_LABEL[mail.provider]} : {mail.email}</span>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={async () => { await post(`/api/automation/connections/${mail.provider}`, 'DELETE'); load(); }}>Déconnecter</Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(['gmail', 'outlook'] as const).map(pv => (
              <Button key={pv} type="button" size="sm" variant="secondary" disabled={busy || !state.oauth[pv]} onClick={() => connect(pv)} title={state.oauth[pv] ? undefined : 'Non configuré sur le serveur'}>
                <Mail className="h-3.5 w-3.5" aria-hidden="true" /> Connecter {PROVIDER_LABEL[pv]}
              </Button>
            ))}
          </div>
        )}
        {state.connections.some(c => c.status === 'revoked') && <p className="text-xs text-rose-700">L’accès à votre messagerie a expiré : reconnectez-la pour reprendre les envois.</p>}
      </div>

      <div className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">Métiers recherchés
          <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={form.roles} onChange={e => set({ roles: e.target.value })} placeholder="développeur web, intégrateur" />
        </label>
        <label className="text-sm font-medium text-slate-700">Lieux
          <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={form.locations} onChange={e => set({ locations: e.target.value })} placeholder="Avignon, Marseille" />
        </label>
        <label className="text-sm font-medium text-slate-700">Compatibilité minimale ({form.minFit} %)
          <input type="range" min={30} max={100} step={5} className="mt-2 w-full accent-brand-600" value={form.minFit} onChange={e => set({ minFit: Number(e.target.value) })} />
        </label>
        <label className="text-sm font-medium text-slate-700">Candidatures par jour (maximum {state.maxDaily})
          <input type="number" min={1} max={state.maxDaily} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={form.dailyLimit} onChange={e => set({ dailyLimit: Math.max(1, Math.min(state.maxDaily, Number(e.target.value) || 1)) })} />
        </label>
        <label className="text-sm font-medium text-slate-700">Entreprises exclues
          <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={form.excludedCompanies} onChange={e => set({ excludedCompanies: e.target.value })} placeholder="mon employeur actuel…" />
        </label>
        <label className="text-sm font-medium text-slate-700">Mots exclus
          <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={form.excludedKeywords} onChange={e => set({ excludedKeywords: e.target.value })} placeholder="intérim, commercial…" />
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-slate-700">Contrats (aucun : tous)</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {CONTRACTS.map(([id, label]) => {
              const on = form.contracts.includes(id);
              return (
                <button key={id} type="button" aria-pressed={on} onClick={() => set({ contracts: on ? form.contracts.filter(c => c !== id) : [...form.contracts, id] })}
                  className={cx('rounded-xl border px-3 py-1.5 text-sm font-semibold', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700')}>{label}</button>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-slate-700">Canaux d’envoi</legend>
          <label className="mt-1 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={form.email} onChange={e => set({ email: e.target.checked })} /> Email à l’adresse de candidature publiée par l’offre</label>
          <label className="mt-1 flex items-center gap-2 text-sm text-slate-500"><input type="checkbox" checked={form.form} onChange={e => set({ form: e.target.checked })} /> Formulaires des sites carrières (Lever, Greenhouse) — dossier préparé, envoi automatique bientôt</label>
        </fieldset>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
        {!p?.enabled ? (
          <Button type="button" variant="primary" disabled={busy} onClick={() => { setConsent(false); setConsentOpen(true); }}>
            <Zap className="h-4 w-4" aria-hidden="true" /> Activer la candidature automatique
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => save(true)}>Enregistrer les réglages</Button>
            {p.paused
              ? <Button type="button" variant="primary" disabled={busy} onClick={async () => { await post('/api/automation/resume'); load(); }}><Play className="h-4 w-4" aria-hidden="true" /> Reprendre</Button>
              : <Button type="button" variant="secondary" disabled={busy} onClick={async () => { await post('/api/automation/pause'); load(); }}><Pause className="h-4 w-4" aria-hidden="true" /> Mettre en pause</Button>}
            <Button type="button" variant="ghost" disabled={busy} onClick={() => save(false)}>Désactiver</Button>
          </>
        )}
      </div>

      {consentOpen && (
        <div role="group" aria-labelledby={`${uid}-c`} className="space-y-3 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-slate-700">
          <p id={`${uid}-c`} className="flex items-center gap-2 font-semibold text-slate-900"><ShieldCheck className="h-4 w-4 text-brand-600" aria-hidden="true" /> Avant d’activer</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Kareer enverra des candidatures en votre nom, depuis votre messagerie connectée, <strong>uniquement</strong> aux adresses de candidature publiées par les offres.</li>
            <li>Au plus {form.dailyLimit} par jour. Chaque CV et chaque lettre sont vérifiés : un élément absent de votre profil bloque l’envoi et vous demande de valider.</li>
            <li>Vos documents sont rédigés par l’IA Gemini (Google). La pause arrête immédiatement tout nouvel envoi.</li>
          </ul>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={consent} onChange={e => setConsent(e.target.checked)} /> J’autorise l’envoi automatique de candidatures en mon nom selon ces règles.</label>
          <div className="flex gap-2">
            <Button type="button" variant="primary" disabled={!consent || busy} onClick={() => save(true)}>Confirmer l’activation</Button>
            <Button type="button" variant="ghost" onClick={() => setConsentOpen(false)}>Annuler</Button>
          </div>
        </div>
      )}

      {state.events.length > 0 && (
        <div className="border-t border-slate-200 pt-4">
          <p className="mb-2 text-sm font-medium text-slate-700">Activité récente</p>
          <ul role="log" aria-live="polite" className="thin-scroll max-h-56 space-y-1.5 overflow-y-auto text-sm">
            {state.events.slice(0, 20).map((e, i) => (
              <li key={i} className="flex gap-2">
                <time className="shrink-0 text-xs tabular-nums text-slate-400" dateTime={e.at}>{new Date(e.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
                <span className={cx(e.type === 'submitted' && 'text-emerald-700', (e.type === 'intervention' || e.type === 'uncertain') && 'text-amber-800', 'text-slate-700')}>{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

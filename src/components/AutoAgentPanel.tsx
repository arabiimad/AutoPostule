import React, { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCircle2, ExternalLink, EyeOff, Mail, Radar, RefreshCw, Send, Settings, XCircle } from 'lucide-react';
import type { UserProfile } from '../types';
import { apiFetch, readJson } from '../utils/api';
import { writeUrl } from '../utils/url';
import { Badge, Button, Card, CompanyAvatar, EmptyState, LinkButton, MatchRing, Tabs, cx } from './ui';

/**
 * Agent de candidature automatique (serveur) :
 *  - Offres pour vous : tout ce que l'agent a trouvé pour le profil (sites d'emploi, pages carrière, publications) ;
 *  - À valider : les candidatures qui attendent un tap (validation, question, code, étape manuelle) ;
 *  - Réglages : niveau d'automatisation, plafond, boîte Gmail.
 */

interface Offer {
  id: string;
  score: number | null;
  status: 'new' | 'seen' | 'queued' | 'dismissed';
  job: any;
}

interface PendingQuestion { key: string; label: string; options?: string[] }

interface AgentTask {
  id: string;
  status: string;
  payload: { job: any; documents?: { coverLetter: string; notices: string[]; hasPdf: boolean }; channel?: string };
  pending?: { kind: 'approve' | 'question' | 'captcha' | 'verification_code' | 'manual_step'; message: string; questions?: PendingQuestion[]; url?: string };
  result?: { channel: string; submittedAt: string };
  lastError?: string;
  updatedAt: string;
}

interface Settings {
  level: 'manual' | 'rules' | 'progressive';
  paused: boolean;
  minMatchScore: number;
  dailyCap: number;
  sameCompanyCooldownDays: number;
  excludedCompanies: string[];
  progressiveThreshold: number;
  cleanApprovals: number;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'En file', running: 'En cours', waiting_user: 'À valider', done: 'Envoyée', failed: 'Échec', cancelled: 'Annulée'
};
const CHANNEL_LABELS: Record<string, string> = { lba: 'La bonne alternance', email: 'Email', manual: 'Envoyée par vous' };

async function api<T = any>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  return readJson<T>(await apiFetch(`/api/automation${path}`, body, init));
}

export const AutoAgentPanel: React.FC<{ userProfile: UserProfile; onSaveSettings: (patch: Partial<UserProfile>) => void }> = ({ userProfile, onSaveSettings }) => {
  const [tab, setTab] = useState<'offers' | 'pending' | 'settings'>('offers');
  const [offers, setOffers] = useState<Offer[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mail, setMail] = useState<{ gmailAvailable: boolean; google: { email: string; status: string } | null } | null>(null);
  const [discovery, setDiscovery] = useState<{ lastRunAt?: string; nextRunAt?: string; lastStats?: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, t, s, m] = await Promise.all([api('/offers?limit=150'), api('/tasks?limit=60'), api('/settings'), api('/mail')]);
      setOffers(o.offers);
      setDiscovery(o.discovery);
      setTasks(t.tasks);
      setSettings(s.settings);
      setMail(m);
      setNeedsLogin(false);
      setError(null);
    } catch (e: any) {
      if (/Connexion requise/i.test(e?.message || '')) setNeedsLogin(true);
      else setError(e?.message || 'Agent indisponible.');
    }
  }, []);

  useEffect(() => {
    load();
    // Retour de la connexion Gmail
    const p = new URLSearchParams(window.location.search);
    const m = p.get('mail');
    if (m) {
      setTab('settings');
      if (m === 'connected') setNotice('Boîte Gmail connectée : les candidatures par email partiront de votre adresse.');
      else setError(p.get('message') || 'Connexion Gmail impossible.');
      writeUrl({ mail: null, message: null });
    }
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (success) setNotice(success);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Action impossible.');
    } finally {
      setBusy(null);
    }
  };

  const waiting = tasks.filter((t) => t.status === 'waiting_user');
  const history = tasks.filter((t) => t.status !== 'waiting_user');
  const visibleOffers = offers.filter((o) => o.status !== 'dismissed');

  if (needsLogin) {
    return (
      <Card className="mb-8">
        <EmptyState icon={<Bot />} title="Connectez-vous pour activer l'agent">
          L'agent cherche des offres et postule depuis nos serveurs, même quand votre ordinateur est éteint : il a besoin de votre compte.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card className="mb-8">
      <div className="flex flex-col gap-3 px-5 pt-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <Radar className="h-5 w-5 text-brand-600" aria-hidden="true" />
            Agent automatique
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Il cherche toutes les offres adaptées à votre profil (sites d'emploi, pages carrière, publications « on recrute ») et postule pour vous, même PC éteint.
            Quand il a besoin de vous, une notification suffit.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy === 'discover'}
          onClick={() => run('discover', async () => {
            const r = await api('/discovery/run', { candidate: userProfile });
            setNotice(`${r.run.found} offres analysées, ${r.run.added} nouvelles${r.run.queued ? `, ${r.run.queued} candidatures lancées` : ''}.${r.run.errors?.length ? ` ${r.run.errors[0]}` : ''}`);
          })}
        >
          <RefreshCw className={cx('h-3.5 w-3.5', busy === 'discover' && 'animate-spin')} aria-hidden="true" />
          {busy === 'discover' ? 'Recherche…' : 'Chercher maintenant'}
        </Button>
      </div>

      {(error || notice) && (
        <div role="status" className={cx('mx-5 mt-4 rounded-xl border p-3 text-sm sm:mx-6', error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800')}>
          {error || notice}
        </div>
      )}

      <Tabs
        className="mt-4 px-5 sm:px-6"
        value={tab}
        onChange={(id) => setTab(id as any)}
        tabs={[
          { id: 'offers', label: <>Offres pour vous <Badge tone="brand" className="ml-1">{visibleOffers.length}</Badge></> },
          { id: 'pending', label: <>À valider {waiting.length > 0 && <Badge tone="amber" className="ml-1">{waiting.length}</Badge>}</> },
          { id: 'settings', label: 'Réglages' }
        ]}
      />

      <div className="p-5 sm:p-6">
        {tab === 'offers' && (
          <OffersList
            offers={visibleOffers}
            discovery={discovery}
            busy={busy}
            onApply={(o) => run(`apply-${o.id}`, () => api(`/offers/${o.id}/apply`, { candidate: userProfile }), `Candidature lancée pour ${o.job.company}.`)}
            onDismiss={(o) => run(`dismiss-${o.id}`, () => api(`/offers/${o.id}/dismiss`, {}))}
          />
        )}
        {tab === 'pending' && (
          <PendingList
            waiting={waiting}
            history={history}
            busy={busy}
            onResolve={(t, body) => run(`resolve-${t.id}`, () => api(`/tasks/${t.id}/resolve`, body))}
          />
        )}
        {tab === 'settings' && settings && (
          <SettingsForm
            settings={settings}
            autoApply={!!userProfile.autoApplyEnabled}
            mail={mail}
            busy={busy}
            onToggleAutoApply={(v) => onSaveSettings({ autoApplyEnabled: v })}
            onSave={(patch) => run('settings', () => api('/settings', patch, { method: 'PUT' }), 'Réglages enregistrés.')}
            onConnectGmail={() => run('gmail', async () => { window.location.href = (await api('/mail/google/connect')).url; })}
            onDisconnectGmail={() => run('gmail', () => api('/mail/google', undefined, { method: 'DELETE' }), 'Boîte Gmail déconnectée.')}
          />
        )}
      </div>
    </Card>
  );
};

const Bot: React.FC = () => <Send className="h-5 w-5" aria-hidden="true" />;

const OffersList: React.FC<{
  offers: Offer[];
  discovery: { lastRunAt?: string; nextRunAt?: string } | null;
  busy: string | null;
  onApply: (o: Offer) => void;
  onDismiss: (o: Offer) => void;
}> = ({ offers, discovery, busy, onApply, onDismiss }) => {
  if (!offers.length) {
    return (
      <EmptyState icon={<Radar className="h-5 w-5" />} title="Aucune offre pour l'instant">
        {discovery?.lastRunAt
          ? 'La dernière recherche n\'a rien trouvé : vérifiez vos postes visés et votre ville dans le profil.'
          : 'La première recherche démarre dans quelques minutes, ou cliquez sur « Chercher maintenant ».'}
      </EmptyState>
    );
  }
  return (
    <div>
      {discovery?.lastRunAt && (
        <p className="mb-3 text-xs text-slate-500">
          Dernière recherche : {new Date(discovery.lastRunAt).toLocaleString('fr-FR')}
          {discovery.nextRunAt && ` · prochaine : ${new Date(discovery.nextRunAt).toLocaleString('fr-FR')}`}
        </p>
      )}
      <ul className="divide-y divide-slate-100">
        {offers.map((o) => (
          <li key={o.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 gap-3">
              <CompanyAvatar name={o.job.company} logo={o.job.companyLogo} size={40} />
              <div className="min-w-0">
                <p className="font-semibold text-slate-900">{o.job.title}</p>
                <p className="text-sm text-slate-600">{o.job.company}{o.job.location ? ` · ${o.job.location}` : ''}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone={o.job.isPost ? 'amber' : 'neutral'}>{o.job.source}</Badge>
                  {o.job.isSpontaneous && <Badge tone="sky">Candidature spontanée</Badge>}
                  {(o.job.contactEmail || o.job.lbaRecipientId) && <Badge tone="green">Envoi automatique possible</Badge>}
                  {o.status === 'queued' && <Badge tone="brand">Candidature lancée</Badge>}
                </div>
                {o.job.postExcerpt && <p className="mt-2 border-l-2 border-amber-300 pl-2 text-sm italic text-slate-600">« {o.job.postExcerpt} »</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 sm:flex-col sm:items-end">
              <MatchRing score={o.score} size={40} />
              <div className="flex gap-1.5">
                {o.job.applyUrl && (
                  <LinkButton size="sm" variant="ghost" href={o.job.applyUrl} target="_blank" rel="noopener noreferrer" aria-label={`Voir l'offre ${o.job.title}`}>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </LinkButton>
                )}
                <Button size="sm" variant="ghost" aria-label="Masquer" disabled={busy === `dismiss-${o.id}`} onClick={() => onDismiss(o)}>
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button size="sm" variant="primary" disabled={o.status === 'queued' || busy === `apply-${o.id}`} onClick={() => onApply(o)}>
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  Postuler
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

const PendingCard: React.FC<{ task: AgentTask; busy: boolean; onResolve: (body: any) => void }> = ({ task, busy, onResolve }) => {
  const p = task.pending!;
  const [letter, setLetter] = useState(task.payload.documents?.coverLetter || '');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const job = task.payload.job || {};
  return (
    <li className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
      <p className="font-semibold text-slate-900">{job.title} · {job.company}</p>
      <p className="mt-1 text-sm text-slate-700">{p.message}</p>
      {task.payload.documents?.notices?.length ? <p className="mt-1 text-xs text-slate-500">{task.payload.documents.notices.join(' ')}</p> : null}

      {p.kind === 'approve' && (
        <div className="mt-3 space-y-2">
          <label className="text-xs font-medium text-slate-600" htmlFor={`letter-${task.id}`}>Lettre (modifiable avant envoi)</label>
          <textarea id={`letter-${task.id}`} value={letter} onChange={(e) => setLetter(e.target.value)} rows={8} className="w-full rounded-xl border border-slate-300 p-3 text-sm" />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onResolve({ action: 'approve', coverLetter: letter })}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Envoyer
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => onResolve({ action: 'reject' })}>
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> Ne pas envoyer
            </Button>
          </div>
        </div>
      )}

      {p.kind === 'question' && (
        <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); onResolve({ action: 'answer', answers }); }}>
          {(p.questions || []).map((q) => (
            <div key={q.key}>
              <label className="text-sm font-medium text-slate-700" htmlFor={`${task.id}-${q.key}`}>{q.label}</label>
              {q.options?.length ? (
                <select id={`${task.id}-${q.key}`} required className="mt-1 w-full rounded-xl border border-slate-300 p-2 text-sm" value={answers[q.key] || ''} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })}>
                  <option value="">Choisir…</option>
                  {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input id={`${task.id}-${q.key}`} required className="mt-1 w-full rounded-xl border border-slate-300 p-2 text-sm" value={answers[q.key] || ''} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
              )}
            </div>
          ))}
          <p className="text-xs text-slate-500">Vos réponses sont enregistrées et resserviront pour les prochains formulaires.</p>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>Répondre</Button>
        </form>
      )}

      {p.kind === 'verification_code' && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); onResolve({ action: 'code', code }); }}>
          <input aria-label="Code de vérification" inputMode="numeric" autoComplete="one-time-code" required className="w-40 rounded-xl border border-slate-300 p-2 text-sm" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button type="submit" variant="primary" size="sm" disabled={busy}>Valider</Button>
        </form>
      )}

      {(p.kind === 'captcha' || p.kind === 'manual_step') && (
        <div className="mt-3 flex flex-wrap gap-2">
          {p.url && (
            <LinkButton size="sm" variant="secondary" href={p.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Ouvrir la page
            </LinkButton>
          )}
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onResolve({ action: 'done' })}>C'est fait</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onResolve({ action: 'reject' })}>Abandonner</Button>
        </div>
      )}
    </li>
  );
};

const PendingList: React.FC<{ waiting: AgentTask[]; history: AgentTask[]; busy: string | null; onResolve: (t: AgentTask, body: any) => void }> = ({ waiting, history, busy, onResolve }) => (
  <div className="space-y-6">
    {waiting.length ? (
      <ul className="space-y-3">
        {waiting.map((t) => <PendingCard key={t.id} task={t} busy={busy === `resolve-${t.id}`} onResolve={(body) => onResolve(t, body)} />)}
      </ul>
    ) : (
      <EmptyState icon={<Bell className="h-5 w-5" />} title="Rien à valider">L'agent vous préviendra quand une candidature aura besoin de vous.</EmptyState>
    )}
    {history.length > 0 && (
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Suivi</h3>
        <ul className="divide-y divide-slate-100 text-sm">
          {history.slice(0, 30).map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-slate-700">{t.payload.job?.title} · {t.payload.job?.company}</span>
              <span className="flex shrink-0 items-center gap-2">
                {t.result?.channel && <span className="text-xs text-slate-500">{CHANNEL_LABELS[t.result.channel] || t.result.channel}</span>}
                <Badge tone={t.status === 'done' ? 'green' : t.status === 'failed' ? 'rose' : 'neutral'} title={t.lastError}>{STATUS_LABELS[t.status] || t.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      </div>
    )}
  </div>
);

const SettingsForm: React.FC<{
  settings: Settings;
  autoApply: boolean;
  mail: { gmailAvailable: boolean; google: { email: string; status: string } | null } | null;
  busy: string | null;
  onToggleAutoApply: (v: boolean) => void;
  onSave: (patch: Partial<Settings>) => void;
  onConnectGmail: () => void;
  onDisconnectGmail: () => void;
}> = ({ settings, autoApply, mail, busy, onToggleAutoApply, onSave, onConnectGmail, onDisconnectGmail }) => {
  const [draft, setDraft] = useState(settings);
  const [excluded, setExcluded] = useState(settings.excludedCompanies.join(', '));
  useEffect(() => { setDraft(settings); setExcluded(settings.excludedCompanies.join(', ')); }, [settings]);
  const levels: { id: Settings['level']; label: string; help: string }[] = [
    { id: 'progressive', label: 'Confiance progressive', help: `Vous validez les premiers envois, puis l'agent envoie seul après ${settings.progressiveThreshold} validations sans correction (${settings.cleanApprovals}/${settings.progressiveThreshold}).` },
    { id: 'manual', label: 'Manuel', help: 'Vous validez chaque envoi.' },
    { id: 'rules', label: 'Automatique', help: 'L\'agent envoie seul, dans la limite de vos règles.' }
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Settings className="h-4 w-4" aria-hidden="true" /> Automatisation</h3>
        <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
          <input type="checkbox" className="mt-1 accent-brand-600" checked={autoApply} onChange={(e) => onToggleAutoApply(e.target.checked)} />
          <span className="text-sm text-slate-700"><strong>Postuler automatiquement</strong> aux offres trouvées au-dessus du score minimum, quand l'envoi est possible sans vous (email du recruteur, La bonne alternance).</span>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Validation des envois</legend>
          {levels.map((l) => (
            <label key={l.id} className={cx('flex items-start gap-3 rounded-xl border p-3', draft.level === l.id ? 'border-brand-600 bg-brand-50/40' : 'border-slate-200')}>
              <input type="radio" name="level" className="mt-1 accent-brand-600" checked={draft.level === l.id} onChange={() => setDraft({ ...draft, level: l.id })} />
              <span className="text-sm"><strong className="text-slate-900">{l.label}</strong><br /><span className="text-slate-600">{l.help}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm text-slate-700">Score minimum (%)
            <input type="number" min={0} max={100} className="mt-1 w-full rounded-xl border border-slate-300 p-2" value={draft.minMatchScore} onChange={(e) => setDraft({ ...draft, minMatchScore: Number(e.target.value) })} />
          </label>
          <label className="text-sm text-slate-700">Envois max. par jour
            <input type="number" min={1} max={50} className="mt-1 w-full rounded-xl border border-slate-300 p-2" value={draft.dailyCap} onChange={(e) => setDraft({ ...draft, dailyCap: Number(e.target.value) })} />
          </label>
        </div>
        <label className="block text-sm text-slate-700">Entreprises exclues (séparées par des virgules)
          <input className="mt-1 w-full rounded-xl border border-slate-300 p-2" value={excluded} onChange={(e) => setExcluded(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="accent-brand-600" checked={draft.paused} onChange={(e) => setDraft({ ...draft, paused: e.target.checked })} />
          Mettre l'agent en pause
        </label>
        <Button variant="primary" disabled={busy === 'settings'} onClick={() => onSave({ ...draft, excludedCompanies: excluded.split(',').map((s) => s.trim()).filter(Boolean) })}>Enregistrer</Button>
      </div>

      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Mail className="h-4 w-4" aria-hidden="true" /> Boîte d'envoi</h3>
        {mail?.google?.status === 'active' ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            Les candidatures par email partent de <strong>{mail.google.email}</strong> et apparaissent dans vos « Messages envoyés ».
            <div className="mt-2"><Button size="sm" variant="secondary" disabled={busy === 'gmail'} onClick={onDisconnectGmail}>Déconnecter</Button></div>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-700">
            {mail?.google?.status === 'revoked' && <p className="mb-2 text-rose-700">L'accès à {mail.google.email} a été retiré : reconnectez la boîte.</p>}
            Connectez Gmail pour que l'agent envoie les candidatures depuis votre adresse. Kareer peut seulement envoyer des emails : il ne lit jamais votre boîte.
            <div className="mt-2">
              <Button size="sm" variant="primary" disabled={!mail?.gmailAvailable || busy === 'gmail'} onClick={onConnectGmail}>Connecter Gmail</Button>
              {!mail?.gmailAvailable && <p className="mt-2 text-xs text-slate-500">Connexion Gmail pas encore activée sur ce serveur.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Plus, Sparkles, Trash2, X } from 'lucide-react';
import type { JobOffer, TailoredCv, TailoredExperience, UserProfile } from '../../types';
import { apiFetch } from '../../utils/api';
import { Badge, Button, cx } from '../ui';

/** Même règle d'identifiant que le serveur (server/cvPipeline.ts → experienceId). */
export const experienceKey = (exp: { id?: string }, index: number) => exp?.id || `exp-${index + 1}`;

const PRESETS = ['Plus concis', 'Plus orienté résultats', 'Reprendre le vocabulaire de l’offre', 'Plus technique'];

type RewriteKind = 'bullet' | 'summary' | 'headline';

/** Zone de texte qui s'agrandit avec son contenu. */
const AutoTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className, value, ...rest }) => {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      {...rest}
      className={cx('block w-full resize-none overflow-hidden rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20', className)}
    />
  );
};

/** Retouche ciblée d'un texte par l'IA (consignes prédéfinies ou libres). */
const RewritePanel: React.FC<{
  text: string;
  kind: RewriteKind;
  job: JobOffer;
  userProfile: UserProfile;
  onDone: (text: string) => void;
  onClose: () => void;
}> = ({ text, kind, job, userProfile, onDone, onClose }) => {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (consigne: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/tailor/rewrite', { candidate: userProfile, job, text, instruction: consigne, kind });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || `Retouche impossible (${res.status}).`);
      if (data.rejected) {
        setMessage(data.rejected);
        return;
      }
      onDone(data.text);
      onClose();
    } catch (e: any) {
      setMessage(e?.message || 'Retouche impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50 p-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(p => (
          <button key={p} type="button" disabled={busy} onClick={() => run(p)}
            className="rounded-full border border-brand-200 bg-white px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50">
            {p}
          </button>
        ))}
      </div>
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (instruction.trim()) run(instruction); }}>
        <label className="sr-only" htmlFor={`rw-${kind}`}>Consigne de retouche</label>
        <input id={`rw-${kind}`} value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={busy} data-autofocus
          placeholder="Ou votre consigne : « mettre en avant la gestion de budget »…"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500" />
        <Button type="submit" size="sm" variant="primary" disabled={busy || !instruction.trim()}>{busy ? 'Réécriture…' : 'Proposer'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} aria-label="Fermer la retouche"><X className="h-3.5 w-3.5" /></Button>
      </form>
      {busy && <p className="mt-2 text-xs text-brand-700" role="status">L’IA reformule à partir de votre profil…</p>}
      {message && <p className="mt-2 text-xs text-amber-800" role="alert">{message}</p>}
    </div>
  );
};

/** Bouton « Retoucher » + panneau. */
const Retouch: React.FC<{ id: string; openId: string | null; setOpenId: (id: string | null) => void; label: string }> = ({ id, openId, setOpenId, label }) => (
  <button type="button" onClick={() => setOpenId(openId === id ? null : id)} aria-expanded={openId === id} aria-label={label}
    className={cx('inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors',
      openId === id ? 'bg-brand-100 text-brand-700' : 'text-slate-500 hover:bg-slate-100 hover:text-brand-700')}>
    <Sparkles className="h-3.5 w-3.5" /> Retoucher
  </button>
);

export const CvContentEditor: React.FC<{
  value: TailoredCv;
  onChange: (next: TailoredCv) => void;
  userProfile: UserProfile;
  job: JobOffer;
  disabled?: boolean;
}> = ({ value, onChange, userProfile, job, disabled }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const profileExps = userProfile.experiences || [];
  const byKey = new Map(profileExps.map((e, i) => [experienceKey(e, i), e]));

  const setExp = (index: number, patch: Partial<TailoredExperience>) =>
    onChange({ ...value, experiences: value.experiences.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  const moveExp = (index: number, dir: -1 | 1) => {
    const list = [...value.experiences];
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    [list[index], list[j]] = [list[j], list[index]];
    onChange({ ...value, experiences: list });
  };
  const moveSkill = (index: number, dir: -1 | 1) => {
    const list = [...value.skillsOrder];
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    [list[index], list[j]] = [list[j], list[index]];
    onChange({ ...value, skillsOrder: list });
  };
  const hiddenSkills = (userProfile.skills || []).filter(s => !value.skillsOrder.includes(s));

  const labelCls = 'mb-1.5 flex items-center justify-between gap-2 text-sm font-medium text-slate-700';

  return (
    <fieldset disabled={disabled} className="space-y-5">
      <p className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600">
        Le texte est reformulé par l’IA à partir de votre profil uniquement : les postes, entreprises et dates ne sont jamais modifiés.
        Chaque modification met à jour le CV instantanément.
      </p>

      {/* Titre */}
      <div>
        <div className={labelCls}>
          <label htmlFor="cv-headline">Titre du CV</label>
          <Retouch id="headline" openId={openId} setOpenId={setOpenId} label="Retoucher le titre" />
        </div>
        <input id="cv-headline" value={value.headline} onChange={(e) => onChange({ ...value, headline: e.target.value })}
          className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20" />
        {openId === 'headline' && (
          <RewritePanel text={value.headline} kind="headline" job={job} userProfile={userProfile}
            onDone={(t) => onChange({ ...value, headline: t })} onClose={() => setOpenId(null)} />
        )}
      </div>

      {/* Accroche */}
      <div>
        <div className={labelCls}>
          <label htmlFor="cv-summary">Accroche</label>
          <Retouch id="summary" openId={openId} setOpenId={setOpenId} label="Retoucher l’accroche" />
        </div>
        <AutoTextarea id="cv-summary" value={value.summary} onChange={(e) => onChange({ ...value, summary: e.target.value })} />
        <p className="mt-1 text-right text-[11px] text-slate-400">{value.summary.length} caractères</p>
        {openId === 'summary' && (
          <RewritePanel text={value.summary} kind="summary" job={job} userProfile={userProfile}
            onDone={(t) => onChange({ ...value, summary: t })} onClose={() => setOpenId(null)} />
        )}
      </div>

      {/* Expériences */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Expériences</h3>
        {value.experiences.map((exp, i) => {
          const source = byKey.get(exp.id);
          if (!source) return null;
          const dates = [source.startDate, source.endDate || (source.current ? 'Présent' : '')].filter(Boolean).join(' – ');
          return (
            <section key={exp.id} className={cx('rounded-2xl border p-4', exp.include ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-50')}
              aria-label={`${source.title} chez ${source.company}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">{source.title}</p>
                  <p className="text-xs text-slate-500">{[source.company, source.location, dates].filter(Boolean).join(' · ')}</p>
                </div>
                <div className="flex items-center gap-1">
                  <label className="mr-1 inline-flex items-center gap-1.5 text-xs text-slate-600">
                    <input type="checkbox" checked={exp.include} onChange={(e) => setExp(i, { include: e.target.checked })} className="h-4 w-4 accent-brand-600" />
                    Afficher sur le CV
                  </label>
                  <button type="button" onClick={() => moveExp(i, -1)} disabled={i === 0} aria-label="Monter l’expérience"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                  <button type="button" onClick={() => moveExp(i, 1)} disabled={i === value.experiences.length - 1} aria-label="Descendre l’expérience"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                </div>
              </div>

              {exp.include && (
                <ul className="mt-3 space-y-2">
                  {exp.bullets.map((b, bi) => {
                    const key = `${exp.id}-${bi}`;
                    return (
                      <li key={key}>
                        <div className="flex items-start gap-1.5">
                          <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden="true" />
                          <AutoTextarea aria-label={`Point ${bi + 1} — ${source.title}`} value={b}
                            onChange={(e) => setExp(i, { bullets: exp.bullets.map((x, k) => (k === bi ? e.target.value : x)) })} />
                          <div className="flex shrink-0 flex-col items-end gap-0.5 sm:flex-row sm:items-center">
                            <Retouch id={key} openId={openId} setOpenId={setOpenId} label={`Retoucher le point ${bi + 1}`} />
                            <button type="button" onClick={() => setExp(i, { bullets: exp.bullets.filter((_, k) => k !== bi) })} aria-label={`Supprimer le point ${bi + 1}`}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                        </div>
                        {openId === key && (
                          <div className="pl-3">
                            <RewritePanel text={b} kind="bullet" job={job} userProfile={userProfile}
                              onDone={(t) => setExp(i, { bullets: exp.bullets.map((x, k) => (k === bi ? t : x)) })} onClose={() => setOpenId(null)} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                  <li>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setExp(i, { bullets: [...exp.bullets, ''] })}>
                      <Plus className="h-3.5 w-3.5" /> Ajouter un point
                    </Button>
                  </li>
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {/* Compétences */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Compétences <span className="font-normal text-slate-500">(dans l’ordre du CV)</span></h3>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {value.skillsOrder.map((s, i) => (
            <li key={s} className="inline-flex items-center rounded-full border border-slate-200 bg-white text-sm text-slate-800">
              <button type="button" onClick={() => moveSkill(i, -1)} disabled={i === 0} aria-label={`Avancer ${s}`} className="rounded-l-full py-1 pl-1.5 pr-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" /></button>
              <span className="px-1">{s}</span>
              <button type="button" onClick={() => moveSkill(i, 1)} disabled={i === value.skillsOrder.length - 1} aria-label={`Reculer ${s}`} className="py-1 px-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronRight className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => onChange({ ...value, skillsOrder: value.skillsOrder.filter(x => x !== s) })} aria-label={`Retirer ${s} du CV`} className="rounded-r-full py-1 pl-0.5 pr-2 text-slate-400 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
        {hiddenSkills.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">Masquées :</span>
            {hiddenSkills.map(s => (
              <button key={s} type="button" onClick={() => onChange({ ...value, skillsOrder: [...value.skillsOrder, s] })} title="Remettre sur le CV">
                <Badge className="hover:bg-slate-200"><Plus className="h-3 w-3" />{s}</Badge>
              </button>
            ))}
          </div>
        )}
      </div>
    </fieldset>
  );
};

import React, { useState, useEffect } from 'react';
import {
  Save,
  Plus,
  Check,
  Briefcase,
  GraduationCap,
  FolderGit2,
  Sparkles,
  Link as LinkIcon,
  CheckCircle2,
  UserRound,
  Camera,
  X
} from 'lucide-react';
import { UserProfile, ContractType } from '../types';
import { User } from 'firebase/auth';
import { Button, PageHeader, cx } from './ui';
import { photoFileError, squareJpegPhoto } from '../utils/photo';

interface MasterProfileViewProps {
  userProfile: UserProfile;
  onSaveProfile: (updated: UserProfile) => Promise<void>;
  isSaving: boolean;
  currentUser?: User | null;
  onOpenAuthModal?: (mode: 'login' | 'register') => void;
  onOpenCvUpload?: () => void;
}

export const MasterProfileView: React.FC<MasterProfileViewProps> = ({
  userProfile,
  onSaveProfile,
  isSaving,
  currentUser,
  onOpenAuthModal,
  onOpenCvUpload
}) => {
  const [profile, setProfile] = useState<UserProfile>(userProfile);
  const [newSkill, setNewSkill] = useState('');
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProfile(userProfile);
  }, [userProfile]);

  const handleTextChange = (field: keyof UserProfile, value: any) => {
    setProfile(prev => ({ ...prev, [field]: value }));
  };

  const handleAddSkill = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSkill.trim()) return;
    if (!profile.skills.includes(newSkill.trim())) {
      setProfile(prev => ({ ...prev, skills: [...prev.skills, newSkill.trim()] }));
    }
    setNewSkill('');
  };

  const handleRemoveSkill = (skillToRemove: string) => {
    setProfile(prev => ({
      ...prev,
      skills: prev.skills.filter(s => s !== skillToRemove)
    }));
  };

  const handlePhotoFile = async (file?: File) => {
    setPhotoError(null);
    if (!file) return;
    const error = photoFileError(file);
    if (error) {
      setPhotoError(error);
      return;
    }
    try {
      const photo = await squareJpegPhoto(file);
      setProfile(prev => ({ ...prev, photo }));
    } catch {
      setPhotoError('Impossible de lire cette image : essayez une autre photo.');
    }
  };

  const handleToggleContract = (contract: ContractType) => {
    const current = profile.preferredContracts || [];
    const next = current.includes(contract)
      ? current.filter(c => c !== contract)
      : [...current, contract];
    setProfile(prev => ({ ...prev, preferredContracts: next }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await onSaveProfile(profile);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch {
      // L'erreur est affichée par App (toast)
    }
  };

  const uid = React.useId();
  const fid = (name: string) => `${uid}-${name}`;
  const inputClass =
    'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';
  const labelClass = 'mb-1.5 block text-sm font-medium text-slate-700';
  const cardClass = 'rounded-2xl border border-slate-200 bg-white p-5 space-y-4';
  const cardTitleClass = 'flex items-center gap-2 text-[15px] font-semibold text-slate-900';

  const field = (key: keyof UserProfile, label: string, opts: { type?: string; placeholder?: string; autoComplete?: string } = {}) => (
    <div className="min-w-0">
      <label htmlFor={fid(key)} className={labelClass}>{label}</label>
      <input
        id={fid(key)}
        type={opts.type || 'text'}
        autoComplete={opts.autoComplete}
        value={(profile[key] as string) || ''}
        onChange={(e) => handleTextChange(key, e.target.value)}
        placeholder={opts.placeholder}
        className={inputClass}
      />
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-6">

      {/* En-tête */}
      <PageHeader
        title="Mon profil"
        subtitle="La base de vos candidatures : le score de compatibilité, les CV et les lettres n’utilisent que ce qui est écrit ici."
        actions={
          <>
            {onOpenCvUpload && (
              <Button type="button" variant="secondary" onClick={onOpenCvUpload}>
                <Sparkles className="h-4 w-4 text-brand-600" aria-hidden="true" /> Importer un CV
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={isSaving}>
              {savedSuccess
                ? (<><Check className="h-4 w-4" aria-hidden="true" /> Enregistré</>)
                : (<><Save className="h-4 w-4" aria-hidden="true" /> {isSaving ? 'Enregistrement…' : 'Enregistrer'}</>)}
            </Button>
          </>
        }
      />

      {/* État du compte */}
      {currentUser ? (
        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-900">
                Compte connecté : <span className="break-all">{currentUser.email}</span>
              </p>
              <p className="mt-0.5 text-xs text-emerald-700">
                Votre profil et vos candidatures sont synchronisés automatiquement.
              </p>
            </div>
          </div>
          <span className="self-start rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-700 sm:self-auto">
            Synchronisé
          </span>
        </div>
      ) : (
        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50 p-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">Session locale (non connecté)</p>
              <p className="mt-0.5 text-xs text-slate-600">
                Créez un compte gratuit pour conserver vos candidatures et vos CV, et les retrouver sur tous vos appareils.
              </p>
            </div>
          </div>
          {onOpenAuthModal && (
            <Button type="button" variant="primary" onClick={() => onOpenAuthModal('register')} className="self-start sm:self-auto">
              Créer un compte
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">

        {/* Colonne gauche : coordonnées, liens, contrats */}
        <div className="min-w-0 space-y-6 lg:col-span-4">

          <section className={cardClass} aria-labelledby={fid('s-contact')}>
            <h2 id={fid('s-contact')} className={cardTitleClass}>
              <UserRound className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Coordonnées
            </h2>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200">
                {profile.photo
                  ? <img src={profile.photo} alt="Votre photo de CV" className="h-full w-full object-cover" />
                  : <UserRound className="h-7 w-7 text-slate-400" aria-hidden="true" />}
              </div>
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => photoInputRef.current?.click()}>
                    <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                    {profile.photo ? 'Changer la photo' : 'Ajouter une photo'}
                  </Button>
                  {profile.photo && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setProfile(prev => ({ ...prev, photo: '' })); setPhotoError(null); }}>
                      Retirer
                    </Button>
                  )}
                </div>
                <p className="text-xs text-slate-500">Facultative. Affichée seulement sur les CV « Photo » et « Créatif ». Jamais envoyée à l’IA.</p>
              </div>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                tabIndex={-1}
                aria-label="Choisir une photo de CV"
                onChange={(e) => { handlePhotoFile(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>
            {photoError && <p role="alert" className="text-sm text-rose-700">{photoError}</p>}
            <div className="space-y-3">
              {field('fullName', 'Nom complet', { autoComplete: 'name' })}
              {field('title', 'Poste recherché', { autoComplete: 'organization-title' })}
              {field('email', 'Adresse e-mail', { type: 'email', autoComplete: 'email' })}
              {field('phone', 'Téléphone', { type: 'tel', autoComplete: 'tel' })}
              {field('location', 'Ville et mobilité')}
            </div>
          </section>

          <section className={cardClass} aria-labelledby={fid('s-links')}>
            <h2 id={fid('s-links')} className={cardTitleClass}>
              <LinkIcon className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Liens et Overleaf
            </h2>
            <div className="space-y-3">
              {field('githubUrl', 'Portfolio / lien professionnel (facultatif)', { placeholder: 'mon-portfolio.fr, site pro ou GitHub' })}
              {field('linkedinUrl', 'Profil LinkedIn', { placeholder: 'linkedin.com/in/mon-profil' })}
              {field('overleafUser', 'Identifiant Overleaf (facultatif)', { placeholder: 'mon_pseudo_overleaf' })}
            </div>
          </section>

          <section className={cardClass} aria-labelledby={fid('s-contracts')}>
            <h2 id={fid('s-contracts')} className={cardTitleClass}>Contrats recherchés</h2>
            <div className="flex flex-wrap gap-2">
              {(['stage', 'alternance', 'cdi', 'cdd', 'freelance'] as ContractType[]).map((c) => {
                const active = !!profile.preferredContracts?.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => handleToggleContract(c)}
                    aria-pressed={active}
                    className={cx(
                      'rounded-xl border px-3 py-1.5 text-sm font-semibold transition-colors',
                      c === 'cdi' || c === 'cdd' ? 'uppercase' : 'capitalize',
                      active ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                    )}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </section>

        </div>

        {/* Colonne droite : résumé, compétences, expériences, formations */}
        <div className="min-w-0 space-y-6 lg:col-span-8">

          <section className={cardClass}>
            <label htmlFor={fid('summary')} className={cardTitleClass}>
              <Sparkles className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Résumé
            </label>
            <textarea
              id={fid('summary')}
              value={profile.summary}
              onChange={(e) => handleTextChange('summary', e.target.value)}
              rows={4}
              className={cx(inputClass, 'resize-y leading-relaxed')}
            />
          </section>

          <section className={cardClass} aria-labelledby={fid('s-skills')}>
            <div>
              <h2 id={fid('s-skills')} className={cardTitleClass}>
                Compétences ({profile.skills.length})
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Elles servent au calcul de compatibilité et sont mises en avant dans vos CV. N'ajoutez que des compétences réelles.
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <label htmlFor={fid('new-skill')} className="sr-only">Nouvelle compétence</label>
              <input
                id={fid('new-skill')}
                type="text"
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddSkill(e); }}
                placeholder="Ex. Négociation, Recrutement, Excel, Gestion de projet, Python…"
                className={cx(inputClass, 'min-w-0 flex-1')}
              />
              <Button type="button" variant="primary" onClick={handleAddSkill}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Ajouter
              </Button>
            </div>

            {profile.skills.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Compétences">
                {profile.skills.map((skill) => (
                  <li key={skill} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 py-1 pl-2.5 pr-1 text-sm font-medium text-brand-700">
                    <span className="truncate">{skill}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveSkill(skill)}
                      aria-label={`Retirer la compétence ${skill}`}
                      className="rounded p-0.5 text-brand-400 hover:bg-white hover:text-rose-600"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Aucune compétence pour l'instant.</p>
            )}
          </section>

          <section className={cardClass} aria-labelledby={fid('s-exp')}>
            <h2 id={fid('s-exp')} className={cardTitleClass}>
              <Briefcase className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Expériences
            </h2>

            <div className="space-y-3">
              {profile.experiences.map((exp) => (
                <article key={exp.id} className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                    <h3 className="text-sm font-semibold text-slate-900">{exp.title} — {exp.company}</h3>
                    <span className="shrink-0 text-xs text-slate-500">{exp.startDate} - {exp.endDate}</span>
                  </div>
                  {exp.bullets.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                      {exp.bullets.map((bullet, bidx) => (
                        <li key={bidx}>{bullet}</li>
                      ))}
                    </ul>
                  )}
                  {exp.technologies.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {exp.technologies.map((t, ti) => (
                        <span key={ti} className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
              {profile.experiences.length === 0 && (
                <p className="text-sm text-slate-500">Aucune expérience. Importez votre CV pour les ajouter.</p>
              )}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">

            <section className={cardClass} aria-labelledby={fid('s-edu')}>
              <h2 id={fid('s-edu')} className={cardTitleClass}>
                <GraduationCap className="h-4 w-4 text-brand-600" aria-hidden="true" />
                Formations
              </h2>
              <div className="space-y-2.5">
                {profile.education.map((edu) => (
                  <div key={edu.id} className="space-y-0.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                    <p className="font-semibold text-slate-900">{edu.degree}</p>
                    <p className="text-slate-600">{edu.institution} ({edu.year})</p>
                    {edu.details && <p className="text-xs text-slate-500">{edu.details}</p>}
                  </div>
                ))}
                {profile.education.length === 0 && <p className="text-sm text-slate-500">Aucune formation.</p>}
              </div>
            </section>

            <section className={cardClass} aria-labelledby={fid('s-proj')}>
              <h2 id={fid('s-proj')} className={cardTitleClass}>
                <FolderGit2 className="h-4 w-4 text-brand-600" aria-hidden="true" />
                Projets
              </h2>
              <div className="space-y-2.5">
                {profile.projects.map((proj) => (
                  <div key={proj.id} className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                    <p className="font-semibold text-slate-900">{proj.name}</p>
                    <p className="text-xs leading-relaxed text-slate-600">{proj.description}</p>
                    {proj.technologies.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {proj.technologies.map((t, ti) => (
                          <span key={ti} className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {profile.projects.length === 0 && <p className="text-sm text-slate-500">Aucun projet.</p>}
              </div>
            </section>

          </div>

        </div>

      </div>

    </form>
  );
};

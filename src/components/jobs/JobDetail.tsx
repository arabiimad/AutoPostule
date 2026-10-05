import React from 'react';
import {
  ArrowLeft, Bookmark, BookmarkCheck, Briefcase, CalendarClock, CheckCircle2, Clock, ExternalLink, FileText,
  Laptop, Link2, MapPin, Navigation, Upload, Wallet, Zap, Check, Share2, Building2, Globe, Users
} from 'lucide-react';
import type { Application, JobOffer, UserProfile } from '../../types';
import type { CandidateMatch } from '../../utils/skillMatcher';
import { getApplyUrl, buildJobSearchLinks } from '../../utils/jobLinks';
import { Badge, Button, CompanyAvatar, LinkButton, MatchRing, cx } from '../ui';
import { CONTRACT_LABELS, REMOTE_LABELS, formatLongDate, publishedPhrase, sourceShortName } from '../../utils/format';

interface JobDetailProps {
  job: JobOffer;
  match: CandidateMatch;
  userProfile: UserProfile;
  application?: Application;
  onToggleSave: () => void;
  onPrepare: () => void;
  onExpressApply: () => void;
  onOpenCvUpload?: () => void;
  /** Mobile : bouton retour vers la liste. */
  onBack?: () => void;
  busy?: boolean;
  /** Lien direct vers cette offre dans AutoPostule (partage). */
  shareUrl?: string;
}

const Section: React.FC<{ title: string; children: React.ReactNode; className?: string }> = ({ title, children, className }) => (
  <section className={cx('border-t border-slate-100 px-5 sm:px-7 py-6', className)}>
    <h3 className="mb-3 text-[15px] font-semibold text-slate-900">{title}</h3>
    {children}
  </section>
);

const Meta: React.FC<{ icon: React.ElementType; children: React.ReactNode }> = ({ icon: Icon, children }) => (
  <span className="inline-flex items-center gap-1.5 text-sm text-slate-600"><Icon className="h-4 w-4 text-slate-400" />{children}</span>
);

export const JobDetail: React.FC<JobDetailProps> = ({ job, match, userProfile, application, onToggleSave, onPrepare, onExpressApply, onOpenCvUpload, onBack, busy, shareUrl }) => {
  const [copied, setCopied] = React.useState(false);
  const [shared, setShared] = React.useState(false);
  const spontaneous = !!job.isSpontaneous;
  const siren = job.siret && /^\d{14}$/.test(job.siret) ? job.siret.slice(0, 9) : null;
  const website = job.companyWebsite ? (/^https?:\/\//i.test(job.companyWebsite) ? job.companyWebsite : `https://${job.companyWebsite}`) : null;

  const share = async () => {
    const url = shareUrl || applyUrl;
    try {
      if (navigator.share && !window.matchMedia('(min-width: 1024px)').matches) {
        await navigator.share({ title: `${job.title} — ${job.company}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 1800);
    } catch { /* partage annulé */ }
  };
  const applyUrl = getApplyUrl(job);
  const links = buildJobSearchLinks(job);
  const hasProfile = userProfile.skills.length > 0;
  const saved = !!application;
  const remote = REMOTE_LABELS[job.remote];
  const hasCoords = typeof job.latitude === 'number' && typeof job.longitude === 'number';
  const destination = hasCoords ? `${job.latitude},${job.longitude}` : `${job.company} ${job.location}`;
  const itineraryUrl = `https://www.google.com/maps/dir/?api=1${userProfile.location ? `&origin=${encodeURIComponent(userProfile.location)}` : ''}&destination=${encodeURIComponent(destination)}`;
  const mapEmbed = hasCoords
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${job.longitude! - 0.02},${job.latitude! - 0.012},${job.longitude! + 0.02},${job.latitude! + 0.012}&layer=mapnik&marker=${job.latitude},${job.longitude}`
    : null;

  // Autres plateformes où postuler : options JSearch + doublons fusionnés (sans répéter le lien principal)
  const otherApply = [
    ...(job.applyOptions || []).map(o => ({ source: o.publisher, url: o.url })),
    ...(job.alsoOn || [])
  ].filter((o, i, arr) => o.url !== applyUrl && arr.findIndex(x => x.url === o.url) === i).slice(0, 8);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(applyUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  const statusText: Record<string, string> = {
    detected: 'Offre sauvegardée dans vos candidatures.',
    prepared: 'Votre dossier (CV + lettre) est prêt : il reste à postuler sur le site.',
    applied: 'Candidature envoyée.',
    interview: 'Entretien en cours — préparez-le dans l’onglet Entretiens.',
    offer: 'Offre reçue.',
    rejected: 'Candidature refusée.'
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {onBack && (
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Retour aux offres</Button>
        </div>
      )}

      {/* En-tête */}
      <div className="px-5 sm:px-7 pt-6 pb-5">
        <div className="flex items-start gap-4">
          <CompanyAvatar name={job.company} logo={job.companyLogo} size={56} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-600">{job.company}</p>
            <h2 className="mt-0.5 text-xl sm:text-2xl font-bold leading-tight tracking-tight text-slate-900 break-words">{job.title}</h2>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Meta icon={Briefcase}>{CONTRACT_LABELS[job.contractType] || job.contractType}</Meta>
          {job.location && <Meta icon={MapPin}>{job.location}</Meta>}
          {remote && <Meta icon={Laptop}>{remote}</Meta>}
          {job.salary && <Meta icon={Wallet}>{job.salary}</Meta>}
          {job.publishedAt && <Meta icon={Clock}>{publishedPhrase(job.publishedAt)}</Meta>}
          {job.expiresAt && <Meta icon={CalendarClock}>Expire le {formatLongDate(job.expiresAt)}</Meta>}
        </div>

        <p className="mt-3 text-xs text-slate-500">
          {job.origin === 'demo'
            ? 'Offre de démonstration — vérifiez son existence sur le site de l’entreprise.'
            : <>Source : <span className="font-medium text-slate-700">{job.source}</span>{job.origin === 'ia-web' && ' — trouvée par recherche IA, à vérifier'}</>}
        </p>

        {/* Actions */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <LinkButton href={applyUrl} target="_blank" rel="noopener noreferrer" variant="primary" size="md" className="h-11">
            {spontaneous ? 'Candidater spontanément' : job.origin === 'site-carriere' ? `Postuler sur le site de ${job.company}` : `Postuler${job.origin !== 'demo' ? ` sur ${sourceShortName(job.source)}` : ''}`} <ExternalLink className="h-4 w-4" />
          </LinkButton>
          <Button variant="secondary" size="md" className="h-11" onClick={onPrepare} title={spontaneous ? 'Générer un CV et une lettre de candidature spontanée pour cette entreprise' : 'Générer et relire un CV LaTeX et une lettre adaptés à cette offre'}>
            <FileText className="h-4 w-4" /> {spontaneous ? 'Préparer CV + lettre spontanée' : 'Préparer CV + lettre'}
          </Button>
          <Button variant="secondary" size="md" className="h-11" onClick={onToggleSave} aria-pressed={saved} title={saved ? 'Déjà dans vos candidatures' : 'Sauvegarder cette offre'}>
            {saved ? <BookmarkCheck className="h-4 w-4 text-brand-600" /> : <Bookmark className="h-4 w-4" />}
            {saved ? 'Sauvegardée' : 'Sauvegarder'}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onExpressApply} disabled={busy} title="Génère le CV et la lettre, ouvre le site de l’entreprise et ajoute l’offre à vos candidatures">
            <Zap className="h-3.5 w-3.5" /> {busy ? 'Préparation…' : 'Candidature express'}
          </Button>
          <Button variant="ghost" size="sm" onClick={copyLink} title="Copier le lien de candidature">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Link2 className="h-3.5 w-3.5" />} {copied ? 'Lien copié' : 'Copier le lien'}
          </Button>
          {shareUrl && (
            <Button variant="ghost" size="sm" onClick={share} title="Partager cette fiche (lien vers AutoPostule)">
              {shared ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Share2 className="h-3.5 w-3.5" />} {shared ? 'Lien de la fiche copié' : 'Partager'}
            </Button>
          )}
        </div>

        {application && (
          <div className="mt-4 flex items-start gap-2 rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm text-brand-900">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
            <span>{statusText[application.status] || 'Dans vos candidatures.'}</span>
          </div>
        )}
      </div>

      {/* Compatibilité (sans objet pour une candidature spontanée : pas de compétences listées) */}
      {!spontaneous && <Section title="Votre compatibilité">
        {hasProfile ? (
          match.score === null ? (
            <p className="text-sm text-slate-500">Cette offre ne liste pas de compétences précises : lisez le descriptif pour juger de votre adéquation.</p>
          ) : (
            <div className="flex flex-col sm:flex-row gap-5">
              <MatchRing score={match.score} size={64} label />
              <div className="flex-1 space-y-3">
                {match.matchedKeywords.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Dans votre profil</p>
                    <div className="flex flex-wrap gap-1.5">
                      {match.matchedKeywords.map(k => <Badge key={k} tone="green"><Check className="h-3 w-3" />{k}</Badge>)}
                    </div>
                  </div>
                )}
                {match.missingKeywords.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Absentes de votre profil</p>
                    <div className="flex flex-wrap gap-1.5">
                      {match.missingKeywords.map(k => <Badge key={k}>{k}</Badge>)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 p-4">
            <p className="text-sm text-slate-600">Importez votre CV pour voir quelles compétences de l’offre vous avez déjà.</p>
            {onOpenCvUpload && <Button variant="secondary" size="sm" onClick={onOpenCvUpload}><Upload className="h-3.5 w-3.5" /> Importer mon CV</Button>}
          </div>
        )}
      </Section>}

      {/* Descriptif */}
      <Section title={spontaneous ? 'Pourquoi candidater ici' : 'Descriptif du poste'}>
        {job.description ? (
          <p className="job-prose">{job.description}</p>
        ) : (
          <p className="text-sm text-slate-500">La source ne fournit pas de descriptif.</p>
        )}
        {job.descriptionIsSnippet && (
          <p className="mt-4 text-sm text-slate-600">
            Ceci n’est qu’un extrait.{' '}
            <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 hover:underline">Lire l’annonce complète ↗</a>
          </p>
        )}
      </Section>

      {/* Entreprise */}
      {(job.companySector || job.companySize || website || siren || spontaneous) && (
        <Section title="L’entreprise">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {job.companySector && <Meta icon={Building2}>{job.companySector}</Meta>}
            {job.companySize && <Meta icon={Users}>{/salari/i.test(job.companySize) ? job.companySize : `${job.companySize} salariés`}</Meta>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {website && <LinkButton href={website} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm"><Globe className="h-3.5 w-3.5" /> Site web</LinkButton>}
            {siren && (
              <LinkButton href={`https://annuaire-entreprises.data.gouv.fr/entreprise/${siren}`} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm" title="Fiche officielle : dirigeants, effectifs, adresse">
                Fiche officielle ↗
              </LinkButton>
            )}
            <LinkButton href={`https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(job.company)}`} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm">LinkedIn ↗</LinkButton>
          </div>
          {spontaneous && (
            <p className="mt-4 rounded-xl bg-sky-50 px-3.5 py-2.5 text-sm text-sky-800">
              Cette entreprise n’a pas d’offre en ligne mais recrute régulièrement des alternants : adressez-lui une candidature spontanée ciblée (CV + lettre adaptés au métier recherché).
            </p>
          )}
        </Section>
      )}

      {/* Localisation (réelle, sans estimation inventée) */}
      {job.location && (
        <Section title="Localisation">
          <p className="flex items-start gap-2 text-sm text-slate-700"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />{job.location}</p>
          {mapEmbed && (
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
              <iframe title={`Carte : ${job.location}`} src={mapEmbed} loading="lazy" className="h-48 w-full" referrerPolicy="no-referrer" />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <LinkButton href={itineraryUrl} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
              <Navigation className="h-3.5 w-3.5" /> Itinéraire{userProfile.location ? ` depuis ${userProfile.location}` : ''}
            </LinkButton>
            {hasCoords && (
              <LinkButton href={`https://www.openstreetmap.org/?mlat=${job.latitude}&mlon=${job.longitude}#map=15/${job.latitude}/${job.longitude}`} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm">
                Agrandir la carte ↗
              </LinkButton>
            )}
          </div>
        </Section>
      )}

      {/* Autres plateformes */}
      <Section title={otherApply.length ? 'Postuler aussi via' : 'Retrouver l’offre ailleurs'} className="pb-10">
        {otherApply.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {otherApply.map(o => (
              <LinkButton key={o.url} href={o.url} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
                {sourceShortName(o.source)} <ExternalLink className="h-3 w-3" />
              </LinkButton>
            ))}
          </div>
        )}
        <p className="mb-2 text-xs text-slate-500">Recherches préremplies avec le nom de l’entreprise :</p>
        <div className="flex flex-wrap gap-2 text-sm">
          {[
            ['LinkedIn', links.linkedin],
            ['Indeed', links.indeed],
            ['Welcome to the Jungle', links.wttj],
            ['France Travail', links.franceTravail],
            ...(job.contractType === 'alternance' || job.contractType === 'stage' ? [['1jeune1solution', links.unJeuneUneSolution]] : []),
            ['Google', links.google],
            ...(links.officialPortal ? [['Site carrières', links.officialPortal]] : [])
          ].map(([label, url]) => (
            <a key={label} href={url} target="_blank" rel="noopener noreferrer" className="rounded-lg px-2.5 py-1 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900">
              {label}
            </a>
          ))}
        </div>
      </Section>
    </div>
  );
};

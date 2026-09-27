import React from 'react';
import { Bookmark, BookmarkCheck, MapPin } from 'lucide-react';
import type { Application, JobOffer } from '../../types';
import type { JobFit } from '../../utils/skillMatcher';
import { Badge, CompanyAvatar, FitBadge, cx } from '../ui';
import { CONTRACT_LABELS, REMOTE_LABELS, formatRelativeDate, sourceShortName } from '../../utils/format';

interface JobCardProps {
  job: JobOffer;
  match: JobFit;
  showMatch: boolean;
  selected: boolean;
  application?: Application;
  onSelect: () => void;
  onToggleSave: () => void;
}

const STATUS_BADGE: Record<string, { label: string; tone: 'brand' | 'green' | 'amber' | 'rose' | 'neutral' | 'sky' }> = {
  detected: { label: 'Sauvegardée', tone: 'neutral' },
  prepared: { label: 'Dossier prêt', tone: 'brand' },
  applied: { label: 'Candidature envoyée', tone: 'sky' },
  interview: { label: 'Entretien', tone: 'green' },
  offer: { label: 'Offre reçue', tone: 'green' },
  rejected: { label: 'Refusée', tone: 'rose' }
};

export const JobCard: React.FC<JobCardProps> = ({ job, match, showMatch, selected, application, onSelect, onToggleSave }) => {
  const saved = !!application;
  const status = application ? STATUS_BADGE[application.status] : null;
  const remote = REMOTE_LABELS[job.remote];

  return (
    <article
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${job.title} — ${job.company}`}
      className={cx(
        'group relative cursor-pointer rounded-2xl border bg-white p-4 sm:p-5 transition-all outline-none',
        selected ? 'border-brand-500 ring-1 ring-brand-500 shadow-sm' : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
      )}
    >
      <div className="flex gap-3.5">
        <CompanyAvatar name={job.company} logo={job.companyLogo} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className={cx('text-[15px] font-semibold leading-snug line-clamp-2', selected ? 'text-brand-700' : 'text-slate-900 group-hover:text-brand-700')}>
                {job.title}
              </h3>
              <p className="mt-0.5 truncate text-sm text-slate-600">{job.company}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); onToggleSave(); }}
                aria-label={saved ? 'Offre sauvegardée' : 'Sauvegarder l’offre'}
                title={saved ? (application?.status === 'detected' ? 'Retirer des offres sauvegardées' : 'Déjà dans vos candidatures') : 'Sauvegarder'}
                className={cx('rounded-lg p-2 transition-colors', saved ? 'text-brand-600 hover:bg-brand-50' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700')}
              >
                {saved ? <BookmarkCheck className="h-5 w-5" /> : <Bookmark className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {job.location && (
            <p className="mt-1.5 flex items-center gap-1 text-[13px] text-slate-500">
              <MapPin className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{job.location}</span>
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {showMatch && !job.isSpontaneous && <FitBadge level={match.level} />}
            {job.isSpontaneous && <Badge tone="sky" title="Entreprise qui recrute en alternance sans offre publiée">Candidature spontanée</Badge>}
            <Badge tone="brand">{CONTRACT_LABELS[job.contractType] || job.contractType}</Badge>
            {remote && <Badge>{remote}</Badge>}
            {job.salary && <Badge tone="green">{job.salary}</Badge>}
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
          </div>

          <p className="mt-3 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
            {job.publishedAt && <><span>{formatRelativeDate(job.publishedAt)}</span><span aria-hidden="true">·</span></>}
            {job.isSpontaneous && job.companySize && <><span>{job.companySize} salariés</span><span aria-hidden="true">·</span></>}
            <span>{job.origin === 'demo' ? 'Offre de démonstration' : sourceShortName(job.source)}</span>
            {job.alsoOn && job.alsoOn.length > 0 && <span>+{job.alsoOn.length} autre{job.alsoOn.length > 1 ? 's' : ''} source{job.alsoOn.length > 1 ? 's' : ''}</span>}
          </p>
        </div>
      </div>
    </article>
  );
};

export const JobCardSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-slate-200 bg-white p-5">
    <div className="flex gap-3.5">
      <div className="skeleton h-12 w-12 rounded-xl" />
      <div className="flex-1 space-y-2.5">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3.5 w-1/3" />
        <div className="skeleton h-3 w-1/2" />
        <div className="flex gap-2 pt-1"><div className="skeleton h-5 w-16" /><div className="skeleton h-5 w-24" /></div>
      </div>
    </div>
  </div>
);

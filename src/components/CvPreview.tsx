import React, { useState, useEffect } from 'react';
import {
  FileText,
  Printer,
  Maximize2,
  ZoomIn,
  ZoomOut,
  Sparkles,
  ExternalLink,
  Mail,
  Phone,
  MapPin,
  CheckCircle2,
  Globe,
  Download,
  RefreshCw,
  Eye
} from 'lucide-react';
import { UserProfile, JobOffer, CvTemplate } from '../types';
import { calculateCandidateMatch, candidateHasSkill } from '../utils/skillMatcher';
import { Button, Badge, cx } from './ui';

interface CvPreviewProps {
  userProfile: UserProfile;
  job: JobOffer | null;
  template: CvTemplate;
  sector?: string;
  onDownloadPdf?: () => void;
  isDownloadingPdf?: boolean;
}

export function getSectorAccent(sector?: string): {
  hex: string;
  bgLight: string;
  borderLight: string;
  label: string;
} {
  const s = String(sector || '').toLowerCase();
  if (s.includes('finance') || s.includes('banque') || s.includes('assurance')) {
    return {
      hex: '#1e50a0',
      bgLight: 'bg-blue-50',
      borderLight: 'border-blue-200',
      label: 'Corporate / Finance (Bleu)'
    };
  }
  if (s.includes('marketing') || s.includes('design') || s.includes('communication') || s.includes('luxe')) {
    return {
      hex: '#8c1e3c',
      bgLight: 'bg-rose-50',
      borderLight: 'border-rose-200',
      label: 'Design / Marketing (Bordeaux)'
    };
  }
  if (s.includes('santé') || s.includes('medical') || s.includes('biotech')) {
    return {
      hex: '#0f766e',
      bgLight: 'bg-teal-50',
      borderLight: 'border-teal-200',
      label: 'Santé & Biotech (Teal)'
    };
  }
  // Vert Connektica par défaut
  return {
    hex: '#3c963c',
    bgLight: 'bg-emerald-50',
    borderLight: 'border-emerald-200',
    label: 'Connektica (Vert)'
  };
}

export const CvPreview: React.FC<CvPreviewProps> = ({
  userProfile,
  job,
  template,
  sector,
  onDownloadPdf,
  isDownloadingPdf
}) => {
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [viewMode, setViewMode] = useState<'visual' | 'pdf'>('visual');
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [isLoadingPdfViewer, setIsLoadingPdfViewer] = useState<boolean>(false);
  const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);

  const detectedSector = sector || job?.domain || job?.companySector;
  const accent = getSectorAccent(detectedSector);

  const ownSkills = userProfile?.skills || [];
  const requirements = job?.skillsRequired || [];
  const isRelevant = (skill: string) => requirements.some(req => candidateHasSkill([skill], req));

  // Tri des compétences : compétences requises en premier
  const sortedSkills = Array.from(
    new Set([...ownSkills.filter(isRelevant), ...ownSkills.filter(s => !isRelevant(s))])
  );

  const isCompact = template === 'compact';
  const isModern = template === 'moderncv';

  // Charger le PDF pour la liseuse intégrée si l'utilisateur bascule sur "pdf"
  useEffect(() => {
    let active = true;
    if (viewMode === 'pdf' && !pdfBlobUrl) {
      setIsLoadingPdfViewer(true);
      setPdfLoadError(null);

      fetch('/api/cv/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidate: userProfile,
          job,
          template,
          sector: detectedSector
        })
      })
        .then(async res => {
          if (!res.ok) {
            const err = await res.json().catch(() => null);
            throw new Error(err?.message || `Erreur serveur (${res.status})`);
          }
          return res.blob();
        })
        .then(blob => {
          if (!active) return;
          const url = URL.createObjectURL(blob);
          setPdfBlobUrl(url);
        })
        .catch(err => {
          if (!active) return;
          setPdfLoadError(err.message || 'Impossible de charger le PDF.');
        })
        .finally(() => {
          if (active) setIsLoadingPdfViewer(false);
        });
    }

    return () => {
      active = false;
    };
  }, [viewMode, template, userProfile, job, detectedSector, pdfBlobUrl]);

  // Si le template change, réinitialiser le blob PDF pour forcer un rechargement
  useEffect(() => {
    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      setPdfBlobUrl(null);
    }
  }, [template]);

  const handlePrint = () => {
    window.print();
  };

  const handleRefreshPdfViewer = () => {
    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      setPdfBlobUrl(null);
    }
    setViewMode('pdf');
  };

  return (
    <div className="flex flex-col space-y-4">
      {/* Barre d'outils de l'aperçu */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {/* Toggle mode de vue */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
            <button
              type="button"
              onClick={() => setViewMode('visual')}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                viewMode === 'visual'
                  ? 'bg-brand-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              )}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              Aperçu A4 réactif
            </button>
            <button
              type="button"
              onClick={() => setViewMode('pdf')}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                viewMode === 'pdf'
                  ? 'bg-brand-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              )}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              Liseuse PDF vectoriel
            </button>
          </div>

          {/* Indicateur de style sectoriel */}
          <div className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-black/10"
              style={{ backgroundColor: accent.hex }}
              aria-hidden="true"
            />
            <span className="font-medium">{accent.label}</span>
          </div>
        </div>

        {/* Zoom & Impression */}
        <div className="flex flex-wrap items-center gap-2">
          {viewMode === 'visual' && (
            <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setZoomLevel(prev => Math.max(70, prev - 10))}
                title="Zoom arrière"
                disabled={zoomLevel <= 70}
                className="p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30"
              >
                <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span className="w-11 text-center text-xs font-mono font-medium text-slate-600">
                {zoomLevel}%
              </span>
              <button
                type="button"
                onClick={() => setZoomLevel(prev => Math.min(130, prev + 10))}
                title="Zoom avant"
                disabled={zoomLevel >= 130}
                className="p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30"
              >
                <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setZoomLevel(100)}
                title="Taille réelle"
                className="ml-1 border-l border-slate-200 pl-1.5 text-xs text-slate-500 hover:text-brand-600"
              >
                100%
              </button>
            </div>
          )}

          {viewMode === 'pdf' && (
            <Button size="sm" variant="ghost" onClick={handleRefreshPdfViewer} title="Régénérer le PDF">
              <RefreshCw className={cx('h-3.5 w-3.5', isLoadingPdfViewer && 'animate-spin')} aria-hidden="true" />
              Rafraîchir
            </Button>
          )}

          <Button size="sm" variant="secondary" onClick={handlePrint} title="Imprimer ou enregistrer en PDF via le navigateur">
            <Printer className="h-3.5 w-3.5" aria-hidden="true" />
            Imprimer
          </Button>

          {onDownloadPdf && (
            <Button
              size="sm"
              variant="primary"
              onClick={onDownloadPdf}
              disabled={isDownloadingPdf}
              title="Télécharger le fichier PDF vectoriel sur votre ordinateur"
            >
              <Download className={cx('h-3.5 w-3.5', isDownloadingPdf && 'animate-spin')} aria-hidden="true" />
              {isDownloadingPdf ? 'Génération…' : 'Télécharger le PDF'}
            </Button>
          )}
        </div>
      </div>

      {/* Contenu principal : Vue Liseuse PDF */}
      {viewMode === 'pdf' && (
        <div className="relative min-h-[580px] w-full rounded-2xl border border-slate-200 bg-slate-900/5 p-2 overflow-hidden flex flex-col items-center justify-center">
          {isLoadingPdfViewer && (
            <div className="flex flex-col items-center gap-3 py-16 text-slate-500">
              <RefreshCw className="h-8 w-8 animate-spin text-brand-600" aria-hidden="true" />
              <p className="text-sm font-medium">Génération du PDF vectoriel avec Chromium…</p>
            </div>
          )}

          {pdfLoadError && (
            <div className="flex flex-col items-center gap-3 py-16 text-rose-600 max-w-md text-center px-4">
              <p className="text-sm font-medium">{pdfLoadError}</p>
              <Button size="sm" variant="secondary" onClick={handleRefreshPdfViewer}>
                Réessayer
              </Button>
            </div>
          )}

          {!isLoadingPdfViewer && !pdfLoadError && pdfBlobUrl && (
            <iframe
              src={pdfBlobUrl}
              title="Aperçu PDF vectoriel"
              className="w-full h-[650px] rounded-xl border border-slate-300 shadow-inner bg-white"
            />
          )}
        </div>
      )}

      {/* Contenu principal : Vue Document A4 Réactif */}
      {viewMode === 'visual' && (
        <div className="relative overflow-x-auto rounded-2xl border border-slate-200/80 bg-slate-100/70 p-4 sm:p-8 flex justify-center shadow-inner">
          <div
            id="cv-preview-sheet"
            style={{
              transform: `scale(${zoomLevel / 100})`,
              transformOrigin: 'top center',
              transition: 'transform 0.15s ease'
            }}
            className={cx(
              'w-full max-w-[794px] min-h-[1050px] bg-white text-slate-800 shadow-2xl rounded-sm p-8 sm:p-12 transition-all font-sans',
              isCompact ? 'text-[12px] leading-[1.4] p-6 sm:p-8' : 'text-[13px] leading-[1.5]'
            )}
          >
            {/* EN-TÊTE DU CV */}
            <header
              className={cx(
                'border-b-2 pb-3 mb-5',
                isCompact && 'pb-2 mb-3'
              )}
              style={{ borderBottomColor: accent.hex }}
            >
              <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
                <div>
                  <h1 className={cx('font-extrabold text-slate-900 tracking-tight', isCompact ? 'text-2xl' : 'text-3xl')}>
                    {userProfile.fullName || 'Votre Nom'}
                  </h1>
                  <div
                    className={cx('font-semibold mt-1', isCompact ? 'text-sm' : 'text-base')}
                    style={{ color: accent.hex }}
                  >
                    {job?.title || userProfile.title || 'Titre recherché'}
                  </div>
                </div>
              </div>

              {/* Barre de contacts & liens */}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600">
                {userProfile.email && (
                  <span className="inline-flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <span>{userProfile.email}</span>
                  </span>
                )}
                {userProfile.phone && (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <span>{userProfile.phone}</span>
                  </span>
                )}
                {userProfile.location && (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <span>{userProfile.location}</span>
                  </span>
                )}
                {userProfile.linkedinUrl && (
                  <span className="inline-flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <a
                      href={userProfile.linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-600 hover:underline"
                    >
                      LinkedIn
                    </a>
                  </span>
                )}
                {userProfile.githubUrl && (
                  <span className="inline-flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <a
                      href={userProfile.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-600 hover:underline"
                    >
                      GitHub
                    </a>
                  </span>
                )}
                {userProfile.portfolioUrl && (
                  <span className="inline-flex items-center gap-1.5">
                    <ExternalLink className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <a
                      href={userProfile.portfolioUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-600 hover:underline"
                    >
                      Portfolio
                    </a>
                  </span>
                )}
              </div>
            </header>

            {/* PROFIL / ACCROCHE */}
            {userProfile.summary && (
              <section className={cx('mb-5', isCompact && 'mb-3')}>
                <h2
                  className={cx(
                    'font-bold uppercase tracking-wider border-b border-slate-200 pb-1 mb-2',
                    isCompact ? 'text-xs' : 'text-sm'
                  )}
                  style={{ color: accent.hex }}
                >
                  Profil
                </h2>
                <p className="text-slate-700 leading-relaxed text-justify">
                  {userProfile.summary}
                </p>
              </section>
            )}

            {/* EXPÉRIENCES PROFESSIONNELLES */}
            {userProfile.experiences && userProfile.experiences.length > 0 && (
              <section className={cx('mb-5', isCompact && 'mb-3')}>
                <h2
                  className={cx(
                    'font-bold uppercase tracking-wider border-b border-slate-200 pb-1 mb-3',
                    isCompact ? 'text-xs' : 'text-sm'
                  )}
                  style={{ color: accent.hex }}
                >
                  Expériences professionnelles
                </h2>

                <div className={cx('space-y-4', isCompact && 'space-y-2.5')}>
                  {userProfile.experiences.map((exp, idx) => {
                    const dates = [exp.startDate, exp.endDate || (exp.current ? 'Présent' : '')].filter(Boolean).join(' – ');
                    return (
                      <div key={idx} className={cx(isModern && 'grid grid-cols-[110px_1fr] gap-4')}>
                        {isModern ? (
                          <div className="text-right text-xs font-semibold" style={{ color: accent.hex }}>
                            {dates}
                          </div>
                        ) : null}

                        <div>
                          <div className="flex flex-wrap items-baseline justify-between gap-1">
                            <div className="font-bold text-slate-900">
                              {exp.title}{' '}
                              <span className="font-medium text-slate-600">— {exp.company}</span>
                              {exp.location && (
                                <span className="font-normal text-slate-400 text-xs ml-1.5">
                                  ({exp.location})
                                </span>
                              )}
                            </div>
                            {!isModern && (
                              <div className="text-xs font-medium text-slate-500">
                                {dates}
                              </div>
                            )}
                          </div>

                          {exp.bullets && exp.bullets.length > 0 && (
                            <ul className="mt-1.5 space-y-1 pl-4">
                              {exp.bullets.map((b, bIdx) => {
                                const m = String(b).match(/^([^:]{2,34}) ?: (.+)$/);
                                return (
                                  <li key={bIdx} className="relative pl-2 text-slate-700">
                                    <span
                                      className="absolute -left-3 font-bold select-none"
                                      style={{ color: accent.hex }}
                                    >
                                      •
                                    </span>
                                    {m ? (
                                      <>
                                        <strong className="font-semibold text-slate-900">{m[1].trim()} :</strong>{' '}
                                        <span>{m[2].trim()}</span>
                                      </>
                                    ) : (
                                      <span>{b}</span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* FORMATION & DIPLÔMES */}
            {userProfile.education && userProfile.education.length > 0 && (
              <section className={cx('mb-5', isCompact && 'mb-3')}>
                <h2
                  className={cx(
                    'font-bold uppercase tracking-wider border-b border-slate-200 pb-1 mb-2.5',
                    isCompact ? 'text-xs' : 'text-sm'
                  )}
                  style={{ color: accent.hex }}
                >
                  Formation & Diplômes
                </h2>

                <div className="space-y-2">
                  {userProfile.education.map((edu, idx) => (
                    <div key={idx} className={cx('flex items-baseline justify-between', isModern && 'grid grid-cols-[110px_1fr] gap-4')}>
                      {isModern ? (
                        <div className="text-right text-xs font-semibold" style={{ color: accent.hex }}>
                          {edu.year}
                        </div>
                      ) : null}
                      <div className="font-medium text-slate-800">
                        <span className="font-bold text-slate-900">{edu.degree}</span>{' '}
                        {edu.institution && <span className="text-slate-600">— {edu.institution}</span>}
                      </div>
                      {!isModern && (
                        <div className="text-xs text-slate-500 font-medium">{edu.year}</div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* COMPÉTENCES */}
            {sortedSkills.length > 0 && (
              <section className={cx('mb-5', isCompact && 'mb-3')}>
                <h2
                  className={cx(
                    'font-bold uppercase tracking-wider border-b border-slate-200 pb-1 mb-2.5',
                    isCompact ? 'text-xs' : 'text-sm'
                  )}
                  style={{ color: accent.hex }}
                >
                  Compétences
                </h2>

                <div className="flex flex-wrap gap-1.5">
                  {sortedSkills.map((skill, idx) => {
                    const isMatched = isRelevant(skill);
                    return (
                      <span
                        key={idx}
                        className={cx(
                          'inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs transition-colors',
                          isMatched
                            ? 'font-semibold border shadow-2xs'
                            : 'bg-slate-100 text-slate-700 border border-slate-200'
                        )}
                        style={
                          isMatched
                            ? {
                                color: accent.hex,
                                borderColor: accent.hex,
                                backgroundColor: accent.hex + '12'
                              }
                            : {}
                        }
                      >
                        {isMatched && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
                        {skill}
                      </span>
                    );
                  })}
                </div>
              </section>
            )}

            {/* LANGUES */}
            {userProfile.languages && userProfile.languages.length > 0 && (
              <section className={cx('mb-4', isCompact && 'mb-2')}>
                <h2
                  className={cx(
                    'font-bold uppercase tracking-wider border-b border-slate-200 pb-1 mb-2',
                    isCompact ? 'text-xs' : 'text-sm'
                  )}
                  style={{ color: accent.hex }}
                >
                  Langues
                </h2>
                <div className="text-xs text-slate-700">
                  {userProfile.languages.join('  ·  ')}
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {/* Règles d'impression @media print */}
      <style>{`
        @media print {
          /* Masquer tout ce qui n'est pas le CV */
          body * {
            visibility: hidden !important;
          }
          #cv-preview-sheet, #cv-preview-sheet * {
            visibility: visible !important;
          }
          #cv-preview-sheet {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 10mm 15mm !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            transform: none !important;
          }
        }
      `}</style>
    </div>
  );
};

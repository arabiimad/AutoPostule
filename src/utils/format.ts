import type { ContractType, JobOffer } from '../types';

export const CONTRACT_LABELS: Record<ContractType, string> = {
  cdi: 'CDI',
  cdd: 'CDD',
  alternance: 'Alternance',
  stage: 'Stage',
  freelance: 'Freelance'
};

export const REMOTE_LABELS: Record<JobOffer['remote'], string> = {
  total: 'Télétravail complet',
  hybride: 'Télétravail partiel',
  'sur-site': 'Sur site',
  'non-precise': ''
};

/** Date ISO → « Aujourd'hui », « Hier », « Il y a 3 jours », « 12 sept. ». Texte libre renvoyé tel quel. */
export function formatRelativeDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  if (days < 7) return `Il y a ${days} jours`;
  if (days < 30) return `Il y a ${Math.floor(days / 7)} sem.`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

/** Âge d'une offre en jours (null si date inconnue). */
export function ageInDays(value?: string): number | null {
  if (!value) return null;
  if (value === "Aujourd'hui") return 0;
  if (value === 'Hier') return 1;
  const m = value.match(/Il y a (\d+) jours?/);
  if (m) return Number(m[1]);
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

export function formatLongDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Nom court de la plateforme d'origine (« indeed.fr (via Jooble) » → « Indeed »). */
export function sourceShortName(source: string): string {
  const s = (source || '').toLowerCase();
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('indeed')) return 'Indeed';
  if (s.includes('welcome') || s.includes('wttj')) return 'Welcome to the Jungle';
  if (s.includes('glassdoor')) return 'Glassdoor';
  if (s.includes('hellowork')) return 'HelloWork';
  if (s.includes('france travail')) return 'France Travail';
  if (s.includes('bonne alternance')) return 'La bonne alternance';
  if (s.startsWith('site carrière')) return 'Site carrière';
  return source.replace(/\s*\(.*\)\s*$/, '') || 'Source';
}

/** « publiée aujourd'hui », « publiée il y a 3 jours », « publiée le 12 sept. » */
export function publishedPhrase(value?: string): string {
  const rel = formatRelativeDate(value);
  if (!rel) return '';
  if (/^(aujourd|hier|il y a)/i.test(rel)) return `Publiée ${rel.toLowerCase()}`;
  return `Publiée le ${rel}`;
}

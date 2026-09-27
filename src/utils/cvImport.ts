/**
 * Import d'un CV dans le profil : aucun mélange silencieux avec l'ancien profil, champs incertains signalés.
 *
 * - « replace » (par défaut quand un profil existe) : le profil reprend UNIQUEMENT le contenu du CV ;
 *   seuls les réglages du compte sont gardés (contrats recherchés, seuil, modèle, alertes, photo, e-mail du compte si le CV n'en a pas).
 * - « complete » : les champs absents du CV sont complétés par l'ancien profil ; la liste en est affichée.
 */
import type { UserProfile } from '../types';

export type ImportMode = 'replace' | 'complete';

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const norm = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

const IDENTITY: { key: keyof UserProfile; label: string }[] = [
  { key: 'fullName', label: 'nom' }, { key: 'title', label: 'titre' }, { key: 'email', label: 'e-mail' }, { key: 'phone', label: 'téléphone' },
  { key: 'location', label: 'ville' }, { key: 'linkedinUrl', label: 'LinkedIn' }, { key: 'githubUrl', label: 'GitHub' },
  { key: 'portfolioUrl', label: 'site web' }, { key: 'summary', label: 'accroche' }
];
const LISTS: { key: keyof UserProfile; label: string }[] = [
  { key: 'skills', label: 'compétences' }, { key: 'experiences', label: 'expériences' }, { key: 'education', label: 'formations' },
  { key: 'projects', label: 'projets' }, { key: 'languages', label: 'langues' }
];

function normalizeParsed(p: any) {
  return {
    experiences: list<any>(p?.experiences).map((exp, idx) => ({
      id: exp.id || `exp-${Date.now()}-${idx}`, title: s(exp.title), company: s(exp.company), location: s(exp.location),
      startDate: s(exp.startDate), endDate: s(exp.endDate), current: !!exp.current,
      bullets: list<string>(exp.bullets).map(s).filter(Boolean), technologies: list<string>(exp.technologies)
    })),
    education: list<any>(p?.education).map((e, idx) => ({ id: e.id || `edu-${Date.now()}-${idx}`, degree: s(e.degree), institution: s(e.institution), year: s(e.year), details: s(e.details) })),
    projects: list<any>(p?.projects).map((pr, idx) => ({ id: pr.id || `proj-${Date.now()}-${idx}`, name: s(pr.name), description: s(pr.description), technologies: list<string>(pr.technologies), link: s(pr.link) })),
    skills: list<string>(p?.skills).map(s).filter(Boolean),
    languages: list<string>(p?.languages).map(s).filter(Boolean)
  };
}

/** Profil résultant de l'import, et champs repris de l'ancien profil (mode « complete »). */
export function buildImportedProfile(current: UserProfile, parsed: any, mode: ImportMode): { profile: UserProfile; keptFromPrevious: string[] } {
  const n = normalizeParsed(parsed);
  const kept: string[] = [];
  const pick = (key: keyof UserProfile, label: string, fromCv: any, empty: any) => {
    const has = Array.isArray(fromCv) ? fromCv.length > 0 : !!fromCv;
    if (has) return fromCv;
    const prev = (current as any)[key];
    const prevHas = Array.isArray(prev) ? prev.length > 0 : !!s(prev);
    if (mode === 'complete' && prevHas) {
      kept.push(label);
      return prev;
    }
    return empty;
  };
  const profile: UserProfile = { ...current };
  for (const { key, label } of IDENTITY) (profile as any)[key] = pick(key, label, s(parsed?.[key]), '');
  // L'e-mail du compte reste le contact par défaut si le CV n'en indique pas (ce n'est pas une donnée du CV)
  if (!profile.email && current.email && mode === 'replace') profile.email = current.email;
  for (const { key, label } of LISTS) (profile as any)[key] = pick(key, label, (n as any)[key], []);
  const roles = list<string>(parsed?.targetRoles).map(s).filter(Boolean);
  profile.targetRoles = roles.length ? roles : profile.title ? [profile.title] : mode === 'complete' ? current.targetRoles : [];
  return { profile, keptFromPrevious: kept };
}

export interface ImportWarning {
  level: 'important' | 'info';
  message: string;
}

/** Champs incertains ou manquants à vérifier avant d'enregistrer. */
export function importWarnings(parsed: any, current: UserProfile): ImportWarning[] {
  const w: ImportWarning[] = [];
  const name = s(parsed?.fullName);
  const prevName = s(current?.fullName);
  if (name && prevName && current?.experiences?.length) {
    const a = new Set(norm(name).split(' ').filter((x) => x.length > 1));
    const b = new Set(norm(prevName).split(' ').filter((x) => x.length > 1));
    if (a.size && b.size && ![...a].some((x) => b.has(x))) {
      w.push({ level: 'important', message: `Ce CV est au nom de « ${name} », votre profil au nom de « ${prevName} » : vérifiez qu’il s’agit bien de votre CV.` });
    }
  }
  if (!name) w.push({ level: 'important', message: 'Nom non trouvé dans le CV : indiquez-le.' });
  if (!s(parsed?.email)) w.push({ level: 'info', message: 'Adresse e-mail non trouvée dans le CV.' });
  if (!s(parsed?.phone)) w.push({ level: 'info', message: 'Téléphone non trouvé dans le CV.' });
  const exps = list<any>(parsed?.experiences);
  if (!exps.length) w.push({ level: 'important', message: 'Aucune expérience détectée : ajoutez-les pour que vos CV adaptés soient complets.' });
  exps.forEach((e, i) => {
    const label = s(e.title) && s(e.title) !== 'Poste' ? `« ${s(e.title)} »` : `n° ${i + 1}`;
    if (!s(e.title) || s(e.title) === 'Poste') w.push({ level: 'important', message: `Expérience n° ${i + 1} : intitulé du poste non reconnu.` });
    if (!s(e.company)) w.push({ level: 'important', message: `Expérience ${label} : entreprise non reconnue.` });
    if (!s(e.startDate)) w.push({ level: 'info', message: `Expérience ${label} : dates non reconnues.` });
    if (!list(e.bullets).length) w.push({ level: 'info', message: `Expérience ${label} : aucune mission détectée.` });
  });
  list<any>(parsed?.education).forEach((e, i) => {
    if (!s(e.degree) || ['Formation', 'Diplôme', 'DIPLÔME'].includes(s(e.degree))) w.push({ level: 'info', message: `Formation n° ${i + 1} : intitulé du diplôme non reconnu.` });
  });
  if (!list(parsed?.skills).length) w.push({ level: 'info', message: 'Aucune compétence détectée.' });
  return w;
}

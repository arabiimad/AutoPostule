/**
 * État de navigation dans l'URL : onglet, recherche et offre ouverte.
 * Les liens deviennent partageables et les boutons Précédent / Suivant du navigateur fonctionnent.
 *   /?onglet=offres&q=développeur&lieu=Lyon&rayon=30&contrat=alternance&offre=ft-123
 */
export type TabId = 'radar' | 'latex' | 'agent' | 'kanban' | 'interview' | 'profile' | 'pricing';

const TAB_SLUGS: Record<TabId, string> = {
  radar: 'offres',
  kanban: 'candidatures',
  interview: 'entretiens',
  agent: 'assistant',
  latex: 'cv',
  profile: 'profil',
  pricing: 'tarifs'
};
const SLUG_TABS = Object.fromEntries(Object.entries(TAB_SLUGS).map(([k, v]) => [v, k])) as Record<string, TabId>;

export interface SearchUrlState {
  query: string;
  location: string;
  radius: number;
  contractType: string;
}

export function readTab(): TabId {
  const slug = new URLSearchParams(window.location.search).get('onglet') || '';
  return SLUG_TABS[slug] || 'radar';
}

export function readSearch(): SearchUrlState {
  const p = new URLSearchParams(window.location.search);
  const radius = Number(p.get('rayon'));
  return {
    query: p.get('q') || '',
    location: p.get('lieu') || '',
    radius: [10, 20, 30, 50, 100, 200].includes(radius) ? radius : 30,
    contractType: p.get('contrat') || 'tous'
  };
}

export function readSelectedJob(): string | null {
  return new URLSearchParams(window.location.search).get('offre');
}

/** Met à jour l'URL. `push` crée une entrée d'historique (changement d'onglet, nouvelle recherche). */
export function writeUrl(patch: Record<string, string | number | null | undefined>, push = false) {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '' || (k === 'contrat' && v === 'tous') || (k === 'rayon' && Number(v) === 30) || (k === 'onglet' && v === 'offres')) p.delete(k);
    else p.set(k, String(v));
  }
  const qs = p.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

export function writeTab(tab: TabId, push = true) {
  // L'offre ouverte n'a de sens que sur l'onglet Offres
  writeUrl({ onglet: TAB_SLUGS[tab], ...(tab !== 'radar' ? { offre: null } : {}) }, push);
}

/** Lien absolu vers une offre (bouton « Partager »). */
export function jobShareUrl(jobId: string, search: SearchUrlState): string {
  const p = new URLSearchParams();
  if (search.query) p.set('q', search.query);
  if (search.location) p.set('lieu', search.location);
  if (search.contractType && search.contractType !== 'tous') p.set('contrat', search.contractType);
  if (search.radius !== 30) p.set('rayon', String(search.radius));
  p.set('offre', jobId);
  return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
}

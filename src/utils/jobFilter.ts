import { JobOffer } from '../types';

/**
 * Filtrage des offres (partagé client / serveur).
 * Sorti de realJobsData.ts pour que l'interface n'embarque plus les 808 offres de démonstration.
 */
export const QUERY_STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'en', 'un', 'une', 'pour', 'chez', 'au', 'aux', 'a', 'h/f', 'f/h', 'hf', 'fh']);

export function filterJobs(
  jobs: JobOffer[],
  params: {
    query?: string;
    contractType?: string;
    location?: string;
    domain?: string;
    remote?: string;
    minScore?: number;
    onlyActive?: boolean;
    /** Résultats déjà filtrés par distance côté serveur : ne pas refiltrer sur le texte de la ville. */
    skipLocation?: boolean;
  }
): JobOffer[] {
  const query = (params.query || '').trim().toLowerCase();
  const location = (params.location || '').trim().toLowerCase();
  const domain = (params.domain || 'tous').trim().toLowerCase();
  const contract = (params.contractType || 'tous').trim().toLowerCase();
  const remote = (params.remote || 'tous').trim().toLowerCase();
  const minScore = params.minScore ?? 0;
  const onlyActive = params.onlyActive ?? false;

  return jobs.filter(job => {
    // 0. Active validity filter
    if (onlyActive && job.status === 'expired') {
      return false;
    }

    // (Le seuil de compatibilité est appliqué côté interface sur le score calculé pour l'utilisateur.)

    // 0.2 Domain / Sector filter
    if (domain && domain !== 'tous' && domain !== 'all') {
      const jobDomain = ((job as any).domain || '').toLowerCase();
      if (!jobDomain || !jobDomain.includes(domain)) {
        return false;
      }
    }

    // 1. Contract filter
    if (contract && contract !== 'tous' && contract !== 'all') {
      if (job.contractType.toLowerCase() !== contract) {
        return false;
      }
    }

    // 2. Remote filter
    if (remote && remote !== 'tous' && remote !== 'all') {
      if (job.remote.toLowerCase() !== remote) {
        return false;
      }
    }

    // 3. Localisation (« Remote » / « Télétravail » = offres 100 % à distance)
    if (!params.skipLocation && location && location !== 'tous' && location !== 'toute la france') {
      if (/^(remote|t[ée]l[ée]travail|full remote)$/i.test(location)) {
        if (job.remote !== 'total') return false;
      } else {
        const locClean = location.replace(/\b(france|&|et)\b/gi, '').trim().toLowerCase();
        if (locClean.length > 1 && !job.location.toLowerCase().includes(locClean)) {
          return false;
        }
      }
    }

    // 4. Recherche : TOUS les mots significatifs doivent apparaître (titre, entreprise, compétences, domaine, description).
    //    Avant, un seul mot suffisait : « chef de projet informatique » renvoyait des postes événementiels.
    if (query && query !== 'tous' && query.length > 1) {
      const norm = (v: string) => (v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const haystack = norm([
        job.title,
        job.company,
        job.skillsRequired.join(' '),
        (job as any).domain || '',
        job.description
      ].join(' '));
      const words = norm(query).split(/[\s,;/]+/).filter(w => w.length > 1 && !QUERY_STOPWORDS.has(w));
      if (words.length > 0 && !words.every(w => haystack.includes(w))) {
        return false;
      }
    }

    return true;
  });
}

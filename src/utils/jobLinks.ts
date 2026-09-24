import { JobOffer } from '../types';

/**
 * Source unique des liens de candidature.
 * Le même lien est utilisé par « Postuler en ligne », « Dossier & Portail RH »
 * et le bouton de validation du Studio LaTeX.
 */

export function cleanCompanyForSearch(company: string): string {
  if (!company) return '';
  return company
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+(?:France|Digital|Tech|Recherche|Conseil|Hospitality|Construction|Direction RH|Siège|Vente|Group|Groupe|International|Communication)$/i, '')
    .trim();
}

export function cleanTitleForSearch(title: string): string {
  if (!title) return '';
  let c = title.replace(/\([^)]*\)/g, ' ');
  c = c.replace(/^(?:Stage|Alternance|Apprentissage|CDI|CDD|Freelance|Poste Junior)[^-–—]*[-–—]\s*/i, '');
  c = c.replace(/\b(?:H\/F|F\/H)\b/gi, ' ');
  if (c.includes(' / ')) c = c.split(' / ')[0];
  return c.replace(/\s+/g, ' ').trim();
}

export function getContractTerm(contractType: string): string {
  if (contractType === 'alternance') return 'alternance';
  if (contractType === 'stage') return 'stage';
  if (contractType === 'cdi') return 'CDI';
  if (contractType === 'cdd') return 'CDD';
  return 'freelance';
}

const COMPANY_CAREER_PORTALS: Record<string, string> = {
  "L'Oréal": "https://careers.loreal.com/fr_FR/jobs/SearchJobs/",
  "Capgemini": "https://www.capgemini.com/fr-fr/carrieres/etudiants/",
  "Danone": "https://careers.danone.com/fr-fr/rejoignez-nous/nos-offres/",
  "BNP Paribas": "https://group.bnpparibas/emploi-carriere/etudiants",
  "TotalEnergies": "https://totalenergies.avature.net/fr_FR/careers",
  "Carrefour": "https://recrute.carrefour.fr/etudiants-alternants/",
  "Deloitte": "https://recrute.deloitte.fr/etudiants-jeunes-diplomes/",
  "Hermès": "https://talents.hermes.com/fr/",
  "Decathlon": "https://recrutement.decathlon.fr/",
  "Sanofi": "https://www.sanofi.fr/fr/carrieres",
  "Publicis": "https://careers.smartrecruiters.com/PublicisGroupe",
  "Canal+": "https://canalplusrecrute.candidats.talents-in.com/",
  "SNCF": "https://www.emploi.sncf.com/alternance/",
  "Airbus": "https://www.airbus.com/en/careers/students-and-graduates",
  "Michelin": "https://recrutement.michelin.fr/",
  "PwC": "https://carrieres.pwc.fr/",
  "KPMG": "https://kpmgrecrute.fr/",
  "EY": "https://www.ey.com/fr_fr/careers",
  "Société Générale": "https://careers.societegenerale.com/fr",
  "Crédit Agricole": "https://www.groupecreditagricole.jobs/",
  "Bouygues": "https://carrieres.bouygues.com/",
  "Vinci": "https://carrieres.vinci.com/",
  "Eiffage": "https://recrutement.eiffage.com/",
  "Safran": "https://www.safran-group.com/fr/talents",
  "Thales": "https://www.thalesgroup.com/fr/carrieres",
  "Schneider Electric": "https://www.se.com/fr/fr/about-us/careers/overview.jsp",
  "EDF": "https://www.edf.fr/edf-recrute",
  "Saint-Gobain": "https://joinus.saint-gobain.com/fr",
  "Alstom": "https://jobsearch.alstom.com/",
  "Accor": "https://careers.accor.com/global/fr",
  "Club Med": "https://www.clubmedjobs.com/",
  "Doctolib": "https://careers.doctolib.fr/",
  "Dassault": "https://careers.3ds.com/fr",
  "OVHcloud": "https://careers.ovhcloud.com/fr/",
  "Sopra Steria": "https://www.soprasteria.fr/carrieres",
  "Renault": "https://www.renaultgroup.com/talents/nos-offres/",
  "Havas": "https://www.havas.com/careers/",
  "Orange": "https://orange.jobs/site/fr-home/",
  "Ubisoft": "https://www.ubisoft.com/fr-fr/company/careers/search"
};

/** Portail carrières connu : le nom de l'entreprise doit COMMENCER par la clé (évite « Leroy » ⇢ « EY »). */
export function getCompanyOfficialPortal(companyName: string): string | null {
  const norm = cleanCompanyForSearch(companyName).toLowerCase();
  if (!norm) return null;
  for (const [key, url] of Object.entries(COMPANY_CAREER_PORTALS)) {
    const k = key.toLowerCase();
    if (norm === k || norm.startsWith(k + ' ')) return url;
  }
  return null;
}

function isUsableUrl(url?: string): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return !/example\.com|localhost|&ibp=htl;jobs/i.test(url);
}

export function buildJobSearchLinks(job: JobOffer) {
  const cleanCo = cleanCompanyForSearch(job.company);
  const cleanTi = cleanTitleForSearch(job.title);
  const contractTerm = getContractTerm(job.contractType);
  const enc = encodeURIComponent;
  return {
    cleanCo,
    indeed: `https://fr.indeed.com/emplois?q=%22${enc(cleanCo)}%22%20${enc(contractTerm)}&l=France`,
    linkedin: `https://www.linkedin.com/jobs/search/?keywords=${enc(`${cleanCo} ${cleanTi}`.trim())}&location=France`,
    franceTravail: `https://candidat.francetravail.fr/offres/recherche?motsCles=${enc(cleanCo + ' ' + contractTerm)}&offresPartenaires=true`,
    unJeuneUneSolution: job.contractType === 'alternance'
      ? `https://www.1jeune1solution.gouv.fr/apprentissage?motCle=${enc(cleanCo)}`
      : job.contractType === 'stage'
        ? `https://www.1jeune1solution.gouv.fr/stages?motCle=${enc(cleanCo)}`
        : `https://www.1jeune1solution.gouv.fr/emplois?motCle=${enc(cleanCo)}`,
    wttj: `https://www.welcometothejungle.com/fr/jobs?query=${enc(cleanCo)}`,
    google: `https://www.google.com/search?q=${enc(cleanCo + ' ' + cleanTi + ' ' + contractTerm + ' offre emploi')}`,
    officialPortal: getCompanyOfficialPortal(job.company)
  };
}

function isGenericSearchPage(url: string): boolean {
  return /indeed\.[a-z.]+\/(emplois|jobs)\?|google\.[a-z.]+\/search|linkedin\.com\/jobs\/search/i.test(url);
}

/**
 * Lien de candidature unique : l'URL de l'offre si elle est exploitable
 * (le portail officiel est préféré à une simple page de recherche),
 * sinon le portail carrières officiel connu, sinon une recherche Indeed ciblée.
 */
export function getApplyUrl(job: Pick<JobOffer, 'applyUrl' | 'company' | 'title' | 'contractType'> & Partial<JobOffer>): string {
  const links = buildJobSearchLinks(job as JobOffer);
  if (isUsableUrl(job.applyUrl)) {
    // Une page de recherche générique (Indeed, Google…) passe après le portail carrières officiel s'il est connu
    return isGenericSearchPage(job.applyUrl) && links.officialPortal ? links.officialPortal : job.applyUrl;
  }
  return links.officialPortal || links.indeed;
}

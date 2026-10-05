/**
 * Annuaire des sites carrières interrogés directement (API publiques des logiciels de recrutement).
 * Chaque entrée a été vérifiée (offres en France au 05/10/2026). Pour en ajouter sans toucher au code :
 * fichier JSON (même format) indiqué par la variable ATS_COMPANIES_FILE.
 *
 * Trouver l'identifiant d'une entreprise : ouvrir « Postuler » sur son site carrière et lire l'adresse :
 *  - boards.greenhouse.io/{slug} ou job-boards.greenhouse.io/{slug}  → greenhouse
 *  - jobs.lever.co/{slug}                                           → lever
 *  - jobs.ashbyhq.com/{slug}                                        → ashby
 *  - jobs.smartrecruiters.com/{slug}                                → smartrecruiters
 *  - {slug}.recruitee.com                                           → recruitee
 *  - {tenant}.wd3.myworkdayjobs.com/{site}                          → workday (host = « {tenant}.wd3 »)
 */
export type AtsKind = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "recruitee" | "workday";

export interface AtsCompany {
  name: string;
  ats: AtsKind;
  /** Identifiant de l'entreprise chez l'ATS (pour Workday : le tenant). */
  slug: string;
  /** Workday uniquement. */
  workday?: {
    /** Sous-domaine complet, ex. « ag.wd3 » pour ag.wd3.myworkdayjobs.com */
    host: string;
    site: string;
    /** Nom du filtre pays du site (« locationCountry » le plus souvent). */
    countryFacet?: string;
  };
}

export const CAREER_SITES: AtsCompany[] = [
  // Greenhouse
  { name: "Doctolib", ats: "greenhouse", slug: "doctolib" },
  { name: "Datadog", ats: "greenhouse", slug: "datadog" },
  { name: "Algolia", ats: "greenhouse", slug: "algolia" },
  { name: "Mirakl", ats: "greenhouse", slug: "mirakl" },
  { name: "Dataiku", ats: "greenhouse", slug: "dataiku" },
  { name: "Ivalua", ats: "greenhouse", slug: "ivalua" },
  { name: "Deliveroo", ats: "greenhouse", slug: "deliveroo" },
  { name: "Dashlane", ats: "greenhouse", slug: "dashlane" },
  // Lever
  { name: "Qonto", ats: "lever", slug: "qonto" },
  { name: "BlaBlaCar", ats: "lever", slug: "blablacar" },
  { name: "Contentsquare", ats: "lever", slug: "contentsquare" },
  { name: "Swile", ats: "lever", slug: "swile" },
  { name: "Vestiaire Collective", ats: "lever", slug: "vestiairecollective" },
  { name: "Agicap", ats: "lever", slug: "agicap" },
  { name: "Brevo", ats: "lever", slug: "brevo" },
  { name: "Malt", ats: "lever", slug: "malt" },
  { name: "Pigment", ats: "lever", slug: "pigment" },
  { name: "Aircall", ats: "lever", slug: "aircall" },
  { name: "Scaleway", ats: "lever", slug: "scaleway" },
  { name: "Younited", ats: "lever", slug: "younited" },
  { name: "Heetch", ats: "lever", slug: "heetch" },
  // Ashby
  { name: "Back Market", ats: "ashby", slug: "backmarket" },
  { name: "Ledger", ats: "ashby", slug: "ledger" },
  { name: "Sorare", ats: "ashby", slug: "sorare" },
  { name: "Pennylane", ats: "ashby", slug: "pennylane" },
  { name: "Photoroom", ats: "ashby", slug: "photoroom" },
  { name: "lemlist", ats: "ashby", slug: "lemlist" },
  { name: "Alan", ats: "ashby", slug: "alan" },
  // SmartRecruiters
  { name: "Ubisoft", ats: "smartrecruiters", slug: "Ubisoft2" },
  { name: "Accor", ats: "smartrecruiters", slug: "Accor" },
  { name: "ALTEN", ats: "smartrecruiters", slug: "Alten" },
  { name: "Assystem", ats: "smartrecruiters", slug: "Assystem" },
  { name: "Boulanger", ats: "smartrecruiters", slug: "Boulanger" },
  { name: "Kiabi", ats: "smartrecruiters", slug: "Kiabi" },
  { name: "SOCOTEC", ats: "smartrecruiters", slug: "Socotec" },
  // Recruitee
  { name: "Livestorm", ats: "recruitee", slug: "livestorm" },
  { name: "Zenchef", ats: "recruitee", slug: "zenchef" },
  // Workday
  { name: "Airbus", ats: "workday", slug: "ag", workday: { host: "ag.wd3", site: "Airbus" } },
  { name: "Thales", ats: "workday", slug: "thales", workday: { host: "thales.wd3", site: "Careers" } },
  { name: "Sanofi", ats: "workday", slug: "sanofi", workday: { host: "sanofi.wd3", site: "SanofiCareers" } },
  { name: "Michelin", ats: "workday", slug: "michelinhr", workday: { host: "michelinhr.wd3", site: "Michelin", countryFacet: "Location_Country" } },
  { name: "Pernod Ricard", ats: "workday", slug: "pernodricard", workday: { host: "pernodricard.wd3", site: "pernod-ricard" } }
];

/**
 * Annuaire des sites carrières interrogés directement (API publiques des logiciels de recrutement).
 *  - CAREER_SITES : entrées vérifiées à la main (dont Workday, impossible à deviner) ;
 *  - DISCOVERED_CAREER_SITES : entrées trouvées automatiquement par `npm run discover:sites`
 *    (server/data/careerSites.generated.ts, à régénérer de temps en temps).
 * Pour en ajouter sans toucher au code : fichier JSON (même format) indiqué par ATS_COMPANIES_FILE.
 *
 * Trouver l'identifiant d'une entreprise : ouvrir « Postuler » sur son site carrière et lire l'adresse :
 *  - boards.greenhouse.io/{slug} ou job-boards.greenhouse.io/{slug}  → greenhouse
 *  - jobs.lever.co/{slug}                                           → lever
 *  - jobs.ashbyhq.com/{slug}                                        → ashby
 *  - jobs.smartrecruiters.com/{slug}                                → smartrecruiters
 *  - {slug}.recruitee.com                                           → recruitee
 *  - {slug}.teamtailor.com                                          → teamtailor
 *  - {tenant}.wd3.myworkdayjobs.com/{site}                          → workday (host = « {tenant}.wd3 »)
 */
export type AtsKind = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "recruitee" | "teamtailor" | "workday";

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
    /** Nom du filtre pays du site (« locationCountry » le plus souvent) ; « none » si le site ne publie qu'en France. */
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
  { name: "Pernod Ricard", ats: "workday", slug: "pernodricard", workday: { host: "pernodricard.wd3", site: "pernod-ricard" } },
  { name: "Pierre Fabre", ats: "workday", slug: "pierrefabre", workday: { host: "pierrefabre.wd3", site: "External_Career_Site" } },
  { name: "Viatris", ats: "workday", slug: "viatris", workday: { host: "viatris.wd5", site: "External", countryFacet: "Country" } },
  { name: "Chanel", ats: "workday", slug: "cc", workday: { host: "cc.wd3", site: "ChanelCareers" } },
  { name: "Lyreco", ats: "workday", slug: "lyreco", workday: { host: "lyreco.wd3", site: "Lyreco_Careers" } },
  { name: "onepoint", ats: "workday", slug: "onepoint", workday: { host: "onepoint.wd3", site: "OnepointFR" } },
  { name: "Medtronic", ats: "workday", slug: "medtronic", workday: { host: "medtronic.wd1", site: "MedtronicCareers" } },
  { name: "Stanley Black & Decker", ats: "workday", slug: "sbdinc", workday: { host: "sbdinc.wd1", site: "Stanley_Black_Decker_Career_Site" } },
  { name: "Air Liquide", ats: "workday", slug: "airliquidehr", workday: { host: "airliquidehr.wd3", site: "AirLiquideExternalCareer" } },
  { name: "ArianeGroup", ats: "workday", slug: "arianegroup", workday: { host: "arianegroup.wd3", site: "EXTERNALALL" } },
  { name: "Maisons du Monde", ats: "workday", slug: "maisonsdumonde", workday: { host: "maisonsdumonde.wd3", site: "Site_carriere" } },
  { name: "JLL", ats: "workday", slug: "jll", workday: { host: "jll.wd1", site: "jllcareers" } },
  { name: "Accenture", ats: "workday", slug: "accenture", workday: { host: "accenture.wd103", site: "AccentureCareers" } },
  { name: "AIG", ats: "workday", slug: "aig", workday: { host: "aig.wd1", site: "aig" } },
  { name: "Valeo", ats: "workday", slug: "valeo", workday: { host: "valeo.wd3", site: "valeo_jobs" } },
  { name: "Workday", ats: "workday", slug: "workday", workday: { host: "workday.wd5", site: "Workday", countryFacet: "Location_Country" } },
  { name: "Swiss Life France", ats: "workday", slug: "swisslife", workday: { host: "swisslife.wd3", site: "Swiss_Life_Division_France_Career_Site", countryFacet: "none" } },
  { name: "Banque de France", ats: "workday", slug: "bdf", workday: { host: "bdf.wd103", site: "recrutement-banque-de-france", countryFacet: "none" } },
  { name: "La Mutuelle Générale", ats: "workday", slug: "lmg", workday: { host: "lmg.wd3", site: "LMG", countryFacet: "none" } },
  { name: "Galileo Global Education (alternance)", ats: "workday", slug: "galileo", workday: { host: "galileo.wd3", site: "elije-alternance", countryFacet: "none" } },
  { name: "Eiffage", ats: "workday", slug: "eiffage", workday: { host: "eiffage.wd3", site: "Eiffage_Careers" } },
  { name: "Roquette", ats: "workday", slug: "roquette", workday: { host: "roquette.wd3", site: "External", countryFacet: "Location_Country" } },
  { name: "Edenred", ats: "workday", slug: "edenpeople", workday: { host: "edenpeople.wd3", site: "Edenred_Careers" } },
  { name: "Ipsen", ats: "workday", slug: "ipsen", workday: { host: "ipsen.wd103", site: "ipsen_careers" } },
  { name: "Imerys", ats: "workday", slug: "imerys", workday: { host: "imerys.wd3", site: "IMERYS-Careers", countryFacet: "Country" } },
  { name: "Renault Group", ats: "workday", slug: "alliancewd", workday: { host: "alliancewd.wd3", site: "renault-group-careers" } }
];

export { DISCOVERED_CAREER_SITES } from "./data/careerSites.generated.ts";

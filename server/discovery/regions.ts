/**
 * Zone couverte par la découverte d'offres. Première version : France uniquement.
 * Pour ouvrir un autre pays plus tard : ajouter une Region ici (noms de lieux, libellé de recherche,
 * code pays des API) et la choisir avec DISCOVERY_COUNTRY.
 */
import type { JobOffer } from "../../src/types.ts";

export interface Region {
  code: string;
  /** Ajouté aux recherches web quand le profil n'a pas de ville. */
  searchLabel: string;
  /** Code pays des API qui filtrent par pays (SmartRecruiters). */
  apiCountry: string;
  /** Sources nationales : leurs offres sans lieu précis sont dans la zone. */
  nativeOrigins: Set<string>;
  pattern: RegExp;
}

const norm = (s: string) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Pays, régions, outre-mer et principales villes (les pages carrière internationales écrivent « Paris, France »,
// « Lyon », « Remote - France », « FR »…)
const FR_PLACES = [
  "france", "fr", "ile de france", "ile-de-france", "idf", "auvergne", "rhone alpes", "rhone-alpes", "hauts de france", "hauts-de-france",
  "nouvelle aquitaine", "nouvelle-aquitaine", "occitanie", "grand est", "provence", "paca", "cote d'azur", "bretagne", "normandie",
  "pays de la loire", "centre val de loire", "centre-val de loire", "bourgogne", "franche comte", "franche-comte", "corse",
  "guadeloupe", "martinique", "guyane", "reunion", "mayotte",
  "paris", "marseille", "lyon", "toulouse", "nice", "nantes", "montpellier", "strasbourg", "bordeaux", "lille", "rennes", "reims",
  "toulon", "saint etienne", "saint-etienne", "le havre", "grenoble", "dijon", "angers", "nimes", "villeurbanne", "clermont ferrand",
  "clermont-ferrand", "le mans", "aix en provence", "aix-en-provence", "brest", "tours", "amiens", "limoges", "annecy", "perpignan",
  "boulogne billancourt", "boulogne-billancourt", "metz", "besancon", "orleans", "rouen", "mulhouse", "caen", "nancy", "argenteuil",
  "saint denis", "saint-denis", "montreuil", "roubaix", "tourcoing", "avignon", "nanterre", "creteil", "poitiers", "versailles",
  "courbevoie", "vitry sur seine", "colombes", "pau", "asnieres", "rueil malmaison", "la defense", "issy les moulineaux",
  "issy-les-moulineaux", "levallois", "neuilly", "massy", "sophia antipolis", "valence", "la rochelle", "bayonne", "lorient",
  "vannes", "saint nazaire", "saint-nazaire", "chambery", "troyes", "niort", "cergy", "evry", "saclay", "velizy", "guyancourt"
];

export const FRANCE: Region = {
  code: "FR",
  searchLabel: "France",
  apiCountry: "fr",
  nativeOrigins: new Set(["france-travail", "la-bonne-alternance", "adzuna", "demo"]),
  pattern: new RegExp(`(^|[^a-z])(${FR_PLACES.map((p) => p.replace(/[.*+?^${}()|[\]\\']/g, "\\$&").replace(/[ -]/g, "[ -]")).join("|")})([^a-z]|$)`)
};

const REGIONS: Record<string, Region> = { FR: FRANCE };

export function activeRegion(code = process.env.DISCOVERY_COUNTRY): Region {
  return REGIONS[String(code || "FR").toUpperCase()] || FRANCE;
}

export function locationInRegion(location: string, region: Region = FRANCE): boolean {
  return region.pattern.test(norm(location));
}

/**
 * L'offre est-elle dans la zone couverte ?
 * Sources nationales (France Travail : « 38 - VOIRON ») : toujours ; autres : le lieu doit être reconnu.
 */
export function isInRegion(job: Pick<JobOffer, "location" | "origin">, region: Region = FRANCE): boolean {
  if (region.nativeOrigins.has(String(job.origin || ""))) return true;
  const loc = String(job.location || "").trim();
  // Publications sans lieu : la recherche web était déjà limitée à la zone
  if (!loc) return job.origin === "web" || job.origin === "web-post";
  return locationInRegion(loc, region);
}

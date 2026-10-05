/**
 * Offres publiées directement sur les sites carrières des entreprises.
 *
 * La plupart des entreprises publient leurs offres via un logiciel de recrutement (ATS) qui expose
 * une API publique, sans clé, destinée à afficher ces offres sur leur site : Greenhouse, Lever, Ashby,
 * SmartRecruiters, Recruitee, Workday. On interroge ces API pour chaque entreprise de l'annuaire
 * (server/careerSitesDirectory.ts) et on renvoie vers la page officielle pour postuler.
 *
 * Désactivation : ATS_SOURCES=off. Annuaire complémentaire : ATS_COMPANIES_FILE (JSON).
 */
import { readFileSync } from "node:fs";
import type { JobOffer, ContractType } from "../src/types.ts";
import { CAREER_SITES, type AtsCompany, type AtsKind } from "./careerSitesDirectory.ts";
import {
  cached, sourceFetch, stripHtml, inferContract, inferRemote, deriveSkills, isRelevant, queryWords,
  type SearchParams, type GeoPoint
} from "./jobSources.ts";

/** Durée de cache d'un site carrière complet (ses offres changent peu d'une heure à l'autre). */
const BOARD_TTL_MS = 60 * 60_000;
/** Délai d'attente par site avant d'afficher les autres résultats (le site continue de remplir le cache). */
const COMPANY_WAIT_MS = Number(process.env.ATS_WAIT_MS) || 10_000;
const MAX_RESULTS = 150;
const MAX_DESCRIPTION = 6000;
/** Identifiant du pays « France » dans Workday (commun à tous les sites). */
const WORKDAY_FRANCE = "54c5b6971ffb4bf0b116fe7651ec789a";

const ATS_LABELS: Record<AtsKind, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  recruitee: "Recruitee",
  workday: "Workday"
};

export function careerSitesEnabled(): boolean {
  return (process.env.ATS_SOURCES || "").toLowerCase() !== "off";
}

let extraCompanies: AtsCompany[] | null = null;
export function careerSiteCompanies(): AtsCompany[] {
  if (extraCompanies === null) {
    extraCompanies = [];
    const file = process.env.ATS_COMPANIES_FILE;
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        extraCompanies = (Array.isArray(data) ? data : []).filter((c: any) => c?.name && c?.slug && ATS_LABELS[c?.ats as AtsKind]);
      } catch (e: any) {
        console.warn(`ATS_COMPANIES_FILE illisible (${e?.message || e}) : annuaire par défaut uniquement.`);
      }
    }
  }
  const all = [...CAREER_SITES, ...extraCompanies];
  // Une entreprise ajoutée dans le fichier remplace celle de l'annuaire par défaut
  const byKey = new Map(all.map((c) => [`${c.ats}:${c.slug.toLowerCase()}`, c]));
  return Array.from(byKey.values());
}
export function __resetCareerSitesForTests() {
  extraCompanies = null;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const norm = (v: string) => (v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Lieux reconnus comme situés en France quand l'ATS ne donne pas le pays. */
const FRENCH_PLACE = /\b(france|paris|ile-de-france|idf|lyon|marseille|toulouse|bordeaux|lille|nantes|nice|montpellier|rennes|strasbourg|grenoble|sophia antipolis|clermont-ferrand|aix-en-provence|la defense|velizy|massy|issy-les-moulineaux|boulogne-billancourt|levallois|courbevoie|nanterre|saint-denis|rouen|reims|tours|dijon|angers|le mans|brest|metz|nancy|orleans|caen|avignon|toulon|pau|limoges|poitiers|blagnac|marignane|elancourt)\b/;
export function looksFrench(text: string): boolean {
  return FRENCH_PLACE.test(norm(text));
}

function iso(v: any): string | undefined {
  if (v == null || v === "") return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Greenhouse renvoie un HTML échappé (« &lt;p&gt; ») : on le décode avant de retirer les balises. */
function decodeEscapedHtml(v: any): string {
  return String(v || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function clip(text: string): string {
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…` : text;
}

/** Contrat : seulement l'intitulé et le type annoncé (« early stage » dans un texte n'est pas un stage). */
function contractFrom(title: string, employment: string): ContractType {
  const e = norm(employment);
  const fallback: ContractType = /intern|stage/.test(e) ? "stage"
    : /apprenti|alternance|work.?study/.test(e) ? "alternance"
    : /temporary|fixed|cdd|contract\b|temporaire/.test(e) ? "cdd"
    : /freelance|contractor/.test(e) ? "freelance"
    : "cdi";
  return inferContract(employment, fallback, title);
}

const REMOTE_WORDS: Record<string, JobOffer["remote"]> = { remote: "total", hybrid: "hybride", onsite: "sur-site", "on-site": "sur-site" };
function remoteFrom(type: any, title: string, location: string): JobOffer["remote"] {
  const t = norm(String(type || "")).replace(/\s+/g, "");
  return REMOTE_WORDS[t] || inferRemote(`${title} ${location}`);
}

/** « Posted Today », « Posted 3 Days Ago », « Posted 30+ Days Ago » (Workday) → date ISO. */
export function workdayPostedOn(text: string, now = Date.now()): string {
  const t = norm(text);
  const day = 86400_000;
  if (/today|aujourd/.test(t)) return new Date(now).toISOString();
  if (/yesterday|hier/.test(t)) return new Date(now - day).toISOString();
  const n = Number(t.match(/(\d+)\+?\s*(days?|jours?)/)?.[1]);
  return new Date(now - (Number.isFinite(n) && n > 0 ? n : 30) * day).toISOString();
}

function base(company: AtsCompany, id: string | number, partial: Omit<JobOffer, "id" | "company" | "source" | "origin" | "status" | "skillsRequired"> & { skills?: string[] }): JobOffer {
  const { skills, ...rest } = partial;
  return {
    ...rest,
    id: `ats-${company.ats}-${company.slug.toLowerCase()}-${id}`,
    company: company.name,
    source: `Site carrière ${company.name} (${ATS_LABELS[company.ats]})`,
    origin: "site-carriere",
    status: "active",
    skillsRequired: deriveSkills(skills || [], rest.title, rest.description)
  };
}

// ---------------------------------------------------------------------------
// Normalisation par ATS (une offre → JobOffer, ou null si hors France / illisible)
// ---------------------------------------------------------------------------
export function normalizeGreenhouseJob(j: any, company: AtsCompany): JobOffer | null {
  if (!j?.title || !j?.absolute_url) return null;
  const location = String(j.location?.name || "");
  const meta = (Array.isArray(j.metadata) ? j.metadata : []) as any[];
  const offices = (Array.isArray(j.offices) ? j.offices : []).map((o: any) => `${o?.name || ""} ${o?.location || ""}`).join(" ");
  const country = meta.find((m) => /country/i.test(String(m?.name)))?.value;
  if (!looksFrench(`${location} ${offices} ${Array.isArray(country) ? country.join(" ") : country || ""}`)) return null;
  const title = String(j.title);
  const employment = String(meta.find((m) => /employment|contract|contrat/i.test(String(m?.name)))?.value || "");
  const description = clip(stripHtml(decodeEscapedHtml(j.content)));
  return base(company, j.id, {
    title,
    location,
    contractType: contractFrom(title, employment),
    remote: remoteFrom("", title, location),
    description,
    applyUrl: String(j.absolute_url),
    publishedAt: iso(j.first_published) || iso(j.updated_at) || new Date().toISOString(),
    domain: j.departments?.[0]?.name || undefined
  });
}

export function normalizeLeverJob(j: any, company: AtsCompany): JobOffer | null {
  if (!j?.text || !j?.hostedUrl) return null;
  const locations: string[] = Array.isArray(j.categories?.allLocations) ? j.categories.allLocations : [j.categories?.location].filter(Boolean);
  const location = locations.join(" · ");
  if (String(j.country || "").toUpperCase() !== "FR" && !looksFrench(location)) return null;
  const title = String(j.text);
  const lists = (Array.isArray(j.lists) ? j.lists : []).map((l: any) => `${l?.text || ""}\n${stripHtml(l?.content)}`).join("\n\n");
  const description = clip([j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).map((s) => String(s).trim()).join("\n\n"));
  return base(company, j.id, {
    title,
    location,
    contractType: contractFrom(title, String(j.categories?.commitment || "")),
    remote: remoteFrom(j.workplaceType, title, location),
    description,
    applyUrl: String(j.hostedUrl),
    publishedAt: iso(j.createdAt) || new Date().toISOString(),
    domain: j.categories?.department || j.categories?.team || undefined
  });
}

export function normalizeAshbyJob(j: any, company: AtsCompany): JobOffer | null {
  if (!j?.title || !j?.jobUrl || j.isListed === false) return null;
  const secondary = (Array.isArray(j.secondaryLocations) ? j.secondaryLocations : []).map((s: any) => s?.location || "").join(" ");
  const country = String(j.address?.postalAddress?.addressCountry || "");
  const location = [j.address?.postalAddress?.addressLocality, j.location].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ") || String(j.location || "");
  if (!/france/i.test(country) && !looksFrench(`${location} ${secondary}`)) return null;
  const title = String(j.title);
  const salary = j.shouldDisplayCompensationOnJobPostings ? j.compensation?.compensationTierSummary || undefined : undefined;
  return base(company, j.id, {
    title,
    location,
    contractType: contractFrom(title, String(j.employmentType || "")),
    remote: j.isRemote === true ? "total" : remoteFrom(j.workplaceType, title, location),
    salary: salary ? String(salary) : undefined,
    description: clip(String(j.descriptionPlain || stripHtml(j.descriptionHtml))),
    applyUrl: String(j.jobUrl),
    publishedAt: iso(j.publishedAt) || new Date().toISOString(),
    domain: j.department || j.team || undefined
  });
}

export function normalizeRecruiteeJob(o: any, company: AtsCompany): JobOffer | null {
  if (!o?.title || !o?.careers_url) return null;
  const location = [o.city, o.state_name].filter(Boolean).join(", ") || String(o.location || "");
  if (String(o.country_code || "").toUpperCase() !== "FR" && !looksFrench(`${location} ${o.country || ""}`)) return null;
  const title = String(o.title);
  const remote: JobOffer["remote"] = o.remote ? "total" : o.hybrid ? "hybride" : o.on_site ? "sur-site" : inferRemote(title);
  const description = clip([stripHtml(o.description), stripHtml(o.requirements)].filter(Boolean).join("\n\n"));
  return base(company, o.id, {
    title,
    location: location || "France",
    contractType: contractFrom(title, String(o.employment_type_code || "")),
    remote,
    description,
    applyUrl: String(o.careers_url),
    publishedAt: iso(String(o.published_at || o.created_at || "").replace(" UTC", "Z").replace(" ", "T")) || new Date().toISOString(),
    domain: o.department || undefined
  });
}

/** SmartRecruiters : la liste ne contient pas la description (extrait = fonction et service). */
export function normalizeSmartRecruitersJob(p: any, company: AtsCompany): JobOffer | null {
  if (!p?.name || !p?.id) return null;
  const loc = p.location || {};
  if (loc.country && String(loc.country).toLowerCase() !== "fr") return null;
  const title = String(p.name);
  const location = String(loc.fullLocation || [loc.city, loc.region].filter(Boolean).join(", ") || "France");
  const description = [p.function?.label, p.department?.label, p.experienceLevel?.label !== "Not Applicable" ? p.experienceLevel?.label : ""]
    .filter(Boolean).join(" · ");
  const lat = Number(loc.latitude), lon = Number(loc.longitude);
  return base(company, p.id, {
    title,
    location,
    latitude: Number.isFinite(lat) && loc.latitude != null ? lat : undefined,
    longitude: Number.isFinite(lon) && loc.longitude != null ? lon : undefined,
    contractType: contractFrom(title, `${p.typeOfEmployment?.id || ""} ${p.typeOfEmployment?.label || ""}`),
    remote: loc.remote ? "total" : loc.hybrid ? "hybride" : inferRemote(title),
    description,
    descriptionIsSnippet: true,
    applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(company.slug)}/${encodeURIComponent(String(p.id))}`,
    publishedAt: iso(p.releasedDate) || new Date().toISOString(),
    domain: p.function?.label || undefined
  });
}

/** Workday : la liste est déjà filtrée sur la France ; la description complète est sur la page de l'offre. */
export function normalizeWorkdayJob(j: any, company: AtsCompany, now = Date.now()): JobOffer | null {
  if (!j?.title || !j?.externalPath || !company.workday) return null;
  const title = String(j.title);
  const multi = /^\d+\s+locations?$/i.test(String(j.locationsText || ""));
  const location = multi ? "France (plusieurs sites)" : String(j.locationsText || "France");
  const bullets = (Array.isArray(j.bulletFields) ? j.bulletFields : []).filter((b: any) => !/^[A-Z]{1,4}[-_]?\d[\w-]*$/.test(String(b)));
  const id = String(j.externalPath).split("_").pop() || j.externalPath;
  return base(company, id, {
    title,
    location,
    contractType: contractFrom(title, `${j.timeType || ""} ${bullets.join(" ")}`),
    remote: remoteFrom(j.remoteType, title, location),
    description: bullets.join(" · "),
    descriptionIsSnippet: true,
    applyUrl: `https://${company.workday.host}.myworkdayjobs.com/${company.workday.site}${j.externalPath}`,
    publishedAt: workdayPostedOn(String(j.postedOn || ""), now)
  });
}

// ---------------------------------------------------------------------------
// Récupération
// ---------------------------------------------------------------------------
async function getJson(url: string, init?: any): Promise<any> {
  const res = await sourceFetch(url, { ...init, headers: { Accept: "application/json", ...(init?.headers || {}) } });
  if (res.status === 404) throw new Error("site carrière introuvable");
  if (!res.ok) throw new Error(`erreur ${res.status}`);
  return res.json();
}

/** Sites qui renvoient toutes leurs offres d'un coup : on garde la liste France en cache une heure. */
async function fetchBoard(company: AtsCompany): Promise<JobOffer[]> {
  const slug = encodeURIComponent(company.slug);
  return cached(`ats:${company.ats}:${company.slug}`, async () => {
    switch (company.ats) {
      case "greenhouse": {
        const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
        return (d?.jobs || []).map((j: any) => normalizeGreenhouseJob(j, company)).filter(Boolean);
      }
      case "lever": {
        const d = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
        return (Array.isArray(d) ? d : []).map((j: any) => normalizeLeverJob(j, company)).filter(Boolean);
      }
      case "ashby": {
        const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
        return (d?.jobs || []).map((j: any) => normalizeAshbyJob(j, company)).filter(Boolean);
      }
      case "recruitee": {
        const d = await getJson(`https://${slug}.recruitee.com/api/offers/`);
        return (d?.offers || []).map((o: any) => normalizeRecruiteeJob(o, company)).filter(Boolean);
      }
      default:
        return [];
    }
  }, BOARD_TTL_MS) as Promise<JobOffer[]>;
}

/** Sites avec recherche côté serveur (catalogues de plusieurs milliers d'offres). */
async function searchCompany(company: AtsCompany, query: string): Promise<JobOffer[]> {
  if (company.ats === "smartrecruiters") {
    const qs = new URLSearchParams({ country: "fr", limit: "100" });
    if (query) qs.set("q", query);
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.slug)}/postings?${qs}`;
    return cached(`ats:${url}`, async () => {
      const d = await getJson(url);
      return (d?.content || []).map((p: any) => normalizeSmartRecruitersJob(p, company)).filter(Boolean);
    }, BOARD_TTL_MS) as Promise<JobOffer[]>;
  }
  if (company.ats === "workday" && company.workday) {
    const { host, site, countryFacet = "locationCountry" } = company.workday;
    const url = `https://${host}.myworkdayjobs.com/wday/cxs/${encodeURIComponent(company.slug)}/${encodeURIComponent(site)}/jobs`;
    const body = { limit: 20, offset: 0, searchText: query, appliedFacets: { [countryFacet]: [WORKDAY_FRANCE] } };
    return cached(`ats:${url}:${query}`, async () => {
      const d = await getJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return (d?.jobPostings || []).map((j: any) => normalizeWorkdayJob(j, company)).filter(Boolean);
    }, BOARD_TTL_MS) as Promise<JobOffer[]>;
  }
  return fetchBoard(company);
}

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------
const IDF_DEPARTEMENTS = new Set(["75", "77", "78", "91", "92", "93", "94", "95"]);

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Le poste est-il dans la zone demandée ? Les postes 100 % à distance sont toujours gardés. */
export function inArea(job: JobOffer, geo: GeoPoint | null, radiusKm = 30): boolean {
  if (!geo || job.remote === "total") return true;
  if (geo.latitude != null && geo.longitude != null && job.latitude != null && job.longitude != null) {
    return distanceKm(geo.latitude, geo.longitude, job.latitude, job.longitude) <= Math.max(radiusKm, 5);
  }
  const loc = norm(job.location);
  if (geo.label.startsWith("Département")) return true; // pas de code postal dans les ATS : on ne peut pas trancher
  if (loc.includes(norm(geo.label))) return true;
  if (geo.departement && IDF_DEPARTEMENTS.has(geo.departement) && /\b(paris|ile-de-france|idf|la defense)\b/.test(loc)) return true;
  return false;
}

/** Pertinence sur l'intitulé et le service (les descriptions complètes citent tous les métiers de l'entreprise). */
function matchesQuery(job: JobOffer, query: string): boolean {
  if (!queryWords(query).length) return true;
  return isRelevant({ ...job, description: `${job.domain || ""}` }, query);
}

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------
export interface CareerSitesResult {
  jobs: JobOffer[];
  /** Sites qui ont échoué (erreur) ou trop lents (résultats à la prochaine recherche). */
  failed: number;
  late: number;
  total: number;
}

export async function searchCareerSites(params: SearchParams, geo: GeoPoint | null): Promise<CareerSitesResult> {
  const query = (params.query || "").trim();
  const companies = careerSiteCompanies();
  let failed = 0, late = 0;

  const perCompany = companies.map(async (company) => {
    let timer: any;
    const work = searchCompany(company, query).catch(() => { failed++; return [] as JobOffer[]; });
    const timeout = new Promise<JobOffer[]>((resolve) => { timer = setTimeout(() => { late++; resolve([]); }, COMPANY_WAIT_MS); });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  });
  const lists = await Promise.all(perCompany);
  if (companies.length && failed === companies.length) throw new Error("aucun site carrière n'a répondu");

  const jobs = lists
    .flat()
    .filter((j) => matchesQuery(j, query) && inArea(j, geo, params.radius))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    .slice(0, MAX_RESULTS);
  return { jobs, failed, late, total: companies.length };
}

/**
 * Offres publiées directement sur les sites carrières des entreprises.
 *
 * La plupart des entreprises publient leurs offres via un logiciel de recrutement (ATS) qui expose
 * une API publique, sans clé, destinée à afficher ces offres sur leur site : Greenhouse, Lever, Ashby,
 * SmartRecruiters, Recruitee, Teamtailor, Workday. Un robot parcourt en tâche de fond tous les sites de
 * l'annuaire (server/careerSitesDirectory.ts) et garde leurs offres en France dans un index en mémoire,
 * sauvegardé sur disque ; la recherche filtre cet index. « Postuler » mène à la page officielle de l'offre.
 *
 * Variables : ATS_SOURCES=off (désactiver), ATS_COMPANIES_FILE (entreprises en plus, JSON),
 * ATS_INDEX_FILE (index sauvegardé, « off » pour ne pas l'écrire), ATS_REFRESH_MINUTES, ATS_CONCURRENCY.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JobOffer, ContractType } from "../src/types.ts";
import { CAREER_SITES, DISCOVERED_CAREER_SITES, type AtsCompany, type AtsKind } from "./careerSitesDirectory.ts";
import {
  sourceFetch, stripHtml, inferContract, inferRemote, deriveSkills, queryWords,
  type SearchParams, type GeoPoint
} from "./jobSources.ts";

/** Fréquence de mise à jour d'un site (les offres changent peu d'une heure à l'autre). */
const REFRESH_MS = (Number(process.env.ATS_REFRESH_MINUTES) || 180) * 60_000;
/** Un site en erreur est réessayé plus tôt. */
const RETRY_MS = 30 * 60_000;
const CHECK_EVERY_MS = 15 * 60_000;
/** Index sauvegardé sur disque : réutilisé au redémarrage s'il a moins de 24 h. */
const SNAPSHOT_MAX_AGE_MS = 24 * 3600_000;
/** Attente maximale du premier parcours lors d'une recherche (la suite arrive aux recherches suivantes). */
const FIRST_WAIT_MS = Number(process.env.ATS_WAIT_MS) || 8_000;
/** Sites interrogés en parallèle par le robot. */
const CONCURRENCY = Number(process.env.ATS_CONCURRENCY) || 12;
/** Offres en France gardées au plus par entreprise (SmartRecruiters, Workday : plusieurs milliers). */
const MAX_PER_COMPANY = 1000;
const MAX_RESULTS = 200;
/** Description gardée dans l'index (mémoire) ; au-delà, l'offre est marquée « extrait » et renvoie au site. */
const MAX_DESCRIPTION = Number(process.env.ATS_DESCRIPTION_CHARS) || 2000;
/** Identifiant du pays « France » dans Workday (commun à tous les sites). */
const WORKDAY_FRANCE = "54c5b6971ffb4bf0b116fe7651ec789a";

const ATS_LABELS: Record<AtsKind, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  recruitee: "Recruitee",
  teamtailor: "Teamtailor",
  workday: "Workday"
};

export function careerSitesEnabled(): boolean {
  return (process.env.ATS_SOURCES || "").toLowerCase() !== "off";
}

let extraCompanies: AtsCompany[] | null = null;
let testCompanies: AtsCompany[] | null = null;
export function careerSiteCompanies(): AtsCompany[] {
  if (testCompanies) return testCompanies;
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
  const all = [...DISCOVERED_CAREER_SITES.map(({ name, ats, slug }) => ({ name, ats, slug })), ...CAREER_SITES, ...extraCompanies];
  // Les entrées vérifiées à la main, puis celles du fichier, remplacent celles trouvées automatiquement
  const byKey = new Map(all.map((c) => [`${c.ats}:${c.slug.toLowerCase()}`, c]));
  return Array.from(byKey.values());
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
  const clipped = rest.description.length > MAX_DESCRIPTION && rest.description.endsWith("…");
  return {
    ...rest,
    descriptionIsSnippet: rest.descriptionIsSnippet || clipped || undefined,
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

/** Contenu d'une balise d'un flux RSS (CDATA et échappement HTML retirés). */
function rssTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return (m?.[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
}

/** Teamtailor : flux RSS public ({slug}.teamtailor.com/jobs.rss), une entrée <item> par offre. */
export function parseTeamtailorRss(xml: string, company: AtsCompany): JobOffer[] {
  return String(xml || "")
    .split("<item>")
    .slice(1)
    .map((item) => normalizeTeamtailorItem(item.split("</item>")[0], company))
    .filter(Boolean) as JobOffer[];
}

export function normalizeTeamtailorItem(item: string, company: AtsCompany): JobOffer | null {
  const title = stripHtml(rssTag(item, "title"));
  const link = rssTag(item, "link");
  if (!title || !/^https?:\/\//.test(link)) return null;
  const locations = item.split("<tt:location>").slice(1).map((l) => ({ city: stripHtml(rssTag(l, "tt:city")), country: stripHtml(rssTag(l, "tt:country")) }));
  if (locations.length && !locations.some((l) => /france/i.test(l.country) || looksFrench(l.city))) return null;
  if (!locations.length && !looksFrench(title)) return null;
  const cities = Array.from(new Set(locations.filter((l) => /france/i.test(l.country) || looksFrench(l.city)).map((l) => l.city).filter(Boolean)));
  const location = cities.join(" · ") || "France";
  const id = rssTag(item, "guid") || link.split("/").pop() || link;
  return base(company, id, {
    title,
    location,
    contractType: contractFrom(title, ""),
    remote: remoteFrom(rssTag(item, "remoteStatus"), title, location),
    description: clip(stripHtml(decodeEscapedHtml(rssTag(item, "description")))),
    applyUrl: link,
    publishedAt: iso(rssTag(item, "pubDate")) || new Date().toISOString(),
    domain: stripHtml(rssTag(item, "tt:department")) || undefined
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
// Récupération : toutes les offres en France d'un site carrière
// ---------------------------------------------------------------------------
async function getJson(url: string, init?: any): Promise<any> {
  const res = await sourceFetch(url, { timeoutMs: 20_000, ...init, headers: { Accept: "application/json", ...(init?.headers || {}) } });
  if (res.status === 404) throw new Error("site carrière introuvable");
  if (!res.ok) throw new Error(`erreur ${res.status}`);
  return res.json();
}

export async function fetchCompanyJobs(company: AtsCompany): Promise<JobOffer[]> {
  const slug = encodeURIComponent(company.slug);
  const keep = (list: any[], normalize: (x: any) => JobOffer | null) => list.map(normalize).filter(Boolean) as JobOffer[];
  switch (company.ats) {
    case "greenhouse": {
      const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      return keep(d?.jobs || [], (j) => normalizeGreenhouseJob(j, company));
    }
    case "lever": {
      const d = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      return keep(Array.isArray(d) ? d : [], (j) => normalizeLeverJob(j, company));
    }
    case "ashby": {
      const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
      return keep(d?.jobs || [], (j) => normalizeAshbyJob(j, company));
    }
    case "recruitee": {
      const d = await getJson(`https://${slug}.recruitee.com/api/offers/`);
      return keep(d?.offers || [], (o) => normalizeRecruiteeJob(o, company));
    }
    case "teamtailor": {
      const res = await sourceFetch(`https://${slug}.teamtailor.com/jobs.rss`, { timeoutMs: 20_000, headers: { Accept: "application/rss+xml, application/xml" } });
      if (res.status === 404) throw new Error("site carrière introuvable");
      if (!res.ok) throw new Error(`erreur ${res.status}`);
      return parseTeamtailorRss(await res.text(), company);
    }
    case "smartrecruiters": {
      const out: JobOffer[] = [];
      for (let offset = 0; offset < MAX_PER_COMPANY; offset += 100) {
        const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?country=fr&limit=100&offset=${offset}`);
        const page = d?.content || [];
        out.push(...keep(page, (p) => normalizeSmartRecruitersJob(p, company)));
        if (page.length < 100 || offset + 100 >= (d?.totalFound || 0)) break;
      }
      return out;
    }
    case "workday": {
      if (!company.workday) return [];
      const { host, site, countryFacet = "locationCountry" } = company.workday;
      const url = `https://${host}.myworkdayjobs.com/wday/cxs/${slug}/${encodeURIComponent(site)}/jobs`;
      const facets = countryFacet === "none" ? {} : { [countryFacet]: [WORKDAY_FRANCE] };
      const out: JobOffer[] = [];
      const now = Date.now();
      for (let offset = 0; offset < MAX_PER_COMPANY; offset += 20) {
        const d = await getJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 20, offset, searchText: "", appliedFacets: facets }) });
        const page = d?.jobPostings || [];
        out.push(...keep(page, (j) => normalizeWorkdayJob(j, company, now)));
        if (page.length < 20 || offset + 20 >= (d?.total || 0)) break;
      }
      return out;
    }
    default:
      return [];
  }
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

/**
 * Pertinence sur l'intitulé et le service (les descriptions complètes citent tous les métiers de l'entreprise).
 * Même règle que isRelevant (au moins la moitié des mots, racine de 5 lettres), préparée une fois par recherche.
 */
const haystacks = new WeakMap<JobOffer, string>();
function queryMatcher(query: string): (job: JobOffer) => boolean {
  const stems = queryWords(query).filter((w) => w.length > 2).map((w) => (w.length > 6 ? w.slice(0, 5) : w));
  if (!stems.length) return () => true;
  const needed = Math.ceil(stems.length / 2);
  return (job) => {
    let hay = haystacks.get(job);
    if (hay === undefined) {
      hay = norm(`${job.title} ${job.domain || ""}`);
      haystacks.set(job, hay);
    }
    let hits = 0;
    for (const w of stems) if (hay.includes(w) && ++hits >= needed) return true;
    return false;
  };
}

// ---------------------------------------------------------------------------
// Index : un robot parcourt tous les sites en tâche de fond, la recherche filtre l'index en mémoire
// ---------------------------------------------------------------------------
interface IndexEntry { jobs: JobOffer[]; fetchedAt: number; error?: string }
const index = new Map<string, IndexEntry>();
const keyOf = (c: AtsCompany) => `${c.ats}:${c.slug.toLowerCase()}`;
let crawling: Promise<void> | null = null;
let firstPassDone = false;
let lastCrawlAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function indexFile(): string | null {
  const f = process.env.ATS_INDEX_FILE ?? ".cache/career-index.json";
  return f && f !== "off" ? f : null;
}

function loadSnapshot() {
  const file = indexFile();
  if (!file || !existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const known = new Set(careerSiteCompanies().map(keyOf));
    for (const [k, v] of Object.entries<IndexEntry>(data?.entries || {})) {
      if (known.has(k) && Date.now() - v.fetchedAt < SNAPSHOT_MAX_AGE_MS) index.set(k, v);
    }
    if (index.size) firstPassDone = true;
  } catch {
    /* index illisible : il sera reconstruit */
  }
}

function saveSnapshot() {
  const file = indexFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), entries: Object.fromEntries(index) }));
  } catch (e: any) {
    console.warn(`Index des sites carrières non sauvegardé : ${e?.message || e}`);
  }
}

/** Met à jour les sites dont l'index a plus de REFRESH_MS (tous au premier passage). */
export function crawlCareerSites(force = false): Promise<void> {
  if (crawling) return crawling;
  crawling = (async () => {
    const companies = careerSiteCompanies().filter((c) => {
      const e = index.get(keyOf(c));
      return force || !e || Date.now() - e.fetchedAt > (e.error ? RETRY_MS : REFRESH_MS);
    });
    let next = 0;
    let sinceSave = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, companies.length) }, async () => {
      while (next < companies.length) {
        const c = companies[next++];
        const k = keyOf(c);
        try {
          index.set(k, { jobs: await fetchCompanyJobs(c), fetchedAt: Date.now() });
        } catch (e: any) {
          const prev = index.get(k);
          // On garde les offres déjà connues en cas de panne passagère
          index.set(k, { jobs: prev?.jobs || [], fetchedAt: Date.now(), error: String(e?.message || e) });
        }
        if (++sinceSave >= 200) { sinceSave = 0; saveSnapshot(); }
      }
    }));
    firstPassDone = true;
    lastCrawlAt = Date.now();
    saveSnapshot();
  })().finally(() => { crawling = null; });
  return crawling;
}

/** Démarre le robot (au lancement du serveur ou à la première recherche) et le relance régulièrement. */
export function startCareerSitesIndexer() {
  if (timer || !careerSitesEnabled()) return;
  loadSnapshot();
  void crawlCareerSites();
  timer = setInterval(() => void crawlCareerSites(), CHECK_EVERY_MS);
  timer.unref?.();
}

export function careerSitesIndexStatus() {
  const entries = Array.from(index.values());
  return {
    companies: careerSiteCompanies().length,
    indexed: entries.length,
    failed: entries.filter((e) => e.error).length,
    jobs: entries.reduce((n, e) => n + e.jobs.length, 0),
    crawling: !!crawling,
    lastCrawlAt: lastCrawlAt ? new Date(lastCrawlAt).toISOString() : null
  };
}

/** Tests : annuaire réduit (null = annuaire réel). */
export function __setCareerSitesForTests(list: AtsCompany[] | null) {
  testCompanies = list;
}

export function __resetCareerSitesForTests() {
  extraCompanies = null;
  testCompanies = null;
  index.clear();
  firstPassDone = false;
  lastCrawlAt = 0;
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------
export interface CareerSitesResult {
  jobs: JobOffer[];
  /** Sites indexés / sites de l'annuaire (l'index se remplit au démarrage du serveur). */
  indexed: number;
  total: number;
  /** Premier parcours encore en cours. */
  indexing: boolean;
}

export async function searchCareerSites(params: SearchParams, geo: GeoPoint | null): Promise<CareerSitesResult> {
  startCareerSitesIndexer();
  // Premier démarrage sans index sauvegardé : on attend un peu le robot, la suite arrivera à la prochaine recherche
  if (!firstPassDone && crawling) {
    let t: any;
    await Promise.race([crawling, new Promise((r) => { t = setTimeout(r, FIRST_WAIT_MS); })]);
    clearTimeout(t);
  }
  const companies = careerSiteCompanies();
  const entries = companies.map((c) => index.get(keyOf(c))).filter(Boolean) as IndexEntry[];
  if (entries.length && entries.every((e) => e.error && !e.jobs.length)) throw new Error("aucun site carrière n'a répondu");

  const query = (params.query || "").trim();
  const contract = (params.contractType || "tous").toLowerCase();
  const matches = queryMatcher(query);
  const jobs = entries
    .flatMap((e) => e.jobs)
    .filter((j) => (contract === "tous" || j.contractType === contract) && matches(j) && inArea(j, geo, params.radius))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    .slice(0, MAX_RESULTS);
  return { jobs, indexed: entries.length, total: companies.length, indexing: !firstPassDone || (!!crawling && entries.length < companies.length) };
}

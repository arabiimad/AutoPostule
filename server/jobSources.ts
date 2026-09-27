/**
 * Sources d'offres RÉELLES :
 *  - API La bonne alternance (offres en alternance : LBA + France Travail + partenaires)
 *    https://api.apprentissage.beta.gouv.fr/fr/documentation-technique — clé : LBA_API_KEY
 *  - API Offres d'emploi v2 de France Travail (CDI, CDD, alternance…)
 *    https://francetravail.io/data/api/offres-emploi — identifiants : FT_CLIENT_ID / FT_CLIENT_SECRET
 *
 * Sans aucune clé configurée, le serveur bascule en mode démonstration (base locale indicative).
 */
import type { JobOffer, ContractType } from "../src/types.ts";
import { extractTechnologies } from "../src/semanticCvParser.ts";
import { QUERY_STOPWORDS } from "../src/utils/jobFilter.ts";
import { createHash } from "node:crypto";
import { kv, __resetKvForTests, countApiCall } from "./store.ts";

// URL surchargeables (tests, bac à sable) ; valeurs par défaut = production
const LBA_BASE = process.env.LBA_API_BASE || "https://api.apprentissage.beta.gouv.fr/api";
const FT_TOKEN_URL = process.env.FT_TOKEN_URL || "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire";
const FT_SEARCH_URL = process.env.FT_SEARCH_URL || "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search";
const GEO_URL = process.env.GEO_API_URL || "https://geo.api.gouv.fr/communes";
const ADZUNA_URL = process.env.ADZUNA_API_URL || "https://api.adzuna.com/v1/api/jobs/fr/search/1";
const JOOBLE_HOST = process.env.JOOBLE_HOST || "https://jooble.org";
const JSEARCH_URL = process.env.JSEARCH_API_URL || "https://jsearch.p.rapidapi.com/search-v2";
const JSEARCH_HOST = process.env.JSEARCH_API_HOST || "jsearch.p.rapidapi.com";
/** Correspondance libellé de métier → codes ROME (service public de La bonne alternance). "off" pour désactiver. */
const LBA_ROME_URL = process.env.LBA_ROME_URL || "https://labonnealternance.apprentissage.beta.gouv.fr/api/rome";

const REQUEST_TIMEOUT_MS = 12_000;
/** Temps d'attente maximal de Google Jobs avant d'afficher les autres résultats. */
const JSEARCH_WAIT_MS = Number(process.env.JSEARCH_WAIT_MS) || 12_000;
const CACHE_TTL_MS = 10 * 60_000;

export interface SearchParams {
  query?: string;
  contractType?: string;
  location?: string;
  radius?: number;
  /** Page de résultats (1 par défaut) pour « Charger plus d'offres ». */
  page?: number;
  /** Entreprises qui recrutent en alternance sans offre publiée (La bonne alternance). Défaut : oui. */
  includeSpontaneous?: boolean;
}

export interface SourceReport {
  enabled: boolean;
  count: number;
  error?: string;
  /** Source configurée mais non interrogée pour cette recherche (raison). */
  skipped?: string;
}

export type SourceKey = "laBonneAlternance" | "franceTravail" | "jsearch" | "adzuna" | "jooble";

export const SOURCE_LABELS: Record<SourceKey, string> = {
  laBonneAlternance: "La bonne alternance",
  franceTravail: "France Travail",
  jsearch: "Google Jobs (LinkedIn, Indeed, WTTJ…)",
  adzuna: "Adzuna",
  jooble: "Jooble"
};

export interface RealSearchResult {
  jobs: JobOffer[];
  sources: Record<SourceKey, SourceReport>;
  warnings: string[];
  resolvedLocation?: string;
  /** D'autres pages de résultats sont disponibles. */
  hasMore?: boolean;
  page?: number;
}

/** fetch injectable (tests). */
type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string>; headers?: any }>;
let fetchImpl: FetchLike = (url, init) => {
  const { timeoutMs, ...rest } = init || {};
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS) }) as any;
};
export function __setFetchForTests(f: FetchLike) {
  fetchImpl = f;
}

export function getSourceStatus(): Record<SourceKey, boolean> {
  return {
    laBonneAlternance: !!process.env.LBA_API_KEY,
    franceTravail: !!(process.env.FT_CLIENT_ID && process.env.FT_CLIENT_SECRET),
    jsearch: !!process.env.JSEARCH_API_KEY,
    adzuna: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    jooble: !!process.env.JOOBLE_API_KEY
  };
}

export function hasRealSources(): boolean {
  return Object.values(getSourceStatus()).some(Boolean);
}

// ---------------------------------------------------------------------------
// Cache mémoire
// ---------------------------------------------------------------------------
// Cache partagé (mémoire, ou Redis si configuré — voir server/store.ts). Les clés sont hachées :
// certaines URL contiennent des identifiants d'API.
async function cached<T>(key: string, loader: () => Promise<T>, ttlMs = CACHE_TTL_MS): Promise<T> {
  const k = `cache:${createHash("sha1").update(key).digest("hex")}`;
  const hit = await kv().get(k);
  if (hit != null) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      /* entrée illisible : on recharge */
    }
  }
  const value = await loader();
  await kv().set(k, JSON.stringify(value ?? null), Math.ceil(ttlMs / 1000));
  return value;
}
export function __clearCacheForTests() {
  __resetKvForTests();
  ftToken = null;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const norm = (v: string) => (v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function queryWords(query: string): string[] {
  return norm(query)
    .split(/[\s,;/]+/)
    .filter((w) => w.length > 1 && !QUERY_STOPWORDS.has(w));
}

/**
 * Codes ROME pour quelques familles de métiers fréquentes, afin de cibler la recherche La bonne alternance.
 * Si aucun ne correspond, la recherche se fait par zone puis par mots-clés.
 */
const ROME_HINTS: { match: RegExp; romes: string[] }[] = [
  { match: /\b(developpeu|dev\b|full ?stack|front[- ]?end|back[- ]?end|logiciel|software|programm|developpement (web|logiciel|informatique|applicati))/, romes: ["M1805"] },
  { match: /\b(chef de projet (informatique|it|si|digital|numerique|web)|moa|amoa|product owner|business analyst|maitrise d.ouvrage|projet (it|si|informatique))/, romes: ["M1806", "M1805"] },
  { match: /\b(systeme|reseau|devops|cloud|infrastructure|sysadmin|administrateur)/, romes: ["M1801", "M1810"] },
  { match: /\b(support|helpdesk|technicien informatique)/, romes: ["M1810", "I1401"] },
  { match: /\b(marketing)/, romes: ["M1705"] },
  { match: /\b(communication|community manager|charge de com)/, romes: ["E1103"] },
  { match: /\b(ressources humaines|\brh\b|recrutement|paie)/, romes: ["M1501", "M1502", "M1503"] },
  { match: /\b(comptab|controle de gestion|controleur de gestion)/, romes: ["M1203", "M1204"] },
  { match: /\b(juriste|juridique)/, romes: ["K1903"] }
];
export function romeHints(query: string): string[] {
  const q = norm(query);
  if (!q) return [];
  const found = new Set<string>();
  for (const h of ROME_HINTS) if (h.match.test(q)) h.romes.forEach((r) => found.add(r));
  // Un code ROME saisi directement (ex. M1805) est aussi accepté
  (q.toUpperCase().match(/\b[A-N]\d{4}\b/g) || []).forEach((r) => found.add(r));
  return [...found].slice(0, 6);
}

export interface GeoPoint {
  label: string;
  latitude?: number;
  longitude?: number;
  inseeCode?: string;
  departement?: string;
}

/** Commune → coordonnées + code INSEE ; « 84 » → département ; « remote » → aucune zone. */
export async function geocode(location?: string): Promise<GeoPoint | null> {
  const loc = (location || "").trim();
  if (!loc || /^(france|toute la france|tous)$/i.test(loc) || /^(remote|t[ée]l[ée]travail|full remote)$/i.test(loc)) return null;
  if (/^(\d{2}|2a|2b|97\d)$/i.test(loc)) return { label: `Département ${loc.toUpperCase()}`, departement: loc.toUpperCase() };

  return cached(`geo:${norm(loc)}`, async () => {
    const url = `${GEO_URL}?nom=${encodeURIComponent(loc)}&fields=centre,codeDepartement,code,nom&boost=population&limit=1`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Géocodage indisponible (${res.status})`);
    const data = await res.json();
    const c = Array.isArray(data) ? data[0] : null;
    if (!c) return null;
    const [longitude, latitude] = c.centre?.coordinates || [];
    return { label: c.nom, latitude, longitude, inseeCode: c.code, departement: c.codeDepartement };
  });
}

/** Caractères Windows-1252 mal convertis par certaines sources (ex. « Alternance \x96 Ingénieur »). */
const CP1252: Record<string, string> = { "\u0080": "€", "\u0085": "…", "\u0091": "‘", "\u0092": "’", "\u0093": "“", "\u0094": "”", "\u0095": "•", "\u0096": "–", "\u0097": "—", "\u009c": "œ", "\u008c": "Œ" };
export function fixEncoding(v: any): string {
  return String(v ?? "").replace(/[\u0080-\u009f]/g, (c) => CP1252[c] ?? "");
}

function isoOrUndefined(v: any): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Retire les phrases de consignes de candidature (« joindre un CV au format Word ou PDF ») :
 * elles ne décrivent pas le poste et faisaient apparaître « Pack Office » dans une offre de maçon.
 */
export function stripApplicationInstructions(description: string): string {
  return String(description || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => !/\b(postul|candidat|curriculum|joign|joindre|envoy|adress|transmet)\w*|\bCV\b|\bformat\s+(word|pdf|doc)/i.test(s))
    .join("\n");
}

/** Compétences exploitables pour le score : compétences listées + compétences reconnues dans le texte. */
export function deriveSkills(listed: string[], title: string, description: string): string[] {
  const fromText = extractTechnologies(`${title}\n${stripApplicationInstructions(description)}`);
  const short = listed.filter((s) => s && s.length <= 60);
  return Array.from(new Set([...fromText, ...short])).slice(0, 15);
}

// ---------------------------------------------------------------------------
// La bonne alternance
// ---------------------------------------------------------------------------
const LBA_REMOTE: Record<string, JobOffer["remote"]> = { onsite: "sur-site", remote: "total", hybrid: "hybride" };

export function normalizeLbaJob(j: any): JobOffer | null {
  const title = j?.offer?.title;
  if (!title) return null;
  const wp = j.workplace || {};
  const coords = wp.location?.geopoint?.coordinates || [];
  const description = String(j.offer?.description || "");
  // desired_skills = savoir-être (« Travailler en équipe »…) et to_be_acquired_skills = ce qui sera appris :
  // ni l'un ni l'autre n'est un prérequis, ils ne comptent donc pas dans le score.
  const listed: string[] = [];
  const partner = j.identifier?.partner_label || "La bonne alternance";
  const id = j.identifier?.id || j.identifier?.partner_job_id || `${wp.siret || wp.name}-${title}`;
  return {
    id: `lba-${id}`,
    title: String(title),
    company: String(wp.brand || wp.name || wp.legal_name || "Entreprise non communiquée"),
    location: String(wp.location?.address || ""),
    latitude: typeof coords[1] === "number" ? coords[1] : undefined,
    longitude: typeof coords[0] === "number" ? coords[0] : undefined,
    contractType: "alternance",
    remote: LBA_REMOTE[j.contract?.remote] || "non-precise",
    description,
    skillsRequired: deriveSkills(listed, title, description),
    source: partner === "La bonne alternance" ? "La bonne alternance" : `${partner} (via La bonne alternance)`,
    origin: "la-bonne-alternance",
    applyUrl: String(j.apply?.url || "https://labonnealternance.apprentissage.beta.gouv.fr/"),
    ...(j.apply?.recipient_id ? { lbaRecipientId: String(j.apply.recipient_id) } : {}),
    publishedAt: isoOrUndefined(j.offer?.publication?.creation) || "",
    expiresAt: isoOrUndefined(j.offer?.publication?.expiration),
    status: j.offer?.status && j.offer.status !== "Active" ? "expired" : "active",
    domain: j.offer?.target_diploma?.label ? `Niveau visé : ${j.offer.target_diploma.label}` : undefined,
    companySize: wp.size ? String(wp.size) : undefined,
    companySector: wp.domain?.naf?.label ? String(wp.domain.naf.label) : undefined,
    companyWebsite: wp.website || undefined,
    siret: wp.siret || undefined
  };
}

/**
 * Codes ROME d'une recherche : indices locaux + service de correspondance métier → ROME de La bonne alternance
 * (mis en cache 24 h). En cas d'indisponibilité, seuls les indices locaux sont utilisés.
 */
export async function resolveRomes(query: string): Promise<string[]> {
  const hints = romeHints(query);
  const q = (query || "").trim();
  if (!q || LBA_ROME_URL === "off" || /^[A-N]\d{4}$/i.test(q)) return hints;
  try {
    const found = await cached(`rome:${norm(q)}`, async () => {
      const res = await fetchImpl(`${LBA_ROME_URL}?title=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" }, timeoutMs: 5000 });
      if (!res.ok) throw new Error(`ROME ${res.status}`);
      const data = await res.json();
      const first = Array.isArray(data?.labelsAndRomes) ? data.labelsAndRomes[0] : null;
      return Array.isArray(first?.romes) ? first.romes.map(String).filter((r: string) => /^[A-N]\d{4}$/.test(r)) : [];
    }, 24 * 3600_000);
    return Array.from(new Set([...hints, ...found])).slice(0, 20);
  } catch {
    return hints;
  }
}

/** Entreprise « qui recrute en alternance » sans offre publiée : candidature spontanée. */
export function normalizeLbaRecruiter(r: any, query = ""): JobOffer | null {
  const wp = r?.workplace || {};
  const name = wp.brand || wp.name || wp.legal_name;
  if (!name) return null;
  const coords = wp.location?.geopoint?.coordinates || [];
  const sector = wp.domain?.naf?.label ? String(wp.domain.naf.label) : undefined;
  const size = wp.size ? String(wp.size) : undefined;
  const job = (query || "").trim();
  const description = [
    `${name} recrute régulièrement des alternants mais n'a pas publié d'offre pour le moment.`,
    `C'est le bon moment pour une candidature spontanée${job ? ` (${job})` : ""} : moins de concurrence qu'une annonce publique.`,
    sector ? `Secteur : ${sector}.` : "",
    size ? `Effectif : ${size} salariés.` : "",
    wp.description ? String(wp.description) : ""
  ].filter(Boolean).join("\n\n");
  return {
    id: `lbar-${r.identifier?.id || wp.siret || name}`,
    title: job ? `Candidature spontanée — ${job.charAt(0).toUpperCase()}${job.slice(1)}` : "Candidature spontanée en alternance",
    company: String(name),
    location: String(wp.location?.address || ""),
    latitude: typeof coords[1] === "number" ? coords[1] : undefined,
    longitude: typeof coords[0] === "number" ? coords[0] : undefined,
    contractType: "alternance",
    remote: "non-precise",
    description,
    skillsRequired: [],
    source: "La bonne alternance",
    origin: "la-bonne-alternance",
    isSpontaneous: true,
    companySize: size,
    companySector: sector,
    companyWebsite: wp.website || undefined,
    siret: wp.siret || undefined,
    applyUrl: String(r.apply?.url || "https://labonnealternance.apprentissage.beta.gouv.fr/"),
    ...(r.apply?.recipient_id ? { lbaRecipientId: String(r.apply.recipient_id) } : {}),
    // Pas de date de publication : on ne prétend pas que c'est récent
    publishedAt: "",
    status: "active",
    domain: sector
  };
}

async function searchLba(params: SearchParams, geo: GeoPoint | null): Promise<JobOffer[]> {
  const qs = new URLSearchParams();
  if (geo?.latitude != null && geo?.longitude != null) {
    qs.set("latitude", String(geo.latitude));
    qs.set("longitude", String(geo.longitude));
    qs.set("radius", String(Math.min(Math.max(params.radius || 30, 1), 200)));
  } else if (geo?.departement) {
    qs.append("departements", geo.departement);
  }
  const romes = await resolveRomes(params.query || "");
  if (romes.length) qs.set("romes", romes.join(","));

  const url = `${LBA_BASE}/job/v1/search?${qs.toString()}`;
  const data = await cached(`lba:${url}`, async () => {
    void countApiCall("laBonneAlternance");
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${process.env.LBA_API_KEY}`, Accept: "application/json" }, timeoutMs: 15_000 });
    if (res.status === 401 || res.status === 403) throw new Error("clé LBA_API_KEY refusée");
    if (res.status === 429) throw new Error("quota La bonne alternance atteint (60 appels/min)");
    if (!res.ok) throw new Error(`erreur ${res.status}`);
    return res.json();
  });

  let jobs = (Array.isArray(data?.jobs) ? data.jobs : []).map(normalizeLbaJob).filter(Boolean) as JobOffer[];

  // Sans code ROME, on filtre localement sur les mots de la recherche
  const words = queryWords(params.query || "");
  if (words.length && !romes.length) {
    jobs = jobs.filter((j) => {
      const hay = norm(`${j.title} ${j.company} ${j.description} ${j.skillsRequired.join(" ")}`);
      return words.every((w) => hay.includes(w));
    });
  }

  // Entreprises qui recrutent sans offre publiée : seulement si la recherche est ciblée (métier ou zone)
  if (params.includeSpontaneous !== false && (romes.length || geo)) {
    const recruiters = (Array.isArray(data?.recruiters) ? data.recruiters : [])
      .slice(0, 40)
      .map((r: any) => normalizeLbaRecruiter(r, params.query))
      .filter(Boolean) as JobOffer[];
    jobs = [...jobs, ...recruiters];
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// France Travail
// ---------------------------------------------------------------------------
let ftToken: { value: string; expiresAt: number } | null = null;

async function getFtToken(): Promise<string> {
  if (ftToken && ftToken.expiresAt > Date.now() + 30_000) return ftToken.value;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.FT_CLIENT_ID || "",
    client_secret: process.env.FT_CLIENT_SECRET || "",
    scope: "api_offresdemploiv2 o2dsoffre"
  });
  const res = await fetchImpl(FT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`identifiants France Travail refusés (${res.status})`);
  const data = await res.json();
  if (!data?.access_token) throw new Error("jeton France Travail absent");
  ftToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 1400) * 1000 };
  return ftToken.value;
}

const FT_CONTRACT: Record<string, ContractType> = { CDI: "cdi", CDD: "cdd", MIS: "cdd", SAI: "cdd", LIB: "freelance", FRA: "freelance" };

export function normalizeFtJob(o: any): JobOffer | null {
  if (!o?.intitule) return null;
  const description = fixEncoding(o.description);
  const listed = (o.competences || []).map((c: any) => String(c?.libelle || "")).filter(Boolean);
  const isAlternance = o.alternance === true || /apprentissage|professionnalisation/i.test(String(o.natureContrat || ""));
  const lieu = o.lieuTravail || {};
  return {
    id: `ft-${o.id}`,
    title: fixEncoding(o.intitule),
    company: String(o.entreprise?.nom || "Entreprise non communiquée"),
    location: String(lieu.libelle || lieu.commune || ""),
    latitude: typeof lieu.latitude === "number" ? lieu.latitude : undefined,
    longitude: typeof lieu.longitude === "number" ? lieu.longitude : undefined,
    contractType: isAlternance ? "alternance" : FT_CONTRACT[o.typeContrat] || "non-precise",
    remote: "non-precise",
    salary: o.salaire?.libelle || undefined,
    description,
    skillsRequired: deriveSkills(listed, fixEncoding(o.intitule), description),
    source: "France Travail",
    origin: "france-travail",
    applyUrl: String(o.origineOffre?.urlOrigine || o.contact?.urlPostulation || `https://candidat.francetravail.fr/offres/recherche/detail/${o.id}`),
    // Adresse de candidature publiée par le recruteur dans l'offre France Travail
    ...(typeof o.contact?.courriel === "string" && o.contact.courriel.includes("@") ? { contactEmail: o.contact.courriel.trim().toLowerCase() } : {}),
    publishedAt: isoOrUndefined(o.dateCreation) || "",
    status: "active",
    domain: o.secteurActiviteLibelle || undefined,
    companySector: o.secteurActiviteLibelle || undefined,
    companySize: o.trancheEffectifEtab || undefined,
    companyWebsite: o.entreprise?.url || undefined,
    companyLogo: o.entreprise?.logo || undefined
  };
}

const PARIS_LYON_MARSEILLE = new Set(["75056", "69123", "13055"]);

const FT_PAGE_SIZE = 150;

async function searchFranceTravail(params: SearchParams, geo: GeoPoint | null): Promise<{ jobs: JobOffer[]; warning?: string; full?: boolean }> {
  const contract = (params.contractType || "tous").toLowerCase();
  if (contract === "stage") {
    return { jobs: [], warning: "France Travail ne publie pas d'offres de stage : seules les autres sources sont interrogées." };
  }
  const page = Math.max(1, params.page || 1);
  const start = (page - 1) * FT_PAGE_SIZE;
  if (start > 3000) return { jobs: [] }; // limite de l'API (3 150 résultats)

  const base = new URLSearchParams({ range: `${start}-${start + FT_PAGE_SIZE - 1}`, sort: "1" });
  if (geo?.inseeCode && !PARIS_LYON_MARSEILLE.has(geo.inseeCode)) {
    base.set("commune", geo.inseeCode);
    base.set("distance", String(Math.min(Math.max(params.radius || 30, 0), 200)));
  } else if (geo?.departement) {
    base.set("departement", geo.departement);
  }
  if (contract === "cdi") base.set("typeContrat", "CDI");
  else if (contract === "cdd") base.set("typeContrat", "CDD,MIS,SAI");
  else if (contract === "freelance") base.set("typeContrat", "LIB,FRA");
  else if (contract === "alternance") base.set("natureContrat", "E2,FS");

  const run = async (qs: URLSearchParams) => {
    const url = `${FT_SEARCH_URL}?${qs.toString()}`;
    return cached(`ft:${url}`, async () => {
      void countApiCall("franceTravail");
      const token = await getFtToken();
      let res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (res.status === 401) {
        ftToken = null;
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${await getFtToken()}`, Accept: "application/json" } });
      }
      if (res.status === 204) return { resultats: [] };
      if (res.status === 429) throw new Error("quota France Travail atteint");
      if (!res.ok && res.status !== 206) throw new Error(`erreur ${res.status}`);
      return res.json();
    });
  };

  const words = queryWords(params.query || "").filter((w) => /^[a-z0-9+#.-]+$/.test(w)).slice(0, 5);
  const byWords = new URLSearchParams(base);
  if (words.length) byWords.set("motsCles", words.join(","));
  let data = await run(byWords);
  let list = Array.isArray(data?.resultats) ? data.resultats : [];

  // Les mots-clés France Travail doivent TOUS apparaître : sans résultat, on retente par métier (codes ROME)
  if (!list.length && words.length && page === 1) {
    const romes = await resolveRomes(params.query || "");
    if (romes.length) {
      const byRome = new URLSearchParams(base);
      byRome.set("codeROME", romes.slice(0, 15).join(","));
      data = await run(byRome);
      list = Array.isArray(data?.resultats) ? data.resultats : [];
    }
  }
  return { jobs: list.map(normalizeFtJob).filter(Boolean) as JobOffer[], full: list.length >= FT_PAGE_SIZE };
}

// ---------------------------------------------------------------------------
// Utilitaires communs aux agrégateurs
// ---------------------------------------------------------------------------
export function stripHtml(v: any): string {
  return fixEncoding(v || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Déduit le type de contrat du titre / texte quand la source ne le donne pas clairement. */
export function inferContract(text: string, fallback: ContractType = "non-precise", title = ""): ContractType {
  // Le contrat annoncé dans l'intitulé prime sur le texte (« … (CDI) » publié par Free-Work, etc.)
  if (title) {
    const fromTitle = inferContract(title, "__none__" as ContractType);
    if (fromTitle !== ("__none__" as ContractType)) return fromTitle;
  }
  const t = norm(text);
  if (/\b(alternance|alternant|apprenti|apprentissage|contrat pro|professionnalisation)/.test(t)) return "alternance";
  if (/\b(stage|stagiaire|internship|intern)\b/.test(t)) return "stage";
  if (/\b(freelance|independant|portage|mission de \d)/.test(t)) return "freelance";
  if (/\bcdd\b|\binterim\b|\btemporaire\b/.test(t)) return "cdd";
  if (/\bcdi\b/.test(t)) return "cdi";
  return fallback;
}

/** Télétravail : n'affirme rien si le texte ne le dit pas. */
export function inferRemote(text: string): JobOffer["remote"] {
  const t = norm(text);
  if (/(100 ?% (en )?teletravail|full remote|entierement a distance|fully remote)/.test(t)) return "total";
  if (/(teletravail|hybride|remote)/.test(t)) return "hybride";
  return "non-precise";
}

function formatSalary(min?: number, max?: number, period = "an"): string | undefined {
  const f = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;
  if (min && max && Math.round(min) !== Math.round(max)) return `${f(min)} – ${f(max)} / ${period}`;
  if (min || max) return `${f((min || max) as number)} / ${period}`;
  return undefined;
}

function contractKeyword(contract: string): string {
  return contract === "alternance" ? "alternance" : contract === "stage" ? "stage" : contract === "cdd" ? "CDD" : contract === "cdi" ? "CDI" : contract === "freelance" ? "freelance" : "";
}

/**
 * Pertinence minimale pour les agrégateurs qui renvoient parfois des offres hors sujet :
 * au moins la moitié des mots significatifs de la recherche (racine de 5 lettres) dans l'intitulé ou l'extrait.
 */
export function isRelevant(job: JobOffer, query: string): boolean {
  const words = queryWords(query).filter((w) => w.length > 2);
  if (!words.length) return true;
  const hay = norm(`${job.title} ${job.description}`);
  const hits = words.filter((w) => hay.includes(w.length > 6 ? w.slice(0, 5) : w)).length;
  return hits >= Math.ceil(words.length / 2);
}

/** Attend au plus `ms` : au-delà, la requête continue en arrière-plan (et remplit le cache pour la prochaine recherche). */
export async function softTimeout<T>(p: Promise<T>, ms: number, onLate: () => void): Promise<T | null> {
  let timer: any;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => { onLate(); resolve(null); }, ms); });
  p.catch(() => undefined);
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// JSearch (Google for Jobs : LinkedIn, Indeed, Welcome to the Jungle, Glassdoor…)
// https://www.openwebninja.com/api/jsearch — clé JSEARCH_API_KEY (RapidAPI par défaut)
// ---------------------------------------------------------------------------
// « Temps plein / partiel » ne dit rien du contrat (CDI ou CDD) : non précisé plutôt que supposé
const JSEARCH_TYPES: Record<string, ContractType> = { CONTRACTOR: "freelance", TEMPORARY: "cdd", INTERN: "stage" };

export function normalizeJSearchJob(j: any): JobOffer | null {
  if (!j?.job_title) return null;
  const description = stripHtml(j.job_description);
  const title = String(j.job_title);
  const typeFallback = JSEARCH_TYPES[String(j.job_employment_type || "").toUpperCase()] || "non-precise";
  const location = [j.job_city, j.job_state].filter(Boolean).join(", ") || String(j.job_location || j.job_country || "");
  const options = (Array.isArray(j.apply_options) ? j.apply_options : [])
    .filter((o: any) => o?.apply_link && o?.publisher)
    .map((o: any) => ({ publisher: String(o.publisher), url: String(o.apply_link) }));
  const publisher = String(j.job_publisher || "Google Jobs");
  return {
    id: `js-${j.job_id}`,
    title,
    company: String(j.employer_name || "Entreprise non communiquée"),
    companyLogo: j.employer_logo || undefined,
    companyWebsite: j.employer_website || undefined,
    location,
    latitude: typeof j.job_latitude === "number" ? j.job_latitude : undefined,
    longitude: typeof j.job_longitude === "number" ? j.job_longitude : undefined,
    contractType: inferContract(description.slice(0, 600), typeFallback, title),
    remote: j.job_is_remote ? "total" : inferRemote(`${title} ${description}`),
    salary: formatSalary(j.job_min_salary, j.job_max_salary, j.job_salary_period === "MONTH" ? "mois" : j.job_salary_period === "HOUR" ? "heure" : "an"),
    description,
    skillsRequired: deriveSkills([], title, description),
    source: publisher,
    origin: "jsearch",
    applyUrl: String(j.job_apply_link || options[0]?.url || ""),
    applyOptions: options.length ? options : undefined,
    publishedAt: isoOrUndefined(j.job_posted_at_datetime_utc) || "",
    status: "active"
  };
}

async function searchJSearch(params: SearchParams, geo: GeoPoint | null): Promise<JobOffer[]> {
  const words = [params.query || "", contractKeyword((params.contractType || "").toLowerCase())].join(" ").trim() || "emploi";
  const where = geo?.label && !geo.label.startsWith("Département") ? ` à ${geo.label}` : geo?.departement ? ` ${geo.departement}` : "";
  const qs = new URLSearchParams({ query: `${words}${where}`, page: String(Math.max(1, params.page || 1)), num_pages: "1", country: "fr", language: "fr", date_posted: "month" });
  if (geo?.latitude != null) qs.set("radius", String(Math.round((params.radius || 30) / 1.609)));
  if (/^(remote|t[ée]l[ée]travail)$/i.test((params.location || "").trim())) qs.set("work_from_home", "true");
  const url = `${JSEARCH_URL}?${qs.toString()}`;
  // Quota gratuit faible (≈ 200 requêtes / mois) : cache de 6 h
  const data = await cached(`js:${url}`, async () => {
    void countApiCall("jsearch");
    const headers: Record<string, string> = JSEARCH_URL.includes("rapidapi")
      ? { "X-RapidAPI-Key": String(process.env.JSEARCH_API_KEY), "X-RapidAPI-Host": JSEARCH_HOST }
      : { "x-api-key": String(process.env.JSEARCH_API_KEY) };
    // Google Jobs peut mettre plus de 10 s à répondre
    const res = await fetchImpl(url, { headers: { ...headers, Accept: "application/json" }, timeoutMs: 25_000 });
    if (res.status === 401 || res.status === 403) throw new Error("clé JSEARCH_API_KEY refusée");
    if (res.status === 429) throw new Error("quota mensuel atteint");
    if (!res.ok) throw new Error(`erreur ${res.status}`);
    return res.json();
  }, 6 * 3600_000);
  const rawList = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.data?.jobs)
    ? data.data.jobs
    : Array.isArray(data?.jobs)
    ? data.jobs
    : [];
  return rawList.map(normalizeJSearchJob).filter(Boolean) as JobOffer[];
}

// ---------------------------------------------------------------------------
// Adzuna — https://developer.adzuna.com — ADZUNA_APP_ID / ADZUNA_APP_KEY
// ---------------------------------------------------------------------------
export function normalizeAdzunaJob(a: any): JobOffer | null {
  if (!a?.title) return null;
  const title = stripHtml(a.title);
  const description = stripHtml(a.description);
  const fallback: ContractType = a.contract_type === "contract" ? "cdd" : a.contract_type === "permanent" ? "cdi" : "non-precise";
  return {
    id: `adz-${a.id}`,
    title,
    company: String(a.company?.display_name || "Entreprise non communiquée"),
    location: String(a.location?.display_name || ""),
    latitude: typeof a.latitude === "number" ? a.latitude : undefined,
    longitude: typeof a.longitude === "number" ? a.longitude : undefined,
    contractType: inferContract(description, fallback, title),
    remote: inferRemote(`${title} ${description}`),
    salary: a.salary_is_predicted === "1" || a.salary_is_predicted === 1 ? undefined : formatSalary(a.salary_min, a.salary_max),
    description,
    descriptionIsSnippet: true,
    skillsRequired: deriveSkills([], title, description),
    source: "Adzuna",
    origin: "adzuna",
    applyUrl: String(a.redirect_url || ""),
    publishedAt: isoOrUndefined(a.created) || "",
    status: "active",
    domain: a.category?.label || undefined
  };
}

async function searchAdzuna(params: SearchParams, geo: GeoPoint | null): Promise<JobOffer[]> {
  const contract = (params.contractType || "tous").toLowerCase();
  const page = Math.max(1, params.page || 1);
  const base = new URLSearchParams({
    app_id: String(process.env.ADZUNA_APP_ID),
    app_key: String(process.env.ADZUNA_APP_KEY),
    results_per_page: "50",
    max_days_old: "45",
    sort_by: "date",
    "content-type": "application/json"
  });
  if (geo?.label && !geo.label.startsWith("Département")) {
    base.set("where", geo.label);
    base.set("distance", String(Math.min(Math.max(params.radius || 30, 5), 200)));
  }
  if (contract === "cdi") base.set("permanent", "1");
  if (contract === "cdd") base.set("contract", "1");

  // Adzuna exige que TOUS les mots soient présents : on retire les mots vides (« de », « en »…)
  const queryPart = queryWords(params.query || "").join(" ");
  const kw = contract === "alternance" || contract === "stage" ? contractKeyword(contract) : "";

  const run = async (what: string) => {
    const qs = new URLSearchParams(base);
    if (what) qs.set("what", what);
    const url = `${ADZUNA_URL.replace(/\/search\/1$/, `/search/${page}`)}?${qs.toString()}`;
    const data = await cached(`adz:${url}`, async () => {
      void countApiCall("adzuna");
      const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (res.status === 401 || res.status === 403) throw new Error("identifiants Adzuna refusés");
      if (res.status === 429) throw new Error("quota atteint");
      if (!res.ok) throw new Error(`erreur ${res.status}`);
      return res.json();
    });
    return (Array.isArray(data?.results) ? data.results : []).map(normalizeAdzunaJob).filter(Boolean) as JobOffer[];
  };

  let jobs = await run([queryPart, kw].join(" ").trim());
  // Rien avec « alternance » / « stage » en plus : on relance sans (le filtre de contrat s'applique ensuite)
  if (!jobs.length && kw && queryPart) jobs = await run(queryPart);
  return jobs;
}

// ---------------------------------------------------------------------------
// Jooble — https://jooble.org/api/about — JOOBLE_API_KEY (quota limité : 500 requêtes par clé)
// ---------------------------------------------------------------------------
const JOOBLE_RADII = [0, 4, 8, 16, 26, 40, 80];

export function normalizeJoobleJob(j: any): JobOffer | null {
  if (!j?.title) return null;
  const title = stripHtml(j.title);
  const description = stripHtml(j.snippet);
  const typeText = String(j.type || "");
  const site = String(j.source || "").replace(/^https?:\/\/(www\.)?/, "");
  return {
    id: `jbl-${j.id}`,
    title,
    company: String(j.company || "Entreprise non communiquée"),
    location: String(j.location || ""),
    contractType: inferContract(`${typeText} ${description}`, "non-precise", title),
    remote: inferRemote(`${title} ${description}`),
    salary: j.salary ? String(j.salary) : undefined,
    description,
    descriptionIsSnippet: true,
    skillsRequired: deriveSkills([], title, description),
    source: site ? `${site} (via Jooble)` : "Jooble",
    origin: "jooble",
    applyUrl: String(j.link || ""),
    publishedAt: isoOrUndefined(j.updated) || "",
    status: "active"
  };
}

/** Lieux renvoyés par Jooble hors de France (ex. « Paris, TX ») avec une clé internationale. */
const FOREIGN_LOCATION = /,\s*[A-Z]{2}$|\b(United States|USA|United Kingdom|Canada|Deutschland|España)\b/;

async function searchJooble(params: SearchParams, geo: GeoPoint | null): Promise<JobOffer[]> {
  const contract = (params.contractType || "tous").toLowerCase();
  const keywords = [params.query || "", contractKeyword(contract)].join(" ").trim();
  const radius = JOOBLE_RADII.reduce((best, r) => (Math.abs(r - (params.radius || 30)) < Math.abs(best - (params.radius || 30)) ? r : best), 26);
  const city = geo?.label && !geo.label.startsWith("Département") ? geo.label : "";
  const body = {
    keywords,
    // « , France » évite Paris (Texas) ou Lyon (Kansas) avec une clé jooble.org internationale
    location: city ? `${city}, France` : "France",
    radius: String(radius),
    page: String(Math.max(1, params.page || 1)),
    ResultOnPage: "50"
  };
  const url = `${JOOBLE_HOST}/api/${process.env.JOOBLE_API_KEY}`;
  // Quota à vie limité : cache de 12 h par recherche
  const data = await cached(`jbl:${JOOBLE_HOST}:${JSON.stringify(body)}`, async () => {
    void countApiCall("jooble");
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), timeoutMs: 15_000 });
    if (res.status === 401 || res.status === 403) throw new Error("clé JOOBLE_API_KEY refusée ou quota épuisé");
    if (!res.ok) throw new Error(`erreur ${res.status}`);
    return res.json();
  }, 12 * 3600_000);
  return (Array.isArray(data?.jobs) ? data.jobs : [])
    .filter((j: any) => !FOREIGN_LOCATION.test(String(j?.location || "")))
    .map(normalizeJoobleJob)
    .filter(Boolean) as JobOffer[];
}

// ---------------------------------------------------------------------------
// Recherche combinée
// ---------------------------------------------------------------------------

/** Ordre de préférence quand la même offre vient de plusieurs sources (fiche la plus complète d'abord). */
const SOURCE_PRIORITY: SourceKey[] = ["franceTravail", "laBonneAlternance", "jsearch", "adzuna", "jooble"];

function locationTokens(loc: string): Set<string> {
  return new Set(norm(loc).replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 2 && !["rue", "avenue", "boulevard", "france", "cedex"].includes(w)));
}

function sameOffer(a: JobOffer, b: JobOffer): boolean {
  // Deux fiches d'une même source sont deux offres distinctes (ex. 8 postes « Assistant comptable » France Travail)
  if (a.origin && a.origin === b.origin) return false;
  if (a.isSpontaneous || b.isSpontaneous) return false;
  if (norm(a.title).replace(/\s*\(?[hf] ?\/ ?[hf]\)?\s*/g, "") !== norm(b.title).replace(/\s*\(?[hf] ?\/ ?[hf]\)?\s*/g, "")) return false;
  // Contrats connus et différents (CDI / stage) : deux offres distinctes
  if (a.contractType !== b.contractType && a.contractType !== "non-precise" && b.contractType !== "non-precise") return false;
  const ca = norm(a.company), cb = norm(b.company);
  // Employeur inconnu d'un côté : impossible d'affirmer que c'est la même offre
  if (!ca || !cb || ca.startsWith("entreprise non") || cb.startsWith("entreprise non")) return false;
  // Même employeur : identique, ou l'un contient l'autre (« Mistral » / « Mistral Numérique ») s'il est assez long
  const sameCompany = ca === cb || (Math.min(ca.length, cb.length) >= 5 && (ca.includes(cb) || cb.includes(ca)));
  if (!sameCompany) return false;
  const ta = locationTokens(a.location), tb = locationTokens(b.location);
  if (!ta.size || !tb.size) return ca === cb;
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

/** Fusionne les doublons : garde la fiche prioritaire, complète avec les autres (description, salaire, liens). */
export function mergeDuplicates(jobs: JobOffer[]): JobOffer[] {
  const out: JobOffer[] = [];
  for (const job of jobs) {
    const existing = out.find((o) => sameOffer(o, job));
    if (!existing) {
      out.push({ ...job });
      continue;
    }
    if ((!existing.description || existing.descriptionIsSnippet) && job.description && !job.descriptionIsSnippet) {
      existing.description = job.description;
      existing.descriptionIsSnippet = false;
    }
    existing.salary ||= job.salary;
    existing.contactEmail ||= job.contactEmail;
    existing.lbaRecipientId ||= job.lbaRecipientId;
    existing.companyLogo ||= job.companyLogo;
    existing.companyWebsite ||= job.companyWebsite;
    existing.companySize ||= job.companySize;
    existing.companySector ||= job.companySector;
    if (existing.remote === "non-precise" && job.remote !== "non-precise") existing.remote = job.remote;
    if (existing.contractType === "non-precise" && job.contractType !== "non-precise") existing.contractType = job.contractType;
    existing.publishedAt ||= job.publishedAt;
    existing.skillsRequired = Array.from(new Set([...existing.skillsRequired, ...job.skillsRequired])).slice(0, 15);
    const also = existing.alsoOn || [];
    if (job.applyUrl && !also.some((x) => x.url === job.applyUrl) && job.applyUrl !== existing.applyUrl) also.push({ source: job.source, url: job.applyUrl });
    for (const o of job.applyOptions || []) if (!also.some((x) => x.url === o.url)) also.push({ source: o.publisher, url: o.url });
    existing.alsoOn = also.slice(0, 8);
  }
  return out;
}

export async function searchRealJobs(params: SearchParams): Promise<RealSearchResult> {
  const status = getSourceStatus();
  const warnings: string[] = [];
  const contract = (params.contractType || "tous").toLowerCase();
  const hasQuery = !!(params.query || "").trim();
  const page = Math.max(1, Math.min(Number(params.page) || 1, 20));
  params = { ...params, page };

  let geo: GeoPoint | null = null;
  try {
    geo = await geocode(params.location);
    if (params.location && !geo && !/^(remote|t[ée]l[ée]travail|france|tous)/i.test(params.location.trim())) {
      warnings.push(`Lieu « ${params.location} » introuvable : recherche sur toute la France.`);
    }
  } catch (e: any) {
    warnings.push(`${e?.message || "Géocodage indisponible"} : recherche sur toute la France.`);
  }

  const sources = Object.fromEntries(
    (Object.keys(status) as SourceKey[]).map((k) => [k, { enabled: status[k], count: 0 } as SourceReport])
  ) as Record<SourceKey, SourceReport>;

  // Sources à quota réduit : interrogées seulement pour une recherche avec mots-clés
  const plan: { key: SourceKey; run: () => Promise<JobOffer[]> }[] = [];
  const skip = (k: SourceKey, why: string) => { if (status[k]) sources[k].skipped = why; };
  let ftFull = false;

  if (status.franceTravail) {
    if (contract === "stage") skip("franceTravail", "pas d'offres de stage");
    else plan.push({ key: "franceTravail", run: async () => {
      const r = await searchFranceTravail(params, geo);
      if (r.warning) warnings.push(r.warning);
      ftFull = !!r.full;
      return r.jobs;
    } });
  }
  if (status.laBonneAlternance) {
    if (page > 1) skip("laBonneAlternance", "tous les résultats sont sur la première page");
    else if (contract === "tous" || contract === "alternance") plan.push({ key: "laBonneAlternance", run: () => searchLba(params, geo) });
    else skip("laBonneAlternance", "alternance uniquement");
  }
  if (status.adzuna) plan.push({ key: "adzuna", run: () => searchAdzuna(params, geo) });
  if (status.jsearch) {
    if (hasQuery) plan.push({ key: "jsearch", run: async () => {
      const r = await softTimeout(searchJSearch(params, geo), JSEARCH_WAIT_MS, () =>
        warnings.push("Google Jobs (LinkedIn, Indeed, WTTJ…) répond lentement : relancez la recherche dans quelques secondes pour ajouter ses offres.")
      );
      return r || [];
    } });
    else skip("jsearch", "saisissez un mot-clé (quota limité)");
  }
  if (status.jooble) {
    if (hasQuery) plan.push({ key: "jooble", run: () => searchJooble(params, geo) });
    else skip("jooble", "saisissez un mot-clé (quota limité)");
  }

  const settled = await Promise.allSettled(plan.map((p) => p.run()));
  const byKey = new Map<SourceKey, JobOffer[]>();
  settled.forEach((r, i) => {
    const key = plan[i].key;
    if (r.status === "fulfilled") {
      sources[key].count = r.value.length;
      byKey.set(key, r.value);
    } else {
      sources[key].error = String(r.reason?.message || r.reason);
      warnings.push(`${SOURCE_LABELS[key]} indisponible : ${sources[key].error}.`);
    }
  });

  const rawCount = (k: SourceKey) => byKey.get(k)?.length || 0;
  const hasMore = ftFull || rawCount("adzuna") >= 45 || rawCount("jsearch") >= 10 || rawCount("jooble") >= 40;

  // Agrégateurs : on écarte les offres sans rapport avec la recherche
  if (hasQuery) {
    for (const k of ["adzuna", "jooble"] as SourceKey[]) {
      const list = byKey.get(k);
      if (!list) continue;
      const kept = list.filter((j) => isRelevant(j, params.query || ""));
      if (k === "jooble" && list.length >= 5 && kept.length === 0) {
        warnings.push("Jooble : résultats hors sujet écartés (votre clé est internationale). Pour des offres françaises, demandez une clé pour fr.jooble.org.");
      }
      byKey.set(k, kept);
      sources[k].count = kept.length;
    }
  }

  let jobs = SOURCE_PRIORITY.flatMap((k) => byKey.get(k) || []);

  // Filtre télétravail demandé via le champ lieu
  if (/^(remote|t[ée]l[ée]travail|full remote)$/i.test((params.location || "").trim())) {
    jobs = jobs.filter((j) => j.remote === "total" || j.remote === "hybride");
  }
  // Contrat : les agrégateurs ne filtrent pas tous ; on applique le filtre demandé
  if (contract !== "tous") jobs = jobs.filter((j) => j.contractType === contract);

  jobs = mergeDuplicates(jobs);
  // Offres publiées d'abord (les plus récentes en tête), puis les candidatures spontanées
  const time = (j: JobOffer) => (j.publishedAt ? new Date(j.publishedAt).getTime() || 0 : 0);
  jobs.sort((a, b) => Number(!!a.isSpontaneous) - Number(!!b.isSpontaneous) || time(b) - time(a));

  if (contract === "stage" && !status.adzuna && !status.jsearch && !status.jooble) {
    warnings.push("Stages : ajoutez une clé Adzuna, JSearch ou Jooble pour en trouver (France Travail et La bonne alternance n'en publient pas).");
  }

  return { jobs, sources, warnings, resolvedLocation: geo?.label, hasMore, page };
}

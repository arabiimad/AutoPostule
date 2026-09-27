/**
 * Offres publiées par les entreprises sur leur propre site au format standard schema.org « JobPosting »
 * (bloc JSON-LD que Google for Jobs demande aux recruteurs) : lecture et conversion en offre Kareer.
 * Données structurées publiées par l'employeur pour être reprises par les moteurs de recherche.
 */
import { createHash } from "node:crypto";
import type { ContractType, JobOffer } from "../../src/types.ts";
import { deriveSkills, inferContract, inferRemote, stripHtml } from "../jobSources.ts";

export const SITES_SOURCE = "Sites carrière";

const SCRIPT_RE = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

const isType = (node: any, type: string) => {
  const t = node?.["@type"];
  return Array.isArray(t) ? t.some((x) => String(x).toLowerCase() === type) : String(t || "").toLowerCase() === type;
};

/** Tous les objets JobPosting des blocs JSON-LD d'une page (tableaux, @graph, ItemList imbriqués). */
export function extractJobPostings(html: string): any[] {
  const out: any[] = [];
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
    if (isType(node, "jobposting")) { out.push(node); return; }
    for (const key of ["@graph", "itemListElement", "item", "mainEntity"]) if (node[key]) visit(node[key], depth + 1);
  };
  for (const m of html.matchAll(SCRIPT_RE)) {
    const raw = m[1].trim().replace(/^<!--|-->$/g, "").replace(/^\s*\/\/<!\[CDATA\[|\/\/\]\]>\s*$/g, "");
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      // Certains sites échappent mal les retours à la ligne dans les chaînes
      try { visit(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " ")), 0); } catch { /* bloc illisible */ }
    }
  }
  return out;
}

const text = (v: any): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (Array.isArray(v)) return text(v[0]);
  return text(v.name ?? v["@value"] ?? v.value ?? "");
};

const EMPLOYMENT: Record<string, ContractType> = {
  FULL_TIME: "cdi", PERMANENT: "cdi", CDI: "cdi",
  TEMPORARY: "cdd", CONTRACT: "cdd", CDD: "cdd", SEASONAL: "cdd", INTERIM: "cdd",
  INTERN: "stage", INTERNSHIP: "stage", STAGE: "stage",
  APPRENTICESHIP: "alternance", ALTERNANCE: "alternance",
  CONTRACTOR: "freelance", FREELANCE: "freelance"
};

function contractOf(jp: any, title: string, description: string): ContractType {
  const types = (Array.isArray(jp.employmentType) ? jp.employmentType : [jp.employmentType]).map((t: any) => String(t || "").toUpperCase().replace(/[\s-]+/g, "_"));
  // Le titre et le texte priment : « FULL_TIME » est souvent mis par défaut, même pour un CDD ou une alternance
  const fromText = inferContract(`${title} ${description.slice(0, 1500)}`, "non-precise", title);
  if (fromText !== "non-precise") return fromText;
  for (const t of types) if (EMPLOYMENT[t] && t !== "FULL_TIME" && t !== "PART_TIME") return EMPLOYMENT[t];
  return types.includes("FULL_TIME") ? "cdi" : "non-precise";
}

const FR_COUNTRY = /^(fr|fra|france)$/i;
const DOM = /^97[1-6]/;

function places(jp: any): { city: string; postalCode: string; country: string; lat?: number; lng?: number }[] {
  const list = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
  return list.map((l: any) => {
    const a = l?.address || l || {};
    const num = (v: any) => (v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
    const locality = text(a.addressLocality);
    // Code postal parfois écrit dans le nom de la ville (« Ingré (45140) ») ou dans l'adresse
    const postal = text(a.postalCode).replace(/\s+/g, "") || (/\b(\d{5})\b/.exec(`${locality} ${text(a.streetAddress)} ${text(a.addressRegion)}`)?.[1] ?? "");
    return {
      city: locality.replace(/\s*\(?\b\d{5}\b\)?\s*/, " ").trim(),
      postalCode: postal,
      country: text(a.addressCountry),
      lat: num(l?.geo?.latitude ?? l?.latitude),
      lng: num(l?.geo?.longitude ?? l?.longitude)
    };
  });
}

export function departementOf(postalCode: string): string | undefined {
  if (!/^\d{5}$/.test(postalCode)) return undefined;
  if (DOM.test(postalCode)) return postalCode.slice(0, 3);
  if (postalCode.startsWith("20")) return Number(postalCode) < 20200 ? "2A" : "2B";
  return postalCode.slice(0, 2);
}

function salaryOf(jp: any): string | undefined {
  const s = jp.baseSalary || jp.estimatedSalary;
  if (!s) return undefined;
  if (typeof s === "string" || typeof s === "number") return String(s);
  const v = s.value || {};
  const unit = String(v.unitText || s.unitText || "").toUpperCase();
  const per = unit === "YEAR" ? " par an" : unit === "MONTH" ? " par mois" : unit === "HOUR" ? " de l'heure" : "";
  const fmt = (n: any) => (n == null || n === "" ? "" : `${Number(n).toLocaleString("fr-FR")} €`);
  const min = fmt(v.minValue), max = fmt(v.maxValue), one = fmt(typeof v === "object" ? v.value : v);
  const range = min && max ? `${min} – ${max}` : min || max || one;
  return range ? `${range}${per}` : undefined;
}

const iso = (v: any) => {
  const d = v ? new Date(text(v)) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
};

export interface JobPostingContext {
  /** Page où l'offre a été lue. */
  pageUrl: string;
  /** Domaine du site (identifiant de la zone de collecte). */
  site: string;
  /** Nom du site (balise og:site_name) : nom de l'enseigne quand l'offre ne donne que le magasin. */
  siteName?: string;
  now?: Date;
}

const squash = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Nom du site d'une page (og:site_name, application-name). */
export function siteNameOf(html: string): string | undefined {
  const m = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:site_name|application-name)["'][^>]*content\s*=\s*["']([^"']{2,80})["']/i.exec(html)
    || /<meta[^>]+content\s*=\s*["']([^"']{2,80})["'][^>]*(?:property|name)\s*=\s*["'](?:og:site_name|application-name)["']/i.exec(html);
  return m ? stripHtml(m[1]).trim() : undefined;
}

/**
 * Offre Kareer à partir d'un JobPosting ; null si l'offre est expirée, hors de France ou incomplète.
 * Les offres sans lieu (télétravail) sont gardées si la page est sur un site français.
 */
export function normalizeJobPosting(jp: any, ctx: JobPostingContext): JobOffer | null {
  const title = stripHtml(text(jp.title) || text(jp.name)).slice(0, 200);
  if (!title) return null;
  const now = ctx.now || new Date();
  const expiresAt = iso(jp.validThrough);
  if (expiresAt && new Date(expiresAt) < now) return null;
  const publishedAt = iso(jp.datePosted);
  // Offres de plus d'un an sans date de fin : sans doute plus d'actualité
  if (!expiresAt && publishedAt && now.getTime() - new Date(publishedAt).getTime() > 365 * 86_400_000) return null;

  const locs = places(jp);
  const remoteOnly = String(jp.jobLocationType || "").toUpperCase() === "TELECOMMUTE";
  const french = locs.filter((l) => FR_COUNTRY.test(l.country) || (!l.country && (departementOf(l.postalCode) || (!l.postalCode && /\.fr$/.test(ctx.site)))));
  if (locs.length && !french.length) return null;
  if (!locs.length && !(remoteOnly || /\.fr$/.test(ctx.site))) return null;
  const place = french[0];

  const description = stripHtml(text(jp.description)).slice(0, 20000);
  const org = jp.hiringOrganization || {};
  const orgName = stripHtml(text(org));
  const brand = ctx.siteName && squash(ctx.siteName).length >= 3 ? ctx.siteName : "";
  // « Orléans - Ingré » (nom du magasin) sur recrute.leroymerlin.fr → « Leroy Merlin – Orléans - Ingré »
  const company = !orgName ? brand || ctx.site.replace(/^www\./, "")
    : brand && !squash(orgName).includes(squash(brand).slice(0, 6)) && !squash(brand).includes(squash(orgName)) ? `${brand} – ${orgName}`
    : orgName;
  const url = text(jp.url) || ctx.pageUrl;
  const ident = text(jp.identifier?.value ?? jp.identifier) || url;
  const email = text(jp.applicationContact?.email).replace(/^mailto:/i, "").toLowerCase();
  const departement = place ? departementOf(place.postalCode) : undefined;
  const location = place ? [place.city, place.postalCode && departement ? `(${departement})` : ""].filter(Boolean).join(" ") : "Télétravail";

  return {
    id: `site-${ctx.site}:${createHash("sha1").update(ident).digest("hex").slice(0, 16)}`,
    title,
    company: company.slice(0, 160),
    location,
    ...(place?.lat != null && place?.lng != null ? { latitude: place.lat, longitude: place.lng } : {}),
    ...(departement ? { departement } : {}),
    contractType: contractOf(jp, title, description),
    remote: remoteOnly ? "total" : inferRemote(description),
    salary: salaryOf(jp),
    description,
    skillsRequired: deriveSkills([], title, description),
    source: SITES_SOURCE,
    origin: "web",
    applyUrl: url,
    ...(email.includes("@") ? { contactEmail: email } : {}),
    publishedAt: publishedAt || "",
    ...(expiresAt ? { expiresAt } : {}),
    status: "active",
    companyWebsite: text(org.sameAs) || text(org.url) || `https://${ctx.site}`,
    ...(text(org.logo) ? { companyLogo: text(org.logo?.url ?? org.logo) } : {}),
    ...(text(jp.industry) ? { companySector: text(jp.industry) } : {})
  };
}

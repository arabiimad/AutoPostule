/**
 * Collecte des offres publiées sur les sites des entreprises (pages carrière), au format schema.org JobPosting.
 *
 * Robot poli et identifié :
 *  - respecte robots.txt (règles propres à KareerBot, sinon « * » ; délai demandé par le site, 10 s au plus) ;
 *  - une requête à la fois par site, 1,5 s d'écart au minimum, pages de 3 Mo au plus ;
 *  - ne lit que les pages d'offres (plan du site ou liens de la page carrière), 150 par site au plus ;
 *  - ne se connecte jamais, ne contourne aucune protection (captcha, pare-feu : le site est ignoré).
 *
 * Sites à visiter : sites des employeurs rencontrés dans les offres collectées (site de l'entreprise,
 * page de candidature hébergée par l'entreprise) et CAREER_SITES (liste manuelle).
 */
import { gunzipSync } from "node:zlib";
import type { JobOffer } from "../../src/types.ts";
import { detectBoard } from "../discovery/atsBoards.ts";
import { HOST_FAMILIES, hostOf } from "./applyHosts.ts";
import { extractJobPostings, normalizeJobPosting, siteNameOf, SITES_SOURCE } from "./jobPosting.ts";
import { toOfferRow, type OfferStore } from "./offerStore.ts";

export const BOT_NAME = "KareerBot";
/** Identité du robot ; l'adresse du service (PUBLIC_URL) permet aux sites de savoir qui les visite. */
export const USER_AGENT = `Mozilla/5.0 (compatible; ${BOT_NAME}/1.0${process.env.PUBLIC_URL ? `; +${process.env.PUBLIC_URL}` : ""})`;
const MAX_BYTES = 3_000_000;

export interface FetchedPage { status: number; url: string; contentType: string; body: string }
export type PageFetcher = (url: string) => Promise<FetchedPage>;

export const defaultFetcher: PageFetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5", "Accept-Language": "fr-FR,fr;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000)
  });
  const contentType = res.headers.get("content-type") || "";
  const gz = /\.gz(\?|$)/i.test(url) || /gzip/i.test(contentType);
  if (!res.body || (!gz && !/html|xml|text\/plain/i.test(contentType))) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, url: res.url || url, contentType, body: "" };
  }
  // Lecture plafonnée : une page d'offre fait rarement plus de quelques centaines de Ko
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  let buf = Buffer.concat(chunks);
  // Plans du site compressés (sitemap.xml.gz)
  if (gz && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = gunzipSync(buf, { maxOutputLength: 20 * MAX_BYTES }); } catch { buf = Buffer.alloc(0); }
  }
  return { status: res.status, url: res.url || url, contentType, body: buf.toString("utf8") };
};

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
export interface Robots {
  allowed(path: string): boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
}

const ALLOW_ALL: Robots = { allowed: () => true, crawlDelayMs: null, sitemaps: [] };

/** Règles robots.txt (RFC 9309) : groupe KareerBot sinon « * », règle la plus longue, Allow en cas d'égalité. */
export function parseRobots(txt: string, agent = BOT_NAME): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number | null }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === "sitemap") { if (value) sitemaps.push(value); continue; }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], delay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") current.rules.push({ allow: key === "allow", path: value });
    else if (key === "crawl-delay" && !Number.isNaN(Number(value))) current.delay = Number(value);
  }
  const me = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== "*" && me.includes(a))) || groups.find((g) => g.agents.includes("*"));
  if (!group) return { ...ALLOW_ALL, sitemaps };
  const toRe = (p: string) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  const rules = group.rules.filter((r) => r.path).map((r) => ({ ...r, re: toRe(r.path), len: r.path.length }));
  return {
    sitemaps,
    crawlDelayMs: group.delay != null ? Math.min(group.delay, 10) * 1000 : null,
    allowed(path: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
      }
      return !best || best.allow;
    }
  };
}

// ---------------------------------------------------------------------------
// Pages d'offres d'un site
// ---------------------------------------------------------------------------
/** Adresse qui ressemble à une offre (plan du site, liens de la page carrière). */
export const JOB_URL_RE = /\/(?:(?:offres?|emplois?|jobs?|postes?|careers?|carrieres?|recrutement|recrute|vacanc[a-z]*|annonces?|positions?|openings?|opportunit[a-z]*|nous-rejoindre)(?:\/|$|\.|\?)|(?:offres?|emplois?|jobs?|postes?|annonces?)[-_])/i;
/** Page carrière (point d'entrée sur la page d'accueil). */
const CAREER_LINK_RE = /(carri[eè]re|recrutement|recrute|nous[-_ ]rejoindre|rejoignez|join[-_ ]us|careers?|jobs?|emplois?|offres?[-_ ]d[-_]?emploi|travailler[-_ ]chez)/i;
/** Sous-domaine consacré au recrutement (« recrutement.exemple.fr », « jobs.exemple.com »). */
const CAREER_HOST_RE = /^(jobs?|emplois?|recrutement|recrute|carrieres?|careers?|talents?|join|rejoindre)\./i;
const CAREER_PATHS = ["/carrieres", "/carriere", "/recrutement", "/emplois", "/offres-emploi", "/nous-rejoindre", "/careers", "/jobs"];
/** Promotions et catalogue (« offres du jour », « offres flash ») : pas des offres d'emploi. */
const NOT_JOBS_RE = /(promo|produit|product|catalogue|du-jour|flash|bon-plan|soldes|magasin|store-locator|blog|actualite|news)/i;
/** Plan du site consacré aux offres (« sitemap-jobs.xml », « offres_emploi.xml »). */
const JOB_SITEMAP_RE = /(job|emploi|offre|career|carriere|recrut|vacanc|position)/i;
/** Adresse d'une page d'offre (mots entiers dans le chemin, hors promotions et catalogue). */
export function isJobUrl(url: string, base?: string): boolean {
  try {
    const u = new URL(url, base || "https://x.invalid");
    return JOB_URL_RE.test(u.pathname) && !NOT_JOBS_RE.test(u.pathname);
  } catch {
    return false;
  }
}
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3|css|js|ico|woff2?)(\?|$)/i;

function links(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    try {
      const u = new URL(m[1].trim(), base);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      out.add(`${u.href}\u0000${m[2].replace(/<[^>]+>/g, " ")}`);
    } catch { /* lien invalide */ }
  }
  return [...out];
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
}

/** Domaine de l'entreprise (« recrutement.exemple.fr » → « exemple.fr ») : ses sous-domaines font partie du site. */
const scopeOf = (site: string) => (CAREER_HOST_RE.test(site) ? site.split(".").slice(1).join(".") : site);
const sameSite = (url: string, site: string) => {
  const h = hostOf(url), scope = scopeOf(site);
  return h === scope || h.endsWith(`.${scope}`);
};

export interface SiteCrawlOptions {
  fetcher?: PageFetcher;
  sleep?: (ms: number) => Promise<void>;
  /** Pages d'offres lues au plus par site (150 par défaut). */
  maxPages?: number;
  /** Écart minimal entre deux requêtes au même site (1 500 ms par défaut). */
  delayMs?: number;
  now?: () => Date;
}

export interface SiteCrawlResult {
  site: string;
  offers: JobOffer[];
  pages: number;
  /** Pages carrière hébergées par un logiciel de recrutement (Greenhouse, Lever…), à suivre par ailleurs. */
  boards: string[];
  /** Site injoignable, interdit aux robots ou protégé. */
  blocked?: string;
}

/** Offres JobPosting publiées sur un site (domaine « exemple.fr »). */
export async function crawlSite(site: string, opts: SiteCrawlOptions = {}): Promise<SiteCrawlResult> {
  const fetcher = opts.fetcher || defaultFetcher;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxPages = opts.maxPages ?? 150;
  const result: SiteCrawlResult = { site, offers: [], pages: 0, boards: [] };
  let delay = opts.delayMs ?? 1500;
  let last = 0;
  let refused = 0;
  const get = async (url: string) => {
    const wait = last + delay - Date.now();
    if (last && wait > 0) await sleep(wait);
    last = Date.now();
    result.pages++;
    try {
      const r = await fetcher(url);
      // Refus répétés : protection anti-robots, on n'insiste pas
      refused = r.status === 403 || r.status === 429 ? refused + 1 : 0;
      if (process.env.DEBUG_CRAWL) console.error(`[crawl] ${r.status} ${url}${r.url !== url ? ` → ${r.url}` : ""} (${r.body.length} o)`);
      return r;
    } catch (e: any) {
      if (process.env.DEBUG_CRAWL) console.error(`[crawl] échec ${url} : ${e?.cause?.code || e?.message}`);
      return { status: 0, url, contentType: "", body: "" };
    }
  };

  // robots.txt de chaque hôte visité (un sous-domaine « recrutement. » a ses propres règles)
  const robotsByOrigin = new Map<string, Robots | string>();
  const robotsOf = async (origin: string): Promise<Robots | string> => {
    const known = robotsByOrigin.get(origin);
    if (known) return known;
    const r = await get(`${origin}/robots.txt`);
    // 4xx : pas de règles ; 5xx, injoignable, 401/403 : on s'abstient (RFC 9309)
    const rules: Robots | string =
      r.status === 0 ? "site injoignable"
      : r.status >= 500 ? `robots.txt indisponible (${r.status})`
      : r.status === 401 || r.status === 403 ? "accès refusé aux robots"
      // Page HTML renvoyée à la place du fichier (fréquent) : pas de règles
      : r.status < 300 && !/<html/i.test(r.body.slice(0, 2000)) ? parseRobots(r.body)
      : ALLOW_ALL;
    robotsByOrigin.set(origin, rules);
    if (typeof rules !== "string" && rules.crawlDelayMs != null) delay = Math.max(delay, rules.crawlDelayMs);
    return rules;
  };
  const allowed = async (url: string) => {
    try {
      const u = new URL(url);
      if (!sameSite(url, site) || u.protocol !== "https:" && u.protocol !== "http:") return false;
      const rules = await robotsOf(u.origin);
      return typeof rules !== "string" && rules.allowed(u.pathname + u.search);
    } catch {
      return false;
    }
  };

  // Point d'entrée : sous-domaine carrière tel quel (« recrutement.exemple.fr »), sinon avec ou sans www
  let origin = "";
  let robots: Robots = ALLOW_ALL;
  let entry: FetchedPage | null = null;
  const careerHost = CAREER_HOST_RE.test(site);
  for (const candidate of careerHost ? [`https://${site}`] : [`https://www.${site}`, `https://${site}`]) {
    const rules = await robotsOf(candidate);
    if (rules === "site injoignable") continue;
    if (typeof rules === "string") { result.blocked = rules; return result; }
    // Accueil (si permis) ; redirection vers un autre sous-domaine de l'entreprise (« recrutement. » → « recrute. »)
    const home = rules.allowed("/") ? await get(`${candidate}/`) : null;
    origin = home?.status && sameSite(home.url, site) ? new URL(home.url).origin : candidate;
    if (origin !== candidate) {
      const moved = await robotsOf(origin);
      if (typeof moved === "string") { result.blocked = moved; return result; }
      robots = moved;
    } else robots = rules;
    entry = home;
    break;
  }
  if (!origin) { result.blocked = "site injoignable"; return result; }
  if (entry && (entry.status === 403 || entry.status === 429)) { result.blocked = "accès refusé (protection anti-robots)"; return result; }
  // Site fermé aux robots (pages carrière comprises) : on respecte
  if (!robots.allowed("/") && CAREER_PATHS.every((p) => !robots.allowed(p))) {
    result.blocked = "interdit par robots.txt";
    return result;
  }

  const jobUrls = new Set<string>();
  const seen = new Map<string, JobOffer>();
  const read = (html: string, pageUrl: string) => {
    const postings = extractJobPostings(html);
    if (!postings.length) return;
    const siteName = siteNameOf(html);
    for (const jp of postings) {
      const o = normalizeJobPosting(jp, { pageUrl, site, siteName, now: opts.now?.() });
      if (o) seen.set(o.id, o);
    }
  };

  // 1. Plan du site : pages d'offres listées
  const sitemapQueue = robots.sitemaps.length ? robots.sitemaps.slice(0, 5) : [`${origin}/sitemap.xml`];
  const readSitemaps = new Set<string>();
  while (sitemapQueue.length && readSitemaps.size < 12) {
    const sm = sitemapQueue.shift()!;
    if (readSitemaps.has(sm) || !(await allowed(sm))) continue;
    readSitemaps.add(sm);
    const r = await get(sm);
    if (refused >= 3) break;
    if (r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    const urls = locs(r.body);
    if (/<sitemapindex/i.test(r.body)) {
      // Index : d'abord les plans qui portent sur les offres
      const subs = urls.filter((u) => JOB_SITEMAP_RE.test(new URL(u, origin).pathname.split("/").pop() || ""));
      sitemapQueue.push(...(subs.length ? subs : urls.slice(0, 5)));
      continue;
    }
    const jobSitemap = JOB_SITEMAP_RE.test(new URL(sm).pathname.split("/").pop() || "");
    for (const u of urls) {
      if (jobUrls.size >= maxPages) break;
      if (!SKIP_EXT.test(u) && (jobSitemap || isJobUrl(u, origin)) && (await allowed(u))) jobUrls.add(u);
    }
  }

  // 2. Sans plan du site utile : page carrière (accueil d'un sous-domaine carrière, liens depuis l'accueil, adresses usuelles)
  if (!jobUrls.size) {
    const careerPages = new Map<string, FetchedPage | null>();
    const home = entry?.status === 200 ? entry : null;
    if (home && careerHost) careerPages.set(home.url, home);
    else if (home) {
      read(home.body, home.url);
      for (const l of links(home.body, home.url)) {
        const [href, label] = l.split("\u0000");
        if (detectBoard(href)) result.boards.push(href);
        else if (sameSite(href, site) && (CAREER_LINK_RE.test(new URL(href).pathname) || CAREER_LINK_RE.test(label) || CAREER_HOST_RE.test(hostOf(href))) && (await allowed(href))) careerPages.set(href, null);
      }
    }
    if (!careerPages.size && !careerHost) for (const p of CAREER_PATHS.slice(0, 4)) if (await allowed(`${origin}${p}`)) careerPages.set(`${origin}${p}`, null);
    for (const [cp, fetched] of [...careerPages].slice(0, 4)) {
      const r = fetched || (await get(cp));
      if (refused >= 3) { result.blocked = "accès refusé (protection anti-robots)"; break; }
      if (r.status !== 200) continue;
      read(r.body, r.url);
      for (const l of links(r.body, r.url)) {
        const href = l.split("\u0000")[0];
        if (detectBoard(href)) { result.boards.push(href); continue; }
        if (jobUrls.size < maxPages && href !== r.url && sameSite(href, site) && !SKIP_EXT.test(href) && isJobUrl(href) && (await allowed(href))) jobUrls.add(href);
      }
      if (/captcha|cf-chl|challenge-platform/i.test(r.body) && !seen.size) { result.blocked = "page protégée"; break; }
    }
  }

  // 3. Pages d'offres
  for (const url of jobUrls) {
    if (result.pages >= maxPages + 20) break;
    const r = await get(url);
    if (refused >= 3) { result.blocked = "accès refusé (protection anti-robots)"; break; }
    if (r.status === 429 || r.status === 503) { result.blocked = `le site demande de ralentir (${r.status})`; break; }
    if (r.status === 200 && /html/i.test(r.contentType)) read(r.body, r.url);
  }

  result.offers = [...seen.values()];
  result.boards = [...new Set(result.boards)];
  return result;
}

// ---------------------------------------------------------------------------
// Collecte de plusieurs sites vers la base d'offres
// ---------------------------------------------------------------------------
/** Hôtes à ne jamais visiter : sites d'emploi et plateformes (conditions d'utilisation), services publics. */
const NOT_A_COMPANY_RE = /(^|\.)(google|facebook|instagram|twitter|x|youtube|tiktok|gouv|free|orange|gmail|outlook|hotmail|wanadoo|bit|linktr|wix|wixsite|jimdo|canva|sfr|laposte)\.[a-z.]+$/;

/** Domaine d'un site d'entreprise (« https://www.exemple.fr/x » → « exemple.fr ») ; null pour un site d'emploi ou un réseau social. */
export function companySite(url: string | undefined): string | null {
  const host = hostOf(String(url || "").startsWith("http") ? String(url) : `https://${url || ""}`);
  if (!host || !/\.[a-z]{2,}$/.test(host)) return null;
  if (HOST_FAMILIES.some((h) => h.re.test(host))) return null;
  if (NOT_A_COMPANY_RE.test(host)) return null;
  const parts = host.split(".");
  // Domaines en deux parties (« co.uk », « com.fr ») : trois derniers segments
  const n = /^(co|com|net|org|gouv|asso)$/.test(parts[parts.length - 2] || "") ? 3 : 2;
  const domain = parts.slice(-n).join(".");
  // Sous-domaine consacré au recrutement : point d'entrée direct
  const sub = parts.length === n + 1 ? `${parts[0]}.${domain}` : "";
  return sub && CAREER_HOST_RE.test(sub) ? sub : domain;
}

export interface SitesSyncSummary { sites: number; offers: number; inserted: number; updated: number; deactivated: number; blocked: number; boards: string[]; errors: { site: string; message: string }[] }

/**
 * Visite chaque site (au plus une fois par `revisitHours`, une fois par semaine pour un site sans offres) et
 * enregistre ses offres ; les offres d'un site qui ne sont plus publiées deviennent inactives.
 */
export async function syncCareerSites(
  store: OfferStore,
  sites: string[],
  opts: SiteCrawlOptions & { revisitHours?: number; /** Sites visités au plus pendant cette collecte. */ maxSites?: number; log?: (event: string, data: Record<string, unknown>) => void } = {}
): Promise<SitesSyncSummary> {
  const now = opts.now ? opts.now() : new Date();
  const summary: SitesSyncSummary = { sites: 0, offers: 0, inserted: 0, updated: 0, deactivated: 0, blocked: 0, boards: [], errors: [] };
  const revisitMs = (opts.revisitHours ?? 24) * 3_600_000;
  for (const site of [...new Set(sites)]) {
    if (opts.maxSites != null && summary.sites >= opts.maxSites) break;
    const partition = `site:${site}`;
    const state = (await store.getState(SITES_SOURCE, partition)) || { source: SITES_SOURCE, partition, lastSuccessAt: null, lastFullAt: null, lastError: null, stats: {} };
    const lastVisit = Math.max(new Date(state.lastSuccessAt || 0).getTime(), new Date(String(state.stats.visitedAt || 0)).getTime() || 0);
    const empty = Number(state.stats.offers || 0) === 0 && !!state.stats.visitedAt;
    if (now.getTime() - lastVisit < (empty ? 7 * 24 * 3_600_000 : revisitMs)) continue;
    const seenAt = now.toISOString();
    try {
      const r = await crawlSite(site, opts);
      summary.sites++;
      summary.boards.push(...r.boards);
      if (r.blocked) summary.blocked++;
      const w = await store.upsertOffers(r.offers.map(toOfferRow), seenAt);
      summary.offers += r.offers.length;
      summary.inserted += w.inserted;
      summary.updated += w.updated;
      // Offres retirées du site : seulement après une visite complète (site non bloqué)
      let deactivated = 0;
      if (!r.blocked) deactivated = await store.deactivateUnseenSite(SITES_SOURCE, site, seenAt);
      summary.deactivated += deactivated;
      await store.saveState({
        ...state,
        lastSuccessAt: r.blocked ? state.lastSuccessAt : seenAt,
        lastFullAt: r.blocked ? state.lastFullAt : seenAt,
        lastError: r.blocked || null,
        stats: { visitedAt: seenAt, offers: r.offers.length, pages: r.pages, deactivated, boards: r.boards.length }
      });
      opts.log?.("ingest_site", { site, offers: r.offers.length, pages: r.pages, blocked: r.blocked || null });
    } catch (e: any) {
      const message = String(e?.message || e).slice(0, 300);
      summary.errors.push({ site, message });
      await store.saveState({ ...state, lastError: message, stats: { ...state.stats, visitedAt: seenAt } });
    }
  }
  summary.boards = [...new Set(summary.boards)];
  return summary;
}

/** Sites à visiter : CAREER_SITES (liste manuelle) puis les employeurs des offres collectées, les plus actifs d'abord. */
export function siteSeeds(employerUrls: { url: string; offers: number }[], manual = process.env.CAREER_SITES): string[] {
  const out = new Map<string, number>();
  for (const s of String(manual || "").split(/[,\s]+/)) {
    const d = companySite(s.trim());
    if (d) out.set(d, Number.MAX_SAFE_INTEGER);
  }
  for (const { url, offers } of employerUrls) {
    const d = companySite(url);
    if (d) out.set(d, (out.get(d) || 0) + offers);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

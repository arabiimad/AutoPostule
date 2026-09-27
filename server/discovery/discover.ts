/**
 * Découverte d'offres pour un utilisateur, à partir de son profil (postes visés, lieu, contrats) :
 *  1. sites d'emploi et agrégateurs déjà branchés (France Travail, La bonne alternance, Google Jobs, Adzuna, Jooble) ;
 *  2. pages carrière des entreprises (Greenhouse, Lever, Ashby, SmartRecruiters), enrichies à chaque recherche ;
 *  3. web public : publications « on recrute » (LinkedIn…) et pages carrière, via la recherche Google de Gemini.
 * Les offres sont fusionnées, notées selon le profil, enregistrées et listées à l'utilisateur.
 * Si l'utilisateur a activé la candidature automatique, les meilleures offres envoyables sans lui
 * (email du recruteur, La bonne alternance) sont mises dans la file de candidatures.
 */
import { createHash } from "node:crypto";
import type { ContractType, JobOffer } from "../../src/types.ts";
import { calculateCandidateMatch } from "../../src/utils/skillMatcher.ts";
import { mergeDuplicates, queryWords, type RealSearchResult, type SearchParams } from "../jobSources.ts";
import { jobKey } from "../automation/guardrails.ts";
import type { AutomationStore, DiscoveredOffer, DiscoveryState } from "../automation/store.ts";
import { boardId, detectBoard, BoardNotFoundError, type Board } from "./atsBoards.ts";
import { discoverFromWeb, type GroundedSearchFn, type ResolveUrlFn } from "./webDiscovery.ts";
import { activeRegion, isInRegion } from "./regions.ts";

export interface DiscoveryDeps {
  store: AutomationStore;
  /** Recherche multi-sources existante (null si aucune source configurée). */
  searchJobs?: ((p: SearchParams) => Promise<RealSearchResult>) | null;
  /** Recherche Google via Gemini (null sans clé Gemini). */
  webSearch?: GroundedSearchFn | null;
  resolveUrl?: ResolveUrlFn;
  /** Offres d'une page carrière (mise en cache par l'appelant). */
  fetchBoard?: ((b: Board) => Promise<JobOffer[]>) | null;
  /** Pages carrière ajoutées à la main (ATS_BOARDS). */
  seedBoards?: Board[];
  log?: (level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) => void;
}

export interface DiscoveryRun {
  found: number;
  added: number;
  queued: number;
  bySource: Record<string, number>;
  errors: string[];
}

export const DEFAULT_DISCOVERY: Omit<DiscoveryState, "nextRunAt"> = { enabled: true, intervalHours: 6 };

const CONTRACTS: ContractType[] = ["stage", "alternance", "cdi", "cdd", "freelance"];

export function offerId(job: any) {
  return createHash("sha1").update(jobKey(job)).digest("hex").slice(0, 24);
}

/** Recherches à lancer pour ce profil (3 postes au plus). */
export function profileQueries(profile: any): { roles: string[]; location: string; contract: ContractType | "tous" } {
  const roles = [...(Array.isArray(profile?.targetRoles) ? profile.targetRoles : []), profile?.title]
    .map((r) => String(r || "").trim())
    .filter(Boolean);
  // « Développeuse web » et « Développeur web » : une seule recherche
  const key = (r: string) => r.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/euse\b/g, "eur").replace(/trice\b/g, "teur").replace(/iere\b/g, "ier").replace(/ienne\b/g, "ien").replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const unique = roles.filter((r) => !seen.has(key(r)) && !!seen.add(key(r))).slice(0, 3);
  const contracts = (Array.isArray(profile?.preferredContracts) ? profile.preferredContracts : []).filter((c: any) => CONTRACTS.includes(c));
  return { roles: unique, location: String(profile?.location || "").trim(), contract: contracts.length === 1 ? contracts[0] : "tous" };
}

/**
 * L'intitulé contient-il tous les mots importants du poste visé ? (« Backend Engineer » ⊂ « Senior Backend Software Engineer »)
 * Plus strict que la recherche des sites d'emploi : une page carrière liste tous les métiers de l'entreprise.
 */
export function titleMatches(title: string, role: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hay = norm(title);
  const words = queryWords(role).map(norm).filter((w) => w.length > 2);
  if (!words.length) return false;
  // Radical des mots longs : « développeur » / « développeuse », « engineer » / « engineering »
  return words.every((w) => hay.includes(w.length > 6 ? w.slice(0, 6) : w));
}

function locationMatches(job: JobOffer, location: string): boolean {
  if (!location || job.remote === "total") return true;
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const loc = norm(job.location || "");
  if (!loc) return true;
  const city = norm(location).split(/[,(]/)[0].trim();
  return loc.includes(city) || /\bfrance\b|\bremote\b|teletravail/.test(loc);
}

/** Candidature possible sans l'utilisateur ? (canaux automatiques actuels) */
export function isAutoApplicable(job: any): boolean {
  return !!(job?.contactEmail || job?.lbaRecipientId);
}

export class DiscoveryService {
  constructor(private deps: DiscoveryDeps) {}

  private log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) {
    this.deps.log?.(level, event, data);
  }

  /** Inscrit l'utilisateur à la découverte régulière (au premier accès). */
  async ensureScheduled(uid: string): Promise<DiscoveryState> {
    const existing = await this.deps.store.getDiscovery(uid);
    if (existing) return existing;
    const state: DiscoveryState = { ...DEFAULT_DISCOVERY, nextRunAt: new Date().toISOString() };
    await this.deps.store.saveDiscovery(uid, state);
    return state;
  }

  /** Enregistre les pages carrière rencontrées dans des liens d'offres. */
  async learnBoards(urls: string[]) {
    const boards = new Map<string, Board>();
    for (const u of urls) {
      const b = detectBoard(u);
      if (b) boards.set(boardId(b), b);
    }
    if (boards.size) await this.deps.store.saveBoards([...boards.entries()].map(([id, b]) => ({ id, ...b })));
    return boards.size;
  }

  async collect(profile: any): Promise<{ jobs: JobOffer[]; bySource: Record<string, number>; errors: string[] }> {
    const { roles, location, contract } = profileQueries(profile);
    const bySource: Record<string, number> = {};
    const errors: string[] = [];
    const all: JobOffer[] = [];
    const add = (source: string, jobs: JobOffer[]) => {
      bySource[source] = (bySource[source] || 0) + jobs.length;
      all.push(...jobs);
    };
    if (!roles.length) return { jobs: [], bySource, errors: ["Profil sans poste visé : renseignez votre titre ou vos postes recherchés."] };

    const tasks: Promise<void>[] = [];

    // 1. Sites d'emploi et agrégateurs
    if (this.deps.searchJobs) {
      for (const role of roles) {
        tasks.push(
          this.deps.searchJobs({ query: role, location, contractType: contract, radius: 50, page: 1, includeSpontaneous: contract === "tous" || contract === "alternance" })
            .then((r) => {
              add("sites d'emploi", r.jobs);
              for (const w of r.warnings) if (/indisponible|quota/i.test(w)) errors.push(w);
            })
            .catch((e) => { errors.push(`Sites d'emploi : ${e?.message || e}`); })
        );
      }
    }

    // 2. Web public (publications, pages carrière) : 2 postes au plus (recherches plus coûteuses)
    if (this.deps.webSearch) {
      for (const role of roles.slice(0, 2)) {
        tasks.push(
          discoverFromWeb(this.deps.webSearch, { role, location, contract }, { resolveUrl: this.deps.resolveUrl })
            .then(async (r) => {
              add("web et publications", r.offers);
              await this.learnBoards(r.urls);
            })
            .catch((e) => { errors.push(`Recherche web : ${e?.message || e}`); })
        );
      }
    }
    await Promise.all(tasks);

    // Pages carrière apparues dans les liens des offres trouvées
    await this.learnBoards(all.flatMap((j) => [j.applyUrl, ...(j.applyOptions || []).map((o) => o.url), ...(j.alsoOn || []).map((o) => o.url)]).filter(Boolean));

    // 3. Pages carrière connues : offres filtrées sur les postes et le lieu du profil
    if (this.deps.fetchBoard) {
      const known = await this.deps.store.listBoards(60);
      const boards = new Map<string, Board>();
      for (const b of this.deps.seedBoards || []) boards.set(boardId(b), b);
      for (const b of known) boards.set(b.id, { ats: b.ats as Board["ats"], token: b.token, ...(b.region === "eu" ? { region: "eu" as const } : {}) });
      const lists = await Promise.allSettled([...boards.values()].map((b) => this.deps.fetchBoard!(b)));
      const matching: JobOffer[] = [];
      lists.forEach((r) => {
        if (r.status === "fulfilled") {
          // Sur les pages carrière, l'intitulé doit correspondre (les descriptions longues citent beaucoup de métiers)
          matching.push(...r.value.filter((j) => roles.some((role) => titleMatches(j.title, role)) && locationMatches(j, location) && (contract === "tous" || j.contractType === contract)));
        } else if (!(r.reason instanceof BoardNotFoundError)) {
          errors.push(String(r.reason?.message || r.reason));
        }
      });
      add("pages carrière", matching);
    }

    // Même fiche renvoyée par deux recherches : gardée une fois, puis fusion des offres identiques entre sources
    const byId = [...new Map(all.map((j) => [j.id, j])).values()];
    return { jobs: mergeDuplicates(byId), bySource, errors: [...new Set(errors)].slice(0, 10) };
  }

  /** Découverte complète pour un utilisateur ; renvoie le bilan. */
  async run(uid: string, profileOverride?: any, opts: { enqueue?: (uid: string, job: any) => Promise<string | null>; minScore?: number; maxQueued?: number } = {}): Promise<DiscoveryRun> {
    const profile = profileOverride || (await this.deps.store.getProfile(uid));
    if (!profile) throw new Error("Profil introuvable");
    const { jobs, bySource, errors } = await this.collect(profile);
    const now = new Date().toISOString();
    // Première version : offres situées en France uniquement (voir regions.ts)
    const region = activeRegion();
    const offers: DiscoveredOffer[] = [...new Map(jobs.map((j) => [offerId(j), j])).values()]
      .filter((j) => j.status !== "expired" && isInRegion(j, region))
      .map((job) => {
        const m = calculateCandidateMatch(profile.skills || [], job.skillsRequired || []);
        return {
          id: offerId(job),
          job: { ...job, matchScore: m.score ?? undefined, matchedKeywords: m.matchedKeywords, missingKeywords: m.missingKeywords },
          score: m.score,
          matchedKeywords: m.matchedKeywords,
          missingKeywords: m.missingKeywords,
          status: "new" as const,
          firstSeenAt: now,
          lastSeenAt: now
        };
      });
    const { added } = await this.deps.store.upsertOffers(uid, offers);

    // Candidature automatique : seulement si l'utilisateur l'a activée
    let queued = 0;
    if (opts.enqueue && profile.autoApplyEnabled) {
      const min = opts.minScore ?? 60;
      const candidates = (await this.deps.store.listOffers(uid, 500))
        .filter((o) => o.status === "new" && o.score != null && o.score >= min && isAutoApplicable(o.job))
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, opts.maxQueued ?? 15);
      for (const o of candidates) {
        const taskId = await opts.enqueue(uid, o.job);
        if (taskId) {
          await this.deps.store.updateOffer(uid, o.id, { status: "queued", taskId });
          queued++;
        }
      }
    }
    this.log("info", "discovery_run", { uid, found: offers.length, added, queued, bySource, errors: errors.length });
    return { found: offers.length, added, queued, bySource, errors };
  }
}

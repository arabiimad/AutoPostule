/**
 * Découverte d'offres au-delà des sites d'emploi, pour la recherche planifiée de l'auto-candidature :
 *  - pages carrière des entreprises (Greenhouse, Lever, Ashby, SmartRecruiters) : chaque lien vers l'une
 *    d'elles rencontré dans une recherche enregistre la page, relue ensuite pour tous les candidats ;
 *  - web public : publications « on recrute » (LinkedIn…) et pages carrière, via la recherche Google de Gemini.
 * Première version : offres situées en France uniquement (regions.ts).
 */
import type { JobOffer } from "../../src/types.ts";
import { queryWords } from "../jobSources.ts";
import { kv } from "../store.ts";
import { boardId, boardsFromEnv, detectBoard, fetchBoardJobs, BoardNotFoundError, type Board } from "./atsBoards.ts";
import { discoverFromWeb, type GroundedSearchFn, type ResolveUrlFn } from "./webDiscovery.ts";
import { activeRegion, isInRegion, locationInRegion, type Region } from "./regions.ts";

// ---------------------------------------------------------------------------
// Pages carrière connues (partagées entre candidats ; Redis si configuré, sinon mémoire)
// ---------------------------------------------------------------------------
const REGISTRY_KEY = "discovery:boards";
const MAX_BOARDS = 500;

export async function knownBoards(): Promise<Board[]> {
  try {
    const raw = await kv().get(REGISTRY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Enregistre les pages carrière apparues dans des liens d'offres ; renvoie le nombre de nouvelles. */
export async function learnBoards(urls: string[]): Promise<number> {
  const found = new Map<string, Board>();
  for (const u of urls) {
    const b = typeof u === "string" ? detectBoard(u) : null;
    if (b) found.set(boardId(b), b);
  }
  if (!found.size) return 0;
  const current = await knownBoards();
  const ids = new Set(current.map(boardId));
  const fresh = [...found.values()].filter((b) => !ids.has(boardId(b)));
  if (!fresh.length) return 0;
  // Les plus récentes en tête ; la liste est plafonnée
  await kv().set(REGISTRY_KEY, JSON.stringify([...fresh, ...current].slice(0, MAX_BOARDS)), 0);
  return fresh.length;
}

/** Offres d'une page carrière, en cache 3 h. */
export async function cachedBoardJobs(board: Board, fetchJson?: Parameters<typeof fetchBoardJobs>[1]): Promise<JobOffer[]> {
  const key = `board:${boardId(board)}`;
  const hit = await kv().get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch { /* recharge */ }
  }
  const jobs = await fetchBoardJobs(board, fetchJson);
  await kv().set(key, JSON.stringify(jobs), 3 * 3600);
  return jobs;
}

/**
 * L'intitulé contient-il tous les mots importants du métier ? (« Backend Engineer » ⊂ « Senior Backend Software Engineer »)
 * Plus strict que la recherche des sites d'emploi : une page carrière liste tous les métiers de l'entreprise.
 */
export function titleMatches(title: string, role: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hay = norm(title);
  const words = queryWords(role).map(norm).filter((w) => w.length > 2);
  if (!words.length) return false;
  // Radical des mots longs : « développeur » / « développeuse », « engineer » / « engineering »
  return words.every((w) => hay.includes(w.length > 6 ? w.slice(0, 6) : w));
}

export interface DiscoveryDeps {
  webSearch?: GroundedSearchFn | null;
  resolveUrl?: ResolveUrlFn;
  fetchBoard?: (b: Board) => Promise<JobOffer[]>;
  region?: Region;
  /** Pages carrière relues à chaque recherche (les plus récemment apprises d'abord). */
  maxBoards?: number;
}

export interface DiscoveryResult {
  jobs: JobOffer[];
  bySource: Record<string, number>;
  errors: string[];
}

/** Offres des pages carrière et du web public pour ces métiers et ces lieux. */
export async function discoverBeyondJobBoards(
  q: { roles: string[]; locations: string[]; contract: string },
  deps: DiscoveryDeps = {}
): Promise<DiscoveryResult> {
  const region = deps.region || activeRegion();
  const bySource: Record<string, number> = {};
  const errors: string[] = [];
  const all: JobOffer[] = [];
  const roles = q.roles.map((r) => r.trim()).filter(Boolean).slice(0, 3);
  if (!roles.length) return { jobs: [], bySource, errors };
  const cities = q.locations.map((l) => l.trim()).filter(Boolean);

  // 1. Web public (publications « on recrute », pages carrière) : 2 métiers au plus, recherches plus coûteuses
  if (deps.webSearch) {
    const location = cities[0] || region.searchLabel;
    const results = await Promise.allSettled(
      roles.slice(0, 2).map((role) => discoverFromWeb(deps.webSearch!, { role, location, contract: q.contract as any }, { resolveUrl: deps.resolveUrl }))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        all.push(...r.value.offers);
        bySource["web et publications"] = (bySource["web et publications"] || 0) + r.value.offers.length;
        await learnBoards(r.value.urls);
      } else {
        errors.push(`Recherche web : ${r.reason?.message || r.reason}`);
      }
    }
  }

  // 2. Pages carrière connues : intitulé correspondant, lieu dans la zone (et dans les villes du candidat s'il en a)
  const fetchBoard = deps.fetchBoard || ((b: Board) => cachedBoardJobs(b));
  const boards = new Map<string, Board>();
  for (const b of boardsFromEnv()) boards.set(boardId(b), b);
  for (const b of (await knownBoards()).slice(0, deps.maxBoards ?? 80)) boards.set(boardId(b), b);
  const lists = await Promise.allSettled([...boards.values()].map((b) => fetchBoard(b)));
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  let fromBoards = 0;
  for (const r of lists) {
    if (r.status === "rejected") {
      if (!(r.reason instanceof BoardNotFoundError)) errors.push(String(r.reason?.message || r.reason));
      continue;
    }
    for (const j of r.value) {
      if (!roles.some((role) => titleMatches(j.title, role))) continue;
      if (q.contract && q.contract !== "tous" && j.contractType !== q.contract) continue;
      if (!locationInRegion(j.location, region)) continue;
      if (cities.length && j.remote !== "total" && !cities.some((c) => norm(j.location).includes(norm(c)))) continue;
      all.push(j);
      fromBoards++;
    }
  }
  if (boards.size) bySource["pages carrière"] = fromBoards;

  const unique = [...new Map(all.filter((j) => isInRegion(j, region)).map((j) => [j.id, j])).values()];
  return { jobs: unique, bySource, errors: [...new Set(errors)].slice(0, 10) };
}

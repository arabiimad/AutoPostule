/**
 * Collecte continue des offres France Travail (y compris celles de ses sites partenaires) dans la base d'offres.
 *
 * L'API renvoie au plus 3 150 résultats par recherche (150 par page, début ≤ 3 000). La collecte interroge donc
 * chaque département et, quand un département dépasse la limite, découpe la période de création en deux,
 * récursivement, jusqu'à passer sous la limite.
 *  - incrémentale (toutes les heures) : offres créées depuis la dernière collecte réussie de la zone ;
 *  - complète (une fois par jour) : toutes les offres en ligne ; celles qui ne sont plus revues deviennent inactives.
 */
import type { JobOffer } from "../../src/types.ts";
import { ftSearchRaw, normalizeFtJob } from "../jobSources.ts";
import { toOfferRow, type OfferStore } from "./offerStore.ts";

export const FT_SOURCE = "France Travail";
export const FT_PAGE = 150;
export const FT_MAX_RESULTS = 3150;

/** Départements de France (métropole, Corse, outre-mer). */
export const DEPARTEMENTS: string[] = [
  ...Array.from({ length: 95 }, (_, i) => String(i + 1).padStart(2, "0")).filter((d) => d !== "20"),
  "2A", "2B", "971", "972", "973", "974", "976"
];

export type FtSearch = (qs: URLSearchParams) => Promise<{ status: number; offers: any[]; total: number | null }>;

export interface FtCollectOptions {
  search?: FtSearch;
  /** Appels par seconde (limite de l'API ; 3 par défaut). */
  rps?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Offres créées depuis N jours pour une collecte complète (120 par défaut). */
  fullWindowDays?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Format de date attendu par l'API : 2026-09-27T08:00:00Z (sans millisecondes). */
export const ftDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

class Throttle {
  private next = 0;
  constructor(private intervalMs: number, private sleep: (ms: number) => Promise<void>) {}
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await this.sleep(at - now);
  }
}

export interface PartitionResult {
  departement: string;
  fetched: number;
  pages: number;
  splits: number;
  /** Une fenêtre d'une heure dépassait encore la limite : résultats tronqués (collecte incomplète). */
  truncated: boolean;
}

/**
 * Toutes les offres d'un département créées dans [from, to], en découpant la période si nécessaire.
 * `onPage` reçoit les offres brutes au fil de l'eau (écriture par lots).
 */
export async function collectDepartement(
  departement: string,
  from: Date,
  to: Date,
  onPage: (offers: any[]) => Promise<void>,
  opts: FtCollectOptions = {}
): Promise<PartitionResult> {
  const search = opts.search || ftSearchRaw;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const throttle = new Throttle(1000 / Math.max(0.2, opts.rps ?? 3), sleep);
  const result: PartitionResult = { departement, fetched: 0, pages: 0, splits: 0, truncated: false };

  const call = async (qs: URLSearchParams) => {
    // Surcharge ou panne passagère : jusqu'à 4 essais (1 s, 2 s, 4 s)
    for (let attempt = 0; ; attempt++) {
      await throttle.wait();
      const r = await search(qs);
      result.pages++;
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= 3) throw new Error(`France Travail indisponible (${r.status}) pour le département ${departement}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (r.status >= 400) throw new Error(`France Travail : erreur ${r.status} pour le département ${departement}`);
      return r;
    }
  };

  const walk = async (a: Date, b: Date): Promise<void> => {
    const base = new URLSearchParams({ departement, minCreationDate: ftDate(a), maxCreationDate: ftDate(b), sort: "1" });
    const first = await call(new URLSearchParams({ ...Object.fromEntries(base), range: `0-${FT_PAGE - 1}` }));
    const total = first.total ?? first.offers.length;
    if (total > FT_MAX_RESULTS && b.getTime() - a.getTime() > 3_600_000) {
      // Trop de résultats : deux demi-périodes (la seconde commence une seconde après la fin de la première)
      result.splits++;
      const mid = new Date(a.getTime() + Math.floor((b.getTime() - a.getTime()) / 2));
      await walk(a, mid);
      await walk(new Date(mid.getTime() + 1000), b);
      return;
    }
    if (total > FT_MAX_RESULTS) result.truncated = true;
    result.fetched += first.offers.length;
    await onPage(first.offers);
    const last = Math.min(total, FT_MAX_RESULTS);
    for (let start = FT_PAGE; start < last; start += FT_PAGE) {
      const r = await call(new URLSearchParams({ ...Object.fromEntries(base), range: `${start}-${Math.min(start + FT_PAGE, last) - 1}` }));
      if (!r.offers.length) break;
      result.fetched += r.offers.length;
      await onPage(r.offers);
    }
  };

  await walk(from, to);
  return result;
}

export interface SyncSummary {
  mode: "incremental" | "full";
  departements: number;
  fetched: number;
  inserted: number;
  updated: number;
  deactivated: number;
  errors: { departement: string; message: string }[];
  truncated: string[];
  ms: number;
}

/** Collecte France Travail vers la base d'offres ; reprend là où la zone s'était arrêtée. */
export async function syncFranceTravail(
  store: OfferStore,
  opts: FtCollectOptions & { mode?: "incremental" | "full"; departements?: string[] } = {}
): Promise<SyncSummary> {
  const mode = opts.mode || "incremental";
  const now = opts.now ? opts.now() : new Date();
  const started = Date.now();
  const summary: SyncSummary = { mode, departements: 0, fetched: 0, inserted: 0, updated: 0, deactivated: 0, errors: [], truncated: [], ms: 0 };
  const fullFrom = new Date(now.getTime() - (opts.fullWindowDays ?? 120) * 86_400_000);

  for (const dep of opts.departements || DEPARTEMENTS) {
    const partition = `dep:${dep}`;
    const state = (await store.getState(FT_SOURCE, partition)) || { source: FT_SOURCE, partition, lastSuccessAt: null, lastFullAt: null, lastError: null, stats: {} };
    // Incrémentale : depuis la dernière réussite, avec une heure de recouvrement ; première fois : collecte complète
    const incremental = mode === "incremental" && !!state.lastSuccessAt;
    const from = incremental ? new Date(new Date(state.lastSuccessAt!).getTime() - 3_600_000) : fullFrom;
    const seenAt = now.toISOString();
    try {
      const res = await collectDepartement(dep, from, now, async (raw) => {
        const jobs = raw.map(normalizeFtJob).filter((j): j is JobOffer => !!j);
        const w = await store.upsertOffers(jobs.map(toOfferRow), seenAt);
        summary.inserted += w.inserted;
        summary.updated += w.updated;
      }, opts);
      summary.fetched += res.fetched;
      summary.departements++;
      if (res.truncated) summary.truncated.push(dep);
      let deactivated = 0;
      // Offres retirées : seulement après un balayage complet et non tronqué de la zone
      if (!incremental && !res.truncated) {
        deactivated = await store.deactivateUnseen(FT_SOURCE, dep, seenAt);
        summary.deactivated += deactivated;
      }
      await store.saveState({
        ...state,
        lastSuccessAt: seenAt,
        lastFullAt: incremental ? state.lastFullAt : seenAt,
        lastError: null,
        stats: { fetched: res.fetched, pages: res.pages, splits: res.splits, truncated: res.truncated, deactivated, mode: incremental ? "incremental" : "full" }
      });
      opts.log?.("ingest_partition", { source: FT_SOURCE, ...res, deactivated });
    } catch (e: any) {
      const message = String(e?.message || e).slice(0, 300);
      summary.errors.push({ departement: dep, message });
      await store.saveState({ ...state, lastError: message });
      opts.log?.("ingest_partition_error", { source: FT_SOURCE, departement: dep, message });
    }
  }
  summary.ms = Date.now() - started;
  return summary;
}

/**
 * Recherche dans la base d'offres (migration 007) : remplace l'appel en direct à l'API France Travail
 * quand la collecte continue est en place (JOBS_INDEX=on). Réponse instantanée, sans quota.
 *
 * Mêmes règles que la recherche en direct : mots-clés (plein texte en français), puis codes métier ROME si
 * aucun résultat ; lieu (rayon autour de la commune, sinon département) ; contrat ; plus récentes d'abord.
 * Base vide ou en panne : null → la recherche repasse sur l'API.
 */
import pg from "pg";
import type { JobOffer } from "../../src/types.ts";
import { needsSsl } from "../automation/pgStore.ts";
import type { GeoPoint, SearchParams } from "../jobSources.ts";

export const INDEX_PAGE = 150;

export type IndexSearch = (params: SearchParams, geo: GeoPoint | null, romes: () => Promise<string[]>) => Promise<{ jobs: JobOffer[]; full: boolean } | null>;

const CONTRACTS = new Set(["cdi", "cdd", "alternance", "freelance"]);

export function buildIndexQuery(params: SearchParams, geo: GeoPoint | null, source: string, romeCodes: string[] | null) {
  const values: unknown[] = [source];
  const where = ["active", "source = $1"];
  const q = String(params.query || "").trim();
  let rank = "0::float8"; // « order by 0 » serait lu comme un numéro de colonne
  if (romeCodes) {
    values.push(romeCodes);
    where.push(`rome_code = any($${values.length}::text[])`);
  } else if (q) {
    values.push(q);
    where.push(`search @@ plainto_tsquery('french', $${values.length})`);
    rank = `ts_rank(search, plainto_tsquery('french', $${values.length}))`;
  }
  const contract = String(params.contractType || "tous").toLowerCase();
  if (CONTRACTS.has(contract)) {
    values.push(contract);
    where.push(`contract = $${values.length}`);
  }
  if (geo?.latitude != null && geo?.longitude != null) {
    // Rayon autour de la commune ; offres sans coordonnées : même département
    values.push(geo.latitude, geo.longitude, Math.min(Math.max(params.radius || 30, 1), 200), geo.departement || null);
    const [lat, lng, km, dep] = [values.length - 3, values.length - 2, values.length - 1, values.length];
    where.push(`(
      ((data->>'latitude') is not null and (data->>'longitude') is not null and
        6371 * 2 * asin(sqrt(power(sin(radians(((data->>'latitude')::float8 - $${lat}) / 2)), 2)
          + cos(radians($${lat})) * cos(radians((data->>'latitude')::float8))
          * power(sin(radians(((data->>'longitude')::float8 - $${lng}) / 2)), 2))) <= $${km})
      or ((data->>'latitude') is null and $${dep}::text is not null and departement = $${dep})
    )`);
  } else if (geo?.departement) {
    values.push(geo.departement);
    where.push(`departement = $${values.length}`);
  }
  const page = Math.max(1, Math.min(Number(params.page) || 1, 20));
  values.push(INDEX_PAGE, (page - 1) * INDEX_PAGE);
  const sql = `select data from public.job_offers where ${where.join(" and ")}
    order by ${rank} desc, published_at desc nulls last, id
    limit $${values.length - 1} offset $${values.length}`;
  return { sql, values };
}

export class PgOfferSearch {
  private readyUntil = 0;
  private ready = false;

  constructor(readonly pool: pg.Pool, private source = "France Travail") {}

  static fromEnv(env = process.env): PgOfferSearch | null {
    const url = env.AUTOMATION_DATABASE_URL;
    if (env.JOBS_INDEX !== "on" || !url) return null;
    return new PgOfferSearch(new pg.Pool({ connectionString: url, max: 5, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined }));
  }

  /** La base contient des offres de cette source (vérifié toutes les 10 minutes). */
  private async isReady() {
    if (Date.now() < this.readyUntil) return this.ready;
    try {
      const { rows } = await this.pool.query(`select exists (select 1 from public.job_offers where active and source = $1 and last_seen_at > now() - interval '3 days') as ok`, [this.source]);
      this.ready = !!rows[0]?.ok;
    } catch {
      this.ready = false;
    }
    this.readyUntil = Date.now() + 10 * 60_000;
    return this.ready;
  }

  search: IndexSearch = async (params, geo, romes) => {
    if (!(await this.isReady())) return null;
    try {
      const run = async (codes: string[] | null) => {
        const { sql, values } = buildIndexQuery(params, geo, this.source, codes);
        return (await this.pool.query(sql, values)).rows.map((r) => r.data as JobOffer);
      };
      let jobs = await run(null);
      // Mots-clés sans résultat : recherche par métier (codes ROME), comme la recherche en direct
      if (!jobs.length && String(params.query || "").trim() && (Number(params.page) || 1) === 1) {
        const codes = await romes();
        if (codes.length) jobs = await run(codes);
      }
      return { jobs, full: jobs.length >= INDEX_PAGE };
    } catch (e: any) {
      if (process.env.DEBUG_INDEX) console.error("[index]", e?.message);
      return null;
    }
  };
}

/** Active la base d'offres pour la recherche (serveur web et worker) si JOBS_INDEX=on et la base est configurée. */
export async function enableOfferIndexFromEnv(env = process.env): Promise<boolean> {
  const idx = PgOfferSearch.fromEnv(env);
  if (!idx) return false;
  const { setOfferIndex, setSiteIndex } = await import("../jobSources.ts");
  setOfferIndex(idx.search);
  // Même base, offres des sites d'employeurs (source « Sites carrière »)
  setSiteIndex(new PgOfferSearch(idx.pool, "Sites carrière").search);
  return true;
}

/**
 * Base d'offres (table job_offers, migration 007) : écriture par lots, offres retirées, état de la collecte,
 * mesures. PostgreSQL en production (même base que l'auto-candidature), mémoire pour les tests.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import type { JobOffer } from "../../src/types.ts";
import { needsSsl } from "../automation/pgStore.ts";
import { classifyApply } from "./applyHosts.ts";

export interface OfferRow {
  id: string;
  source: string;
  sourceRef: string;
  title: string;
  company: string;
  location: string;
  contract: string | null;
  offerUrl: string;
  publishedAt: string | null;
  expiresAt: string | null;
  fingerprint: string;
  romeCode: string | null;
  departement: string | null;
  partner: string | null;
  applyKind: string;
  applyHost: string;
  data: JobOffer;
}

export interface IngestState {
  source: string;
  partition: string;
  lastSuccessAt: string | null;
  lastFullAt: string | null;
  lastError: string | null;
  stats: Record<string, unknown>;
}

export interface ChannelStat { kind: string; host: string; count: number }

export interface OfferStore {
  upsertOffers(rows: OfferRow[], seenAt: string): Promise<{ inserted: number; updated: number }>;
  /** Offres d'une source et d'un département non revues depuis `before` : retirées (inactives). */
  deactivateUnseen(source: string, departement: string, before: string): Promise<number>;
  /** Offres d'un site d'entreprise (« exemple.fr ») non revues depuis `before` : retirées. */
  deactivateUnseenSite(source: string, site: string, before: string): Promise<number>;
  getState(source: string, partition: string): Promise<IngestState | null>;
  saveState(state: IngestState): Promise<void>;
  channelStats(filter?: { source?: string }): Promise<ChannelStat[]>;
  countActive(): Promise<{ total: number; bySource: Record<string, number> }>;
}

const norm = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\(?\b[hf]\s*\/\s*[hf](\s*\/\s*[a-z])?\b\)?/g, " ") // (H/F), F/H/N
    .replace(/\b(sas|sasu|sa|sarl|eurl|scop)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();

/** Empreinte d'une offre : même entreprise, même intitulé, même lieu → même offre, quelle que soit la source. */
export function fingerprintOf(o: Pick<JobOffer, "company" | "title" | "location"> & { departement?: string }): string {
  const place = o.departement || norm(o.location).split(" ").filter((w) => !/^\d+$/.test(w)).slice(0, 2).join(" ");
  return createHash("sha1").update(`${norm(o.company)}|${norm(o.title)}|${place}`).digest("hex").slice(0, 20);
}

const iso = (v: unknown) => {
  const d = v ? new Date(String(v)) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

export function toOfferRow(job: JobOffer): OfferRow {
  const apply = classifyApply(job);
  return {
    id: job.id,
    source: job.source,
    sourceRef: job.id.replace(/^[a-z]+-/, ""),
    title: job.title,
    company: job.company || "",
    location: job.location || "",
    contract: job.contractType && job.contractType !== ("non-precise" as any) ? job.contractType : null,
    offerUrl: job.applyUrl || "",
    publishedAt: iso(job.publishedAt),
    expiresAt: iso(job.expiresAt),
    fingerprint: fingerprintOf(job),
    romeCode: job.romeCode || null,
    departement: job.departement || null,
    partner: job.sourcePartner || null,
    applyKind: apply.kind,
    applyHost: apply.host,
    data: job
  };
}

// ---------------------------------------------------------------------------
// Mémoire (tests, mesure sans base)
// ---------------------------------------------------------------------------
export class MemoryOfferStore implements OfferStore {
  rows = new Map<string, OfferRow & { lastSeenAt: string; active: boolean }>();
  states = new Map<string, IngestState>();

  async upsertOffers(rows: OfferRow[], seenAt: string) {
    let inserted = 0, updated = 0;
    for (const r of rows) {
      if (this.rows.has(r.id)) updated++;
      else inserted++;
      this.rows.set(r.id, { ...r, lastSeenAt: seenAt, active: true });
    }
    return { inserted, updated };
  }
  async deactivateUnseen(source: string, departement: string, before: string) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.active && r.source === source && r.departement === departement && r.lastSeenAt < before) {
        r.active = false;
        n++;
      }
    }
    return n;
  }
  async deactivateUnseenSite(source: string, site: string, before: string) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.active && r.source === source && r.sourceRef.startsWith(`${site}:`) && r.lastSeenAt < before) {
        r.active = false;
        n++;
      }
    }
    return n;
  }
  async getState(source: string, partition: string) {
    return this.states.get(`${source}|${partition}`) ?? null;
  }
  async saveState(state: IngestState) {
    this.states.set(`${state.source}|${state.partition}`, { ...state });
  }
  async channelStats(filter: { source?: string } = {}) {
    const m = new Map<string, ChannelStat>();
    for (const r of this.rows.values()) {
      if (!r.active || (filter.source && r.source !== filter.source)) continue;
      const k = `${r.applyKind}|${r.applyHost}`;
      const s = m.get(k) || { kind: r.applyKind, host: r.applyHost, count: 0 };
      s.count++;
      m.set(k, s);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }
  async countActive() {
    const bySource: Record<string, number> = {};
    let total = 0;
    for (const r of this.rows.values()) if (r.active) { total++; bySource[r.source] = (bySource[r.source] || 0) + 1; }
    return { total, bySource };
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
export class PgOfferStore implements OfferStore {
  constructor(readonly pool: pg.Pool) {}

  static fromEnv(url = process.env.AUTOMATION_DATABASE_URL): PgOfferStore | null {
    if (!url) return null;
    return new PgOfferStore(new pg.Pool({ connectionString: url, max: 3, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined }));
  }

  async upsertOffers(rows: OfferRow[], seenAt: string) {
    if (!rows.length) return { inserted: 0, updated: 0 };
    const payload = rows.map((r) => ({
      id: r.id, source: r.source, source_ref: r.sourceRef, title: r.title, company: r.company, location: r.location,
      contract: r.contract, offer_url: r.offerUrl, published_at: r.publishedAt, expires_at: r.expiresAt,
      fingerprint: r.fingerprint, rome_code: r.romeCode, departement: r.departement, partner: r.partner,
      apply_kind: r.applyKind, apply_host: r.applyHost, data: r.data
    }));
    const { rows: out } = await this.pool.query(
      `insert into public.job_offers as o (id, source, source_ref, title, company, location, contract, offer_url, published_at, expires_at,
          fingerprint, rome_code, departement, partner, apply_kind, apply_host, data, verified_at, last_seen_at, active)
       select id, source, source_ref, title, company, location, contract, offer_url, published_at, expires_at,
          fingerprint, rome_code, departement, partner, apply_kind, apply_host, data, $2::timestamptz, $2::timestamptz, true
       from jsonb_to_recordset($1::jsonb) as x(id text, source text, source_ref text, title text, company text, location text,
          contract text, offer_url text, published_at timestamptz, expires_at timestamptz, fingerprint text, rome_code text,
          departement text, partner text, apply_kind text, apply_host text, data jsonb)
       on conflict (id) do update set title = excluded.title, company = excluded.company, location = excluded.location,
          contract = excluded.contract, offer_url = excluded.offer_url,
          published_at = coalesce(excluded.published_at, o.published_at), expires_at = excluded.expires_at,
          fingerprint = excluded.fingerprint, rome_code = excluded.rome_code, departement = excluded.departement,
          partner = excluded.partner, apply_kind = excluded.apply_kind, apply_host = excluded.apply_host, data = excluded.data,
          verified_at = excluded.verified_at, last_seen_at = excluded.last_seen_at, active = true
       returning (xmax = 0) as inserted`,
      [JSON.stringify(payload), seenAt]
    );
    const inserted = out.filter((r) => r.inserted).length;
    return { inserted, updated: out.length - inserted };
  }

  async deactivateUnseen(source: string, departement: string, before: string) {
    const { rowCount } = await this.pool.query(
      `update public.job_offers set active = false where active and source = $1 and departement = $2 and last_seen_at < $3`,
      [source, departement, before]
    );
    return rowCount || 0;
  }

  async deactivateUnseenSite(source: string, site: string, before: string) {
    const { rowCount } = await this.pool.query(
      `update public.job_offers set active = false
       where active and source = $1 and left(source_ref, length($2) + 1) = $2 || ':' and last_seen_at < $3`,
      [source, site, before]
    );
    return rowCount || 0;
  }

  /**
   * Adresses de sites d'employeurs rencontrées dans les offres actives (site de l'entreprise, page de candidature
   * hébergée chez elle), les plus fréquentes d'abord.
   */
  async employerUrls(limit = 5000): Promise<{ url: string; offers: number }[]> {
    const { rows } = await this.pool.query(
      `select url, count(*)::int as offers from (
         select coalesce(nullif(data->>'companyWebsite', ''), case when apply_host like 'autre:%' then offer_url end) as url
         from public.job_offers where active and source <> $1
       ) t where url is not null group by url order by offers desc limit $2`,
      ["Sites carrière", limit]
    );
    return rows;
  }

  async getState(source: string, partition: string): Promise<IngestState | null> {
    const { rows } = await this.pool.query(`select * from public.ingest_state where source = $1 and partition = $2`, [source, partition]);
    const r = rows[0];
    return r ? { source, partition, lastSuccessAt: iso(r.last_success_at), lastFullAt: iso(r.last_full_at), lastError: r.last_error, stats: r.stats || {} } : null;
  }

  async saveState(s: IngestState) {
    await this.pool.query(
      `insert into public.ingest_state (source, partition, last_success_at, last_full_at, last_error, stats, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (source, partition) do update set last_success_at = excluded.last_success_at, last_full_at = excluded.last_full_at,
         last_error = excluded.last_error, stats = excluded.stats, updated_at = now()`,
      [s.source, s.partition, s.lastSuccessAt, s.lastFullAt, s.lastError, s.stats]
    );
  }

  async channelStats(filter: { source?: string } = {}) {
    const { rows } = await this.pool.query(
      `select coalesce(apply_kind, 'inconnu') as kind, coalesce(apply_host, 'inconnu') as host, count(*)::int as count
       from public.job_offers where active and ($1::text is null or source = $1)
       group by 1, 2 order by 3 desc`,
      [filter.source ?? null]
    );
    return rows as ChannelStat[];
  }

  async countActive() {
    const { rows } = await this.pool.query(`select source, count(*)::int as n from public.job_offers where active group by 1`);
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r.n]));
    return { total: rows.reduce((a, r) => a + r.n, 0), bySource };
  }

  /** Un seul collecteur à la fois, même avec plusieurs workers (verrou consultatif PostgreSQL). */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query(`select pg_try_advisory_lock(hashtext($1)) as ok`, [name]);
      if (!rows[0]?.ok) return null;
      try {
        return await fn();
      } finally {
        await client.query(`select pg_advisory_unlock(hashtext($1))`, [name]).catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

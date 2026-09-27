/**
 * Stockage clé-valeur partagé : cache des recherches, limiteur de débit, compteurs de quotas.
 *
 * - Par défaut : mémoire du processus (suffisant pour une seule instance).
 * - Si UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN sont définis : Redis via l'API REST d'Upstash
 *   (aucune dépendance, simple fetch). Plusieurs instances partagent alors cache, limites et quotas.
 *   En cas de panne de Redis, on retombe silencieusement sur la mémoire.
 */

export interface KV {
  readonly kind: "memory" | "redis";
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Incrémente et renvoie la nouvelle valeur ; la clé expire après ttlSec (0 = jamais). */
  incr(key: string, ttlSec: number): Promise<number>;
  /** Décrémente (sans descendre sous 0) et renvoie la nouvelle valeur. */
  decr(key: string): Promise<number>;
}

class MemoryKV implements KV {
  readonly kind = "memory" as const;
  private data = new Map<string, { value: string; expiresAt: number }>();
  private maxEntries: number;

  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
    const t = setInterval(() => this.sweep(), 60_000);
    (t as any).unref?.();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.data) if (v.expiresAt && v.expiresAt < now) this.data.delete(k);
  }

  private alive(key: string) {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt < Date.now()) {
      this.data.delete(key);
      return null;
    }
    return e;
  }

  async get(key: string) {
    return this.alive(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSec: number) {
    if (this.data.size >= this.maxEntries) {
      // Éviction simple : la plus ancienne insertion
      const first = this.data.keys().next().value;
      if (first !== undefined) this.data.delete(first);
    }
    this.data.set(key, { value, expiresAt: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
  }

  async incr(key: string, ttlSec: number) {
    const e = this.alive(key);
    const next = (e ? Number(e.value) || 0 : 0) + 1;
    this.data.set(key, { value: String(next), expiresAt: e?.expiresAt || (ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0) });
    return next;
  }

  async decr(key: string) {
    const e = this.alive(key);
    if (!e) return 0;
    const next = Math.max(0, (Number(e.value) || 0) - 1);
    e.value = String(next);
    return next;
  }
}

class UpstashKV implements KV {
  readonly kind = "redis" as const;
  constructor(private url: string, private token: string, private fallback: KV) {}

  private async cmd(args: (string | number)[]): Promise<any> {
    const res = await fetch(this.url.replace(/\/$/, ""), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) throw new Error(`Redis ${res.status}`);
    const data: any = await res.json();
    if (data?.error) throw new Error(String(data.error));
    return data?.result;
  }

  async get(key: string) {
    try {
      const r = await this.cmd(["GET", key]);
      return r == null ? null : String(r);
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string, ttlSec: number) {
    // Upstash refuse les valeurs > 1 Mo : les grosses réponses restent en mémoire locale
    if (value.length > 900_000) return this.fallback.set(key, value, ttlSec);
    try {
      await this.cmd(ttlSec > 0 ? ["SET", key, value, "EX", Math.ceil(ttlSec)] : ["SET", key, value]);
    } catch {
      await this.fallback.set(key, value, ttlSec);
    }
  }

  async incr(key: string, ttlSec: number) {
    try {
      const n = Number(await this.cmd(["INCR", key]));
      if (n === 1 && ttlSec > 0) await this.cmd(["EXPIRE", key, Math.ceil(ttlSec)]);
      return n;
    } catch {
      return this.fallback.incr(key, ttlSec);
    }
  }

  async decr(key: string) {
    try {
      return Number(await this.cmd(["DECR", key]));
    } catch {
      return this.fallback.decr(key);
    }
  }
}

function createKV(): KV {
  const memory = new MemoryKV();
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new UpstashKV(url, token, memory) : memory;
}

let instance: KV | null = null;
export function kv(): KV {
  if (!instance) instance = createKV();
  return instance;
}

/** Tests : repart d'un stockage mémoire vierge. */
export function __resetKvForTests() {
  instance = new MemoryKV();
}

// ---------------------------------------------------------------------------
// Compteurs de quotas des API partenaires
// ---------------------------------------------------------------------------
export type QuotaSource = "laBonneAlternance" | "franceTravail" | "jsearch" | "adzuna" | "jooble" | "gemini";

/** Limites des offres gratuites (indicatives) ; null = pas de plafond mensuel connu. */
export const QUOTA_LIMITS: Record<QuotaSource, { limit: number | null; period: "mois" | "total" }> = {
  laBonneAlternance: { limit: null, period: "mois" },
  franceTravail: { limit: null, period: "mois" },
  jsearch: { limit: Number(process.env.JSEARCH_MONTHLY_QUOTA) || 200, period: "mois" },
  adzuna: { limit: Number(process.env.ADZUNA_MONTHLY_QUOTA) || 2500, period: "mois" },
  jooble: { limit: Number(process.env.JOOBLE_TOTAL_QUOTA) || 500, period: "total" },
  gemini: { limit: null, period: "mois" }
};

const monthKey = () => new Date().toISOString().slice(0, 7);

export async function countApiCall(source: QuotaSource): Promise<void> {
  try {
    const period = QUOTA_LIMITS[source].period;
    const key = period === "total" ? `quota:${source}:total` : `quota:${source}:${monthKey()}`;
    await kv().incr(key, period === "total" ? 0 : 40 * 86400);
  } catch {
    /* compteur indicatif : jamais bloquant */
  }
}

export async function getQuotaUsage(): Promise<Record<QuotaSource, { used: number; limit: number | null; period: string }>> {
  const out = {} as Record<QuotaSource, { used: number; limit: number | null; period: string }>;
  for (const source of Object.keys(QUOTA_LIMITS) as QuotaSource[]) {
    const { limit, period } = QUOTA_LIMITS[source];
    const key = period === "total" ? `quota:${source}:total` : `quota:${source}:${monthKey()}`;
    const used = Number(await kv().get(key)) || 0;
    out[source] = { used, limit, period: period === "total" ? "depuis le début (compté par ce serveur)" : "ce mois-ci" };
  }
  return out;
}

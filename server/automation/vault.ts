/**
 * Coffre des identifiants créés par l'agent sur les sites carrière.
 *
 * Chiffrement AES-256-GCM avec une clé maître (VAULT_KEY, 32 octets en base64), jamais stockée
 * avec les données. Format : "v1:<keyId>:<iv>:<tag>:<données>" (base64url) ; le keyId permet de
 * changer de clé plus tard (rotation, ou passage à Cloud KMS) sans perdre les anciens secrets.
 *
 * Sans VAULT_KEY : clé temporaire en développement (secrets illisibles après redémarrage),
 * coffre désactivé en production.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { AutomationStore } from "./store.ts";
import type { VaultEntry } from "./types.ts";

export interface Cipher {
  readonly keyId: string;
  encrypt(plain: string, context: string): string;
  decrypt(sealed: string, context: string): string;
}

export class AesGcmCipher implements Cipher {
  readonly keyId: string;
  private keys: Map<string, Buffer>;

  /** @param keys clés en base64 ; la première chiffre, toutes peuvent déchiffrer (rotation). */
  constructor(keys: string[]) {
    const decoded = keys.map((k) => Buffer.from(k.trim(), "base64"));
    if (!decoded.length || decoded.some((k) => k.length !== 32)) {
      throw new Error("VAULT_KEY doit contenir 32 octets encodés en base64 (openssl rand -base64 32).");
    }
    this.keys = new Map(decoded.map((k) => [createHash("sha256").update(k).digest("hex").slice(0, 8), k]));
    this.keyId = [...this.keys.keys()][0];
  }

  encrypt(plain: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.keyId)!, iv);
    // Le contexte (utilisateur + site) est authentifié : un secret copié vers un autre compte ne se déchiffre pas
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", this.keyId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
  }

  decrypt(sealed: string, context: string) {
    const [version, keyId, iv, tag, data] = sealed.split(":");
    const key = this.keys.get(keyId);
    if (version !== "v1" || !key) throw new Error("Secret chiffré avec une clé inconnue");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}

/** VAULT_KEY (clé active) et VAULT_KEYS_OLD (anciennes clés, séparées par des virgules). */
export function cipherFromEnv(env = process.env, production = env.NODE_ENV === "production"): Cipher | null {
  const active = env.VAULT_KEY?.trim();
  if (active) return new AesGcmCipher([active, ...String(env.VAULT_KEYS_OLD || "").split(",").filter(Boolean)]);
  if (production) return null;
  console.warn("[Coffre] VAULT_KEY absente : clé temporaire (développement uniquement, secrets perdus au redémarrage).");
  return new AesGcmCipher([randomBytes(32).toString("base64")]);
}

/** Mot de passe fort accepté par la plupart des portails (majuscule, minuscule, chiffre, symbole). */
export function generatePassword(length = 20): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%*-_?"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function normalizeSite(site: string): string {
  const s = String(site || "").trim().toLowerCase();
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, "");
  } catch {
    return s;
  }
}

export class VaultUnavailableError extends Error {
  constructor() {
    super("Coffre indisponible : VAULT_KEY n'est pas configurée sur le serveur.");
  }
}

export class VaultNotFoundError extends Error {
  constructor() {
    super("Identifiant introuvable");
  }
}

export class Vault {
  constructor(private store: AutomationStore, private cipher: Cipher | null) {}

  get enabled() {
    return !!this.cipher;
  }

  private need(): Cipher {
    if (!this.cipher) throw new VaultUnavailableError();
    return this.cipher;
  }

  private context(uid: string, site: string) {
    return `${uid}|${site}`;
  }

  /** Identifiants enregistrés, sans les mots de passe. */
  async list(uid: string) {
    return (await this.store.listVault(uid)).map(({ secret, ...rest }) => rest);
  }

  async find(uid: string, site: string): Promise<VaultEntry | null> {
    const host = normalizeSite(site);
    return (await this.store.listVault(uid)).find((e) => e.site === host) || null;
  }

  async save(uid: string, site: string, username: string, password: string): Promise<Omit<VaultEntry, "secret">> {
    const cipher = this.need();
    const host = normalizeSite(site);
    const existing = await this.find(uid, host);
    const at = new Date().toISOString();
    const entry: VaultEntry = {
      id: existing?.id || randomUUID(),
      site: host,
      username,
      secret: cipher.encrypt(password, this.context(uid, host)),
      createdAt: existing?.createdAt || at,
      updatedAt: at
    };
    await this.store.saveVault(uid, entry);
    const { secret, ...rest } = entry;
    return rest;
  }

  /** Identifiants d'un site ; en crée de nouveaux (mot de passe généré) si absents. */
  async getOrCreate(uid: string, site: string, username: string) {
    const existing = await this.find(uid, site);
    if (existing) return { username: existing.username, password: await this.reveal(uid, existing.id), created: false };
    const password = generatePassword();
    await this.save(uid, site, username, password);
    return { username, password, created: true };
  }

  async reveal(uid: string, id: string): Promise<string> {
    const cipher = this.need();
    const entry = (await this.store.listVault(uid)).find((e) => e.id === id);
    if (!entry) throw new VaultNotFoundError();
    return cipher.decrypt(entry.secret, this.context(uid, entry.site));
  }

  async remove(uid: string, id: string) {
    await this.store.deleteVault(uid, id);
  }
}

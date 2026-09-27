/**
 * Envoi depuis la boîte Gmail de l'utilisateur (OAuth Google, autorisation gmail.send uniquement :
 * l'application peut envoyer, jamais lire la boîte).
 *
 * Parcours : /api/automation/mail/google/connect → consentement Google → /mail/google/callback
 * → jeton de rafraîchissement chiffré (même clé que le coffre) → envoi par l'API Gmail.
 *
 * Variables : GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, APP_URL
 * (URI de redirection à déclarer dans Google Cloud : APP_URL + /api/automation/mail/google/callback).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RetryableError, type MailMessage, type MailSender } from "./channels.ts";
import type { Cipher } from "./vault.ts";
import type { AutomationStore, MailConnection } from "./store.ts";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "openid", "email"];

type HttpFetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Clé de signature du paramètre state (anti-falsification). */
  stateSecret: string;
  authUrl?: string;
  tokenUrl?: string;
  gmailUrl?: string;
  revokeUrl?: string;
  fetch?: HttpFetch;
}

export class MailAuthError extends Error {}

// ---------------------------------------------------------------------------
// Message MIME (RFC 5322) avec pièces jointes
// ---------------------------------------------------------------------------
function encodeHeader(v: string) {
  // En-tête non ASCII : encodé en UTF-8 (RFC 2047)
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function wrap76(b64: string) {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function cleanHeaderValue(v: string) {
  // Aucun retour à la ligne : empêche l'injection d'en-têtes
  return String(v || "").replace(/[\r\n]+/g, " ").trim();
}

export function buildMime(from: string, msg: MailMessage, boundary = `ap_${randomBytes(12).toString("hex")}`): string {
  const headers = [
    `From: ${cleanHeaderValue(from)}`,
    `To: ${cleanHeaderValue(msg.to)}`,
    ...(msg.replyTo ? [`Reply-To: ${cleanHeaderValue(msg.replyTo)}`] : []),
    `Subject: ${encodeHeader(cleanHeaderValue(msg.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];
  const parts = [
    [`--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(msg.text, "utf8").toString("base64"))].join("\r\n"),
    ...msg.attachments.map((a) => {
      const name = cleanHeaderValue(a.filename).replace(/"/g, "");
      return [
        `--${boundary}`,
        `Content-Type: ${cleanHeaderValue(a.contentType)}; name="${encodeHeader(name)}"`,
        `Content-Disposition: attachment; filename="${encodeHeader(name)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrap76(a.contentBase64.replace(/\s+/g, ""))
      ].join("\r\n");
    })
  ];
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
}

// ---------------------------------------------------------------------------
// state signé : relie le retour de Google au compte qui a lancé la connexion
// ---------------------------------------------------------------------------
export function signState(uid: string, secret: string, ttlMs = 10 * 60_000, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: now + ttlMs, n: randomBytes(8).toString("hex") })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string, secret: string, now = Date.now()): string | null {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof data.uid === "string" && Number(data.exp) > now ? data.uid : null;
  } catch {
    return null;
  }
}

/** Email contenu dans le id_token (reçu directement de Google en HTTPS : la signature n'a pas à être revérifiée). */
function emailFromIdToken(idToken: string): string {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

export class GoogleMail {
  private accessTokens = new Map<string, { token: string; expiresAt: number }>();
  private http: HttpFetch;

  constructor(private cfg: GoogleOAuthConfig, private store: AutomationStore, private cipher: Cipher) {
    this.http = cfg.fetch || ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }) as any);
  }

  authorizationUrl(uid: string): string {
    const qs = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPES.join(" "),
      access_type: "offline",
      // Force l'envoi d'un jeton de rafraîchissement, même si l'utilisateur a déjà autorisé l'application
      prompt: "consent",
      include_granted_scopes: "true",
      state: signState(uid, this.cfg.stateSecret)
    });
    return `${this.cfg.authUrl || "https://accounts.google.com/o/oauth2/v2/auth"}?${qs}`;
  }

  /** Retour de Google : échange le code, enregistre le jeton chiffré. Renvoie l'uid et l'adresse connectée. */
  async handleCallback(code: string, state: string): Promise<{ uid: string; email: string }> {
    const uid = verifyState(state, this.cfg.stateSecret);
    if (!uid) throw new MailAuthError("Lien de connexion expiré ou invalide : recommencez depuis l'application.");
    const res = await this.http(this.cfg.tokenUrl || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: this.cfg.redirectUri, grant_type: "authorization_code" }).toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new MailAuthError("Google a refusé la connexion. Réessayez.");
    if (!String(data.scope || "").includes("gmail.send")) throw new MailAuthError("Autorisation d'envoi non accordée : cochez « Envoyer des e-mails » sur l'écran de Google.");
    if (!data.refresh_token) throw new MailAuthError("Google n'a pas fourni d'accès durable : retirez Kareer de votre compte Google puis reconnectez-vous.");
    const email = emailFromIdToken(data.id_token);
    if (!email) throw new MailAuthError("Adresse Gmail introuvable dans la réponse de Google.");

    const at = new Date().toISOString();
    await this.store.saveMailConnection(uid, {
      provider: "google",
      email,
      secret: this.cipher.encrypt(data.refresh_token, `${uid}|mail|google`),
      status: "active",
      connectedAt: at,
      updatedAt: at
    });
    this.accessTokens.set(uid, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 });
    return { uid, email };
  }

  private async accessToken(uid: string, conn: MailConnection): Promise<string> {
    const cached = this.accessTokens.get(uid);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const refresh = this.cipher.decrypt(conn.secret, `${uid}|mail|google`);
    const res = await this.http(this.cfg.tokenUrl || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ refresh_token: refresh, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "refresh_token" }).toString()
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 400 && data.error === "invalid_grant") {
      // Accès retiré par l'utilisateur (ou jeton expiré) : la boîte n'est plus utilisable
      await this.store.saveMailConnection(uid, { ...conn, status: "revoked", updatedAt: new Date().toISOString() });
      throw new MailAuthError("Accès Gmail retiré : reconnectez votre boîte dans l'application.");
    }
    if (!res.ok || !data.access_token) throw new Error(`Jeton Gmail indisponible (${res.status})`);
    this.accessTokens.set(uid, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 });
    return data.access_token;
  }

  /** Boîte d'envoi de l'utilisateur, ou null s'il n'a pas connecté Gmail (ou a retiré l'accès). */
  async senderFor(uid: string): Promise<MailSender | null> {
    const conn = await this.store.getMailConnection(uid, "google");
    if (!conn || conn.status !== "active") return null;
    return {
      kind: "gmail",
      from: conn.email,
      send: async (message) => {
        const token = await this.accessToken(uid, conn);
        const raw = Buffer.from(buildMime(conn.email, message)).toString("base64url");
        const res = await this.http(this.cfg.gmailUrl || "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw })
        });
        if (res.status === 401) this.accessTokens.delete(uid);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const reason = data?.error?.message || `erreur ${res.status}`;
          // Quota ou panne passagère : nouvelle tentative plus tard
          if (res.status === 429 || res.status >= 500 || res.status === 401) throw new RetryableError(`Gmail : ${reason}`);
          throw new Error(`Gmail : ${reason}`);
        }
        return { messageId: String(data.id || "") };
      }
    };
  }

  async disconnect(uid: string) {
    const conn = await this.store.getMailConnection(uid, "google");
    if (!conn) return;
    try {
      const token = this.cipher.decrypt(conn.secret, `${uid}|mail|google`);
      await this.http(`${this.cfg.revokeUrl || "https://oauth2.googleapis.com/revoke"}?token=${encodeURIComponent(token)}`, { method: "POST" });
    } catch {
      /* révocation au mieux : la connexion est supprimée quoi qu'il arrive */
    }
    this.accessTokens.delete(uid);
    await this.store.deleteMailConnection(uid, "google");
  }
}

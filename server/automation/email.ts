/**
 * Envoi d'une candidature par email depuis la boîte du candidat (Gmail ou Outlook, OAuth).
 * - Le destinataire est fourni par le serveur (canal résolu depuis l'offre), jamais par le modèle d'IA.
 * - Les jetons sont stockés chiffrés (AES-256-GCM, clé AUTOMATION_TOKEN_KEY) et renouvelés au besoin.
 * - Preuve conservée : « accepté par le fournisseur » (identifiant du message), distincte d'une réponse du recruteur.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export type MailProvider = "gmail" | "outlook";

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMail {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  attachments: Attachment[];
}

export interface SendResult {
  provider: MailProvider;
  messageId: string | null;
  acceptedAt: string;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

// ---------------------------------------------------------------------------
// Chiffrement des jetons OAuth
// ---------------------------------------------------------------------------
function tokenKey(): Buffer {
  const raw = process.env.AUTOMATION_TOKEN_KEY || "";
  if (!raw) throw new Error("AUTOMATION_TOKEN_KEY manquante : impossible de chiffrer les jetons de messagerie.");
  // Clé de 32 octets dérivée (accepte une clé base64 de 32 octets ou une phrase secrète longue)
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : createHash("sha256").update(raw).digest();
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptToken(sealed: string): string {
  const [v, iv, tag, data] = String(sealed || "").split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Jeton chiffré illisible.");
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Message MIME (RFC 5322 / 2045 / 2047), pièces jointes en base64
// ---------------------------------------------------------------------------
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
const safeHeader = (s: string) => String(s || "").replace(/[\r\n]+/g, " ").trim();

export function isPlausibleEmail(s: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(String(s || ""));
}

export function buildMime(mail: OutgoingMail, boundary = `kareer-${randomBytes(12).toString("hex")}`): string {
  if (!isPlausibleEmail(mail.to) || !isPlausibleEmail(mail.from)) throw new Error("Adresse email invalide.");
  const from = mail.fromName ? `${encodeWord(safeHeader(mail.fromName))} <${mail.from}>` : mail.from;
  const lines = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeWord(safeHeader(mail.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(mail.text, "utf8").toString("base64"))
  ];
  for (const a of mail.attachments) {
    const name = safeHeader(a.filename).replace(/"/g, "");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${encodeWord(name)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${encodeWord(name)}"`,
      "",
      wrap76(a.content.toString("base64"))
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Envoi (Gmail API, Microsoft Graph)
// ---------------------------------------------------------------------------
export const GMAIL_SEND_URL = process.env.GMAIL_API_URL || "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GRAPH_SEND_URL = process.env.GRAPH_API_URL || "https://graph.microsoft.com/v1.0/me/sendMail";

export class MailSendError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean, readonly authExpired = false) {
    super(message);
  }
}

async function failure(provider: MailProvider, res: { status: number; text(): Promise<string> }): Promise<MailSendError> {
  const body = (await res.text().catch(() => "")).slice(0, 300);
  return new MailSendError(`${provider} ${res.status}: ${body}`, res.status, res.status === 429 || res.status >= 500, res.status === 401);
}

export async function sendMail(provider: MailProvider, accessToken: string, mail: OutgoingMail, fetchImpl: FetchLike = fetch as any): Promise<SendResult> {
  if (provider === "gmail") {
    const raw = Buffer.from(buildMime(mail), "utf8").toString("base64url");
    const res = await fetchImpl(GMAIL_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw await failure(provider, res);
    const data = await res.json().catch(() => ({}));
    return { provider, messageId: data?.id || null, acceptedAt: new Date().toISOString() };
  }
  const res = await fetchImpl(GRAPH_SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: mail.subject,
        body: { contentType: "Text", content: mail.text },
        toRecipients: [{ emailAddress: { address: mail.to } }],
        attachments: mail.attachments.map((a) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.filename,
          contentType: a.contentType,
          contentBytes: a.content.toString("base64")
        }))
      },
      saveToSentItems: true
    }),
    signal: AbortSignal.timeout(30_000)
  });
  // Graph répond 202 sans identifiant : preuve = acceptation par le fournisseur (message dans « Éléments envoyés »)
  if (res.status !== 202 && !res.ok) throw await failure(provider, res);
  return { provider, messageId: null, acceptedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Renouvellement des jetons OAuth
// ---------------------------------------------------------------------------
export const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
export const MICROSOFT_TOKEN_URL = process.env.MICROSOFT_TOKEN_URL || "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export async function refreshAccessToken(provider: MailProvider, refreshToken: string, fetchImpl: FetchLike = fetch as any): Promise<{ accessToken: string; expiresAt: string; refreshToken?: string }> {
  const google = provider === "gmail";
  const clientId = google ? process.env.GOOGLE_CLIENT_ID : process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = google ? process.env.GOOGLE_CLIENT_SECRET : process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new MailSendError(`Application OAuth ${google ? "Google" : "Microsoft"} non configurée.`, 500, false);
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken });
  if (!google) body.set("scope", "offline_access https://graph.microsoft.com/Mail.Send");
  const res = await fetchImpl(google ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    // invalid_grant : autorisation révoquée par l'utilisateur → reconnexion nécessaire
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new MailSendError(`Renouvellement refusé (${res.status}) : ${text}`, res.status, res.status >= 500, true);
  }
  const data = await res.json();
  return {
    accessToken: String(data.access_token),
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
    ...(data.refresh_token ? { refreshToken: String(data.refresh_token) } : {})
  };
}

/** Empreinte d'un document (conservée avec la tentative d'envoi). */
export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

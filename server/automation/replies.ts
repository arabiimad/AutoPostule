/**
 * Suivi des réponses des recruteurs (facultatif : autorisation de lecture de la boîte mail).
 * Seuls les messages REÇUS de l'adresse ou du domaine de candidature après l'envoi sont examinés ;
 * leur contenu n'est ni stocké ni transmis à une IA : un classement par mots-clés suffit et reste vérifiable.
 */
import type { MailProvider } from "./email.ts";

export type ReplyKind = "acknowledgement" | "interview" | "rejection" | "other";

export interface InboundMessage {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
}

const RULES: [ReplyKind, RegExp][] = [
  ["rejection", /(malheureusement|ne pas donner suite|pas (pu )?donner (une )?suite|ne correspond(ait)? pas|autre candidat|candidature n'a pas été retenue|pas été retenue|regret|unfortunately|not (be )?moving forward|other candidates)/i],
  ["interview", /(entretien|rencontrer|échange téléphonique|échanger avec vous|disponibilités|rendez-vous|visio|interview|schedule a call|next step)/i],
  ["acknowledgement", /(bien reçu|accusé de réception|avons (bien )?reçu votre candidature|réception de votre candidature|thank you for (your )?appl|we have received|application received)/i]
];

export function classifyReply(m: Pick<InboundMessage, "subject" | "snippet">): ReplyKind {
  const text = `${m.subject} ${m.snippet}`;
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  return "other";
}

const domainOf = (email: string) => String(email || "").toLowerCase().split("@")[1] || "";
/** Domaines de messageries grand public : on n'y rapproche que l'adresse exacte. */
const PUBLIC_DOMAINS = /^(gmail\.com|outlook\.(com|fr)|hotmail\.(com|fr)|yahoo\.(com|fr)|orange\.fr|free\.fr|laposte\.net|live\.(com|fr)|icloud\.com|wanadoo\.fr|sfr\.fr)$/;

/** Le message vient-il du recruteur (adresse exacte, ou même domaine d'entreprise) ? */
export function isFromRecruiter(from: string, destination: string): boolean {
  const addr = (String(from || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] || "").toLowerCase();
  if (!addr) return false;
  if (addr === String(destination || "").toLowerCase()) return true;
  const d = domainOf(destination);
  return !!d && !PUBLIC_DOMAINS.test(d) && (domainOf(addr) === d || domainOf(addr).endsWith(`.${d}`));
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export const GMAIL_LIST_URL = process.env.GMAIL_LIST_URL || "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const GRAPH_INBOX_URL = process.env.GRAPH_INBOX_URL || "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages";

/** Messages reçus d'un expéditeur (adresse ou domaine) depuis une date. */
export async function fetchReplies(provider: MailProvider, token: string, destination: string, since: string, fetchImpl: FetchLike = fetch as any): Promise<InboundMessage[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const d = domainOf(destination);
  const who = PUBLIC_DOMAINS.test(d) ? destination : d;
  if (provider === "gmail") {
    const after = Math.floor(new Date(since).getTime() / 1000);
    const list = await fetchImpl(`${GMAIL_LIST_URL}?maxResults=10&q=${encodeURIComponent(`from:${who} after:${after} -in:sent`)}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!list.ok) throw Object.assign(new Error(`gmail ${list.status}`), { status: list.status });
    const ids: string[] = ((await list.json())?.messages || []).map((m: any) => m.id);
    const out: InboundMessage[] = [];
    for (const id of ids) {
      const r = await fetchImpl(`${GMAIL_LIST_URL}/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const m = await r.json();
      const h = (name: string) => (m.payload?.headers || []).find((x: any) => x.name?.toLowerCase() === name.toLowerCase())?.value || "";
      out.push({ id, from: h("From"), subject: h("Subject"), snippet: String(m.snippet || ""), receivedAt: new Date(Number(m.internalDate) || Date.now()).toISOString() });
    }
    return out;
  }
  const filter = `receivedDateTime ge ${new Date(since).toISOString()}`;
  const r = await fetchImpl(`${GRAPH_INBOX_URL}?$top=25&$select=id,from,subject,bodyPreview,receivedDateTime&$filter=${encodeURIComponent(filter)}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw Object.assign(new Error(`outlook ${r.status}`), { status: r.status });
  const items: any[] = (await r.json())?.value || [];
  return items
    .map((m) => ({ id: m.id, from: m.from?.emailAddress?.address || "", subject: m.subject || "", snippet: m.bodyPreview || "", receivedAt: m.receivedDateTime }))
    .filter((m) => isFromRecruiter(m.from, destination));
}

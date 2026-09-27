/**
 * Envoi par l'API officielle de La bonne alternance : POST /job/v1/apply
 * (documentation : https://api.apprentissage.beta.gouv.fr/api/documentation/json, vérifiée en septembre 2026).
 * La candidature (coordonnées, CV, lettre) est transmise par email au recruteur par La bonne alternance.
 *
 * Clé LBA_API_KEY avec l'habilitation « applications:write » : automatique pour une clé bac à sable
 * (envois vers un environnement de test), sur demande à La bonne alternance pour la production.
 * Limite : 10 appels par minute pour tout le service.
 */

export interface LbaApplyInput {
  recipientId: string;
  fullName: string;
  email: string;
  phone: string;
  cvPdf: Buffer;
  cvFileName: string;
  letter: string;
}

export type LbaResult =
  | { status: "submitted"; id: string | null }
  /** Rien n'est parti (limite, panne signalée) : nouvel essai plus tard. */
  | { status: "retry"; reason: string }
  /** Refus explicite (profil incomplet, offre fermée, droits de la clé) : action du candidat. */
  | { status: "refused"; reason: string }
  /** Pas de réponse : la candidature a pu partir, jamais de nouvel envoi aveugle. */
  | { status: "uncertain"; reason: string };

type Fetch = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function splitName(fullName: string): { first: string; last: string } {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return parts.length < 2 ? { first: parts[0] || "", last: "" } : { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Téléphone au format national (10 chiffres) quand c'est possible. */
export function normalizePhone(phone: string): string {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  if (/^\+33\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^0033\d{9}$/.test(digits)) return `0${digits.slice(4)}`;
  return digits;
}

/** Champs obligatoires manquants dans le profil (message lisible), ou null. */
export function lbaMissingFields(profile: any): string | null {
  const { first, last } = splitName(profile?.fullName);
  const missing = [!first && "prénom", !last && "nom", !String(profile?.email || "").trim() && "email", !normalizePhone(profile?.phone) && "téléphone"].filter(Boolean);
  return missing.length ? `Profil incomplet pour La bonne alternance (${missing.join(", ")}).` : null;
}

export function lbaConfigured(env = process.env): boolean {
  return !!env.LBA_API_KEY && env.LBA_APPLY !== "off";
}

export async function applyViaLba(
  input: LbaApplyInput,
  opts: { apiKey?: string; baseUrl?: string; fetch?: Fetch; timeoutMs?: number } = {}
): Promise<LbaResult> {
  const { first, last } = splitName(input.fullName);
  const body = {
    applicant_first_name: first.slice(0, 50),
    applicant_last_name: last.slice(0, 50),
    applicant_email: input.email.trim(),
    applicant_phone: normalizePhone(input.phone),
    applicant_attachment_name: input.cvFileName,
    applicant_attachment_content: input.cvPdf.toString("base64"),
    applicant_message: input.letter || null,
    recipient_id: input.recipientId
  };
  const base = (opts.baseUrl || process.env.LBA_API_BASE || "https://api.apprentissage.beta.gouv.fr/api").replace(/\/$/, "");
  const doFetch: Fetch = opts.fetch || ((url, init) => fetch(url, init) as any);
  let res;
  try {
    res = await doFetch(`${base}/job/v1/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey ?? process.env.LBA_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000)
    });
  } catch (e: any) {
    // Connexion impossible : rien n'est parti. Délai dépassé : la requête a pu être traitée.
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return timedOut
      ? { status: "uncertain", reason: "La bonne alternance n'a pas répondu à temps." }
      : { status: "retry", reason: `La bonne alternance injoignable : ${String(e?.message || e).slice(0, 120)}` };
  }
  if (res.status === 429) return { status: "retry", reason: "Limite d'envois de La bonne alternance atteinte." };
  if (res.status === 502 || res.status === 503 || res.status === 504) return { status: "uncertain", reason: `La bonne alternance a répondu ${res.status} pendant l'envoi.` };
  if (res.status >= 500) return { status: "retry", reason: `La bonne alternance indisponible (${res.status}).` };
  if (res.status === 401 || res.status === 403) return { status: "refused", reason: "La clé La bonne alternance n'a pas le droit d'envoyer des candidatures (habilitation applications:write)." };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: "refused", reason: `Candidature refusée par La bonne alternance (${res.status}${data?.message ? ` : ${String(data.message).slice(0, 120)}` : ""}).` };
  return { status: "submitted", id: data?.id ? String(data.id) : null };
}

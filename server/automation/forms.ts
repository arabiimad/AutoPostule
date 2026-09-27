/**
 * Envoi par formulaire des logiciels de recrutement (Lever, Greenhouse) : inspect → fill → validate → submit → verify.
 *
 * Règles :
 *  - seuls les champs reconnus sont remplis à partir du profil ; toute question OBLIGATOIRE inconnue doit avoir
 *    une réponse enregistrée par le candidat (personal_answers), sinon → action du candidat (jamais inventée) ;
 *  - CAPTCHA, connexion demandée ou champ obligatoire non rempli → action du candidat ;
 *  - succès seulement si la page de confirmation est détectée ; sinon « résultat incertain » (jamais de renvoi).
 */
import type { Page } from "playwright";

export type FormKind = "lever" | "greenhouse";

export interface FormInput {
  profile: any;
  cvPdf: Buffer;
  cvFileName: string;
  letter: string;
  /** Réponses enregistrées par le candidat, par clé normalisée de question. */
  answers: Record<string, string>;
}

export interface FormField {
  selector: string;
  name: string;
  label: string;
  key: string;
  type: "text" | "email" | "tel" | "textarea" | "file" | "select" | "checkbox" | "radio" | "other";
  required: boolean;
}

export type FormResult =
  | { status: "submitted"; proof: { url: string; confirmationText: string } }
  | { status: "needs_user"; reason: string; questions?: { key: string; label: string }[] }
  | { status: "uncertain"; reason: string }
  | { status: "cancelled"; reason: string };

/** Clé normalisée d'une question (« Êtes-vous disponible immédiatement ? » → « etes-vous-disponible-immediatement »). */
export const questionKey = (label: string) =>
  String(label || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[*?:]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

const CAPTCHA = 'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], .h-captcha, .g-recaptcha, [data-sitekey]';
const CONFIRMATION = /(application (has been )?(submitted|received)|thank(s| you) for (applying|your application)|candidature (a bien été |a été )?(envoyée|reçue|transmise)|merci pour votre candidature)/i;

/** Valeur connue pour un champ, d'après son nom et son libellé (profil uniquement, rien d'inventé). */
function knownValue(field: FormField, p: any): string | null {
  const n = `${field.name} ${field.key}`.toLowerCase();
  const [first, ...rest] = String(p?.fullName || "").trim().split(/\s+/);
  const last = rest.join(" ");
  // Ordre important : « last_name » contient « name », « nom-complet » contient « nom »
  if (/full[_-]?name|nom-complet/.test(n)) return p?.fullName || null;
  if (/first[_-]?name|prenom/.test(n)) return first || null;
  if (/last[_-]?name|(^|[^a-z])nom([^a-z]|$)|surname/.test(n)) return last || null;
  if (/(^|[^a-z])name([^a-z]|$)/.test(n)) return p?.fullName || null;
  if (/e-?mail/.test(n)) return p?.email || null;
  if (/phone|telephone|tel([^a-z]|$)/.test(n)) return p?.phone || null;
  if (/linkedin/.test(n)) return p?.linkedinUrl || null;
  if (/github/.test(n)) return p?.githubUrl || null;
  if (/portfolio|website|site-web|urls\[other\]/.test(n)) return p?.portfolioUrl || null;
  if (/(^|[^a-z])org([^a-z]|$)|current[_-]?company|entreprise-actuelle/.test(n)) {
    const cur = (p?.experiences || []).find((e: any) => e?.current);
    return cur?.company || null;
  }
  if (/location|ville|city/.test(n)) return p?.location || null;
  return null;
}

/** Inspection : champs du formulaire avec libellé, type et caractère obligatoire. */
export async function inspectForm(page: Page): Promise<FormField[]> {
  return page.$$eval("form input, form textarea, form select", (els) => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const el of els as any[]) {
      const type = (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : (el.getAttribute("type") || "text")).toLowerCase();
      if (["hidden", "submit", "button"].includes(type)) continue;
      const name = el.getAttribute("name") || el.id || "";
      if (!name || seen.has(`${name}:${type === "radio" ? "" : el.value}`)) continue;
      seen.add(`${name}:${type === "radio" ? "" : el.value}`);
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const wrap = el.closest("label, .application-question, .field, li, div");
      const labelEl = byFor || wrap?.querySelector("label, .application-label, .text") || wrap;
      const label = (el.getAttribute("aria-label") || labelEl?.textContent || name).replace(/\s+/g, " ").trim().slice(0, 200);
      const required = el.required || el.getAttribute("aria-required") === "true" || /\*|✱/.test(labelEl?.textContent || "");
      out.push({ selector: `[name="${CSS.escape(name)}"]`, name, label, type: ["text", "email", "tel", "textarea", "file", "select", "checkbox", "radio"].includes(type) ? type : type === "url" ? "text" : "other", required });
    }
    return out;
  }).then((fields) => fields.map((f: any) => ({ ...f, key: questionKey(f.label || f.name) })));
}

/** Remplit, valide, soumet et vérifie. La page doit déjà afficher le formulaire de candidature. */
export async function submitApplicationForm(
  page: Page,
  kind: FormKind,
  input: FormInput,
  opts: { confirmTimeoutMs?: number; beforeSubmit?: () => Promise<boolean> } = {}
): Promise<FormResult> {
  if (await page.locator(CAPTCHA).count()) {
    return { status: "needs_user", reason: "Le formulaire demande de prouver que vous n'êtes pas un robot : terminez la candidature vous-même (dossier prêt)." };
  }
  if (await page.locator('input[type="password"]').count()) {
    return { status: "needs_user", reason: "Le site demande de créer un compte ou de se connecter : terminez la candidature vous-même." };
  }
  const fields = await inspectForm(page);
  if (!fields.some((f) => f.type === "file")) return { status: "needs_user", reason: "Formulaire non reconnu (aucun envoi de CV) : terminez la candidature vous-même." };

  const missing: { key: string; label: string }[] = [];
  let cvAttached = false;
  for (const f of fields) {
    const loc = page.locator(f.selector).first();
    if (f.type === "file") {
      const isLetter = /cover|lettre|motivation/i.test(`${f.name} ${f.label}`);
      if (isLetter) {
        await loc.setInputFiles({ name: "Lettre de motivation.txt", mimeType: "text/plain", buffer: Buffer.from(input.letter, "utf8") });
      } else if (!cvAttached) {
        await loc.setInputFiles({ name: input.cvFileName, mimeType: "application/pdf", buffer: input.cvPdf });
        cvAttached = true;
      }
      continue;
    }
    if (f.type === "textarea" && /cover|lettre|motivation|comments|additional/i.test(`${f.name} ${f.label}`)) {
      await loc.fill(input.letter);
      continue;
    }
    const known = knownValue(f, input.profile);
    const answer = input.answers[f.key];
    const value = known ?? answer ?? null;
    if (value === null) {
      if (f.required) missing.push({ key: f.key, label: f.label });
      continue;
    }
    if (f.type === "select") {
      const ok = await loc.selectOption({ label: value }).then(() => true, () => loc.selectOption(value).then(() => true, () => false));
      if (!ok && f.required) missing.push({ key: f.key, label: f.label });
    } else if (f.type === "checkbox") {
      if (/^(oui|yes|true|1)$/i.test(value)) await loc.check();
    } else if (f.type === "radio") {
      const opt = page.locator(`${f.selector}[value="${value.replace(/"/g, '\\"')}"]`);
      if (await opt.count()) await opt.first().check();
      else if (f.required) missing.push({ key: f.key, label: f.label });
    } else if (f.type !== "other") {
      await loc.fill(value);
    } else if (f.required) {
      missing.push({ key: f.key, label: f.label });
    }
  }
  if (!cvAttached) return { status: "needs_user", reason: "Impossible de joindre le CV à ce formulaire : terminez la candidature vous-même." };
  if (missing.length) {
    return {
      status: "needs_user",
      reason: `Question(s) obligatoire(s) sans réponse enregistrée : ${missing.map((m) => `« ${m.label} »`).join(", ")}. Répondez-y une fois : elles serviront aux prochaines candidatures.`,
      questions: missing
    };
  }

  // Validation du navigateur (champs obligatoires, formats) avant tout envoi
  const invalid = await page.$$eval("form input, form textarea, form select", (els) =>
    (els as any[]).filter((e) => typeof e.checkValidity === "function" && !e.checkValidity()).map((e) => e.getAttribute("name") || e.id));
  if (invalid.length) return { status: "needs_user", reason: `Champs refusés par le formulaire (${invalid.slice(0, 3).join(", ")}) : vérifiez votre profil ou terminez vous-même.` };

  // Dernier contrôle (pause, désactivation) juste avant le clic : rien n'est parti jusqu'ici
  if (opts.beforeSubmit && !(await opts.beforeSubmit())) return { status: "cancelled", reason: "Envoi annulé : automatisation en pause ou désactivée." };

  const submit = page.locator(kind === "lever" ? '#btn-submit, button[type="submit"], input[type="submit"]' : '#submit_app, button[type="submit"], input[type="submit"]').first();
  try {
    await Promise.all([page.waitForLoadState("load").catch(() => {}), submit.click()]);
    await page.waitForFunction(
      (src) => new RegExp(src, "i").test(document.body?.innerText || "") || /\/(thanks|confirmation)/.test(location.pathname),
      CONFIRMATION.source,
      { timeout: opts.confirmTimeoutMs ?? 30_000 }
    );
  } catch (e: any) {
    // Soumission partie ou non : impossible de le savoir → jamais de renvoi automatique
    return { status: "uncertain", reason: `Aucune confirmation affichée après l'envoi du formulaire (${String(e?.message || e).slice(0, 80)}).` };
  }
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const confirmation = text.match(CONFIRMATION)?.[0] || "page de confirmation";
  return { status: "submitted", proof: { url: page.url(), confirmationText: confirmation } };
}

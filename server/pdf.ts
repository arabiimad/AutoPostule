/**
 * Moteur de rendu PDF haute fidélité basé sur Playwright Chromium.
 * Génère des documents A4 vectoriels élégants et conformes aux maquettes Connektica.
 */
import { chromium, type Browser } from "playwright";
import { candidateHasSkill } from "../src/utils/skillMatcher.ts";
import type { CvTemplate } from "../src/types.ts";

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      // Chromium déjà installé (même convention que les tests de bout en bout)
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browserInstance;
}

/** Ferme le navigateur partagé (fin des tests, arrêt du serveur). */
export async function closeBrowser(): Promise<void> {
  const b = browserInstance;
  browserInstance = null;
  if (b) await b.close().catch(() => {});
}

export function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const hasItems = (v: any): v is any[] => Array.isArray(v) && v.length > 0;
const clean = (v: any) => (typeof v === "string" ? v.trim() : "");

export function getSectorColor(sector?: string, customColor?: string): { hex: string; lightHex: string } {
  if (customColor && /^#[0-9a-fA-F]{6}$/.test(customColor)) {
    return { hex: customColor, lightHex: customColor + "18" };
  }
  const s = String(sector || "").toLowerCase();
  if (s.includes("finance") || s.includes("banque") || s.includes("assurance")) {
    return { hex: "#1e50a0", lightHex: "#eff6ff" }; // Bleu corporate
  }
  if (s.includes("marketing") || s.includes("design") || s.includes("communication") || s.includes("luxe")) {
    return { hex: "#8c1e3c", lightHex: "#fdf2f8" }; // Bordeaux élégant
  }
  if (s.includes("santé") || s.includes("medical") || s.includes("biotech")) {
    return { hex: "#0f766e", lightHex: "#f0fdfa" }; // Teal médical
  }
  // Vert Connektica par défaut
  return { hex: "#3c963c", lightHex: "#f0fdf4" };
}

export function renderCvHtml(candidate: any, job: any, template: CvTemplate = "article", sector?: string, customColor?: string): string {
  const ownSkills: string[] = hasItems(candidate?.skills) ? candidate.skills : [];
  const requirements: string[] = Array.isArray(job?.skillsRequired) ? job.skillsRequired : [];
  const relevant = (skill: string) => requirements.some((req) => candidateHasSkill([skill], req));

  const name = clean(candidate?.fullName) || "Candidat";
  const title = clean(job?.title) || clean(candidate?.title) || "Professionnel";
  const summary = clean(candidate?.summary);

  const contacts = [candidate?.email, candidate?.phone, candidate?.location].map(clean).filter(Boolean);
  const links = [
    candidate?.linkedinUrl ? { url: candidate.linkedinUrl, label: "LinkedIn" } : null,
    candidate?.githubUrl ? { url: candidate.githubUrl, label: "GitHub" } : null,
    candidate?.portfolioUrl ? { url: candidate.portfolioUrl, label: "Portfolio" } : null
  ].filter(Boolean) as { url: string; label: string }[];

  const experiences: { company: string; role: string; location: string; dates: string; bullets: { bold?: string; text: string }[] }[] = (hasItems(candidate?.experiences) ? candidate.experiences : []).map((exp: any) => ({
    company: clean(exp.company),
    role: clean(exp.title),
    location: clean(exp.location),
    dates: [clean(exp.startDate), clean(exp.endDate) || (exp.current ? "Présent" : "")].filter(Boolean).join(" – "),
    bullets: (Array.isArray(exp.bullets) ? exp.bullets : []).map(clean).filter(Boolean).map((b: string) => {
      const m = b.match(/^([^:]{2,34}) ?: (.+)$/);
      return m ? { bold: m[1].trim(), text: m[2].trim() } : { text: b };
    })
  }));

  const education: { year: string; degree: string; institution: string }[] = (hasItems(candidate?.education) ? candidate.education : []).map((e: any) => ({
    year: clean(e.year),
    degree: clean(e.degree),
    institution: clean(e.institution)
  }));

  const sortedSkills = Array.from(new Set([...ownSkills.filter(relevant), ...ownSkills.filter((s) => !relevant(s))]));
  const languages: string[] = hasItems(candidate?.languages) ? candidate.languages.map(clean).filter(Boolean) : [];

  const detectedSector = sector || job?.domain || job?.companySector;
  const colors = getSectorColor(detectedSector, customColor);

  const isCompact = template === "compact";
  const isModern = template === "moderncv";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>CV — ${escapeHtml(name)}</title>
  <style>
    @page {
      size: A4;
      margin: ${isCompact ? "10mm 12mm" : "14mm 16mm"};
    }
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      background: #ffffff;
      font-size: ${isCompact ? "12px" : "13px"};
      line-height: ${isCompact ? "1.4" : "1.5"};
      -webkit-font-smoothing: antialiased;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cv-container {
      width: 100%;
      max-width: 100%;
      margin: 0 auto;
    }
    /* Header */
    .header {
      padding-bottom: ${isCompact ? "10px" : "14px"};
      margin-bottom: ${isCompact ? "12px" : "16px"};
      border-bottom: 2px solid ${colors.hex};
    }
    .header-main {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    .candidate-name {
      font-size: ${isCompact ? "24px" : "28px"};
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .candidate-title {
      font-size: ${isCompact ? "14px" : "16px"};
      font-weight: 600;
      color: ${colors.hex};
      margin-top: 4px;
    }
    .contact-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-top: 8px;
      font-size: ${isCompact ? "11.5px" : "12px"};
      color: #475569;
    }
    .contact-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .contact-item a {
      color: inherit;
      text-decoration: none;
    }
    /* Sections */
    .section {
      margin-bottom: ${isCompact ? "12px" : "16px"};
    }
    .section-title {
      font-size: ${isCompact ? "13px" : "14px"};
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: ${colors.hex};
      padding-bottom: 4px;
      border-bottom: 1px solid #e2e8f0;
      margin-bottom: ${isCompact ? "8px" : "10px"};
    }
    /* Summary */
    .summary-text {
      color: #334155;
      text-align: justify;
      font-size: ${isCompact ? "12px" : "12.5px"};
      line-height: 1.5;
    }
    /* Experiences */
    .exp-item {
      margin-bottom: ${isCompact ? "10px" : "14px"};
      page-break-inside: avoid;
    }
    .exp-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 2px;
    }
    .exp-role-company {
      font-weight: 700;
      font-size: ${isCompact ? "12.5px" : "13.5px"};
      color: #0f172a;
    }
    .exp-company {
      font-weight: 600;
      color: #334155;
    }
    .exp-meta {
      font-size: 11.5px;
      color: #64748b;
      white-space: nowrap;
      font-weight: 500;
    }
    .exp-bullets {
      list-style-type: none;
      padding-left: 0;
      margin-top: 4px;
    }
    .exp-bullet {
      position: relative;
      padding-left: 14px;
      margin-bottom: 3px;
      color: #334155;
    }
    .exp-bullet::before {
      content: "•";
      position: absolute;
      left: 2px;
      top: -1px;
      color: ${colors.hex};
      font-weight: bold;
    }
    .exp-bullet strong {
      color: #0f172a;
      font-weight: 600;
    }
    /* ModernCV layout adaptation */
    ${isModern ? `
      .exp-item {
        display: grid;
        grid-template-columns: 100px 1fr;
        gap: 16px;
        margin-bottom: 12px;
      }
      .exp-meta {
        text-align: right;
        font-weight: 600;
        color: ${colors.hex};
      }
      .edu-item {
        display: grid;
        grid-template-columns: 100px 1fr;
        gap: 16px;
        margin-bottom: 8px;
      }
      .edu-year {
        text-align: right;
        font-weight: 600;
        color: ${colors.hex};
      }
    ` : ""}
    /* Education */
    .edu-list {
      display: flex;
      flex-direction: column;
      gap: ${isCompact ? "4px" : "6px"};
    }
    .edu-item {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .edu-title {
      font-weight: 600;
      color: #0f172a;
    }
    .edu-school {
      color: #475569;
    }
    .edu-year {
      font-size: 11.5px;
      color: #64748b;
      font-weight: 500;
    }
    /* Skills */
    .skills-container {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .skill-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      color: #1e293b;
    }
    .skill-pill.matched {
      background: ${colors.lightHex};
      border-color: ${colors.hex};
      color: ${colors.hex};
      font-weight: 600;
    }
    /* Languages */
    .languages-line {
      color: #334155;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="cv-container">
    <!-- Header -->
    <header class="header">
      <div class="header-main">
        <div>
          <h1 class="candidate-name">${escapeHtml(name)}</h1>
          <div class="candidate-title">${escapeHtml(title)}</div>
        </div>
      </div>
      <div class="contact-bar">
        ${contacts.map((c) => `<span class="contact-item">${escapeHtml(c)}</span>`).join("<span>·</span>")}
        ${links.map((l) => `<span class="contact-item"><a href="${escapeHtml(l.url)}" target="_blank">${escapeHtml(l.label)}</a></span>`).join("<span>·</span>")}
      </div>
    </header>

    <!-- Summary -->
    ${summary ? `
    <section class="section">
      <h2 class="section-title">Profil</h2>
      <p class="summary-text">${escapeHtml(summary)}</p>
    </section>
    ` : ""}

    <!-- Experiences -->
    ${experiences.length > 0 ? `
    <section class="section">
      <h2 class="section-title">Expériences professionnelles</h2>
      ${experiences.map((exp) => isModern ? `
        <div class="exp-item">
          <div class="exp-meta">${escapeHtml(exp.dates)}</div>
          <div>
            <div class="exp-role-company">${escapeHtml(exp.role)} <span class="exp-company">— ${escapeHtml(exp.company)}</span>${exp.location ? ` <span style="font-weight:normal;color:#64748b;">(${escapeHtml(exp.location)})</span>` : ""}</div>
            ${exp.bullets.length > 0 ? `
              <ul class="exp-bullets">
                ${exp.bullets.map((b) => `<li class="exp-bullet">${b.bold ? `<strong>${escapeHtml(b.bold)} :</strong> ` : ""}${escapeHtml(b.text)}</li>`).join("")}
              </ul>
            ` : ""}
          </div>
        </div>
      ` : `
        <div class="exp-item">
          <div class="exp-header">
            <div class="exp-role-company">${escapeHtml(exp.role)} <span class="exp-company">— ${escapeHtml(exp.company)}</span></div>
            <div class="exp-meta">${escapeHtml(exp.dates)}${exp.location ? ` · ${escapeHtml(exp.location)}` : ""}</div>
          </div>
          ${exp.bullets.length > 0 ? `
            <ul class="exp-bullets">
              ${exp.bullets.map((b) => `<li class="exp-bullet">${b.bold ? `<strong>${escapeHtml(b.bold)} :</strong> ` : ""}${escapeHtml(b.text)}</li>`).join("")}
            </ul>
          ` : ""}
        </div>
      `).join("")}
    </section>
    ` : ""}

    <!-- Formations -->
    ${education.length > 0 ? `
    <section class="section">
      <h2 class="section-title">Formation & Diplômes</h2>
      <div class="edu-list">
        ${education.map((e) => isModern ? `
          <div class="edu-item">
            <div class="edu-year">${escapeHtml(e.year)}</div>
            <div><span class="edu-title">${escapeHtml(e.degree)}</span> — <span class="edu-school">${escapeHtml(e.institution)}</span></div>
          </div>
        ` : `
          <div class="edu-item">
            <div><span class="edu-title">${escapeHtml(e.degree)}</span> — <span class="edu-school">${escapeHtml(e.institution)}</span></div>
            <div class="edu-year">${escapeHtml(e.year)}</div>
          </div>
        `).join("")}
      </div>
    </section>
    ` : ""}

    <!-- Compétences -->
    ${sortedSkills.length > 0 ? `
    <section class="section">
      <h2 class="section-title">Compétences</h2>
      <div class="skills-container">
        ${sortedSkills.map((s) => {
          const isMatched = relevant(s);
          return `<span class="skill-pill ${isMatched ? "matched" : ""}">${escapeHtml(s)}</span>`;
        }).join("")}
      </div>
    </section>
    ` : ""}

    <!-- Langues -->
    ${languages.length > 0 ? `
    <section class="section">
      <h2 class="section-title">Langues</h2>
      <div class="languages-line">
        ${languages.map(escapeHtml).join(" · ")}
      </div>
    </section>
    ` : ""}
  </div>
</body>
</html>`;
}

/**
 * Génère un Buffer PDF A4 à partir du code HTML fourni.
 */
export async function generatePdfFromHtml(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    // Donnez un bref instant pour le calcul de mise en page
    await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

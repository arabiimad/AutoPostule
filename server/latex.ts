/**
 * Génération LaTeX (modèles de CV) et compilation PDF locale.
 * Tous les modèles n'utilisent QUE les données du profil : une section vide est omise.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { candidateHasSkill } from "../src/utils/skillMatcher.ts";
import type { CvTemplate } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Échappement
// ---------------------------------------------------------------------------
const LATEX_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "%": "\\%",
  "$": "\\$",
  "&": "\\&",
  "_": "\\_",
  "#": "\\#",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}"
};

/** Échappement en une seule passe (évite de ré-échapper les accolades de \textbackslash{}). */
export function escapeLatex(str: string): string {
  if (!str) return "";
  return String(str).replace(/[\\%$&_#{}~^]/g, (c) => LATEX_ESCAPES[c]);
}

/** URL utilisable dans \href{} : % et # échappés, caractères cassants retirés. */
export function escapeLatexUrl(url: string): string {
  return String(url || "").replace(/[{}\\\s]/g, "").replace(/[%#]/g, (c) => "\\" + c);
}

const hasItems = (v: any): v is any[] => Array.isArray(v) && v.length > 0;
const clean = (v: any) => (typeof v === "string" ? v.trim() : "");

export const TEMPLATES: { id: CvTemplate; label: string; description: string }[] = [
  { id: "article", label: "Classique", description: "Sobre, titres soulignés, une colonne (classe article)." },
  { id: "moderncv", label: "Moderne", description: "Classe moderncv : dates en marge, couleurs, très lisible." },
  { id: "compact", label: "Compact", description: "Une page dense, marges réduites, idéal pour les profils riches." }
];

export function normalizeTemplate(t: any): CvTemplate {
  return t === "moderncv" || t === "compact" ? t : "article";
}

// Préambule robuste : n'échoue pas si lmodern ou le français de babel ne sont pas installés
const SAFE_FONTS = `\\IfFileExists{lmodern.sty}{\\usepackage{lmodern}}{}
\\IfFileExists{french.ldf}{\\usepackage[french]{babel}}{}`;

interface CvData {
  name: string;
  title: string;
  contacts: string[];
  links: { url: string; label: string }[];
  summary: string;
  experiences: { head: string; company: string; role: string; location: string; dates: string; bullets: { bold?: string; text: string }[] }[];
  education: { year: string; degree: string; institution: string }[];
  skills: string[];
  languages: string[];
}

function buildData(candidate: any, job: any, tailored = false): CvData {
  const ownSkills: string[] = hasItems(candidate?.skills) ? candidate.skills.map(clean).filter(Boolean) : [];
  const requirements: string[] = Array.isArray(job?.skillsRequired) ? job.skillsRequired : [];
  // Une compétence du profil est « pertinente » si elle couvre une exigence de l'offre.
  // Seuls les libellés du profil sont affichés : jamais ceux de l'offre (« Photoshop et Illustrator »).
  const relevant = (skill: string) => requirements.some((req) => candidateHasSkill([skill], req));
  return {
    name: escapeLatex(clean(candidate?.fullName)),
    // Contenu adapté : titre choisi pour ce CV ; sinon intitulé de l'offre (sans le préfixe des candidatures spontanées)
    title: escapeLatex(tailored
      ? clean(candidate?.title)
      : clean(String(job?.title || "").replace(/^Candidature spontanée — /, "")) || clean(candidate?.title)),
    contacts: [candidate?.email, candidate?.phone, candidate?.location].map(clean).filter(Boolean).map(escapeLatex),
    links: [candidate?.linkedinUrl, candidate?.githubUrl, candidate?.portfolioUrl]
      .map(clean)
      .filter((v) => /^https?:\/\//i.test(v))
      .map((v) => ({ url: escapeLatexUrl(v), label: escapeLatex(v.replace(/^https?:\/\/(www\.)?/, "")) })),
    summary: escapeLatex(clean(candidate?.summary)),
    experiences: (hasItems(candidate?.experiences) ? candidate.experiences : []).map((exp: any) => ({
      company: escapeLatex(clean(exp.company)),
      role: escapeLatex(clean(exp.title)),
      head: [exp.company, exp.title].map(clean).filter(Boolean).map(escapeLatex).join(" | "),
      location: escapeLatex(clean(exp.location)),
      dates: [clean(exp.startDate), clean(exp.endDate) || (exp.current ? "Présent" : "")].filter(Boolean).map(escapeLatex).join(" -- "),
      bullets: (Array.isArray(exp.bullets) ? exp.bullets : []).map(clean).filter(Boolean).map((b: string) => {
        // Préfixe court « Planification : … » mis en gras (deux-points suivi d'un espace)
        const m = b.match(/^([^:]{2,34}) ?: (.+)$/);
        return m ? { bold: escapeLatex(m[1].trim()), text: escapeLatex(m[2].trim()) } : { text: escapeLatex(b) };
      })
    })),
    education: (hasItems(candidate?.education) ? candidate.education : []).map((e: any) => ({
      year: escapeLatex(clean(e.year)),
      degree: escapeLatex(clean(e.degree)),
      institution: escapeLatex(clean(e.institution))
    })),
    // Compétences demandées par l'offre ET possédées d'abord, puis le reste du profil
    skills: (tailored ? ownSkills : Array.from(new Set([...ownSkills.filter(relevant), ...ownSkills.filter((s) => !relevant(s))]))).map(escapeLatex),
    languages: (hasItems(candidate?.languages) ? candidate.languages : []).map(clean).filter(Boolean).map(escapeLatex)
  };
}

const bulletLine = (b: { bold?: string; text: string }) => (b.bold ? `\\textbf{${b.bold} :} ${b.text}` : b.text);

// ---------------------------------------------------------------------------
// Modèle « Classique » (article)
// ---------------------------------------------------------------------------
function renderArticle(d: CvData, compact = false): string {
  const margin = compact ? "1.1cm" : "1.5cm";
  const size = compact ? "10pt" : "11pt";
  const itemSep = compact ? "[leftmargin=*,noitemsep,topsep=1pt]" : "[leftmargin=*,noitemsep]";

  const exp = d.experiences.map((e) => {
    const bullets = e.bullets.length ? `\\begin{itemize}${itemSep}\n${e.bullets.map((b) => `    \\item ${bulletLine(b)}`).join("\n")}\n\\end{itemize}` : "";
    return `\\noindent\\textbf{${e.head}}${e.dates ? ` \\hfill \\textit{${e.dates}}` : ""}${e.location ? ` \\\\\n\\textit{${e.location}}` : ""}\n${bullets}\n\\vspace{${compact ? "0.1" : "0.2"}cm}`;
  }).join("\n\n");

  const edu = d.education.map((e) => `    \\item ${e.year ? `\\textbf{${e.year} :} ` : ""}${e.degree}${e.institution ? ` -- \\textit{${e.institution}}` : ""}`).join("\n");

  const sections: string[] = [];
  if (d.summary) sections.push(`\\section*{PROFIL}\n${d.summary}`);
  if (exp) sections.push(`\\section*{EXPÉRIENCES PROFESSIONNELLES}\n${exp}`);
  if (d.skills.length) sections.push(`\\section*{COMPÉTENCES}\n${d.skills.join(" \\textbullet{} ")}`);
  if (edu) sections.push(`\\section*{FORMATIONS}\n\\begin{itemize}${itemSep}\n${edu}\n\\end{itemize}`);
  if (d.languages.length) sections.push(`\\section*{LANGUES}\n${d.languages.join(" \\hfill ")}`);

  const color = compact ? "{RGB}{40, 40, 40}" : "{RGB}{30, 80, 160}";
  return `\\documentclass[${size},a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
${SAFE_FONTS}
\\usepackage[left=${margin}, right=${margin}, top=${margin}, bottom=${margin}]{geometry}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{titlesec}
\\usepackage{xcolor}

\\definecolor{primary}${color}
\\titleformat{\\section}{\\${compact ? "large" : "Large"}\\bfseries\\color{primary}}{}{0em}{}[\\titlerule]
\\titlespacing*{\\section}{0pt}{${compact ? "1ex" : "1.5ex plus 1ex minus .2ex"}}{${compact ? "0.5ex" : "1ex plus .2ex"}}
\\setlength{\\parindent}{0pt}

\\begin{document}
\\pagestyle{empty}

\\begin{center}
    {\\${compact ? "LARGE" : "Huge"} \\textbf{${d.name}}} \\\\ \\vspace{0.15cm}
${d.title ? `    {\\large \\textbf{${d.title}}} \\\\ \\vspace{0.15cm}\n` : ""}${d.contacts.length ? `    ${d.contacts.join(" | ")} \\\\\n` : ""}${d.links.length ? `    ${d.links.map((l) => `\\href{${l.url}}{${l.label}}`).join(" | ")}\n` : ""}\\end{center}

${sections.join("\n\n")}

\\end{document}
`;
}

// ---------------------------------------------------------------------------
// Modèle « Moderne » (moderncv — disponible sur Overleaf et dans TeX Live / MiKTeX)
// ---------------------------------------------------------------------------
function renderModernCv(d: CvData): string {
  const parts = d.name.split(/\s+/);
  const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : d.name;
  const last = parts.length > 1 ? parts[parts.length - 1] : "";

  const contactLines: string[] = [];
  // moderncv attend des commandes dédiées ; on n'utilise que ce qui est renseigné
  const raw = d.contacts;
  const email = raw.find((c) => c.includes("@"));
  const phone = raw.find((c) => /\d{2}/.test(c) && !c.includes("@"));
  const address = raw.find((c) => c !== email && c !== phone);
  if (email) contactLines.push(`\\email{${email}}`);
  if (phone) contactLines.push(`\\phone[mobile]{${phone}}`);
  if (address) contactLines.push(`\\address{${address}}{}{}`);
  for (const l of d.links) contactLines.push(`\\homepage{${l.label}}`);

  const exp = d.experiences.map((e) => {
    const desc = e.bullets.length ? `\\begin{itemize}\n${e.bullets.map((b) => `  \\item ${bulletLine(b)}`).join("\n")}\n\\end{itemize}` : "";
    return `\\cventry{${e.dates}}{${e.role}}{${e.company}}{${e.location}}{}{${desc}}`;
  }).join("\n");
  const edu = d.education.map((e) => `\\cventry{${e.year}}{${e.degree}}{${e.institution}}{}{}{}`).join("\n");

  const sections: string[] = [];
  if (exp) sections.push(`\\section{Expériences professionnelles}\n${exp}`);
  if (d.skills.length) sections.push(`\\section{Compétences}\n\\cvitem{}{${d.skills.join(", ")}}`);
  if (edu) sections.push(`\\section{Formations}\n${edu}`);
  if (d.languages.length) sections.push(`\\section{Langues}\n${d.languages.map((l) => `\\cvitem{}{${l}}`).join("\n")}`);

  return `\\documentclass[11pt,a4paper,sans]{moderncv}
\\moderncvstyle{classic}
\\moderncvcolor{blue}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\IfFileExists{french.ldf}{\\usepackage[french]{babel}}{}
\\usepackage[scale=0.8]{geometry}

\\name{${first}}{${last}}
${d.title ? `\\title{${d.title}}\n` : ""}${contactLines.join("\n")}

\\begin{document}
\\makecvtitle
${d.summary ? `\\section{Profil}\n\\cvitem{}{${d.summary}}\n` : ""}
${sections.join("\n\n")}

\\end{document}
`;
}

/** CV généré sans IA, uniquement à partir du profil. */
export function generateFallbackLatex(candidate: any, job: any, template: CvTemplate = "article", options: { tailored?: boolean } = {}): string {
  const data = buildData(candidate, job, !!options.tailored);
  if (template === "moderncv") return renderModernCv(data);
  if (template === "compact") return renderArticle(data, true);
  return renderArticle(data);
}

/** Consignes de mise en page transmises à l'IA selon le modèle choisi. */
export function templateInstructions(template: CvTemplate): string {
  if (template === "moderncv") {
    return `Utilise la classe moderncv : \\documentclass[11pt,a4paper,sans]{moderncv}, \\moderncvstyle{classic}, \\moderncvcolor{blue}, \\name{Prénom}{Nom}, \\makecvtitle, des \\cventry{dates}{poste}{entreprise}{lieu}{}{description} pour les expériences et formations, \\cvitem pour les compétences et langues.`;
  }
  if (template === "compact") {
    return `Utilise la classe article en 10pt, marges de 1,1 cm (geometry), sections \\section* avec titlesec en \\large, listes enumitem [noitemsep,topsep=1pt] : le CV doit tenir sur UNE page.`;
  }
  return `Utilise la classe article en 11pt, marges 1,5 cm, titlesec (\\titleformat{\\section}{\\Large\\bfseries\\color{primary}}{}{0em}{}[\\titlerule]), enumitem, hyperref, xcolor avec \\definecolor{primary}{RGB}{30, 80, 160}.`;
}

// ---------------------------------------------------------------------------
// Compilation PDF locale (optionnelle)
// ---------------------------------------------------------------------------
let compilerProbe: Promise<{ cmd: string; kind: "tectonic" | "pdflatex" } | null> | null = null;

function which(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, ["--version"], { stdio: "ignore", shell: false });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

export function detectLatexCompiler() {
  compilerProbe ||= (async () => {
    const forced = process.env.LATEX_COMPILER;
    if (forced === "off") return null;
    if (forced) {
      return (await which(forced)) ? { cmd: forced, kind: /tectonic/i.test(forced) ? ("tectonic" as const) : ("pdflatex" as const) } : null;
    }
    if (await which("tectonic")) return { cmd: "tectonic", kind: "tectonic" as const };
    if (await which("pdflatex")) return { cmd: "pdflatex", kind: "pdflatex" as const };
    return null;
  })();
  return compilerProbe;
}

const MAX_TEX_BYTES = 200_000;

/** Commandes LaTeX refusées : lecture/écriture de fichiers et exécution de commandes. */
const FORBIDDEN = /\\(write18|immediate\\write|openout|openin|read\s*\d|input\s*\{?\s*\/|include\s*\{?\s*\/|directlua|catcode)/i;

export async function compileLatex(tex: string): Promise<{ pdf?: Buffer; error?: string; log?: string }> {
  const compiler = await detectLatexCompiler();
  if (!compiler) return { error: "NO_COMPILER" };
  if (!tex || Buffer.byteLength(tex, "utf8") > MAX_TEX_BYTES) return { error: "Document vide ou trop volumineux." };
  if (FORBIDDEN.test(tex)) return { error: "Le document contient des commandes non autorisées (accès fichiers / shell)." };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-"));
  const texPath = path.join(dir, "cv.tex");
  fs.writeFileSync(texPath, tex, "utf8");

  // Chemins relatifs : en mode « paranoïaque » (openin_any=p), TeX refuse les chemins absolus
  const args = compiler.kind === "tectonic"
    ? ["--outdir", ".", "--untrusted", "cv.tex"]
    : ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "cv.tex"];

  const run = () => new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    const p = spawn(compiler.cmd, args, { cwd: dir, env: { ...process.env, openin_any: "p", openout_any: "p" } });
    const timer = setTimeout(() => p.kill("SIGKILL"), 45_000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
    p.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });

  try {
    let r = await run();
    // pdflatex : deuxième passe pour les références (sans effet si inutile)
    if (compiler.kind === "pdflatex" && r.code === 0) r = await run();
    const pdfPath = path.join(dir, "cv.pdf");
    if (r.code === 0 && fs.existsSync(pdfPath)) {
      return { pdf: fs.readFileSync(pdfPath) };
    }
    const firstError = r.out.split("\n").find((l) => l.startsWith("!")) || "Erreur de compilation.";
    return { error: firstError.slice(0, 300), log: r.out.slice(-4000) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

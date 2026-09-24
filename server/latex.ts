/**
 * Génération LaTeX (modèles de CV) et compilation PDF locale.
 * Tous les modèles n'utilisent QUE les données du profil : une section vide est omise.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { candidateHasSkill } from "../src/utils/skillMatcher.ts";
import { normalizeCvTemplate } from "../src/utils/templates.ts";
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
  { id: "article", label: "Classique", description: "Sobre, titres soulignés, une colonne, sans photo." },
  { id: "photo", label: "Photo", description: "Épuré avec photo en haut à droite, dates alignées à droite." },
  { id: "creatif", label: "Créatif", description: "Bandeau de couleur, pastilles de compétences, photo ronde facultative ; une colonne lisible par les logiciels de recrutement." },
  { id: "moderncv", label: "Moderne", description: "Classe moderncv : dates en marge, couleurs, très lisible." },
  { id: "compact", label: "Compact", description: "Une page dense, marges réduites, idéal pour les profils riches." }
];

export function normalizeTemplate(t: any): CvTemplate {
  return normalizeCvTemplate(t);
}

// Préambule robuste : n'échoue pas si lmodern ou le français de babel ne sont pas installés
const SAFE_FRENCH = `\\IfFileExists{french.ldf}{\\usepackage[french]{babel}}{}`;
const SAFE_FONTS = `\\IfFileExists{lmodern.sty}{\\usepackage{lmodern}}{}
${SAFE_FRENCH}`;
/** Police sans empattement du modèle Créatif (Lato si installée). */
const SANS_FONTS = `\\IfFileExists{lato.sty}{\\usepackage[default]{lato}}{\\renewcommand{\\familydefault}{\\sfdefault}}
${SAFE_FRENCH}`;
/**
 * Texte du PDF extractible tel quel par les logiciels de tri des candidatures :
 * correspondance Unicode des glyphes (pdfLaTeX) et ligatures désactivées (« fi » reste « f » + « i »).
 */
const ATS_TEXT = `\\ifdefined\\pdfgentounicode\\input{glyphtounicode}\\pdfgentounicode=1\\fi
\\IfFileExists{microtype.sty}{\\usepackage[expansion=false]{microtype}\\DisableLigatures[f]{encoding = *, family = *}}{}`;
/** Nom du fichier photo attendu à côté du .tex (écrit par compileLatex, ou ajouté à la main dans Overleaf). */
export const PHOTO_FILE = "photo.jpg";

interface CvData {
  name: string;
  title: string;
  contacts: string[];
  email: string;
  phone: string;
  location: string;
  links: { url: string; label: string }[];
  hasPhoto: boolean;
  summary: string;
  experiences: { head: string; company: string; role: string; location: string; dates: string; bullets: { bold?: string; text: string }[] }[];
  education: { year: string; degree: string; institution: string }[];
  projects: { name: string; description: string; tech: string[] }[];
  skills: string[];
  languages: string[];
}

/**
 * Profil sans l'image de la photo, remplacée par l'indicateur `hasPhoto` :
 * la photo ne sert qu'à la mise en page, elle n'est jamais envoyée à l'IA ni journalisée.
 */
export function withoutPhoto<T>(candidate: T): T {
  if (!candidate || typeof candidate !== "object" || !("photo" in (candidate as any))) return candidate;
  const { photo, ...rest } = candidate as any;
  return { ...rest, hasPhoto: rest.hasPhoto === true || (typeof photo === "string" && photo.startsWith("data:image/")) } as T;
}

/** Le profil a-t-il une photo ? (le serveur ne reçoit que l'indicateur `hasPhoto`, jamais l'image pour l'IA) */
function profileHasPhoto(candidate: any): boolean {
  return candidate?.hasPhoto === true || (typeof candidate?.photo === "string" && candidate.photo.startsWith("data:image/"));
}

function buildData(candidate: any, job: any, tailored = false): CvData {
  const ownSkills: string[] = (hasItems(candidate?.skills) ? candidate.skills : []).map(clean).filter(Boolean);
  // Compétences du profil utiles pour l'offre d'abord, TOUJOURS avec le libellé du profil
  // (jamais celui de l'offre : « Photoshop et Illustrator » ne doit pas apparaître si seul Photoshop est acquis)
  const required: string[] = Array.isArray(job?.skillsRequired) ? job.skillsRequired.filter(Boolean) : [];
  const relevant = ownSkills.filter((s) => required.some((r) => candidateHasSkill([s], r)));
  const email = escapeLatex(clean(candidate?.email));
  const phone = escapeLatex(clean(candidate?.phone));
  const location = escapeLatex(clean(candidate?.location));
  return {
    name: escapeLatex(clean(candidate?.fullName)),
    // Contenu adapté : titre choisi pour ce CV ; sinon intitulé de l'offre (sans le préfixe des candidatures spontanées)
    title: escapeLatex(tailored
      ? clean(candidate?.title)
      : clean(String(job?.title || "").replace(/^Candidature spontanée — /, "")) || clean(candidate?.title)),
    contacts: [email, phone, location].filter(Boolean),
    email,
    phone,
    location,
    links: [candidate?.linkedinUrl, candidate?.githubUrl, candidate?.portfolioUrl]
      .map(clean)
      .filter((v) => /^https?:\/\//i.test(v))
      .map((v) => ({ url: escapeLatexUrl(v), label: escapeLatex(v.replace(/^https?:\/\/(www\.)?/, "")) })),
    hasPhoto: profileHasPhoto(candidate),
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
    projects: (hasItems(candidate?.projects) ? candidate.projects : [])
      .filter((p: any) => clean(p?.name))
      .map((p: any) => ({
        name: escapeLatex(clean(p.name)),
        description: escapeLatex(clean(p.description)),
        tech: (Array.isArray(p.technologies) ? p.technologies : []).map(clean).filter(Boolean).map(escapeLatex)
      })),
    skills: (tailored ? ownSkills : Array.from(new Set([...relevant, ...ownSkills]))).map(escapeLatex),
    languages: (hasItems(candidate?.languages) ? candidate.languages : []).map(clean).filter(Boolean).map(escapeLatex)
  };
}

const contactLine = (d: CvData, sep: string) => [d.email, d.phone, d.location].filter(Boolean).join(sep);
const linkLine = (d: CvData, sep: string) => d.links.map((l) => `\\href{${l.url}}{${l.label}}`).join(sep);
const projectTech = (p: CvData["projects"][number]) => (p.tech.length ? p.tech.join(", ") : "");
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
  if (d.projects.length) {
    const projects = d.projects.map((p) => `    \\item \\textbf{${p.name}}${projectTech(p) ? ` (${projectTech(p)})` : ""}${p.description ? ` : ${p.description}` : ""}`).join("\n");
    sections.push(`\\section*{PROJETS}\n\\begin{itemize}${itemSep}\n${projects}\n\\end{itemize}`);
  }
  if (d.languages.length) sections.push(`\\section*{LANGUES}\n${d.languages.join(" \\hfill ")}`);

  const color = compact ? "{RGB}{40, 40, 40}" : "{RGB}{30, 70, 100}";
  return `\\documentclass[${size},a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
${SAFE_FONTS}
\\usepackage[left=${margin}, right=${margin}, top=${margin}, bottom=${margin}]{geometry}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{titlesec}
\\usepackage{xcolor}
${ATS_TEXT}

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


// ---------------------------------------------------------------------------
// Modèle « Photo » : épuré, photo en haut à droite, dates alignées à droite
// ---------------------------------------------------------------------------
function renderPhoto(d: CvData): string {
  const bullets = (items: { bold?: string; text: string }[]) =>
    items.length ? `\n\\begin{itemize}[leftmargin=1.4em,itemsep=0pt,topsep=1pt,parsep=0pt,label=\\textbullet]\n${items.map((b) => `  \\item \\small ${bulletLine(b)}`).join("\n")}\n\\end{itemize}` : "";

  const exp = d.experiences.map((e) =>
    `\\cvEntry{${e.company || e.role}}{${e.location}}{${e.company ? e.role : ""}}{${e.dates}}${bullets(e.bullets)}`
  ).join("\n\\vspace{3pt}\n");
  const edu = d.education.map((e) =>
    e.institution ? `\\cvEntry{${e.institution}}{}{${e.degree}}{${e.year}}` : `\\cvEntry{${e.degree}}{${e.year}}{}{}`
  ).join("\n");
  const projects = d.projects.map((p) =>
    `\\noindent\\textbf{${p.name}}${projectTech(p) ? ` $|$ \\emph{\\small ${projectTech(p)}}` : ""}${p.description ? `\\\\\n{\\small ${p.description}}` : ""}\\par`
  ).join("\n\\vspace{3pt}\n");

  const sections: string[] = [];
  if (d.summary) sections.push(`\\section*{Profil}\n{\\small ${d.summary}}`);
  if (exp) sections.push(`\\section*{Expériences professionnelles}\n${exp}`);
  if (edu) sections.push(`\\section*{Formations}\n${edu}`);
  if (projects) sections.push(`\\section*{Projets}\n${projects}`);
  if (d.skills.length) sections.push(`\\section*{Compétences}\n{\\small ${d.skills.join(", ")}}`);
  if (d.languages.length) sections.push(`\\section*{Langues}\n{\\small ${d.languages.join(" \\quad\\textbullet\\quad ")}}`);

  const head = [
    `{\\LARGE \\textsc{${d.name}}}`,
    d.title ? `{\\large ${d.title}}` : "",
    contactLine(d, " \\quad ") ? `\\small ${contactLine(d, " \\quad ")}` : "",
    d.links.length ? `\\small ${linkLine(d, " \\quad ")}` : ""
  ].filter(Boolean).join("\\\\[3pt]\n");
  const photo = d.hasPhoto
    ? `\\hfill\n\\begin{minipage}[c]{0.2\\textwidth}\n\\raggedleft\\IfFileExists{${PHOTO_FILE}}{\\includegraphics[width=\\linewidth]{${PHOTO_FILE}}}{}\n\\end{minipage}`
    : "";

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
${SAFE_FONTS}
\\usepackage[top=1.1cm, bottom=1.1cm, left=1.5cm, right=1.5cm]{geometry}
\\usepackage{titlesec}
\\usepackage{enumitem}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage[hidelinks]{hyperref}
${ATS_TEXT}

\\definecolor{primary}{RGB}{0, 74, 84}
\\titleformat{\\section}{\\scshape\\raggedright\\large\\color{primary}}{}{0em}{}[\\color{primary}\\titlerule]
\\titlespacing*{\\section}{0pt}{8pt}{4pt}
\\setlength{\\parindent}{0pt}
\\newcommand{\\cvEntry}[4]{%
  \\begin{tabular*}{\\textwidth}{@{}l@{\\extracolsep{\\fill}}r@{}}
    \\textbf{\\color{primary}#1} & #2 \\\\
    \\textit{\\small #3} & \\textit{\\small #4} \\\\
  \\end{tabular*}\\par}

\\begin{document}
\\pagestyle{empty}

\\noindent
\\begin{minipage}[c]{${d.hasPhoto ? "0.76" : "1"}\\textwidth}
${head}
\\end{minipage}
${photo}

${sections.join("\n\n")}

\\end{document}
`;
}

// ---------------------------------------------------------------------------
// Modèle « Créatif » : bandeau de couleur, pastilles, photo ronde facultative.
// Une seule colonne et du vrai texte : lisible par les logiciels de tri des candidatures.
// ---------------------------------------------------------------------------
const CREATIF_COLORS = `\\definecolor{primary}{RGB}{43, 45, 110}
\\definecolor{accent}{RGB}{255, 111, 97}
\\definecolor{soft}{RGB}{234, 235, 250}
\\definecolor{muted}{RGB}{96, 100, 122}
\\definecolor{headsub}{RGB}{255, 196, 187}`;

function renderCreatif(d: CvData): string {
  const bullets = (items: { bold?: string; text: string }[]) =>
    items.length ? `\n\\begin{itemize}\n${items.map((b) => `  \\item ${bulletLine(b)}`).join("\n")}\n\\end{itemize}` : "";
  const entry = (heading: string, dates: string, sub: string, place: string) =>
    `{\\bfseries\\color{primary}${heading}}${dates ? `\\hfill{\\small\\color{muted}${dates}}` : ""}` +
    (sub || place ? `\\\\\n{\\color{accent}\\bfseries ${sub}}${place ? `${sub ? "\\enspace" : ""}{\\small\\color{muted}${sub ? "\\textbar\\enspace " : ""}${place}}` : ""}` : "");

  const exp = d.experiences.map((e) =>
    `${entry(e.role || e.company, e.dates, e.role ? e.company : "", e.location)}${bullets(e.bullets)}\\par`
  ).join("\n\\vspace{5pt}\n");
  const edu = d.education.map((e) => `${entry(e.degree, e.year, e.institution, "")}\\par`).join("\n\\vspace{3pt}\n");
  const projects = d.projects.map((p) =>
    `{\\bfseries\\color{primary}${p.name}}${projectTech(p) ? `\\enspace{\\small\\color{muted}\\textbar\\enspace ${projectTech(p)}}` : ""}${p.description ? `\\\\\n${p.description}` : ""}\\par`
  ).join("\n\\vspace{3pt}\n");
  const chips = (items: string[]) =>
    `{\\raggedright\\setlength{\\fboxsep}{3pt}\\setlength{\\lineskiplimit}{3pt}\\setlength{\\lineskip}{5pt}\n${items.map((s) => `\\chip{${s}}`).join(" \n")}\\par}`;

  const sections: string[] = [];
  if (d.summary) sections.push(`\\section*{Profil}\n${d.summary}`);
  if (exp) sections.push(`\\section*{Expériences}\n${exp}`);
  if (d.skills.length) sections.push(`\\section*{Compétences}\n${chips(d.skills)}`);
  if (edu) sections.push(`\\section*{Formations}\n${edu}`);
  if (projects) sections.push(`\\section*{Projets}\n${projects}`);
  if (d.languages.length) sections.push(`\\section*{Langues}\n${d.languages.join(" {\\color{accent}\\textbullet} ")}`);

  const center = "[xshift=-3cm,yshift=-2.15cm]current page.north east";
  const photo = d.hasPhoto
    ? `\\IfFileExists{${PHOTO_FILE}}{%
    \\begin{scope}
      \\clip (${center}) circle (1.45cm);
      \\node at (${center}) {\\includegraphics[width=2.9cm,height=2.9cm]{${PHOTO_FILE}}};
    \\end{scope}
    \\draw[white, line width=2.5pt] (${center}) circle (1.45cm);}{}`
    : "";
  const head = [
    `{\\color{white}\\fontsize{26}{30}\\selectfont\\bfseries ${d.name}}`,
    d.title ? `{\\color{headsub}\\large\\bfseries ${d.title}}` : "",
    contactLine(d, " \\enspace\\textbar\\enspace ") ? `{\\color{white}\\small ${contactLine(d, " \\enspace\\textbar\\enspace ")}}` : "",
    d.links.length ? `{\\color{white}\\small ${linkLine(d, " \\enspace\\textbar\\enspace ")}}` : ""
  ].filter(Boolean).join("\\\\[5pt]\n");

  return `\\documentclass[10pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
${SANS_FONTS}
\\usepackage[top=0.9cm, bottom=1.1cm, left=1.5cm, right=1.5cm]{geometry}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref}
${ATS_TEXT}

${CREATIF_COLORS}
\\setlength{\\parindent}{0pt}
\\titleformat{\\section}{\\color{primary}\\large\\bfseries}{}{0em}{{\\color{accent}\\rule{0.3cm}{0.3cm}}\\hspace{0.25cm}\\MakeUppercase}[\\vspace{-3pt}{\\color{soft}\\titlerule[1.2pt]}]
\\titlespacing*{\\section}{0pt}{10pt}{5pt}
\\setlist[itemize]{leftmargin=1.1em, label={\\color{accent}\\textbullet}, itemsep=1pt, topsep=2pt, parsep=0pt}
\\newcommand{\\chip}[1]{\\colorbox{soft}{\\strut\\color{primary}\\small #1}}

\\begin{document}
\\pagestyle{empty}
\\begin{tikzpicture}[remember picture, overlay]
  \\fill[primary] (current page.north west) rectangle ([yshift=-4.3cm]current page.north east);
  \\fill[accent] ([yshift=-4.3cm]current page.north west) rectangle ([yshift=-4.45cm]current page.north east);
  ${photo}
\\end{tikzpicture}%
\\begin{minipage}[t][3.1cm][c]{${d.hasPhoto ? "\\dimexpr\\textwidth-4.3cm\\relax" : "\\textwidth"}}
${head}
\\end{minipage}

\\vspace{0.75cm}
${sections.join("\n\n")}

\\end{document}
`;
}

/** CV généré sans IA, uniquement à partir du profil. */
export function generateFallbackLatex(candidate: any, job: any, template: CvTemplate = "article", options: { tailored?: boolean } = {}): string {
  const data = buildData(candidate, job, !!options.tailored);
  const t = normalizeTemplate(template);
  if (t === "moderncv") return renderModernCv(data);
  if (t === "compact") return renderArticle(data, true);
  if (t === "photo") return renderPhoto(data);
  if (t === "creatif") return renderCreatif(data);
  return renderArticle(data);
}

// ---------------------------------------------------------------------------
// Lettre de motivation : expéditeur, destinataire, objet, corps, signature ;
// couleurs assorties au modèle de CV choisi. Le texte vient tel quel de l'utilisateur (ou de l'IA, relu).
// ---------------------------------------------------------------------------
const LETTER_COLORS: Record<CvTemplate, string> = {
  article: "30, 70, 100",
  photo: "0, 74, 84",
  creatif: "43, 45, 110",
  moderncv: "30, 80, 160",
  compact: "40, 40, 40"
};

const normName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** Paragraphes du corps de la lettre, sans la signature finale (ajoutée par le modèle). */
export function letterParagraphs(letter: string, fullName: string): string[] {
  const paras = String(letter || "").replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const name = normName(fullName || "");
  if (name && paras.length) {
    const lines = paras[paras.length - 1].split("\n");
    if (normName(lines[lines.length - 1]) === name) {
      lines.pop();
      if (lines.length) paras[paras.length - 1] = lines.join("\n");
      else paras.pop();
    }
  }
  return paras;
}

export function generateLetterLatex(candidate: any, job: any, letter: string, template: CvTemplate = "article", date: Date = new Date()): string {
  const t = normalizeTemplate(template);
  const d = buildData(candidate, job, true);
  const body = letterParagraphs(letter, clean(candidate?.fullName))
    .map((p) => p.split("\n").map((l) => escapeLatex(l.trim())).join("\\\\\n"))
    .join("\n\n");
  const spontaneous = !!job?.isSpontaneous || /^Candidature spontanée/i.test(String(job?.title || ""));
  const jobTitle = escapeLatex(clean(String(job?.title || "").replace(/^Candidature spontanée — /, "")));
  const subject = spontaneous
    ? `Candidature spontanée${jobTitle ? ` -- ${jobTitle}` : ""}`
    : `Candidature au poste de ${jobTitle || "votre offre"}`;
  const city = escapeLatex(clean(String(candidate?.location || "").split(/[,(]/)[0]));
  const when = date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  const sender = [
    `{\\Large \\textbf{\\textcolor{primary}{${d.name}}}}`,
    d.location, d.phone, d.email,
    ...d.links.map((l) => `\\href{${l.url}}{${l.label}}`)
  ].filter(Boolean).join("\\\\\n");
  const company = escapeLatex(clean(job?.company));
  const recipient = [
    "\\textbf{À l'attention du service Recrutement}",
    company ? `\\textbf{${company}}` : "",
    escapeLatex(clean(job?.location))
  ].filter(Boolean).join("\\\\\n");

  const creatif = t === "creatif";
  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
${creatif ? SANS_FONTS : SAFE_FONTS}
\\usepackage[left=2cm, right=2cm, top=${creatif ? "2.4cm" : "2cm"}, bottom=2cm]{geometry}
\\usepackage{xcolor}
${creatif ? "\\usepackage{tikz}\n" : ""}\\usepackage[hidelinks]{hyperref}
${ATS_TEXT}

${creatif ? CREATIF_COLORS : `\\definecolor{primary}{RGB}{${LETTER_COLORS[t]}}`}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0.8em}

\\begin{document}
\\pagestyle{empty}
${creatif ? `\\begin{tikzpicture}[remember picture, overlay]
  \\fill[primary] (current page.north west) rectangle ([yshift=-1cm]current page.north east);
  \\fill[accent] ([yshift=-1cm]current page.north west) rectangle ([yshift=-1.12cm]current page.north east);
\\end{tikzpicture}%
` : ""}${sender}

\\vspace{0.4cm}

\\begin{flushright}
${recipient}
\\end{flushright}

\\begin{flushright}
${city ? `${city}, le` : "Le"} ${escapeLatex(when)}
\\end{flushright}

\\textbf{Objet : ${subject}}

\\vspace{0.2cm}

${body}

\\vspace{0.3cm}
\\textbf{${d.name}}

\\end{document}
`;
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

/** Taille maximale de la photo (JPEG déjà réduit par le navigateur). */
const MAX_PHOTO_BYTES = 600_000;

/** Photo du profil (data URL ou base64) → JPEG valide, ou null. Seul le JPEG est accepté. */
export function decodeJpegPhoto(input: unknown): Buffer | null {
  if (typeof input !== "string" || !input) return null;
  const m = input.match(/^data:image\/jpeg;base64,(.+)$/);
  if (!m && input.startsWith("data:")) return null;
  const buf = Buffer.from(m ? m[1] : input, "base64");
  if (buf.length < 4 || buf.length > MAX_PHOTO_BYTES) return null;
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? buf : null;
}

/**
 * Environnement minimal du compilateur : aucune clé du serveur (Gemini, sources, Redis…) n'y est transmise.
 * HOME et les caches restent ceux du serveur (Tectonic y garde ses paquets téléchargés).
 */
function compilerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { openin_any: "p", openout_any: "p" };
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR", "XDG_CACHE_HOME", "TEXMFHOME", "TEXMFVAR", "TEXMFCNF", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

export async function compileLatex(tex: string, options: { photo?: Buffer | null } = {}): Promise<{ pdf?: Buffer; error?: string; log?: string }> {
  const compiler = await detectLatexCompiler();
  if (!compiler) return { error: "NO_COMPILER" };
  if (!tex || Buffer.byteLength(tex, "utf8") > MAX_TEX_BYTES) return { error: "Document vide ou trop volumineux." };
  if (FORBIDDEN.test(tex)) return { error: "Le document contient des commandes non autorisées (accès fichiers / shell)." };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-"));
  const texPath = path.join(dir, "cv.tex");
  fs.writeFileSync(texPath, tex, "utf8");
  if (options.photo) fs.writeFileSync(path.join(dir, PHOTO_FILE), options.photo);

  // Chemins relatifs : en mode « paranoïaque » (openin_any=p), TeX refuse les chemins absolus
  const args = compiler.kind === "tectonic"
    ? ["--outdir", ".", "--untrusted", "cv.tex"]
    : ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "cv.tex"];

  const run = () => new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    const p = spawn(compiler.cmd, args, { cwd: dir, env: compilerEnv() });
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

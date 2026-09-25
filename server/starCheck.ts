/**
 * Évaluation STAR sans IA (repli quand Gemini est indisponible).
 * Repère dans la réponse les phrases de Situation, Tâche, Action et Résultat à partir d'indices de langage,
 * et vérifie la présence d'un résultat mesurable. Ne réécrit rien : aucune donnée n'est inventée.
 */

export interface StarEvaluation {
  source: "local-heuristic";
  score: number;
  verdict: string;
  starBreakdown: { situation: string; task: string; action: string; result: string };
  strengths: string[];
  improvements: string[];
  improvedSample: string;
}

const CUES = {
  situation: /\b(en (?:19|20)\d{2}|l'an dernier|l'année dernière|lors d[e'u]|quand|lorsque|dans le cadre|chez|pendant|au sein d|au cours d|contexte|à l'époque|durant)\b/i,
  task: /\b(je devais|j'ai dû|il fallait|il me fallait|objectif|ma mission|mon rôle|ma tâche|j'étais chargée?|j'étais responsable|on m'a confié|le défi|l'enjeu)\b/i,
  action: /\b(j'ai (?:alors |donc |d'abord |ensuite )?(?:\w+[ée]e?s?|mis|pris|fait|conçu|construit|écrit|repris|mené|introduit|produit)|nous avons|je me suis|j'ai choisi de|j'ai décidé de)\b/i,
  result: /\b(résultat|ce qui a permis|cela a permis|a permis de|au final|finalement|grâce à|en conséquence|réduit|augmenté|amélioré|gagné|économisé|atteint|dépassé|livré|obtenu|validé|satisfaction)\b/i
};

const MEASURE = /\d+(?:[.,]\d+)?\s*(?:%|€|k€|jours?|semaines?|mois|heures?|h\b|clients?|utilisateurs?|personnes?|x\b|fois|points?)|\b\d{2,}\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function evaluateStarLocally(answer: string): StarEvaluation {
  const text = String(answer || "").replace(/[’`]/g, "'").trim();
  const parts = sentences(text);
  const used = new Set<number>();
  const pick = (re: RegExp) => {
    const i = parts.findIndex((s, idx) => !used.has(idx) && re.test(s));
    if (i < 0) return "";
    used.add(i);
    return parts[i];
  };
  // Le résultat est cherché en premier (souvent en fin de réponse), puis situation, tâche, action
  const result = pick(CUES.result);
  const situation = pick(CUES.situation);
  const task = pick(CUES.task);
  const action = pick(CUES.action);

  const words = text.split(/\s+/).filter(Boolean).length;
  const measurable = MEASURE.test(result || text);
  const present = { situation: !!situation, task: !!task, action: !!action, result: !!result };
  const count = Object.values(present).filter(Boolean).length;

  let score = 1 + count * 2;
  if (measurable && present.result) score += 1;
  if (words >= 60 && words <= 250) score += 1;
  score = Math.max(1, Math.min(10, score));

  const strengths: string[] = [];
  const improvements: string[] = [];
  if (present.situation) strengths.push("Le contexte est posé.");
  else improvements.push("Situez l'exemple : où, quand, dans quelle équipe ou quel projet ?");
  if (present.task) strengths.push("L'objectif ou votre rôle est explicite.");
  else improvements.push("Précisez votre mission ou l'objectif à atteindre (« je devais… », « l'objectif était… »).");
  if (present.action) strengths.push("Vous décrivez vos propres actions.");
  else improvements.push("Décrivez ce que VOUS avez fait, à la première personne (« j'ai organisé… »).");
  if (present.result) {
    strengths.push("La réponse se conclut par un résultat.");
    if (!measurable) improvements.push("Chiffrez le résultat si possible (délai, pourcentage, volume, satisfaction).");
  } else {
    improvements.push("Terminez par le résultat obtenu et, si possible, un chiffre.");
  }
  if (words < 60) improvements.push("Développez un peu : une bonne réponse STAR dure environ 1 à 2 minutes à l'oral.");
  if (words > 250) improvements.push("Resserrez la réponse : visez 1 à 2 minutes à l'oral.");

  const verdict = count === 4
    ? "Évaluation automatique (sans IA) : structure STAR complète."
    : `Évaluation automatique (sans IA) : ${count} élément(s) STAR repéré(s) sur 4.`;

  return {
    source: "local-heuristic",
    score,
    verdict,
    starBreakdown: { situation, task, action, result },
    strengths,
    improvements,
    improvedSample: ""
  };
}

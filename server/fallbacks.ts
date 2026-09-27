import { calculateCandidateMatch } from "../src/utils/skillMatcher.ts";

export function hasItems(v: any): v is any[] {
  return Array.isArray(v) && v.length > 0;
}

export function generateFallbackLetter(candidate: any, job: any): string {
  const candidateName = candidate?.fullName || "";
  const jobTitle = job?.title || "le poste proposé";
  const company = job?.company || "votre structure";
  const matched = calculateCandidateMatch(candidate?.skills || [], job?.skillsRequired || []).matchedKeywords;
  const skillsSentence = matched.length > 0
    ? `Mon parcours m'a permis de développer des compétences directement utiles pour ce poste, notamment : ${matched.slice(0, 3).join(", ")}.`
    : `Mon parcours m'a permis de développer des compétences que je serais heureux(se) de mettre au service de ${company}.`;
  const lastExp = hasItems(candidate?.experiences) ? candidate.experiences[0] : null;
  const expSentence = lastExp?.title && lastExp?.company
    ? `\n\nEn tant que ${lastExp.title} chez ${lastExp.company}, ${lastExp.bullets?.[0] ? `j'ai notamment été en charge de la mission suivante : ${String(lastExp.bullets[0]).replace(/\.$/, "").replace(/^./, (c: string) => c.toLowerCase())}.` : "j'ai pu mettre en pratique ces compétences au quotidien."}`
    : "";

  const opening = job?.isSpontaneous
    ? `Je vous adresse une candidature spontanée pour un contrat en alternance au sein de ${company}${job?.companySector ? `, dont l'activité (${String(job.companySector).toLowerCase()}) m'intéresse particulièrement` : ""}.`
    : `Je vous adresse ma candidature pour le poste de ${jobTitle} au sein de ${company}.`;

  return `Madame, Monsieur,

${opening}

${skillsSentence}${expSentence}

Je serais ravi(e) d'échanger avec vous lors d'un entretien afin de vous présenter plus en détail ma motivation.

Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.
${candidateName ? `\n${candidateName}` : ""}`;
}

export function generateFallbackPrepKit(candidate: any, job: any) {
  const company = job?.company || "L'entreprise";
  const jobTitle = job?.title || "Poste ciblé";
  const skills: string[] = hasItems(job?.skillsRequired) ? job.skillsRequired : (candidate?.skills || []);

  return {
    generic: true,
    companySynthesis: {
      summary: `Synthèse non disponible (IA hors ligne). Renseignez-vous sur ${company} : activité, actualité récente, valeurs affichées sur son site carrières.`,
      coreChallenges: [
        `Comprendre les missions concrètes du poste de ${jobTitle}`,
        "Identifier les outils et méthodes utilisés par l'équipe",
        "Relier vos expériences aux besoins exprimés dans l'offre"
      ],
      techStackAnticipated: skills.slice(0, 5),
      culturalValues: []
    },
    elevatorPitch: `Trame (à personnaliser) : « Bonjour, je suis ${candidate?.fullName || "[votre nom]"}, ${candidate?.title || "[votre titre]"}. [Votre expérience la plus pertinente en une phrase]. Ce qui m'attire chez ${company}, c'est [élément précis de l'offre ou de l'entreprise]. »`,
    topQuestions: [
      {
        question: "Pouvez-vous me présenter une réalisation ou un projet récent dont vous êtes particulièrement fier(e) ?",
        category: "Projet",
        whyTheyAsk: "Évaluer la profondeur de vos compétences et votre impact concret.",
        suggestedAnswer: "Structurez votre réponse avec la méthode STAR (Situation, Tâche, Action, Résultat mesurable).",
        keyPoints: ["Contexte initial", "Vos actions personnelles", "Un résultat chiffré"]
      },
      {
        question: `Pourquoi souhaitez-vous rejoindre ${company} ?`,
        category: "Motivation",
        whyTheyAsk: "Vérifier votre préparation et l'alignement avec l'entreprise.",
        suggestedAnswer: "Citez un élément précis de l'entreprise et reliez-le à votre projet professionnel.",
        keyPoints: ["Un élément distinctif de l'entreprise", "Le lien avec votre parcours"]
      },
      {
        question: "Comment gérez-vous les imprévus face à des échéances serrées ?",
        category: "Comportemental / Culture",
        whyTheyAsk: "Observer votre capacité à prioriser et à communiquer.",
        suggestedAnswer: "Donnez un exemple réel : priorisation, communication, solution trouvée.",
        keyPoints: ["Méthode", "Communication proactive", "Résultat"]
      }
    ],
    smartQuestionsToAskInterviewer: [
      `Quelle sera la priorité principale de la personne qui occupera le poste de ${jobTitle} durant ses premiers mois ?`,
      "Comment l'équipe est-elle organisée au quotidien ?",
      "Quelles sont les perspectives d'évolution sur ce poste ?"
    ]
  };
}

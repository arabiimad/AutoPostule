export type CvTemplate = 'article' | 'photo' | 'creatif' | 'moderncv' | 'compact';

export type ContractType = 'stage' | 'alternance' | 'cdi' | 'cdd' | 'freelance';

export interface Experience {
  id: string;
  title: string;
  company: string;
  location: string;
  startDate: string;
  endDate: string;
  current: boolean;
  bullets: string[];
  technologies: string[];
}

export interface Education {
  id: string;
  degree: string;
  institution: string;
  year: string;
  details?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  technologies: string[];
  link?: string;
}

export interface UserProfile {
  userId: string;
  fullName: string;
  email: string;
  title: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  overleafUser: string;
  summary: string;
  skills: string[];
  experiences: Experience[];
  education: Education[];
  projects: Project[];
  languages: string[];
  targetRoles: string[];
  preferredContracts: ContractType[];
  autoApplyEnabled: boolean;
  minMatchScore: number;
  preferredTemplate: CvTemplate;
  /** Photo facultative (JPEG carré en data URL), affichée sur les modèles « Photo » et « Créatif ». Jamais envoyée à l'IA. */
  photo?: string;
  /** Recherches enregistrées (alertes). */
  savedSearches?: SavedSearch[];
  updatedAt?: string;
}

/** Recherche enregistrée : relancée automatiquement pour signaler les nouvelles offres. */
export interface SavedSearch {
  id: string;
  query: string;
  location: string;
  contractType: string;
  radius: number;
  createdAt: string;
  lastCheckedAt?: string;
  /** Identifiants des offres déjà vues (les 300 plus récentes). */
  seenIds: string[];
  /** Nouvelles offres depuis la dernière consultation. */
  newCount?: number;
}

/** Analyse structurée d'une offre (étape 1 de la génération du CV). */
export interface OfferAnalysis {
  domain: string;
  roleSummary: string;
  seniority: string;
  tone: string;
  mustHave: string[];
  niceToHave: string[];
  softSkills: string[];
  missions: string[];
  keywords: string[];
  source: 'ai' | 'fallback';
}

export interface TailoredExperience {
  /** Identifiant de l'expérience du profil (les faits — poste, entreprise, dates — ne sont jamais modifiés). */
  id: string;
  include: boolean;
  bullets: string[];
}

/** Contenu du CV adapté à une offre (étape 2), mis en forme ensuite par un modèle LaTeX. */
export interface TailoredCv {
  headline: string;
  summary: string;
  experiences: TailoredExperience[];
  skillsOrder: string[];
  highlights: string[];
}

/** Version enregistrée d'un dossier (CV LaTeX + lettre). */
export interface DossierVersion {
  id: string;
  createdAt: string;
  label: string;
  template?: CvTemplate;
  latexResumeCode: string;
  coverLetter: string;
  tailoredContent?: TailoredCv;
}

export type JobOrigin = 'la-bonne-alternance' | 'france-travail' | 'jsearch' | 'adzuna' | 'jooble' | 'demo' | 'ia-web';

export interface JobOffer {
  id: string;
  title: string;
  company: string;
  location: string;
  contractType: ContractType;
  remote: 'total' | 'hybride' | 'sur-site' | 'non-precise';
  /** Provenance de l'offre (source réelle, démo ou recherche IA). */
  origin?: JobOrigin;
  /** Date d'expiration ISO si la source la fournit. */
  expiresAt?: string;
  latitude?: number;
  longitude?: number;
  /** Logo de l'entreprise si la source le fournit. */
  companyLogo?: string;
  /** La description n'est qu'un extrait (Adzuna, Jooble) : l'annonce complète est sur le site source. */
  descriptionIsSnippet?: boolean;
  /** Autres plateformes où postuler (LinkedIn, Indeed, WTTJ…). */
  applyOptions?: { publisher: string; url: string }[];
  /** Même offre trouvée sur d'autres sources. */
  alsoOn?: { source: string; url: string }[];
  /** Entreprise qui recrute en alternance sans offre publiée (candidature spontanée). */
  isSpontaneous?: boolean;
  /** Informations entreprise quand la source les fournit. */
  companySize?: string;
  companySector?: string;
  companyWebsite?: string;
  siret?: string;
  salary?: string;
  description: string;
  skillsRequired: string[];
  source: string;
  applyUrl: string;
  publishedAt: string;
  domain?: string;
  status?: 'active' | 'expired';
  lastVerifiedAt?: string;
  matchScore?: number;
  matchedKeywords?: string[];
  missingKeywords?: string[];
  companyLocationInfo?: {
    address?: string;
    metro?: string;
    commuteEstimate?: string;
    summary?: string;
  };
}

export interface InterviewQuestion {
  question: string;
  category: string;
  whyTheyAsk: string;
  suggestedAnswer: string;
  keyPoints: string[];
}

export interface InterviewPrepKit {
  companySynthesis: {
    summary: string;
    coreChallenges: string[];
    techStackAnticipated: string[];
    culturalValues: string[];
  };
  elevatorPitch: string;
  topQuestions: InterviewQuestion[];
  smartQuestionsToAskInterviewer: string[];
}

export type ApplicationStatus = 'detected' | 'prepared' | 'applied' | 'interview' | 'rejected' | 'offer';

export interface Application {
  id: string;
  userId: string;
  jobId: string;
  jobTitle: string;
  company: string;
  location: string;
  contractType: ContractType;
  jobUrl: string;
  /** Description et compétences de l'offre, conservées pour régénérer / préparer l'entretien. */
  jobDescription?: string;
  skillsRequired?: string[];
  /** Part des compétences de l'offre présentes dans le profil ; null = non évaluable. */
  matchScore: number | null;
  status: ApplicationStatus;
  latexResumeCode: string;
  coverLetter: string;
  overleafSnippetUrl: string;
  interviewPrep?: InterviewPrepKit;
  appliedAt?: string;
  /** Date (ISO) à laquelle relancer l'entreprise si aucune réponse. */
  followUpAt?: string;
  /** Nombre de relances déjà envoyées. */
  followUpCount?: number;
  /** Modèle de CV utilisé pour ce dossier. */
  template?: CvTemplate;
  /** Contenu adapté (titre, accroche, puces) : permet de retoucher le CV sans repasser par l'IA. */
  tailoredContent?: TailoredCv;
  /** Analyse de l'offre utilisée pour ce dossier. */
  offerAnalysis?: OfferAnalysis;
  /** Date de la dernière génération / modification du CV et de la lettre. */
  dossierUpdatedAt?: string;
  /** Versions précédentes du CV et de la lettre (10 au plus, la plus récente en premier). */
  versions?: DossierVersion[];
  /** Plateforme d'origine de l'offre (statistiques par source). */
  jobSource?: string;
  /** Date de la première réponse de l'entreprise (entretien, offre ou refus). */
  respondedAt?: string;
  /** Candidature spontanée (entreprise sans offre publiée). */
  isSpontaneous?: boolean;
  createdAt: string;
  matchedKeywords: string[];
  missingKeywords?: string[];
  logEvents: { timestamp: string; message: string }[];
}

export interface AgentLog {
  id: string;
  timestamp: string;
  type: 'scan' | 'match' | 'latex' | 'apply' | 'success' | 'alert';
  message: string;
  jobTitle?: string;
  company?: string;
  score?: number;
}

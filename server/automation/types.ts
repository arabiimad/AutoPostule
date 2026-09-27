/**
 * Types de l'agent de candidature automatique.
 *
 * Une candidature = une tâche dans la file. L'agent la traite sur le serveur (même PC éteint) ;
 * quand il a besoin de l'utilisateur (validation, question inconnue, captcha, code SMS), la tâche
 * passe en « waiting_user » avec une action en attente, puis reprend là où elle s'était arrêtée.
 */

export type TaskStatus = "queued" | "running" | "waiting_user" | "done" | "failed" | "cancelled";

/** Ce que l'agent attend de l'utilisateur. */
export type PendingKind =
  | "approve"            // valider l'envoi (niveau manuel ou confiance progressive)
  | "question"           // questions de formulaire sans réponse fiable
  | "captcha"            // vérification humaine sur le site : l'utilisateur la fait lui-même
  | "verification_code"  // code SMS / double authentification
  | "manual_step";       // canal non automatisable : dossier prêt, l'utilisateur termine l'envoi

export interface PendingQuestion {
  /** Clé normalisée de la question (voir answers.ts). */
  key: string;
  label: string;
  category: QuestionCategory;
  /** Choix proposés par le formulaire, s'il y en a. */
  options?: string[];
}

export interface PendingAction {
  kind: PendingKind;
  message: string;
  questions?: PendingQuestion[];
  /** Page à ouvrir (captcha, étape manuelle). */
  url?: string;
  createdAt: string;
}

/** Réponses de l'utilisateur accumulées au fil des reprises. */
export interface Resolution {
  approved?: boolean;
  /** Validation avec corrections : ne compte pas pour la confiance progressive. */
  edited?: boolean;
  /** Lettre corrigée par l'utilisateur à la validation. */
  coverLetter?: string;
  rejected?: boolean;
  answers?: Record<string, string>;
  verificationCode?: string;
  /** Captcha résolu ou étape manuelle terminée par l'utilisateur. */
  humanStepDone?: boolean;
}

export interface PreparedDocuments {
  coverLetter: string;
  latexCode: string;
  /** CV compilé (base64), si un compilateur LaTeX est disponible. */
  cvPdfBase64?: string;
  notices: string[];
  preparedAt: string;
}

export interface ApplyPayload {
  /** Offre au format JobOffer (src/types.ts) + éventuellement contactEmail. */
  job: any;
  /** Instantané du profil au moment de la mise en file (sinon lu dans le stockage). */
  candidate?: any;
  /** "user" : demandée par l'utilisateur ; "agent" : trouvée par la recherche automatique. */
  origin: "user" | "agent";
  documents?: PreparedDocuments;
  /** Canal retenu : une candidature mise en pause reprend sur le même canal. */
  channel?: string;
}

export interface TaskEvent {
  at: string;
  message: string;
}

export interface Task {
  id: string;
  uid: string;
  type: "apply";
  status: TaskStatus;
  /** Empêche deux candidatures pour la même offre. */
  dedupeKey: string;
  payload: ApplyPayload;
  attempts: number;
  maxAttempts: number;
  /** Date (ISO) à partir de laquelle la tâche peut être traitée. */
  runAt: string;
  leaseUntil?: string;
  lockedBy?: string;
  pending?: PendingAction;
  resolution?: Resolution;
  result?: SubmissionResult;
  lastError?: string;
  history: TaskEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  uid: string;
  type: "apply";
  dedupeKey: string;
  payload: ApplyPayload;
  runAt?: string;
  maxAttempts?: number;
}

export interface SubmissionResult {
  channel: string;
  /** Référence renvoyée par le canal (identifiant de message, de candidature…). */
  reference?: string;
  /** Détail de ce qui a été envoyé (destinataire, réponses données…), montré à l'utilisateur. */
  details: Record<string, unknown>;
  submittedAt: string;
}

/** Candidature envoyée : sert au plafond quotidien et à l'anti-doublon par entreprise. */
export interface Submission {
  id: string;
  taskId: string;
  jobKey: string;
  company: string;
  jobTitle: string;
  channel: string;
  submittedAt: string;
}

export type AutomationLevel = "manual" | "rules" | "progressive";

export interface AutomationSettings {
  /** manual : chaque envoi est validé ; rules : envoi automatique ; progressive : validation puis automatique. */
  level: AutomationLevel;
  /** Pause générale de l'agent. */
  paused: boolean;
  /** Score minimum pour les offres trouvées par l'agent (0-100). */
  minMatchScore: number;
  /** Nombre maximum d'envois sur 24 heures glissantes. */
  dailyCap: number;
  /** Délai minimum entre deux candidatures à la même entreprise. */
  sameCompanyCooldownDays: number;
  excludedCompanies: string[];
  /** Validations sans correction nécessaires avant l'envoi automatique (niveau progressive). */
  progressiveThreshold: number;
  /** Validations sans correction déjà faites. */
  cleanApprovals: number;
}

export type QuestionCategory =
  | "identity"            // nom, email, téléphone, adresse, liens
  | "work_authorization"  // droit de travailler, visa
  | "salary"              // prétentions salariales
  | "availability"        // date de début, préavis
  | "relocation"          // mobilité, télétravail
  | "diversity"           // handicap, genre, origine… (données sensibles)
  | "legal"               // casier judiciaire, clauses de non-concurrence, consentements
  | "experience"          // années d'expérience, niveau sur une compétence
  | "motivation"          // question ouverte (pourquoi nous ?)
  | "other";

export interface SavedAnswer {
  key: string;
  label: string;
  category: QuestionCategory;
  answer: string;
  updatedAt: string;
}

export interface VaultEntry {
  id: string;
  /** Domaine du site (ex. : societe.wd3.myworkdayjobs.com). */
  site: string;
  username: string;
  /** Mot de passe chiffré (voir vault.ts) ; jamais renvoyé tel quel au navigateur. */
  secret: string;
  createdAt: string;
  updatedAt: string;
}

import { UserProfile, Application } from './types';

export const EMPTY_PROFILE: UserProfile = {
  userId: "",
  fullName: "",
  email: "",
  title: "",
  phone: "",
  location: "",
  linkedinUrl: "",
  githubUrl: "",
  portfolioUrl: "",
  overleafUser: "",
  summary: "",
  skills: [],
  experiences: [],
  education: [],
  projects: [],
  languages: [],
  targetRoles: [],
  preferredContracts: ["cdi", "alternance", "stage"],
  autoApplyEnabled: false,
  minMatchScore: 60,
  preferredTemplate: "article"
};

// Profil de départ vide : aucune donnée personnelle ne doit être pré-remplie.
export const INITIAL_PROFILE: UserProfile = EMPTY_PROFILE;

export const INITIAL_APPLICATIONS: Application[] = [];

// Les offres ne sont plus embarquées dans l'interface : elles sont chargées depuis le serveur
// (sources réelles, ou base de démonstration si aucune clé d'API n'est configurée).

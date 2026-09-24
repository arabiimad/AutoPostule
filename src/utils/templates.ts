import type { CvTemplate } from '../types';

/** Modèles de CV, dans l'ordre d'affichage. Partagé par l'interface et le serveur. */
export const CV_TEMPLATE_IDS: CvTemplate[] = ['article', 'photo', 'creatif', 'moderncv', 'compact'];

/** Modèles qui affichent la photo du profil (si elle existe). */
export const PHOTO_TEMPLATES: CvTemplate[] = ['photo', 'creatif'];

export function normalizeCvTemplate(t: unknown): CvTemplate {
  return CV_TEMPLATE_IDS.includes(t as CvTemplate) ? (t as CvTemplate) : 'article';
}

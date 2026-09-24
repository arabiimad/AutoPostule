import type { Application, ApplicationStatus } from '../types';

// ---------------------------------------------------------------------------
// Statistiques de suivi
// ---------------------------------------------------------------------------
export interface ApplicationStats {
  total: number;
  sent: number;
  responses: number;
  interviews: number;
  offers: number;
  rejected: number;
  /** Réponses / candidatures envoyées (%) ; null si aucune candidature envoyée. */
  responseRate: number | null;
  interviewRate: number | null;
  /** Délai médian de réponse (jours) ; null si inconnu. */
  medianResponseDays: number | null;
  bySource: { source: string; sent: number; responses: number }[];
  /** Candidatures envoyées par semaine (8 dernières semaines, la plus ancienne en premier). */
  weekly: { label: string; count: number }[];
}

const SENT: ApplicationStatus[] = ['applied', 'interview', 'offer', 'rejected'];
const RESPONDED: ApplicationStatus[] = ['interview', 'offer', 'rejected'];

const median = (values: number[]) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function computeStats(apps: Application[], now = Date.now()): ApplicationStats {
  const sent = apps.filter(a => SENT.includes(a.status));
  const responded = sent.filter(a => RESPONDED.includes(a.status));
  const pct = (n: number) => (sent.length ? Math.round((n / sent.length) * 100) : null);

  const delays = responded
    .filter(a => a.appliedAt && a.respondedAt)
    .map(a => Math.max(0, Math.round((new Date(a.respondedAt!).getTime() - new Date(a.appliedAt!).getTime()) / 86_400_000)));

  const sources = new Map<string, { sent: number; responses: number }>();
  for (const a of sent) {
    const key = a.isSpontaneous ? 'Candidature spontanée' : (a.jobSource || 'Non renseignée');
    const e = sources.get(key) || { sent: 0, responses: 0 };
    e.sent++;
    if (RESPONDED.includes(a.status)) e.responses++;
    sources.set(key, e);
  }

  const weekMs = 7 * 86_400_000;
  const weekly = Array.from({ length: 8 }, (_, i) => {
    const end = now - (7 - i) * weekMs;
    const start = end - weekMs;
    const d = new Date(end);
    return {
      label: d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
      count: sent.filter(a => {
        const t = new Date(a.appliedAt || a.createdAt).getTime();
        return t > start && t <= end;
      }).length
    };
  });

  return {
    total: apps.length,
    sent: sent.length,
    responses: responded.length,
    interviews: apps.filter(a => a.status === 'interview' || a.status === 'offer').length,
    offers: apps.filter(a => a.status === 'offer').length,
    rejected: apps.filter(a => a.status === 'rejected').length,
    responseRate: pct(responded.length),
    interviewRate: pct(sent.filter(a => a.status === 'interview' || a.status === 'offer').length),
    medianResponseDays: median(delays),
    bySource: [...sources.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.sent - a.sent),
    weekly
  };
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------
const STATUS_FR: Record<ApplicationStatus, string> = {
  detected: 'Sauvegardée',
  prepared: 'Dossier prêt',
  applied: 'Envoyée',
  interview: 'Entretien',
  offer: 'Offre reçue',
  rejected: 'Refusée'
};

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dateFr = (v?: string) => (v ? new Date(v).toLocaleDateString('fr-FR') : '');

/** CSV compatible Excel (séparateur « ; », BOM UTF-8 pour les accents). */
export function applicationsToCsv(apps: Application[]): string {
  const header = ['Entreprise', 'Poste', 'Lieu', 'Contrat', 'Statut', 'Compatibilité (%)', 'Source', 'Créée le', 'Envoyée le', 'Réponse le', 'Prochaine relance', 'Relances', 'Lien'];
  const rows = apps.map(a => [
    a.company, a.jobTitle, a.location, a.contractType, STATUS_FR[a.status] || a.status,
    a.matchScore ?? '', a.isSpontaneous ? 'Candidature spontanée' : a.jobSource || '',
    dateFr(a.createdAt), dateFr(a.appliedAt), dateFr(a.respondedAt), dateFr(a.followUpAt), a.followUpCount || 0, a.jobUrl
  ]);
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n');
}

export function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sauvegarde complète (JSON) : réimportable dans Kareer. */
export function applicationsBackup(apps: Application[]): string {
  return JSON.stringify({ app: 'Kareer', version: 1, exportedAt: new Date().toISOString(), applications: apps }, null, 2);
}

/** Lit une sauvegarde JSON ; renvoie les candidatures valides. */
export function parseApplicationsBackup(text: string): Application[] {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.applications;
  if (!Array.isArray(list)) throw new Error('Fichier de sauvegarde invalide.');
  return list.filter((a: any) => a && typeof a.id === 'string' && typeof a.company === 'string' && typeof a.jobTitle === 'string' && typeof a.status === 'string');
}

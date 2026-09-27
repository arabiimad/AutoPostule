/**
 * Notifications sur le téléphone (Web Push, standard des navigateurs) : candidature envoyée, action demandée,
 * résultat incertain. Clés VAPID : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: ou https:).
 * Sans ces variables, les notifications sont simplement désactivées.
 */
import webpush from "web-push";
import type pg from "pg";

export interface PushMessage {
  title: string;
  body: string;
  /** Page ouverte au toucher de la notification. */
  url: string;
  /** Regroupe les notifications d'une même offre (pas de répétition). */
  tag?: string;
}

export const pushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

let configured = false;
function configure() {
  if (configured || !pushConfigured()) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:contact@kareer.pro", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  configured = true;
}

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<{ statusCode: number }>;

/** Envoie à tous les appareils du candidat ; les abonnements expirés (404/410) sont supprimés. Renvoie le nombre d'envois réussis. */
export async function sendPushToUser(pool: pg.Pool, userId: string, msg: PushMessage, send?: Sender): Promise<number> {
  if (!send) {
    if (!pushConfigured()) return 0;
    configure();
    send = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 24 * 3600, urgency: "normal" });
  }
  const { rows } = await pool.query(`select endpoint, p256dh, auth from public.push_subscriptions where user_id = $1`, [userId]);
  let ok = 0;
  for (const r of rows) {
    try {
      await send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(msg));
      ok++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await pool.query(`delete from public.push_subscriptions where endpoint = $1`, [r.endpoint]);
      }
    }
  }
  return ok;
}

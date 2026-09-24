/** Forfait, quotas, paiement et données du compte (API du serveur). */
import { apiFetch, readJson } from '../utils/api';

export type PlanId = 'free' | 'premium';
export type QuotaKind = 'cv' | 'letter' | 'rewrite' | 'interview' | 'import';

export interface AccountUsage {
  plan: PlanId;
  period: string;
  limits: Record<QuotaKind, number>;
  usage: Partial<Record<QuotaKind, number>>;
  quotasEnabled: boolean;
  billing: { enabled: boolean; status: string | null; renewsAt: string | null; hasCustomer: boolean };
  account: boolean;
}

export const QUOTA_LABELS: Record<QuotaKind, string> = {
  cv: 'CV adaptés par l’IA',
  letter: 'Lettres de motivation',
  rewrite: 'Retouches et évaluations IA',
  interview: 'Préparations d’entretien',
  import: 'Imports de CV'
};

/** Prix affiché (le montant réellement facturé est celui du tarif Stripe). */
export const PREMIUM_PRICE = import.meta.env.VITE_PREMIUM_PRICE || '9,99 €';

/** Évènement émis par apiFetch quand le serveur répond 402 QUOTA_EXCEEDED. */
export const QUOTA_EVENT = 'autopostule:quota';
export interface QuotaEventDetail { kind: QuotaKind; limit: number; plan: PlanId; message: string }

export const fetchUsage = async (): Promise<AccountUsage> => readJson(await apiFetch('/api/account/usage'));

async function redirectTo(path: string) {
  const { url } = await readJson<{ url: string }>(await apiFetch(path, {}));
  window.location.assign(url);
}
export const startCheckout = () => redirectTo('/api/billing/checkout');
export const openBillingPortal = () => redirectTo('/api/billing/portal');

export async function downloadAccountExport() {
  const res = await apiFetch('/api/account/export');
  const data = await readJson(res);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `autopostule-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function deleteAccount() {
  await readJson(await apiFetch('/api/account', undefined, { method: 'DELETE' }));
}

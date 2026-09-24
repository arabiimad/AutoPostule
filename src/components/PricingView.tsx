import React, { useState } from 'react';
import { Check, Sparkles, CreditCard, Loader2, ShieldCheck } from 'lucide-react';
import { Badge, Button, PageHeader, cx } from './ui';
import { track } from '../utils/monitoring';
import { PREMIUM_PRICE, QUOTA_LABELS, openBillingPortal, startCheckout, type AccountUsage, type QuotaKind } from '../data/account';

interface PricingViewProps {
  usage: AccountUsage | null;
  /** Compte en ligne connecté (le paiement est rattaché au compte). */
  signedIn: boolean;
  onOpenAuthModal: (mode: 'login' | 'register') => void;
  showToast: (title: string, desc: string, error?: boolean) => void;
  /** Retour de Stripe : « ok » ou « annule ». */
  paymentStatus?: string | null;
}

const ORDER: QuotaKind[] = ['cv', 'letter', 'rewrite', 'interview', 'import'];
const INLINE_LABELS: Record<QuotaKind, string> = {
  cv: 'CV adaptés par l’IA',
  letter: 'lettres de motivation',
  rewrite: 'retouches ou évaluations IA',
  interview: 'préparations d’entretien',
  import: 'imports de CV'
};

const FREE_FEATURES = [
  'Recherche d’offres multi-sources et candidatures spontanées',
  'Suivi des candidatures, relances et statistiques',
  'CV et lettre adaptés par l’IA (modèle rapide), dans la limite du forfait',
  'Export PDF (mise en page Web ou LaTeX)'
];
const PREMIUM_FEATURES = [
  'CV et lettres rédigés par le modèle IA le plus avancé',
  'Générations et retouches en usage illimité raisonnable',
  'Préparation d’entretien et évaluation des réponses',
  'Priorité aux nouvelles fonctions (alertes e-mail…)',
  'Sans engagement : résiliable en un clic'
];

export const PricingView: React.FC<PricingViewProps> = ({ usage, signedIn, onOpenAuthModal, showToast, paymentStatus }) => {
  const [busy, setBusy] = useState<'checkout' | 'portal' | null>(null);
  const plan = usage?.plan || 'free';
  const billing = usage?.billing;

  const go = async (action: 'checkout' | 'portal') => {
    if (!signedIn) {
      showToast('Compte requis', 'Créez un compte (gratuit) pour souscrire : l’abonnement y sera rattaché.');
      onOpenAuthModal('register');
      return;
    }
    setBusy(action);
    track(action === 'checkout' ? 'checkout_started' : 'billing_portal_opened');
    try {
      await (action === 'checkout' ? startCheckout() : openBillingPortal());
    } catch (e: any) {
      showToast('Paiement indisponible', e?.message || 'Réessayez dans un instant.', true);
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Tarifs"
        subtitle="Commencez gratuitement. Passez à Premium quand vous postulez à grande échelle."
      />

      {paymentStatus === 'ok' && (
        <div role="status" className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          Merci ! Votre paiement est validé. Le forfait Premium s’active dans quelques secondes (rechargez la page si besoin).
        </div>
      )}
      {paymentStatus === 'annule' && (
        <div role="status" className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          Paiement annulé : aucun montant n’a été prélevé.
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {/* Gratuit */}
        <section className={cx('rounded-2xl border bg-white p-6', plan === 'free' ? 'border-brand-300 ring-2 ring-brand-100' : 'border-slate-200')} aria-labelledby="plan-free">
          <div className="flex items-center justify-between gap-2">
            <h2 id="plan-free" className="text-lg font-bold text-slate-900">Gratuit</h2>
            {plan === 'free' && <Badge tone="brand">Votre forfait</Badge>}
          </div>
          <p className="mt-2 text-3xl font-extrabold text-slate-900">0 €</p>
          <p className="text-sm text-slate-500">pour toujours</p>
          <ul className="mt-5 space-y-2.5">
            {FREE_FEATURES.map((f) => (
              <li key={f} className="flex gap-2 text-sm text-slate-700"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />{f}</li>
            ))}
          </ul>
          {usage && (
            <p className="mt-5 text-xs text-slate-500">
              Chaque mois : {usage.plan === 'free' ? ORDER.map((k) => `${usage.limits[k]} ${INLINE_LABELS[k]}`).join(', ') : 'quotas du forfait gratuit'}.
            </p>
          )}
        </section>

        {/* Premium */}
        <section className={cx('relative rounded-2xl border bg-white p-6', plan === 'premium' ? 'border-brand-300 ring-2 ring-brand-100' : 'border-slate-200')} aria-labelledby="plan-premium">
          <div className="flex items-center justify-between gap-2">
            <h2 id="plan-premium" className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <Sparkles className="h-5 w-5 text-brand-600" aria-hidden="true" /> Premium
            </h2>
            {plan === 'premium' ? <Badge tone="brand">Votre forfait</Badge> : <Badge tone="green">Recommandé</Badge>}
          </div>
          <p className="mt-2 text-3xl font-extrabold text-slate-900">{PREMIUM_PRICE}</p>
          <p className="text-sm text-slate-500">par mois, TTC · sans engagement</p>
          <ul className="mt-5 space-y-2.5">
            {PREMIUM_FEATURES.map((f) => (
              <li key={f} className="flex gap-2 text-sm text-slate-700"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />{f}</li>
            ))}
          </ul>
          <div className="mt-6">
            {plan === 'premium' ? (
              <Button variant="secondary" size="lg" className="w-full" onClick={() => go('portal')} disabled={!!busy || !billing?.hasCustomer}>
                {busy === 'portal' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CreditCard className="h-4 w-4" aria-hidden="true" />}
                Gérer mon abonnement
              </Button>
            ) : billing?.enabled ? (
              <Button variant="primary" size="lg" className="w-full" onClick={() => go('checkout')} disabled={!!busy}>
                {busy === 'checkout' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
                {signedIn ? 'Passer à Premium' : 'Créer un compte et passer à Premium'}
              </Button>
            ) : (
              <p className="rounded-xl bg-slate-50 p-3 text-center text-sm text-slate-600">Abonnement bientôt disponible.</p>
            )}
            {plan === 'premium' && billing?.renewsAt && (
              <p className="mt-2 text-center text-xs text-slate-500">
                {billing.status === 'canceled' ? 'Se termine' : 'Renouvellement'} le {new Date(billing.renewsAt).toLocaleDateString('fr-FR')}
              </p>
            )}
          </div>
          {billing?.enabled && (
            <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> Paiement sécurisé par Stripe
            </p>
          )}
        </section>
      </div>

      {/* Consommation du mois */}
      {usage && usage.quotasEnabled && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6" aria-labelledby="usage-title">
          <h2 id="usage-title" className="text-base font-bold text-slate-900">Votre consommation ce mois-ci</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Remise à zéro le 1er du mois{usage.account ? '' : ' · sans compte, le compteur est lié à votre connexion Internet'}.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {ORDER.map((k) => {
              const used = usage.usage[k] || 0;
              const limit = usage.limits[k] || 0;
              const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <div key={k}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{QUOTA_LABELS[k]}</span>
                    <span className={cx('font-semibold', pct >= 100 ? 'text-rose-600' : 'text-slate-900')}>{used} / {limit}</span>
                  </div>
                  <div
                    className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
                    role="progressbar"
                    aria-label={QUOTA_LABELS[k]}
                    aria-valuemin={0}
                    aria-valuemax={limit}
                    aria-valuenow={used}
                  >
                    <div className={cx('h-full rounded-full', pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};

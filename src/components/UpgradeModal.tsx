import React from 'react';
import { Sparkles, Check } from 'lucide-react';
import { Button, Modal } from './ui';
import { PREMIUM_PRICE, type QuotaEventDetail } from '../data/account';

/** Proposé quand le serveur refuse une action IA (quota du forfait atteint). */
export const UpgradeModal: React.FC<{
  detail: QuotaEventDetail | null;
  onClose: () => void;
  onSeePlans: () => void;
}> = ({ detail, onClose, onSeePlans }) => (
  <Modal open={!!detail} onClose={onClose} title="Limite du mois atteinte" size="sm">
    <div className="space-y-4 px-5 py-5 sm:px-6">
      <p className="text-sm text-slate-700">{detail?.message}</p>
      {detail?.plan !== 'premium' && (
        <>
          <ul className="space-y-2 rounded-xl bg-brand-50 p-4 text-sm text-slate-800">
            {['CV et lettres par le modèle IA le plus avancé', 'Générations et retouches sans compter', 'Sans engagement, résiliable en un clic'].map((t) => (
              <li key={t} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />{t}</li>
            ))}
          </ul>
          <Button variant="primary" size="lg" className="w-full" onClick={onSeePlans}>
            <Sparkles className="h-4 w-4" aria-hidden="true" /> Passer à Premium · {PREMIUM_PRICE}/mois
          </Button>
        </>
      )}
      <Button variant="ghost" size="md" className="w-full" onClick={onClose}>
        {detail?.plan === 'premium' ? 'Compris' : 'Plus tard'}
      </Button>
    </div>
  </Modal>
);

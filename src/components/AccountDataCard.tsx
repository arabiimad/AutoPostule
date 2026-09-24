import React, { useState } from 'react';
import { Download, Trash2, Loader2 } from 'lucide-react';
import { Button } from './ui';
import { deleteAccount, downloadAccountExport } from '../data/account';

/** RGPD : export des données et suppression définitive du compte en ligne. */
export const AccountDataCard: React.FC<{
  email: string;
  onDeleted: () => void;
  showToast?: (title: string, desc: string, error?: boolean) => void;
}> = ({ email, onDeleted, showToast }) => {
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const run = async (kind: 'export' | 'delete') => {
    setBusy(kind);
    try {
      if (kind === 'export') {
        await downloadAccountExport();
        showToast?.('Export prêt', 'Vos données ont été téléchargées (fichier JSON).');
      } else {
        await deleteAccount();
        showToast?.('Compte supprimé', 'Votre compte et toutes vos données ont été effacés.');
        onDeleted();
      }
    } catch (e: any) {
      showToast?.(kind === 'export' ? 'Export impossible' : 'Suppression impossible', e?.message || 'Réessayez.', true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="account-data-title">
      <h2 id="account-data-title" className="text-base font-bold text-slate-900">Mes données</h2>
      <p className="mt-1 text-sm text-slate-600">
        Vos données sont hébergées dans l’Union européenne. Vous pouvez les télécharger ou supprimer votre compte à tout moment.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => run('export')} disabled={!!busy}>
          {busy === 'export' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
          Télécharger mes données
        </Button>
        {!confirming && (
          <Button type="button" variant="danger" onClick={() => setConfirming(true)} disabled={!!busy}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Supprimer mon compte
          </Button>
        )}
      </div>
      {confirming && (
        <div className="mt-4 space-y-3 rounded-xl border border-rose-200 bg-rose-50 p-4" role="alert">
          <p className="text-sm text-rose-800">
            Suppression <strong>définitive</strong> du compte {email} : profil, candidatures, CV et historique. Un abonnement en cours est résilié.
          </p>
          <label className="block text-sm text-rose-900">
            Tapez <strong>SUPPRIMER</strong> pour confirmer
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm"
              autoComplete="off"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" onClick={() => run('delete')} disabled={typed.trim().toUpperCase() !== 'SUPPRIMER' || !!busy}>
              {busy === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
              Supprimer définitivement
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setConfirming(false); setTyped(''); }}>Annuler</Button>
          </div>
        </div>
      )}
    </section>
  );
};

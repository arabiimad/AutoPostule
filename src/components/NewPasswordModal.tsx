import React, { useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import * as cloud from '../data/cloud';
import { Button, Modal } from './ui';

/** Nouveau mot de passe, après le lien « mot de passe oublié » reçu par e-mail. */
export const NewPasswordModal: React.FC<{ onDone: (ok: boolean) => void }> = ({ onDone }) => {
  const uid = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) return setError('8 caractères minimum, avec des lettres et des chiffres.');
    if (password !== confirm) return setError('Les deux mots de passe ne correspondent pas.');
    setBusy(true);
    try {
      await cloud.updatePassword(password);
      onDone(true);
    } catch (err: any) {
      setError(cloud.authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';
  return (
    <Modal open onClose={() => onDone(false)} title="Choisissez un nouveau mot de passe" subtitle="Vous êtes connecté(e) grâce au lien reçu par e-mail." size="md">
      <form onSubmit={submit} className="space-y-3.5 px-5 py-5 sm:px-6">
        {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <label htmlFor={`${uid}-p`} className="block text-sm font-medium text-slate-700">Nouveau mot de passe</label>
        <input id={`${uid}-p`} type="password" autoComplete="new-password" className={input} value={password} onChange={e => setPassword(e.target.value)} />
        <label htmlFor={`${uid}-c`} className="block text-sm font-medium text-slate-700">Confirmez le mot de passe</label>
        <input id={`${uid}-c`} type="password" autoComplete="new-password" className={input} value={confirm} onChange={e => setConfirm(e.target.value)} />
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
          <KeyRound className="h-4 w-4" aria-hidden="true" /> {busy ? 'Enregistrement…' : 'Enregistrer le nouveau mot de passe'}
        </Button>
      </form>
    </Modal>
  );
};

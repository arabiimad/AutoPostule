import React, { useState } from 'react';
import { AlertCircle, Eye, EyeOff, Lock } from 'lucide-react';
import * as cloud from '../data/cloud';
import { Button, Modal, cx } from './ui';
import { passwordProblem } from '../utils/passwordReset';

/**
 * Arrivée par le lien « mot de passe oublié » : choix du nouveau mot de passe.
 * Lien expiré ou déjà utilisé : explication et nouvelle demande.
 */
export const ResetPasswordModal: React.FC<{
  state: cloud.RecoveryState;
  onClose: () => void;
  onDone: () => void;
  onRequestNewLink: () => void;
}> = ({ state, onClose, onDone, onRequestNewLink }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) return setError(problem);
    setError(null);
    setLoading(true);
    try {
      await cloud.updatePassword(password);
      onDone();
    } catch (err: any) {
      setError(cloud.authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-10 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';

  if (state === 'expired') {
    return (
      <Modal open onClose={onClose} title="Lien expiré" subtitle="Ce lien a expiré ou a déjà été utilisé." size="sm">
        <div className="space-y-4 p-5 sm:p-6">
          <p className="text-sm text-slate-600">Pour votre sécurité, un lien de réinitialisation ne sert qu’une fois et pendant une durée limitée. Demandez-en un nouveau : il arrive en quelques instants (pensez aux indésirables).</p>
          <Button variant="primary" size="lg" className="w-full" onClick={onRequestNewLink}>Recevoir un nouveau lien</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Nouveau mot de passe" subtitle="Choisissez le mot de passe de votre compte Kareer." size="sm">
      <form onSubmit={submit} className="space-y-3.5 p-5 sm:p-6">
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
          </p>
        )}
        {[
          { id: 'new-password', label: 'Nouveau mot de passe', value: password, set: setPassword },
          { id: 'confirm-password', label: 'Confirmer le mot de passe', value: confirm, set: setConfirm }
        ].map((f, i) => (
          <div key={f.id}>
            <label htmlFor={f.id} className="mb-1.5 block text-sm font-medium text-slate-700">{f.label}</label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                id={f.id}
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={8}
                autoFocus={i === 0}
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
                className={cx(inputClass)}
              />
              {i === 0 && (
                <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-700">
                  {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              )}
            </div>
          </div>
        ))}
        <p className="text-xs text-slate-500">8 caractères minimum, avec des lettres et des chiffres.</p>
        <Button type="submit" variant="primary" size="lg" disabled={loading} className="w-full">
          {loading ? 'Enregistrement…' : 'Enregistrer le mot de passe'}
        </Button>
      </form>
    </Modal>
  );
};

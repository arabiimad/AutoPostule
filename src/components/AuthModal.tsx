import React, { useState } from 'react';
import * as cloud from '../data/cloud';
import type { AppUser as User } from '../data/cloud';
import {
  Mail,
  Lock,
  User as UserIcon,
  Briefcase,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ArrowRight,
  ShieldCheck
} from 'lucide-react';
import { Button, Modal, cx } from './ui';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** extra : nom / titre saisis à l'inscription. Le profil en ligne est créé par App (un seul écrivain). */
  onSuccess: (user: User, isNewAccount: boolean, extra?: { fullName?: string; title?: string }) => void;
  defaultMode?: 'login' | 'register' | 'forgot';
  /** Pourquoi un compte est demandé (action du visiteur), affiché en sous-titre. */
  reason?: string;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  defaultMode = 'register',
  reason
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(defaultMode);
  
  // Form fields
  const [fullName, setFullName] = useState('');
  const [targetTitle, setTargetTitle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  
  // Status states
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  /** Secondes avant de pouvoir redemander un lien (évite d'atteindre la limite d'e-mails). */
  const [resetCooldown, setResetCooldown] = useState(0);
  React.useEffect(() => {
    if (resetCooldown <= 0) return;
    const t = setTimeout(() => setResetCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resetCooldown]);

  // La fenêtre reste montée : à chaque ouverture, on affiche l'onglet demandé (« Connexion » ou « Créer un compte »)
  React.useEffect(() => {
    if (isOpen) {
      setMode(defaultMode);
      setErrorMessage(null);
      setSuccessNotice(null);
    }
  }, [isOpen, defaultMode]);

  const errorId = React.useId();
  const fieldPrefix = React.useId();
  const fid = (name: string) => `${fieldPrefix}-${name}`;

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setErrorMessage(null);
    setSuccessNotice(null);
    try {
      // Redirection vers Google puis retour sur l'application (session détectée au chargement)
      await cloud.signInWithGoogle();
    } catch (err: any) {
      setErrorMessage(cloud.authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLocalCandidateSession = (providedName?: string, providedEmail?: string) => {
    const candidateName = providedName || fullName.trim() || '';
    const candidateEmail = providedEmail || email.trim() || '';
    const localUser: User = {
      uid: 'local-usr-' + (candidateEmail.replace(/[^a-z0-9]/gi, '') || 'invite'),
      displayName: candidateName,
      email: candidateEmail
    };
    try {
      localStorage.setItem('autopostule_local_user', JSON.stringify({ uid: localUser.uid, displayName: candidateName, email: candidateEmail }));
    } catch (e) {}
    onSuccess(localUser, false, { fullName: candidateName });
    onClose();
  };

  const handleRegisterWithEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    if (!fullName.trim()) {
      setErrorMessage('Veuillez renseigner votre nom complet.');
      return;
    }
    if (!email.trim()) {
      setErrorMessage('Veuillez renseigner votre adresse email.');
      return;
    }
    if (password.length < 8) {
      setErrorMessage('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Les deux mots de passe ne correspondent pas.');
      return;
    }

    setLoading(true);
    try {
      const { user, needsConfirmation } = await cloud.signUp(email.trim(), password, { fullName: fullName.trim(), title: targetTitle.trim() });
      if (needsConfirmation || !user) {
        setMode('login');
        setPassword('');
        setConfirmPassword('');
        setSuccessNotice(`Compte créé. Un lien de confirmation a été envoyé à ${email.trim()} : cliquez dessus puis connectez-vous.`);
        return;
      }
      onSuccess(user, true, { fullName: fullName.trim(), title: targetTitle.trim() });
      onClose();
    } catch (err: any) {
      setErrorMessage(cloud.authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLoginWithEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    if (!email.trim() || !password) {
      setErrorMessage('Veuillez saisir votre email et votre mot de passe.');
      return;
    }

    setLoading(true);
    try {
      const user = await cloud.signIn(email.trim(), password);
      onSuccess(user, false);
      onClose();
    } catch (err: any) {
      setErrorMessage(cloud.authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    if (!email.trim()) {
      setErrorMessage('Veuillez renseigner votre adresse email pour recevoir le lien de réinitialisation.');
      return;
    }

    setLoading(true);
    try {
      await cloud.resetPassword(email.trim());
      setSuccessNotice('Si un compte existe pour cette adresse, un e-mail de réinitialisation vient d’être envoyé. Pensez à vérifier les indésirables.');
      setResetCooldown(60);
    } catch (err: any) {
      setErrorMessage(cloud.authErrorMessage(err));
      const wait = String(err?.message || '').match(/after (\d+) seconds?/i);
      if (wait) setResetCooldown(Number(wait[1]));
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setErrorMessage(null);
  };

  const title =
    mode === 'register' ? 'Créer votre compte' : mode === 'login' ? 'Connexion à votre espace' : 'Mot de passe oublié';
  const subtitle =
    reason && mode !== 'forgot'
      ? reason
      : mode === 'register'
      ? 'Synchronisez vos candidatures, vos CV et votre assistant sur tous vos appareils.'
      : mode === 'login'
        ? 'Retrouvez vos candidatures, vos CV et votre historique.'
        : 'Recevez un lien sécurisé pour définir un nouveau mot de passe.';

  const inputClass =
    'w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';
  const labelClass = 'mb-1.5 block text-sm font-medium text-slate-700';
  const iconClass = 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400';
  const describedBy = errorMessage ? errorId : undefined;

  const PasswordToggle = (
    <button
      type="button"
      onClick={() => setShowPassword(!showPassword)}
      aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
      aria-pressed={showPassword}
      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
    >
      {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
    </button>
  );

  return (
    <Modal open={isOpen} onClose={onClose} title={title} subtitle={subtitle} size="sm">
      <div className="space-y-4 px-5 py-5 sm:px-6">
        {/* Onglets Inscription / Connexion */}
        {cloud.cloudEnabled && mode !== 'forgot' && (
          <div role="group" aria-label="Type d'accès" className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
            {(['register', 'login'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                aria-pressed={mode === m}
                className={cx(
                  'rounded-lg py-2 text-sm font-semibold transition-colors',
                  mode === m ? 'border border-slate-200 bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                )}
              >
                {m === 'register' ? 'Créer un compte' : 'Se connecter'}
              </button>
            ))}
          </div>
        )}

        {/* Connexion Google (si activée dans Supabase) */}
        {cloud.googleAuthEnabled && (<Button type="button" variant="secondary" size="lg" onClick={handleGoogleSignIn} disabled={loading} className="w-full">
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            {/* Logo Google officiel : couleurs de marque fixes, indépendantes du thème */}
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
          </svg>
          Continuer avec Google
        </Button>)}

        {/* Session locale (sans compte) : uniquement quand les comptes en ligne ne sont pas configurés */}
        {!cloud.accountsRequired && <Button type="button" variant="ghost" size="md" onClick={() => handleLocalCandidateSession()} className="w-full border border-dashed border-slate-300">
          <Sparkles className="h-4 w-4 text-brand-600" aria-hidden="true" />
          Continuer sans compte (session locale)
        </Button>}

        {cloud.cloudEnabled ? (
          <div className="flex items-center gap-3" aria-hidden="true">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs font-medium text-slate-400">ou par e-mail</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>
        ) : (
          <p className="text-center text-xs text-slate-500">Comptes en ligne non configurés sur ce serveur : vos données restent dans ce navigateur.</p>
        )}

        {/* Messages */}
        {errorMessage && (
          <div id={errorId} role="alert" className="space-y-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
            {!cloud.accountsRequired && <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => handleLocalCandidateSession()}
              className="w-full"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Utiliser une session locale
            </Button>}
          </div>
        )}

        {successNotice && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            <span>{successNotice}</span>
          </div>
        )}

        {/* Inscription */}
        {cloud.cloudEnabled && mode === 'register' && (
          <form onSubmit={handleRegisterWithEmail} className="space-y-3.5">
            <div>
              <label htmlFor={fid('name')} className={labelClass}>
                Nom et prénom <span className="text-rose-600" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <UserIcon className={iconClass} aria-hidden="true" />
                <input
                  id={fid('name')}
                  type="text"
                  required
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="ex. Ayman Hakim"
                  aria-describedby={describedBy}
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor={fid('title')} className={labelClass}>Poste recherché</label>
              <div className="relative">
                <Briefcase className={iconClass} aria-hidden="true" />
                <input
                  id={fid('title')}
                  type="text"
                  autoComplete="organization-title"
                  value={targetTitle}
                  onChange={(e) => setTargetTitle(e.target.value)}
                  placeholder="ex. Chargé(e) RH, Comptable, Développeur…"
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor={fid('email')} className={labelClass}>
                Adresse e-mail <span className="text-rose-600" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <Mail className={iconClass} aria-hidden="true" />
                <input
                  id={fid('email')}
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="prenom.nom@exemple.com"
                  aria-describedby={describedBy}
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor={fid('password')} className={labelClass}>
                Mot de passe <span className="text-rose-600" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <Lock className={iconClass} aria-hidden="true" />
                <input
                  id={fid('password')}
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8 caractères minimum"
                  aria-describedby={describedBy}
                  className={cx(inputClass, 'pr-10')}
                />
                {PasswordToggle}
              </div>
            </div>

            <div>
              <label htmlFor={fid('confirm')} className={labelClass}>
                Confirmer le mot de passe <span className="text-rose-600" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <Lock className={iconClass} aria-hidden="true" />
                <input
                  id={fid('confirm')}
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Répétez le mot de passe"
                  aria-describedby={describedBy}
                  className={inputClass}
                />
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" disabled={loading} className="w-full">
              {loading ? 'Création du compte…' : 'Créer mon compte'}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </form>
        )}

        {/* Connexion */}
        {cloud.cloudEnabled && mode === 'login' && (
          <form onSubmit={handleLoginWithEmail} className="space-y-3.5">
            <div>
              <label htmlFor={fid('login-email')} className={labelClass}>Adresse e-mail</label>
              <div className="relative">
                <Mail className={iconClass} aria-hidden="true" />
                <input
                  id={fid('login-email')}
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="prenom.nom@exemple.com"
                  aria-describedby={describedBy}
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor={fid('login-password')} className="block text-sm font-medium text-slate-700">Mot de passe</label>
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); setErrorMessage(null); }}
                  className="text-xs font-semibold text-brand-700 hover:text-brand-900"
                >
                  Mot de passe oublié ?
                </button>
              </div>
              <div className="relative">
                <Lock className={iconClass} aria-hidden="true" />
                <input
                  id={fid('login-password')}
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Votre mot de passe"
                  aria-describedby={describedBy}
                  className={cx(inputClass, 'pr-10')}
                />
                {PasswordToggle}
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" disabled={loading} className="w-full">
              {loading ? 'Connexion…' : 'Se connecter'}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </form>
        )}

        {/* Mot de passe oublié */}
        {cloud.cloudEnabled && mode === 'forgot' && (
          <form onSubmit={handleResetPassword} className="space-y-3.5">
            <div>
              <label htmlFor={fid('reset-email')} className={labelClass}>Adresse e-mail du compte</label>
              <div className="relative">
                <Mail className={iconClass} aria-hidden="true" />
                <input
                  id={fid('reset-email')}
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="prenom.nom@exemple.com"
                  aria-describedby={describedBy}
                  className={inputClass}
                />
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" disabled={loading || resetCooldown > 0} className="w-full">
              {loading ? 'Envoi…' : resetCooldown > 0 ? `Nouvel envoi possible dans ${resetCooldown} s` : 'Envoyer le lien de réinitialisation'}
            </Button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => { setMode('login'); setErrorMessage(null); setSuccessNotice(null); }}
                className="text-sm font-semibold text-slate-600 hover:text-brand-700"
              >
                ← Retour à la connexion
              </button>
            </div>
          </form>
        )}

        {/* Sécurité */}
        <div className="flex items-center justify-center gap-2 border-t border-slate-200 pt-3 text-xs text-slate-500">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>Données hébergées dans l’Union européenne, accessibles à vous seul</span>
        </div>
      </div>
    </Modal>
  );
};

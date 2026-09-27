import React from 'react';
import { Check, Lock } from 'lucide-react';
import { Button } from './ui';
import type { TabId } from '../utils/url';

const CONTENT: Partial<Record<TabId, { title: string; text: string; points: string[] }>> = {
  latex: {
    title: 'Studio CV & lettre',
    text: 'Adaptez votre CV et votre lettre à chaque offre, en quelques secondes.',
    points: ['Collez une offre trouvée ailleurs : voyez exactement quoi changer', 'CV reformulé par l’IA sans rien inventer', 'Lettre de motivation sur mesure et PDF prêt à envoyer']
  },
  kanban: {
    title: 'Suivi des candidatures',
    text: 'Toutes vos candidatures au même endroit, de l’offre à la réponse.',
    points: ['Tableau de suivi par étape', 'Rappels de relance au bon moment', 'Statistiques : taux de réponse, sources qui marchent']
  },
  interview: {
    title: 'Préparation aux entretiens',
    text: 'Arrivez préparé à chaque entretien.',
    points: ['Questions probables pour le poste', 'Trames de réponse à partir de votre vrai parcours', 'Entraînement avec évaluation de vos réponses']
  },
  agent: {
    title: 'Assistant de candidature',
    text: 'Préparez plusieurs dossiers d’un coup à partir de vos recherches.',
    points: ['Dossiers prêts à relire', 'Vous gardez la main : rien n’est envoyé sans vous']
  },
  profile: {
    title: 'Votre profil',
    text: 'La base de tous vos CV et lettres.',
    points: ['Import de CV (PDF, Word, image)', 'Profil synchronisé sur tous vos appareils', 'Données hébergées dans l’Union européenne']
  }
};

/** Page affichée à un visiteur sur une fonction réservée aux comptes. */
export const AccountGate: React.FC<{ tab: TabId; onOpenAuthModal: (mode: 'login' | 'register') => void }> = ({ tab, onOpenAuthModal }) => {
  const c = CONTENT[tab] || CONTENT.profile!;
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 text-center" aria-labelledby="gate-title">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><Lock className="h-5 w-5" aria-hidden="true" /></span>
      <h1 id="gate-title" className="mt-4 text-xl font-bold text-slate-900">{c.title}</h1>
      <p className="mt-1.5 text-sm text-slate-600">{c.text}</p>
      <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left">
        {c.points.map((p) => (
          <li key={p} className="flex gap-2 text-sm text-slate-700"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />{p}</li>
        ))}
      </ul>
      <div className="mt-6 flex flex-col sm:flex-row justify-center gap-2">
        <Button variant="primary" size="lg" onClick={() => onOpenAuthModal('register')}>Créer un compte gratuit</Button>
        <Button variant="secondary" size="lg" onClick={() => onOpenAuthModal('login')}>J’ai déjà un compte</Button>
      </div>
      <p className="mt-3 text-xs text-slate-500">Gratuit, sans carte bancaire.</p>
    </section>
  );
};

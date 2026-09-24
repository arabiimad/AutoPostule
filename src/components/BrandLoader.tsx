import React from 'react';
import { KareerMark } from './KareerLogo';

/**
 * Chargement aux couleurs de Kareer : animation du logo de kareer.pro (entrée, étincelles, halo),
 * nom, message et barre de progression. Point unique à modifier pour changer l'animation.
 */
export const BrandLoader: React.FC<{ label: string; className?: string }> = ({ label, className }) => (
  <div role="status" aria-live="polite" className={`kl-loader flex flex-col items-center justify-center gap-4 py-10 text-center ${className || ''}`}>
    <div className="kl-logo-wrapper">
      <KareerMark size={84} animated />
      <div className="kl-glow-ring" aria-hidden="true" />
    </div>
    <div className="flex flex-col items-center gap-1">
      <span className="kl-brand text-2xl font-extrabold tracking-tight text-slate-900">Kareer</span>
      <span className="kl-tagline text-sm font-medium text-slate-600">{label}</span>
    </div>
    <div className="kl-bar" aria-hidden="true"><div className="kl-bar-fill" /></div>
  </div>
);

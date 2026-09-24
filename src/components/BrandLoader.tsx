import React from 'react';

/**
 * Chargement aux couleurs de la marque : logo animé + message.
 * Point unique à remplacer pour changer de logo ou d'animation.
 */
export const BrandLoader: React.FC<{ label: string; className?: string }> = ({ label, className }) => (
  <div role="status" aria-live="polite" className={`flex flex-col items-center justify-center gap-3 py-10 text-center ${className || ''}`}>
    <span className="brand-loader-mark flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-md">
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 17l5-5 4 4 7-8" /><path d="M15 8h5v5" />
      </svg>
    </span>
    <span className="text-sm font-medium text-slate-600">{label}</span>
  </div>
);

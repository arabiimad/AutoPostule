import React from 'react';

/**
 * Logo Kareer (le « K » : flèche montante + chevron), repris de kareer.pro en SVG vectoriel.
 * `animated` : animation d'entrée du site (fond, flèche, chevron, étincelles), puis respiration.
 */
export const KareerMark: React.FC<{ size?: number; className?: string; animated?: boolean; title?: string }> = ({ size = 36, className, animated = false, title }) => (
  <svg
    viewBox="0 0 128 128"
    width={size}
    height={size}
    className={[animated ? 'kl-svg' : '', className || ''].join(' ').trim() || undefined}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
  >
    <rect className={animated ? 'kl-bg' : undefined} x="4" y="4" width="120" height="120" rx="24" fill="#1565C0" />
    <path className={animated ? 'kl-part kl-upper' : undefined} d="M98 22L68 21L67 23L71 29L41 50L38 49L38 23L24 23L23 75L77 41L83 48Z" fill="#FFFFFF" />
    <path className={animated ? 'kl-part kl-lower' : undefined} d="M23 83L24 97L60 74L85 106L103 106L65 56Z" fill="#FFFFFF" />
    {animated && (
      <>
        <circle className="kl-spark kl-s1" cx="92" cy="18" r="0" fill="#fff" />
        <circle className="kl-spark kl-s2" cx="104" cy="28" r="0" fill="#fff" />
        <circle className="kl-spark kl-s3" cx="86" cy="14" r="0" fill="#fff" />
      </>
    )}
  </svg>
);

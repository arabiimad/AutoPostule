import React from 'react';

/** Petites briques d'interface partagées (boutons, badges, avatars, squelettes, états vides). */

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm disabled:bg-brand-300',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 hover:border-slate-400 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:text-slate-300',
  danger: 'bg-white text-rose-600 border border-rose-200 hover:bg-rose-50',
  dark: 'bg-slate-900 text-slate-50 hover:bg-slate-800 shadow-sm disabled:bg-slate-400'
};
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-xl'
};

export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }>(
  ({ variant = 'secondary', size = 'md', className, ...rest }, ref) => (
    <button
      ref={ref}
      {...rest}
      className={cx('inline-flex items-center justify-center font-semibold transition-colors disabled:cursor-not-allowed whitespace-nowrap', VARIANTS[variant], SIZES[size], className)}
    />
  )
);
Button.displayName = 'Button';

export const LinkButton: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }> = ({ variant = 'secondary', size = 'md', className, ...rest }) => (
  <a {...rest} className={cx('inline-flex items-center justify-center font-semibold transition-colors whitespace-nowrap', VARIANTS[variant], SIZES[size], className)} />
);

type Tone = 'neutral' | 'brand' | 'green' | 'amber' | 'rose' | 'sky';
const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  brand: 'bg-brand-50 text-brand-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-800',
  rose: 'bg-rose-50 text-rose-700',
  sky: 'bg-sky-50 text-sky-700'
};

export const Badge: React.FC<{ tone?: Tone; className?: string; children: React.ReactNode; title?: string }> = ({ tone = 'neutral', className, children, title }) => (
  <span title={title} className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium leading-5', TONES[tone], className)}>
    {children}
  </span>
);

/** Avatar d'entreprise : logo si disponible, sinon initiales sur une couleur stable. */
const AVATAR_COLORS = ['bg-brand-100 text-brand-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-700', 'bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700', 'bg-teal-100 text-teal-700'];
export const CompanyAvatar: React.FC<{ name: string; logo?: string; size?: number }> = ({ name, logo, size = 44 }) => {
  const [broken, setBroken] = React.useState(false);
  const initials = (name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const color = AVATAR_COLORS[[...(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const style = { width: size, height: size };
  if (logo && !broken) {
    return (
      <span className="shrink-0 rounded-xl border border-slate-200 bg-white overflow-hidden flex items-center justify-center" style={style}>
        <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="w-full h-full object-contain p-1" />
      </span>
    );
  }
  return (
    <span className={cx('shrink-0 rounded-xl flex items-center justify-center font-bold', color)} style={{ ...style, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {initials}
    </span>
  );
};

/** Pastille de compatibilité (anneau). */
export const MatchRing: React.FC<{ score: number | null; size?: number; label?: boolean }> = ({ score, size = 44, label = false }) => {
  if (score === null) {
    return <span className="text-[11px] font-medium text-slate-400" title="L'offre ne liste pas de compétences">—</span>;
  }
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const color = score >= 70 ? '#059669' : score >= 40 ? '#d97706' : '#94a3b8';
  return (
    <span className="inline-flex items-center gap-2" title={`${score} % des compétences demandées sont dans votre profil`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: 'var(--color-slate-200)' }} strokeWidth="4" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.28} fontWeight="700" style={{ fill: 'var(--color-slate-900)' }}>{score}</text>
      </svg>
      {label && <span className="text-xs text-slate-500 leading-tight">compatibilité<br />avec votre profil</span>}
    </span>
  );
};

export const Skeleton: React.FC<{ className?: string }> = ({ className }) => <div className={cx('skeleton', className)} />;

export const EmptyState: React.FC<{ icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }> = ({ icon, title, children, action }) => (
  <div className="flex flex-col items-center justify-center text-center px-6 py-14">
    {icon && <div className="mb-4 w-12 h-12 rounded-2xl bg-slate-100 text-slate-500 flex items-center justify-center">{icon}</div>}
    <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
    {children && <div className="mt-1.5 text-sm text-slate-500 max-w-md">{children}</div>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const Card: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
  <div className={cx('bg-white border border-slate-200 rounded-2xl', className)}>{children}</div>
);

export const PageHeader: React.FC<{ title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }> = ({ title, subtitle, actions }) => (
  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-6">
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-500 max-w-2xl">{subtitle}</p>}
    </div>
    {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// Fenêtre modale accessible : focus piégé, Échap pour fermer, retour du focus, défilement de page bloqué.
// ---------------------------------------------------------------------------
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Modal: React.FC<{
  open?: boolean;
  onClose: () => void;
  /** Titre lu par les lecteurs d'écran (et affiché si `showHeader`). */
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Largeur maximale : sm (28rem) · md (36rem) · lg (48rem) · xl (64rem) · full (80rem). */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** En-tête standard (titre + bouton fermer). Désactiver pour un en-tête personnalisé. */
  showHeader?: boolean;
  /** Empêche la fermeture par Échap / clic extérieur (ex. onboarding obligatoire). */
  dismissible?: boolean;
  footer?: React.ReactNode;
  className?: string;
}> = ({ open = true, onClose, title, subtitle, children, size = 'lg', showHeader = true, dismissible = true, footer, className }) => {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  // Référence stable : un onClose recréé à chaque rendu du parent ne doit pas redonner le focus au premier champ
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // Focus initial : premier champ, sinon le panneau
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') || panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first || panel)?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, dismissible]);

  if (!open) return null;
  const width = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl', full: 'sm:max-w-7xl' }[size];

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-[2px]" onClick={dismissible ? onClose : undefined} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('relative flex w-full flex-col bg-white shadow-2xl outline-none max-h-[94vh] rounded-t-3xl sm:rounded-2xl', width, className)}
      >
        {showHeader ? (
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 sm:px-6 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
              {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
            </div>
            {dismissible && (
              <button onClick={onClose} aria-label="Fermer" className="-mr-2 rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        ) : (
          <h2 id={titleId} className="sr-only">{title}</h2>
        )}
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 sm:px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
};

/** Onglets accessibles (rôle tablist) pour les modales et pages. */
export const Tabs: React.FC<{ tabs: { id: string; label: React.ReactNode }[]; value: string; onChange: (id: string) => void; className?: string }> = ({ tabs, value, onChange, className }) => (
  <div role="tablist" className={cx('flex gap-1 overflow-x-auto border-b border-slate-200', className ?? 'px-5 sm:px-6')}>
    {tabs.map(t => (
      <button
        key={t.id}
        role="tab"
        aria-selected={value === t.id}
        onClick={() => onChange(t.id)}
        className={cx('relative -mb-px whitespace-nowrap px-3 py-3 text-sm font-medium transition-colors',
          value === t.id ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800')}
      >
        {t.label}
        {value === t.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
      </button>
    ))}
  </div>
);

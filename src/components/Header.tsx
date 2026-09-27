import React, { useState, useRef, useEffect } from 'react';
import { Search, FileText, KanbanSquare, MessagesSquare, UserRound, LogOut, Bot, ChevronDown, Upload, Bell, Sun, Moon, Monitor } from 'lucide-react';
import { getThemePref, setThemePref, type ThemePref } from '../utils/theme';
import { User } from 'firebase/auth';
import { Button, cx } from './ui';

export type TabId = 'radar' | 'latex' | 'agent' | 'kanban' | 'interview' | 'profile';

interface HeaderProps {
  currentTab: TabId;
  setCurrentTab: (tab: TabId) => void;
  currentUser: User | null;
  onOpenAuthModal: (mode: 'login' | 'register') => void;
  onLogout: () => void;
  onOpenCvUpload?: () => void;
  autoApplyActive: boolean;
  appliedCount: number;
  interviewCount: number;
  /** Candidatures déposées sans réponse dont la date de relance est passée. */
  followUpDueCount?: number;
  /** Nombre total de candidatures suivies (badge de l'onglet). */
  applicationsCount?: number;
  /** Nouvelles offres trouvées par les alertes. */
  alertsNewCount?: number;
}

const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark'];
const THEME_META: Record<ThemePref, { label: string; icon: React.ElementType }> = {
  system: { label: 'Thème : automatique (système)', icon: Monitor },
  light: { label: 'Thème : clair', icon: Sun },
  dark: { label: 'Thème : sombre', icon: Moon }
};

/** Bouton de thème : automatique → clair → sombre. */
const ThemeButton: React.FC = () => {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref());
  const { label, icon: Icon } = THEME_META[pref];
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(pref) + 1) % THEME_CYCLE.length];
  return (
    <button
      onClick={() => { setThemePref(next); setPref(next); }}
      title={`${label} — cliquer pour passer au thème ${next === 'system' ? 'automatique' : next === 'light' ? 'clair' : 'sombre'}`}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
};

const TABS: { id: TabId; label: string; short: string; icon: React.ElementType }[] = [
  { id: 'radar', label: 'Offres', short: 'Offres', icon: Search },
  { id: 'kanban', label: 'Candidatures', short: 'Suivi', icon: KanbanSquare },
  { id: 'interview', label: 'Entretiens', short: 'Entretiens', icon: MessagesSquare },
  { id: 'agent', label: 'Assistant', short: 'Assistant', icon: Bot },
  { id: 'latex', label: 'Studio CV', short: 'CV', icon: FileText },
  { id: 'profile', label: 'Profil', short: 'Profil', icon: UserRound }
];

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  setCurrentTab,
  currentUser,
  onOpenAuthModal,
  onLogout,
  onOpenCvUpload,
  followUpDueCount = 0,
  applicationsCount = 0,
  alertsNewCount = 0
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const displayName = currentUser?.displayName || currentUser?.email?.split('@')[0] || '';
  const initial = (displayName || 'U')[0].toUpperCase();
  const isLocal = !!currentUser && currentUser.uid.startsWith('local-');

  const tabBadge = (id: TabId) =>
    id === 'radar' && alertsNewCount > 0 ? (
      <span className="ml-1 rounded-full bg-brand-600 px-1.5 text-[10px] font-bold leading-4 text-white" title={`${alertsNewCount} nouvelle(s) offre(s) pour vos alertes`}>{alertsNewCount}</span>
    ) : id === 'kanban' && followUpDueCount > 0 ? (
      <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold leading-4 text-white" title={`${followUpDueCount} relance(s) à faire`}>{followUpDueCount}</span>
    ) : id === 'kanban' && applicationsCount > 0 ? (
      <span className="ml-1 rounded-full bg-slate-200 px-1.5 text-[10px] font-semibold leading-4 text-slate-700">{applicationsCount}</span>
    ) : null;

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 xl:gap-6 px-4 sm:px-6 lg:px-8">
          <button onClick={() => setCurrentTab('radar')} className="flex items-center gap-2.5 shrink-0" aria-label="Kareer — accueil">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 17l5-5 4 4 7-8" /><path d="M15 8h5v5" />
              </svg>
            </span>
            <span className="text-[17px] font-extrabold tracking-tight text-slate-900">Kareer</span>
          </button>

          <nav className="hidden lg:flex items-center h-full" aria-label="Navigation principale">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = currentTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setCurrentTab(id)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'relative flex h-full items-center gap-2 px-2.5 xl:px-3 text-sm font-medium whitespace-nowrap transition-colors',
                    active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-900'
                  )}
                >
                  <Icon className="h-4 w-4 hidden 2xl:block" />
                  {label}
                  {tabBadge(id)}
                  {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-600" />}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2" ref={menuRef}>
            <ThemeButton />
            {followUpDueCount > 0 && (
              <button
                onClick={() => setCurrentTab('kanban')}
                className="hidden sm:flex items-center gap-1.5 rounded-full bg-amber-50 px-3 h-8 text-xs font-semibold text-amber-800 hover:bg-amber-100"
              >
                <Bell className="h-3.5 w-3.5" /> {followUpDueCount} à relancer
              </button>
            )}
            {onOpenCvUpload && (
              <span className="hidden sm:block">
                <Button variant="secondary" size="sm" onClick={onOpenCvUpload}>
                  <Upload className="h-3.5 w-3.5" /> <span className="hidden xl:inline">Importer mon CV</span><span className="xl:hidden">CV</span>
                </Button>
              </span>
            )}

            {currentUser ? (
              <div className="relative">
                <button
                  onClick={() => setMenuOpen(o => !o)}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="flex items-center gap-2 rounded-full border border-slate-200 py-1 pl-1 pr-2.5 hover:bg-slate-50"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">{initial}</span>
                  <span className="hidden md:block max-w-[140px] truncate text-sm font-medium text-slate-700">{displayName || 'Mon compte'}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                </button>
                {menuOpen && (
                  <div role="menu" className="absolute right-0 mt-2 w-64 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl">
                    <div className="px-3 py-2.5 border-b border-slate-100 mb-1">
                      <p className="truncate text-sm font-semibold text-slate-900">{displayName || 'Mon compte'}</p>
                      {currentUser.email && <p className="truncate text-xs text-slate-500">{currentUser.email}</p>}
                      <p className="mt-1.5 text-[11px] font-medium text-slate-500">{isLocal ? 'Session locale (ce navigateur)' : 'Données synchronisées'}</p>
                    </div>
                    {onOpenCvUpload && (
                      <button role="menuitem" onClick={() => { onOpenCvUpload(); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                        <Upload className="h-4 w-4 text-slate-400" /> Importer un CV
                      </button>
                    )}
                    <button role="menuitem" onClick={() => { setCurrentTab('profile'); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                      <UserRound className="h-4 w-4 text-slate-400" /> Mon profil
                    </button>
                    <div className="my-1 border-t border-slate-100" />
                    <button role="menuitem" onClick={() => { onLogout(); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50">
                      <LogOut className="h-4 w-4" /> Se déconnecter
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => onOpenAuthModal('login')}>Connexion</Button>
                <span className="hidden sm:block">
                  <Button variant="primary" size="sm" onClick={() => onOpenAuthModal('register')}>Créer un compte</Button>
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Barre d'onglets mobile (bas d'écran) */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]" aria-label="Navigation">
        <div className="grid grid-cols-6">
          {TABS.map(({ id, short, icon: Icon }) => {
            const active = currentTab === id;
            return (
              <button key={id} onClick={() => setCurrentTab(id)} aria-current={active ? 'page' : undefined}
                className={cx('relative flex flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium', active ? 'text-brand-700' : 'text-slate-500')}>
                <Icon className="h-5 w-5" />
                {short}
                {id === 'kanban' && followUpDueCount > 0 && <span className="absolute top-1.5 right-[28%] h-2 w-2 rounded-full bg-amber-500" aria-label="Relances à faire" />}
                {id === 'radar' && alertsNewCount > 0 && <span className="absolute top-1.5 right-[28%] h-2 w-2 rounded-full bg-brand-600" aria-label="Nouvelles offres" />}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};

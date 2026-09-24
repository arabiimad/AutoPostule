/** Thème clair / sombre / système, mémorisé par navigateur. */
export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'autopostule_theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b0f17' : '#ffffff');
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* stockage indisponible */
  }
  applyTheme(pref);
}

/** Suit le réglage du système quand le thème est « système ». */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const on = () => getThemePref() === 'system' && applyTheme('system');
  mq.addEventListener('change', on);
  return () => mq.removeEventListener('change', on);
}

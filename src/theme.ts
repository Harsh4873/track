type Theme = 'light' | 'dark';

const storageKey = 'track-theme';
const backgrounds: Record<Theme, string> = { dark: '#101719', light: '#f6f4ef' };
let chosen: Theme | null = null;

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function activeTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function labelToggle(toggle: HTMLButtonElement, theme: Theme) {
  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} mode`;
  // U+FE0E keeps the sun a text glyph instead of a color emoji.
  toggle.textContent = theme === 'light' ? '☾' : '☀\uFE0E';
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => { meta.content = backgrounds[theme]; });
  document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach((toggle) => labelToggle(toggle, theme));
}

export function initTheme() {
  const system = window.matchMedia('(prefers-color-scheme: light)');
  chosen = storedTheme();
  applyTheme(chosen ?? (system.matches ? 'light' : 'dark'));
  system.addEventListener('change', (event) => { if (!chosen) applyTheme(event.matches ? 'light' : 'dark'); });
}

export function themeToggle(): HTMLButtonElement {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'theme-toggle';
  toggle.className = 'button button-quiet theme-toggle';
  labelToggle(toggle, activeTheme());
  toggle.addEventListener('click', () => {
    chosen = activeTheme() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(storageKey, chosen); } catch { /* Blocked storage still allows switching until reload. */ }
    applyTheme(chosen);
  });
  return toggle;
}

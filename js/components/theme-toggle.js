/**
 * Robayer WealthLab: Theme Toggle Component
 *
 * Applies data-theme="dark"/"light" to <html> and remembers the choice
 * in localStorage. The toggle button lives in partials/header.html, so
 * this runs after the header partial has been injected into the page.
 *
 * Known limitation: since there's no shared <head> partial, this runs
 * after the page's own scripts rather than as a head-blocking inline
 * script, so a returning dark-mode visitor may see a brief light-mode
 * flash on navigation before this applies the stored preference.
 */

const THEME_STORAGE_KEY = 'robayer-theme';

function applyStoredTheme() {
  if (localStorage.getItem(THEME_STORAGE_KEY) === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

function initThemeToggle() {
  const toggle = document.querySelector('[data-theme-toggle]');
  if (!toggle) return;

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  toggle.setAttribute('aria-pressed', String(isDark));

  toggle.addEventListener('click', () => {
    const nowDark = document.documentElement.getAttribute('data-theme') !== 'dark';
    document.documentElement.setAttribute('data-theme', nowDark ? 'dark' : 'light');
    toggle.setAttribute('aria-pressed', String(nowDark));
    localStorage.setItem(THEME_STORAGE_KEY, nowDark ? 'dark' : 'light');
  });
}

applyStoredTheme();
document.addEventListener('partials:loaded', initThemeToggle);

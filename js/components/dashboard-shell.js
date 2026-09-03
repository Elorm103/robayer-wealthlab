/**
 * Robayer WealthLab: Dashboard Shell Component — Version 3.1 Milestone
 * M3 (Checkout Auto-Provisioning & Dashboard MVP).
 *
 * Pure UI behavior for the nav every /dashboard/* page shares (email
 * display, active-link marking, logout) — never calls the API itself
 * except via `CustomerDashboard.requireSession()` for the one real
 * session check every page needs. Direct mirror of
 * js/components/admin/admin-shell.js.
 *
 * Runs on `partials:loaded` (the nav is a partial, per js/includes.js)
 * and is the actual authentication gate: nothing below the nav renders
 * as usable until `requireSession()` resolves — a missing/expired
 * session redirects to sign-in before this function does anything else.
 *
 * Exception: a page whose own `<body>` carries `data-optional-auth`
 * (currently only affiliate/index.html, the public /affiliate/ landing
 * page) uses the non-redirecting `getSessionOrNull()` instead, and
 * fires `dashboard:ready` only when a real session exists, otherwise it
 * fires `dashboard:guest` and returns, so the page itself decides what
 * a logged-out visitor sees instead of being bounced to sign-in.
 *
 * Deliberately read from `document.body`, a given page's own static
 * markup, never from `.dashboard-nav` itself: the nav is a single
 * shared partial (partials/affiliate-nav.html) included identically by
 * every /affiliate/* page, so an attribute placed there would apply to
 * all of them at once. A production regression shipped exactly that
 * way once (the nav partial carried the attribute directly), which
 * silently switched affiliate/links/, affiliate/resources/, and
 * affiliate/earnings/ over to the non-redirecting path too: those pages
 * never dispatch or listen for `dashboard:guest`, so a logged-out
 * visitor to any of them saw a permanently stuck "Loading..." screen
 * instead of the intended sign-in redirect. Keying off `document.body`
 * instead scopes the exception to the one page that actually opts in,
 * with no risk of a shared include silently widening it again. Every
 * other /dashboard/* and /admin/ page, and every other /affiliate/*
 * page, behaves exactly as before: hard redirect via `requireSession()`.
 */

async function initDashboardShell() {
  const nav = document.querySelector('.dashboard-nav');
  if (!nav || nav.hasAttribute('data-bound')) return;
  nav.setAttribute('data-bound', 'true');

  const optionalAuth = document.body.hasAttribute('data-optional-auth');
  const session = optionalAuth ? await window.CustomerDashboard.getSessionOrNull() : await window.CustomerDashboard.requireSession();
  // requireSession() never resolves after issuing a redirect, so
  // reaching this line in the non-optional path means we have a real,
  // currently-valid session.

  if (optionalAuth && !session) {
    nav.hidden = true;
    document.dispatchEvent(new CustomEvent('dashboard:guest'));
    return;
  }

  renderEmail(session);
  markActiveNavLink();
  initLogout();

  document.dispatchEvent(new CustomEvent('dashboard:ready', { detail: session }));
}

function renderEmail(session) {
  const emailEl = document.querySelector('[data-dashboard-nav-email]');
  if (emailEl) emailEl.textContent = session.email;
}

function initLogout() {
  const button = document.querySelector('[data-dashboard-nav-logout]');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    await window.CustomerDashboard.logout();
  });
}

/** Mirrors js/components/admin/admin-shell.js's own markActiveNavLink() exactly, applied to the dashboard nav instead of the admin sidebar. */
function markActiveNavLink() {
  const currentPath = window.location.pathname.replace(/index\.html$/, '');
  document.querySelectorAll('[data-dashboard-nav-link]').forEach((link) => {
    const linkPath = new URL(link.href, window.location.origin).pathname;
    if (linkPath === currentPath) {
      link.setAttribute('aria-current', 'page');
    }
  });
}

document.addEventListener('partials:loaded', initDashboardShell);

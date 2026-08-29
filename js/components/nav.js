/**
 * Robayer WealthLab: Navigation Component
 *
 * Handles the mobile menu toggle and marks the current page's nav link
 * as active. Runs after the header partial has been injected into the
 * page (listens for the `partials:loaded` event fired by includes.js).
 */

function initNav() {
  const toggle = document.querySelector('.nav__toggle');
  const menu = document.querySelector('.nav__menu');

  if (!toggle || !menu) return; // header partial not present on this page

  function openMenu() {
    menu.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    const firstLink = menu.querySelector('a');
    if (firstLink) firstLink.focus();
  }

  function closeMenu() {
    menu.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    isOpen ? closeMenu() : openMenu();
  }

  toggle.addEventListener('click', toggleMenu);

  // Close on Escape
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      toggle.focus();
    }
  });

  // Close when a nav link is chosen (mobile)
  menu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closeMenu);
  });

  // Close when clicking outside the open menu
  document.addEventListener('click', (event) => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    if (isOpen && !menu.contains(event.target) && !toggle.contains(event.target)) {
      closeMenu();
    }
  });

  // Reset to desktop state on resize past the mobile breakpoint
  // (must match the @media breakpoint in .nav__toggle, components.css —
  // 1199px as of the Header/Typography Modernisation pass, reverted
  // from 1439px now that the "More" disclosure shrank the nav back
  // down to the shared breakpoint. Regression caught in the final
  // audit: this value is NOT css/tokens.css-driven — no custom
  // property can be read inside a media query feature test — so it
  // has to be kept in sync by hand with components.css's own
  // @media (max-width: 1199px) block above the mobile nav rules.
  // Leaving this stale after a breakpoint change is a real, reproducible
  // bug, not just a comment going out of date: resize narrow -> a width
  // inside the old-but-not-new mobile range (e.g. 1199 -> 1300 -> 1199)
  // would leave the menu's `.is-open` class never cleared, so the panel
  // would silently render already-open the next time the viewport
  // crossed back under the real 1199px breakpoint, with no click ever
  // having happened.)
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1199) {
      closeMenu();
    }
  });

  // Mark the current page's link as active for assistive tech and styling
  const currentPath = window.location.pathname.replace(/index\.html$/, '');
  menu.querySelectorAll('a').forEach((link) => {
    const linkPath = new URL(link.href, window.location.origin).pathname;
    if (linkPath === currentPath) {
      link.setAttribute('aria-current', 'page');
    }
  });

  // Add a subtle shadow to the sticky header once the page has scrolled
  const header = document.querySelector('.site-header');
  if (header) {
    const updateScrolledState = () => {
      header.classList.toggle('site-header--scrolled', window.scrollY > 8);
    };
    updateScrolledState();
    window.addEventListener('scroll', updateScrolledState, { passive: true });
  }

  initMoreDisclosure();
  initLibraryNavLink();
}

/**
 * Phase 9B (Library Discoverability) — swaps the header's "Sign In"
 * link to "My Library" for an already-authenticated visitor, on every
 * page site-wide, not just /dashboard/*. The customer_session cookie
 * is httpOnly (see backend/routes/customer/auth.ts), so this can't be
 * read directly - a real request to the same GET
 * /api/customer/auth/session endpoint js/components/dashboard-auth.js
 * already uses is the only way to know. Cached in sessionStorage for a
 * few minutes (same storage mechanism js/components/analytics.js
 * already uses for its own session id, applied here to a new purpose)
 * so a customer clicking through several pages doesn't trigger a fresh
 * request on every single one. Never blocks or delays navigation: the
 * link's real, working default href/text (set directly in
 * partials/header.html) is correct for the common case (not signed
 * in) before this ever resolves, and any failure here (network error,
 * sessionStorage unavailable in a private window) just leaves that
 * default in place rather than breaking anything.
 */
const LIBRARY_LINK_CACHE_KEY = 'robayer_library_link_state';
const LIBRARY_LINK_CACHE_TTL_MS = 5 * 60 * 1000;

function readCachedLibraryLinkState() {
  try {
    const raw = sessionStorage.getItem(LIBRARY_LINK_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.signedIn !== 'boolean' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > LIBRARY_LINK_CACHE_TTL_MS) return null;
    return parsed.signedIn;
  } catch {
    return null;
  }
}

function writeCachedLibraryLinkState(signedIn) {
  try {
    sessionStorage.setItem(LIBRARY_LINK_CACHE_KEY, JSON.stringify({ signedIn, at: Date.now() }));
  } catch {
    // sessionStorage unavailable (private browsing, quota) - simply
    // means the next page load re-checks instead of using a cached
    // value; never worth failing navigation over.
  }
}

function applyLibraryLinkState(link, signedIn) {
  if (signedIn) {
    link.href = '/dashboard/';
    link.textContent = 'My Library';
  } else {
    link.href = '/checkout/sign-in/';
    link.textContent = 'Sign In';
  }
}

async function initLibraryNavLink() {
  const link = document.querySelector('[data-nav-library-link]');
  if (!link) return;

  const cached = readCachedLibraryLinkState();
  if (cached !== null) {
    applyLibraryLinkState(link, cached);
    return;
  }

  let signedIn = false;
  try {
    const response = await fetch('/api/customer/auth/session');
    signedIn = response.ok;
  } catch {
    signedIn = false; // network error - the link's own safe default already covers this case
  }
  writeCachedLibraryLinkState(signedIn);
  applyLibraryLinkState(link, signedIn);
}

/**
 * Header/Typography Modernisation — the desktop "More" nav disclosure.
 * Pure CSS already handles the mouse-hover reveal (:hover/:focus-within
 * on .nav__more in components.css, with a zero-gap padding bridge so
 * the pointer never has to leave the hoverable box to reach the
 * panel). This only adds what CSS can't: an explicit open/close state
 * for click, tap, and keyboard activation (touch devices have no real
 * :hover; a keyboard user tabbing to the trigger and pressing Enter/
 * Space needs the same reveal a mouse hover gives for free) — plus
 * Escape-to-close and click-outside-to-close, matching the exact same
 * pattern the mobile menu above already uses for its own toggle.
 */
function initMoreDisclosure() {
  const trigger = document.querySelector('.nav__more-trigger');
  const panel = document.querySelector('.nav__more-panel');
  if (!trigger || !panel) return; // not present on this page's header state

  function openPanel() {
    panel.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    panel.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  function isPanelOpen() {
    return trigger.getAttribute('aria-expanded') === 'true';
  }

  // Native <button> already fires this `click` handler for mouse,
  // touch, and keyboard Enter/Space activation alike — no separate
  // keydown handler needed for opening.
  trigger.addEventListener('click', () => {
    isPanelOpen() ? closePanel() : openPanel();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isPanelOpen()) {
      closePanel();
      trigger.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (isPanelOpen() && !panel.contains(event.target) && !trigger.contains(event.target)) {
      closePanel();
    }
  });

  // Choosing a link inside the panel closes it immediately, same as
  // the mobile menu's own link-click behavior above.
  panel.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closePanel);
  });

  // Tabbing all the way past the panel's last link (without pressing
  // Escape or clicking) should close it too, so keyboard focus moving
  // on to the rest of the page doesn't leave a stale open dropdown
  // behind it.
  panel.addEventListener('focusout', (event) => {
    if (!panel.contains(event.relatedTarget) && event.relatedTarget !== trigger) {
      closePanel();
    }
  });
}

document.addEventListener('partials:loaded', initNav);

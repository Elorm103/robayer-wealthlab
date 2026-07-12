/**
 * Robayer WealthLab — Admin Shell Component
 *
 * Pure UI behavior for the sidebar/topbar every protected admin page
 * shares (sidebar collapse, mobile off-canvas nav, user-menu dropdown,
 * active-link marking, page title/breadcrumb) — never calls the API
 * itself except via `AdminAuth.requireSession()` for the one real
 * session check every page needs, mirroring how js/components/nav.js
 * is pure UI while js/components/newsletter-form.js does the one real
 * fetch its page needs.
 *
 * Runs on `partials:loaded` (the sidebar/topbar are partials, per
 * js/includes.js) and is the actual authentication gate: nothing below
 * the shell renders as usable until `requireSession()` resolves — a
 * 401 redirects to login before this function does anything else.
 */

async function initAdminShell() {
  const shell = document.querySelector('.admin-shell');
  if (!shell || shell.hasAttribute('data-bound')) return;
  shell.setAttribute('data-bound', 'true');

  const session = await window.AdminAuth.requireSession();
  // requireSession() never resolves after issuing a redirect, so
  // reaching this line means we have a real, currently-valid session.

  renderUserMenu(session);
  initSidebarCollapse(shell);
  initMobileNav(shell);
  initUserMenuDropdown();
  initLogout();
  markActiveNavLink();
  setPageTitle();
}

function renderUserMenu(session) {
  const nameEl = document.querySelector('[data-admin-user-name]');
  const roleEl = document.querySelector('[data-admin-user-role]');
  const avatarEl = document.querySelector('[data-admin-user-initial]');

  const displayName = session.name || session.email;
  if (nameEl) nameEl.textContent = displayName;
  if (roleEl) roleEl.textContent = session.role.replace('_', ' ');
  if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();
}

const SIDEBAR_COLLAPSE_KEY = 'robayer-admin-sidebar-collapsed';

function initSidebarCollapse(shell) {
  const toggle = document.querySelector('[data-admin-sidebar-toggle]');
  if (!toggle) return;

  if (localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === 'true') {
    shell.setAttribute('data-sidebar-collapsed', 'true');
  }

  toggle.addEventListener('click', () => {
    const collapsed = shell.getAttribute('data-sidebar-collapsed') === 'true';
    shell.setAttribute('data-sidebar-collapsed', String(!collapsed));
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(!collapsed));
  });
}

function initMobileNav(shell) {
  const menuToggle = document.querySelector('[data-admin-menu-toggle]');
  const sidebar = document.querySelector('[data-admin-sidebar]') || shell.querySelector('.admin-sidebar');
  const backdrop = document.querySelector('[data-admin-sidebar-backdrop]');
  if (!menuToggle || !sidebar || !backdrop) return;

  function openNav() {
    sidebar.classList.add('is-open');
    backdrop.classList.add('is-visible');
    menuToggle.setAttribute('aria-expanded', 'true');
  }

  function closeNav() {
    sidebar.classList.remove('is-open');
    backdrop.classList.remove('is-visible');
    menuToggle.setAttribute('aria-expanded', 'false');
  }

  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    isOpen ? closeNav() : openNav();
  });

  backdrop.addEventListener('click', closeNav);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') {
      closeNav();
      menuToggle.focus();
    }
  });

  sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeNav));

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 1200) closeNav();
  });
}

function initUserMenuDropdown() {
  const trigger = document.querySelector('[data-admin-user-menu-trigger]');
  const menu = document.querySelector('[data-admin-user-menu-dropdown]');
  if (!trigger || !menu) return;

  function open() {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  function close() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.hidden ? open() : close();
  });

  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      close();
      trigger.focus();
    }
  });
}

function initLogout() {
  const button = document.querySelector('[data-admin-logout]');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    await window.AdminAuth.logout();
  });
}

/** Mirrors js/components/nav.js's own current-page matching exactly, applied to the admin sidebar instead of the public nav. */
function markActiveNavLink() {
  const currentPath = window.location.pathname.replace(/index\.html$/, '');
  document.querySelectorAll('[data-admin-nav-link]').forEach((link) => {
    const linkPath = new URL(link.href, window.location.origin).pathname;
    if (linkPath === currentPath) {
      link.setAttribute('aria-current', 'page');
    }
  });
}

/** Page title/breadcrumb come from <title> (already correct per page) rather than a duplicated data attribute — "Products | Robayer WealthLab Admin" -> "Products". */
function setPageTitle() {
  const pageName = document.title.split('|')[0].trim();
  if (!pageName) return;

  const titleEl = document.querySelector('[data-admin-page-title]');
  const breadcrumbEl = document.querySelector('[data-admin-breadcrumb-current]');
  if (titleEl) titleEl.textContent = pageName;
  if (breadcrumbEl) breadcrumbEl.textContent = pageName;
}

document.addEventListener('partials:loaded', initAdminShell);

/**
 * Robayer WealthLab — Navigation Component
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
  window.addEventListener('resize', () => {
    if (window.innerWidth > 767) {
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
}

document.addEventListener('partials:loaded', initNav);

/**
 * Robayer WealthLab — Site-wide Announcement Strip (Phase C).
 *
 * Progressive enhancement for [data-announcement-root] (see
 * partials/header.html). Fetches the public, unauthenticated
 * GET /api/announcement and shows the strip only when the admin has
 * genuinely enabled one — the element stays [hidden] otherwise, so a
 * fetch failure or a disabled announcement never leaves an empty bar
 * on the page (same fail-safe philosophy as js/content-inject.js).
 *
 * Dismissal is versioned, not a single permanent boolean: the stored
 * key includes the announcement's own `version` (site_settings'
 * updated_at, from services/admin/settingsService.ts's
 * getAnnouncement()), so dismissing today's announcement never hides
 * a different one the admin publishes later — see this project's own
 * explicit requirement on why a flat `announcementDismissed = true`
 * would be wrong. Mirrors dashboard-activation.js's localStorage
 * dismiss pattern, kept as its own small file rather than sharing code
 * with that dashboard-only component, since the two are deliberately
 * decoupled (site-wide vs. dashboard-specific — see this file's own
 * header reasoning in the implementation report).
 */

const ANNOUNCEMENT_API_URL = '/api/announcement';
const DISMISSED_KEY_PREFIX = 'robayer_announcement_dismissed:';

function initSiteAnnouncement() {
  const root = document.querySelector('[data-announcement-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    title: root.querySelector('[data-announcement-title]'),
    message: root.querySelector('[data-announcement-message]'),
    button: root.querySelector('[data-announcement-button]'),
    dismiss: root.querySelector('[data-announcement-dismiss]'),
  };

  load();

  async function load() {
    let announcement;
    try {
      const response = await fetch(ANNOUNCEMENT_API_URL);
      if (!response.ok) return;
      const body = await response.json();
      if (!body || !body.success || !body.data) return;
      announcement = body.data;
    } catch (error) {
      console.error(error);
      return;
    }

    if (!announcement.enabled) return;
    // No real content configured — nothing to show, matches
    // getAnnouncement()'s own safe-default shape when never set.
    if (!announcement.title && !announcement.message) return;

    const dismissKey = announcement.version ? `${DISMISSED_KEY_PREFIX}${announcement.version}` : null;
    if (announcement.dismissible && dismissKey) {
      let alreadyDismissed = false;
      try {
        alreadyDismissed = localStorage.getItem(dismissKey) === '1';
      } catch {
        // Private browsing / storage disabled — treat as not dismissed.
      }
      if (alreadyDismissed) return;
    }

    render(announcement, dismissKey);
  }

  function render(announcement, dismissKey) {
    root.className = `site-announcement site-announcement--${announcement.type}`;

    els.title.textContent = announcement.title;
    els.message.textContent = announcement.message ? ` ${announcement.message}` : '';

    if (announcement.buttonText && announcement.buttonUrl) {
      els.button.textContent = announcement.buttonText;
      els.button.href = announcement.buttonUrl;
      els.button.hidden = false;
    }

    if (announcement.dismissible) {
      els.dismiss.hidden = false;
      els.dismiss.addEventListener('click', () => {
        if (dismissKey) {
          try {
            localStorage.setItem(dismissKey, '1');
          } catch {
            // Best-effort only — worst case it reappears next load.
          }
        }
        root.hidden = true;
      });
    }

    root.hidden = false;
  }
}

// This file is itself loaded dynamically, after DOMContentLoaded (see
// js/main.js's loadSiteAnnouncement()) — unlike a script present in the
// initial parsed markup, there is no guarantee 'partials:loaded' hasn't
// already fired by the time this executes (a real race, not a
// hypothetical one: includes.js's own fetch can resolve before this
// dynamically-inserted script finishes loading). Checking immediately
// covers "already fired"; the listener covers "not yet fired" — both
// paths funnel through initSiteAnnouncement()'s own data-bound guard,
// so running both is always safe, never a double-init.
if (document.querySelector('[data-announcement-root]')) {
  initSiteAnnouncement();
}
document.addEventListener('partials:loaded', initSiteAnnouncement);

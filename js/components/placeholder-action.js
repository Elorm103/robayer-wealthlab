/**
 * Robayer WealthLab: Placeholder Action Component
 *
 * Generic click-intercept for buttons/links whose real backend isn't
 * wired up yet (e.g. resource downloads before real files exist).
 * Reveals a note next to the element instead of behaving like a dead
 * link or silent no-op, same progressive-enhancement pattern as
 * newsletter-form.js and Sprint 3's buy-button.js, generalized so any
 * future "not built yet" action can reuse it via [data-message].
 */

function initPlaceholderActions() {
  document.querySelectorAll('[data-placeholder-action]:not([data-bound])').forEach((el) => {
    el.setAttribute('data-bound', 'true');
    el.addEventListener('click', (event) => {
      event.preventDefault();
      if (el.nextElementSibling && el.nextElementSibling.hasAttribute('data-placeholder-note')) return;

      const message = el.getAttribute('data-message') ||
        'This isn\'t connected yet. <a href="/newsletter/">Subscribe</a> to know when it is.';

      const note = document.createElement('p');
      note.setAttribute('data-placeholder-note', 'true');
      note.setAttribute('role', 'status');
      note.className = 'alert alert--info mt-3';
      note.innerHTML = message;
      el.insertAdjacentElement('afterend', note);
    });
  });
}

document.addEventListener('DOMContentLoaded', initPlaceholderActions);

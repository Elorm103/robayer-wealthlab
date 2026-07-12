/**
 * Robayer WealthLab — Newsletter Form Component
 *
 * Progressive enhancement for any form marked [data-newsletter-form].
 * On submit: validates the email client-side, then POSTs to the
 * Cloudflare Worker backend (Version 1.2 Sprint 3, POST /api/newsletter)
 * and swaps the form for a confirmation message. A failed request
 * (network error, rate limit, server error) shows a retryable error
 * alert instead, leaving the form in place so the visitor can try again.
 */

// Relative — the frontend and Worker API are same-origin (Cloudflare
// Workers Route on robayerwealthlab.com/api/*, see backend/wrangler.jsonc
// and docs/v2-same-origin-migration-audit.md).
const NEWSLETTER_API_URL = '/api/newsletter';

function initNewsletterForms() {
  const forms = document.querySelectorAll('[data-newsletter-form]:not([data-bound])');

  forms.forEach((form) => {
    form.setAttribute('data-bound', 'true');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const input = form.querySelector('input[type="email"]');
      const errorEl = form.querySelector('.field__error');
      const email = input ? input.value.trim() : '';
      const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!isValid) {
        form.classList.add('field--error');
        if (errorEl) errorEl.hidden = false;
        input.focus();
        return;
      }

      form.classList.remove('field--error');
      if (errorEl) errorEl.hidden = true;
      clearServerError(form);

      const submitButton = form.querySelector('[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      try {
        const response = await fetch(NEWSLETTER_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, source: window.location.pathname }),
        });
        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error((result && result.error && result.error.message) || 'Something went wrong. Please try again.');
        }

        showConfirmation(form);
      } catch (error) {
        // fetch() itself throws a TypeError on a network/CORS failure —
        // its message ("Failed to fetch") is a browser-internal string,
        // not something to show a visitor. Any other error here was
        // deliberately thrown above with a message the server or this
        // file already wrote to be user-facing.
        const message = error instanceof TypeError
          ? 'Could not reach the server. Please check your connection and try again.'
          : error.message;
        showServerError(form, message);
        if (submitButton) submitButton.disabled = false;
      }
    });
  });

  function showConfirmation(form) {
    // Optional per-form override (e.g. the /free-guide/ landing page
    // wants "Check your email..." instead of the sitewide default) —
    // every existing form without this attribute keeps today's exact
    // message, unchanged.
    const customMessage = form.getAttribute('data-confirmation-message');
    const confirmation = document.createElement('p');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.textContent = customMessage || "You're in. Look out for your first tip soon.";
    form.replaceWith(confirmation);
  }

  function showServerError(form, message) {
    clearServerError(form);
    const alertEl = document.createElement('p');
    alertEl.className = 'alert alert--error';
    alertEl.setAttribute('role', 'alert');
    alertEl.setAttribute('data-server-error', 'true');
    alertEl.textContent = message || 'Something went wrong. Please try again in a moment.';
    form.insertAdjacentElement('beforebegin', alertEl);
  }

  function clearServerError(form) {
    const previous = form.previousElementSibling;
    if (previous && previous.matches('[data-server-error]')) {
      previous.remove();
    }
  }
}

document.addEventListener('partials:loaded', initNewsletterForms);
document.addEventListener('DOMContentLoaded', initNewsletterForms);

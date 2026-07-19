/**
 * Robayer WealthLab: Contact Form Component
 *
 * Progressive enhancement for [data-contact-form]. Validates Name, Email,
 * and Message client-side (Phone is optional), then POSTs to the
 * Cloudflare Worker backend (Version 1.2 Sprint 3, POST /api/contact).
 * A failed request (network error, rate limit, server error) shows a
 * retryable error alert instead of the confirmation, leaving the form
 * in place so the visitor can try again or email us directly.
 */

// Relative: see js/components/newsletter-form.js's equivalent constant.
const CONTACT_API_URL = '/api/contact';

function initContactForms() {
  const forms = document.querySelectorAll('[data-contact-form]:not([data-bound])');

  forms.forEach((form) => {
    form.setAttribute('data-bound', 'true');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const fields = [
        { input: form.querySelector('[name="name"]'), test: (value) => value.length > 0 },
        { input: form.querySelector('[name="email"]'), test: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) },
        { input: form.querySelector('[name="message"]'), test: (value) => value.length > 0 },
      ];

      let firstInvalid = null;
      fields.forEach(({ input, test }) => {
        if (!input) return;
        const valid = validateField(input, test);
        if (!valid && !firstInvalid) firstInvalid = input;
      });

      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      clearServerError(form);
      const submitButton = form.querySelector('[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      const name = form.querySelector('[name="name"]').value.trim();
      const email = form.querySelector('[name="email"]').value.trim();
      const phoneInput = form.querySelector('[name="phone"]');
      const phone = phoneInput ? phoneInput.value.trim() : '';
      const message = form.querySelector('[name="message"]').value.trim();

      try {
        const response = await fetch(CONTACT_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, phone: phone || undefined, message }),
        });
        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error((result && result.error && result.error.message) || 'Something went wrong. Please try again.');
        }

        showConfirmation(form);
      } catch (error) {
        // fetch() itself throws a TypeError on a network/CORS failure;
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

  function validateField(input, test) {
    const field = input.closest('.field');
    const errorEl = field ? field.querySelector('.field__error') : null;
    const valid = test(input.value.trim());

    if (field) field.classList.toggle('field--error', !valid);
    if (errorEl) errorEl.hidden = valid;

    return valid;
  }

  function getFallbackEmail() {
    // Reuse the general-enquiries email already on the page (populated by
    // js/content-inject.js from assets/config/site.json) instead of a
    // second hardcoded copy; falls back to the known-correct default if
    // that element isn't found for any reason.
    const emailEl = document.querySelector('[data-content-href="contact.emails.general.href"]');
    return {
      href: emailEl ? emailEl.getAttribute('href') : 'mailto:hello@robayerwealthlab.com',
      text: emailEl ? emailEl.textContent : 'hello@robayerwealthlab.com',
    };
  }

  function showConfirmation(form) {
    const confirmation = document.createElement('p');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.textContent = "Thanks for reaching out. We've received your message and will reply within 2–3 business days.";
    form.replaceWith(confirmation);
  }

  function showServerError(form, message) {
    clearServerError(form);
    const { href, text } = getFallbackEmail();
    const alertEl = document.createElement('p');
    alertEl.className = 'alert alert--error';
    alertEl.setAttribute('role', 'alert');
    alertEl.setAttribute('data-server-error', 'true');
    alertEl.innerHTML = `${message || 'Something went wrong. Please try again in a moment.'} You can also email us directly at <a href="${href}">${text}</a>.`;
    form.insertAdjacentElement('beforebegin', alertEl);
  }

  function clearServerError(form) {
    const previous = form.previousElementSibling;
    if (previous && previous.matches('[data-server-error]')) {
      previous.remove();
    }
  }
}

document.addEventListener('partials:loaded', initContactForms);
document.addEventListener('DOMContentLoaded', initContactForms);

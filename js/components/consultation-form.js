/**
 * Robayer WealthLab — Consultation Request Form
 *
 * Progressive enhancement for [data-consultation-form]. Validates Name,
 * Email, Country, Category, Description, Preferred Contact Method, and
 * Consent client-side (Phone is optional, matching the existing
 * contact-form.js convention), then POSTs to the Cloudflare Worker
 * backend (Version 1.2 Sprint 3, POST /api/consultation). A failed
 * request (network error, rate limit, server error) shows a retryable
 * error alert instead of the confirmation, leaving the form in place.
 */

// Relative — see js/components/newsletter-form.js's equivalent constant.
const CONSULTATION_API_URL = '/api/consultation';

function initConsultationForms() {
  const forms = document.querySelectorAll('[data-consultation-form]:not([data-bound])');

  forms.forEach((form) => {
    form.setAttribute('data-bound', 'true');

    // Pre-select the category when arriving with ?category=<slug> (e.g. from
    // the Goal Planner's recommendation) — a contextual convenience, not a
    // form of pre-filling personal data, so it's safe to read from the URL.
    const category = form.querySelector('[name="category"]');
    const requestedCategory = new URLSearchParams(window.location.search).get('category');
    if (category && requestedCategory && category.querySelector('option[value="' + CSS.escape(requestedCategory) + '"]')) {
      category.value = requestedCategory;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const fields = [
        { input: form.querySelector('[name="name"]'), test: (value) => value.length > 0 },
        { input: form.querySelector('[name="email"]'), test: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) },
        { input: form.querySelector('[name="country"]'), test: (value) => value.length > 0 },
        { input: form.querySelector('[name="category"]'), test: (value) => value.length > 0 },
        { input: form.querySelector('[name="description"]'), test: (value) => value.length > 0 },
        { input: form.querySelector('[name="contact-method"]'), test: (value) => value.length > 0 },
      ];

      let firstInvalid = null;
      fields.forEach(({ input, test }) => {
        if (!input) return;
        const valid = validateField(input, test);
        if (!valid && !firstInvalid) firstInvalid = input;
      });

      // Consent checkbox is validated separately (no text value to test)
      const consent = form.querySelector('[name="consent"]');
      if (consent) {
        const consentField = consent.closest('.field');
        const consentError = consentField ? consentField.querySelector('.field__error') : null;
        const consentValid = consent.checked;
        if (consentField) consentField.classList.toggle('field--error', !consentValid);
        if (consentError) consentError.hidden = consentValid;
        if (!consentValid && !firstInvalid) firstInvalid = consent;
      }

      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      clearServerError(form);
      const submitButton = form.querySelector('[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      const phoneInput = form.querySelector('[name="phone"]');
      const payload = {
        name: form.querySelector('[name="name"]').value.trim(),
        email: form.querySelector('[name="email"]').value.trim(),
        phone: phoneInput && phoneInput.value.trim() ? phoneInput.value.trim() : undefined,
        country: form.querySelector('[name="country"]').value.trim(),
        category: form.querySelector('[name="category"]').value.trim(),
        description: form.querySelector('[name="description"]').value.trim(),
        preferredContactMethod: form.querySelector('[name="contact-method"]').value.trim(),
        consent: consent ? consent.checked : false,
      };

      try {
        const response = await fetch(CONSULTATION_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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

  function validateField(input, test) {
    const field = input.closest('.field');
    const errorEl = field ? field.querySelector('.field__error') : null;
    const valid = test(input.value.trim());

    if (field) field.classList.toggle('field--error', !valid);
    if (errorEl) errorEl.hidden = valid;

    return valid;
  }

  function getFallbackEmail() {
    // Reuse the general-enquiries email already on the page (populated
    // by js/content-inject.js from assets/config/site.json), matching
    // the exact pattern established in js/components/contact-form.js —
    // one source of truth, not a second hardcoded copy.
    const emailEl = document.querySelector('[data-content-href="contact.emails.general.href"]');
    return {
      href: emailEl ? emailEl.getAttribute('href') : 'mailto:hello@robayerwealthlab.com',
      text: emailEl ? emailEl.textContent : 'hello@robayerwealthlab.com',
    };
  }

  function showConfirmation(form) {
    const { href, text } = getFallbackEmail();
    const confirmation = document.createElement('div');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.innerHTML =
      '<p><strong>Thank you — your consultation request has been received.</strong></p>' +
      '<p class="mt-2">This isn\'t an automatic booking: Robert reviews every request personally, and there is no live calendar or scheduling system yet. We\'ll get back to you using your preferred contact method within 2–3 business days to confirm details and arrange next steps.</p>' +
      '<p class="mt-2">Need to reach us sooner? Email <a href="' + href + '">' + text + '</a> directly.</p>';
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

document.addEventListener('partials:loaded', initConsultationForms);
document.addEventListener('DOMContentLoaded', initConsultationForms);

/**
 * Robayer WealthLab — Consultation Request Form
 *
 * Progressive enhancement for [data-consultation-form]. Validates Name,
 * Email, Country, Category, Description, Preferred Contact Method, and
 * Consent client-side (Phone is optional, matching the existing
 * contact-form.js convention). There is no backend, booking system, or
 * calendar integration on this static GitHub Pages site — a successful
 * submission shows an honest confirmation explaining that every
 * request is reviewed manually, not automatically booked, following
 * the exact pattern already established by contact-form.js.
 */

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

    form.addEventListener('submit', (event) => {
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

      showConfirmation(form);
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

  function showConfirmation(form) {
    // Reuse the general-enquiries email already on the page (populated
    // by js/content-inject.js from assets/config/site.json), matching
    // the exact pattern established in js/components/contact-form.js —
    // one source of truth, not a second hardcoded copy.
    const emailEl = document.querySelector('[data-content-href="contact.emails.general.href"]');
    const emailHref = emailEl ? emailEl.getAttribute('href') : 'mailto:hello@robayerwealthlab.com';
    const emailText = emailEl ? emailEl.textContent : 'hello@robayerwealthlab.com';

    const confirmation = document.createElement('div');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.innerHTML =
      '<p><strong>Thank you — your consultation request has been received.</strong></p>' +
      '<p class="mt-2">This isn\'t an automatic booking: Robert reviews every request personally, and there is no live calendar or scheduling system yet. We\'ll get back to you using your preferred contact method within 2–3 business days to confirm details and arrange next steps.</p>' +
      '<p class="mt-2">Need to reach us sooner? Email <a href="' + emailHref + '">' + emailText + '</a> directly.</p>';
    form.replaceWith(confirmation);
  }
}

document.addEventListener('partials:loaded', initConsultationForms);
document.addEventListener('DOMContentLoaded', initConsultationForms);

/**
 * Robayer WealthLab — Contact Form Component
 *
 * Progressive enhancement for [data-contact-form]. Validates Name, Email,
 * and Message client-side (Phone is optional), following the same pattern
 * as newsletter-form.js. There is no backend on this static GitHub Pages
 * site, so a successful submission shows an honest confirmation rather
 * than a fake "message sent" state — matches placeholder-action.js's
 * honesty-first convention.
 */

function initContactForms() {
  const forms = document.querySelectorAll('[data-contact-form]:not([data-bound])');

  forms.forEach((form) => {
    form.setAttribute('data-bound', 'true');

    form.addEventListener('submit', (event) => {
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
    // Reuse the general-enquiries email already on the page (populated by
    // js/content-inject.js from assets/config/site.json) instead of a
    // second hardcoded copy — falls back to the known-correct default if
    // that element isn't found for any reason.
    const emailEl = document.querySelector('[data-content-href="contact.emails.general.href"]');
    const emailHref = emailEl ? emailEl.getAttribute('href') : 'mailto:hello@robayerwealthlab.com';
    const emailText = emailEl ? emailEl.textContent : 'hello@robayerwealthlab.com';

    const confirmation = document.createElement('p');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.innerHTML = `Thanks for reaching out. This form isn't connected to a backend yet — email us directly at <a href="${emailHref}">${emailText}</a> and we'll reply within 2–3 business days.`;
    form.replaceWith(confirmation);
  }
}

document.addEventListener('partials:loaded', initContactForms);
document.addEventListener('DOMContentLoaded', initContactForms);

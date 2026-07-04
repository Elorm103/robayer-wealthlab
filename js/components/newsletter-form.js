/**
 * Robayer WealthLab — Newsletter Form Component
 *
 * Progressive enhancement for any form marked [data-newsletter-form].
 * On submit: validates the email client-side, then swaps the form for a
 * warm confirmation message (per Phase 4 Section 2.9 interaction spec).
 *
 * NOTE: this does not yet send the email anywhere — there is no backend
 * on a GitHub Pages / vanilla-JS stack. Wire the fetch() call in
 * `submitToProvider()` once a form-handling service is chosen (see
 * Phase 3 A.7 and the Phase 5.1 README open items).
 */

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

      // TODO: submitToProvider(email) — wire once a form backend is chosen
      showConfirmation(form);
    });
  });

  function showConfirmation(form) {
    const confirmation = document.createElement('p');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.textContent = "You're in. Look out for your first tip soon.";
    form.replaceWith(confirmation);
  }
}

document.addEventListener('partials:loaded', initNewsletterForms);
document.addEventListener('DOMContentLoaded', initNewsletterForms);

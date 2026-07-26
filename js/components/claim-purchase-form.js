/**
 * Robayer WealthLab: Claim Purchase Form Component — Version 3.3
 * Milestone M5C (Activation, Analytics and Customer Reconciliation).
 *
 * Progressive enhancement for the form on /checkout/claim-purchase/.
 * POSTs to POST /api/customer/reconcile-purchases, which — per
 * services/customer/reconciliationService.ts's no-enumeration
 * discipline (mirroring forgot-password-form.js exactly) — always
 * returns the same generic success response whether or not the email
 * had any unclaimed purchase behind it, so this form always shows the
 * same confirmation message too; it never learns (and must never
 * imply) whether a given email has purchase history.
 */

const CLAIM_PURCHASE_API_URL = '/api/customer/reconcile-purchases';

function initClaimPurchaseForm() {
  const form = document.querySelector('[data-claim-purchase-form]:not([data-bound])');
  if (!form) return;
  form.setAttribute('data-bound', 'true');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const emailInput = form.querySelector('#claim-purchase-email');
    const email = emailInput ? emailInput.value.trim() : '';

    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Checking…';
    }

    try {
      await fetch(CLAIM_PURCHASE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Deliberately ignores the response body beyond a network-level
      // failure — the endpoint always returns the same generic
      // { requested: true } shape by design (no-enumeration), so
      // there's nothing meaningful to branch on.
      showConfirmation(form);
    } catch {
      // A network-level failure (fetch() itself throwing) is the only
      // case worth surfacing — still shown generically, never
      // distinguishing "no purchase found" from any other outcome.
      showConfirmation(form);
    }
  });

  function showConfirmation(formEl) {
    const confirmation = document.createElement('p');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.textContent = "If we found a purchase linked to that email, we've sent a link to set a password and access it. Check your inbox.";
    formEl.replaceWith(confirmation);
  }
}

document.addEventListener('partials:loaded', initClaimPurchaseForm);
document.addEventListener('DOMContentLoaded', initClaimPurchaseForm);

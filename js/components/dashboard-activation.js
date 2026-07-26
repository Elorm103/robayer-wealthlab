/**
 * Robayer WealthLab: Dashboard Activation Banner — Version 3.3
 * Milestone M5C (Activation, Analytics and Customer Reconciliation).
 *
 * Shows one-time first-login guidance on /dashboard/'s My Library
 * page. Reuses the existing `dashboard:ready` event
 * (js/components/dashboard-shell.js) and the `isFirstSession` flag
 * GET /api/customer/auth/session now returns (see
 * routes/customer/auth.ts's handleCustomerSession()) — no separate API
 * call, no new authentication concept, purely additive UI.
 *
 * Dismissible and remembered client-side only (localStorage) — once a
 * customer has a second session, the server-side flag itself already
 * stops being true, so this is just a same-session "don't show it
 * again if they reload the page" convenience, not the source of truth.
 */

const ACTIVATION_DISMISSED_KEY = 'rwl_activation_banner_dismissed';

function initDashboardActivation(event) {
  const root = document.querySelector('[data-activation-banner-root]');
  if (!root) return;

  const session = event.detail;
  if (!session || !session.isFirstSession) return;

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(ACTIVATION_DISMISSED_KEY) === 'true';
  } catch {
    // Private browsing / storage disabled — treat as not dismissed.
  }
  if (dismissed) return;

  const banner = document.createElement('div');
  banner.className = 'card mb-5';
  banner.setAttribute('data-activation-banner', 'true');
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <p class="mb-2" style="font-weight:600;">Welcome to your account!</p>
    <p class="text-secondary mb-3">
      Everything you've purchased lives here from now on. A few things
      worth doing first:
    </p>
    <ul class="text-secondary mb-3" style="padding-left:1.25em;">
      <li>Download your guides any time from the list below.</li>
      <li>Grab your receipts under <a href="/dashboard/receipts/">Receipts</a>.</li>
      <li>Review your login and sessions under <a href="/dashboard/security/">Security</a>.</li>
    </ul>
    <button type="button" class="btn btn--secondary" data-activation-banner-dismiss>Got it</button>
  `;

  root.appendChild(banner);

  const dismissButton = banner.querySelector('[data-activation-banner-dismiss]');
  if (dismissButton) {
    dismissButton.addEventListener('click', () => {
      try {
        localStorage.setItem(ACTIVATION_DISMISSED_KEY, 'true');
      } catch {
        // Best-effort only — worst case the banner reappears next reload.
      }
      banner.remove();
    });
  }
}

document.addEventListener('dashboard:ready', initDashboardActivation);

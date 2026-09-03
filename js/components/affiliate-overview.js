/**
 * Robayer WealthLab: Affiliate Overview Component. Drives
 * affiliate/index.html's hub page. Fetches the customer's affiliate
 * status once (dashboard:ready, per dashboard-shell.js/dashboard-auth.js,
 * reused unmodified for the affiliate area) and renders exactly one of:
 * apply form / pending / rejected / suspended / approved overview.
 * Never assumes a status client-side beyond what the server just
 * returned: a customer who reloads this page always sees their real,
 * current state.
 */

function formatPesewas(pesewas) {
  return `GH₵${(pesewas / 100).toFixed(2)}`;
}

function showState(name) {
  const states = ['apply', 'pending', 'rejected', 'suspended', 'approved'];
  states.forEach((state) => {
    const el = document.querySelector(`[data-affiliate-state="${state}"]`);
    if (el) el.hidden = state !== name;
  });
}

async function initAffiliateOverview() {
  const root = document.querySelector('[data-affiliate-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-affiliate-loading]');
  const errorEl = document.querySelector('[data-affiliate-error]');

  try {
    const profile = await window.CustomerDashboard.customerFetch('/api/customer/affiliates/me');
    loadingEl.hidden = true;
    root.hidden = false;

    if (profile.status === 'pending') {
      showState('pending');
    } else if (profile.status === 'rejected') {
      showState('rejected');
      const reasonEl = document.querySelector('[data-affiliate-rejection-reason]');
      if (reasonEl) reasonEl.textContent = profile.rejectionReason || "No specific reason was given.";
    } else if (profile.status === 'suspended') {
      showState('suspended');
      const reasonEl = document.querySelector('[data-affiliate-suspended-reason]');
      if (reasonEl) reasonEl.textContent = profile.suspendedReason || 'Please contact support for details.';
    } else if (profile.status === 'approved') {
      showState('approved');
      await loadOverviewStats();
    }
  } catch (error) {
    if (error.code === 'AFFILIATE_NOT_FOUND') {
      loadingEl.hidden = true;
      root.hidden = false;
      showState('apply');
      wireApplyForm();
      return;
    }
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = error.message || 'Something went wrong. Please try again.';
  }
}

function wireApplyForm() {
  const form = document.querySelector('[data-affiliate-apply-form]');
  if (!form) return;
  const submitBtn = form.querySelector('[type="submit"]');
  const errorEl = document.querySelector('[data-affiliate-apply-error]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const termsAccepted = form.querySelector('[data-affiliate-terms-checkbox]').checked;
    if (!termsAccepted) {
      errorEl.hidden = false;
      errorEl.textContent = 'Please accept the Affiliate Programme Terms to continue.';
      return;
    }

    submitBtn.disabled = true;
    errorEl.hidden = true;
    try {
      await window.CustomerDashboard.customerFetch('/api/customer/affiliates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termsAccepted: true }),
      });
      showState('pending');
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error.message || 'Something went wrong. Please try again.';
      submitBtn.disabled = false;
    }
  });
}

async function loadOverviewStats() {
  try {
    const overview = await window.CustomerDashboard.customerFetch('/api/customer/affiliates/overview');
    setText('[data-affiliate-stat-clicks]', overview.clicks);
    setText('[data-affiliate-stat-conversions]', overview.conversions);
    setText('[data-affiliate-stat-revenue]', formatPesewas(overview.revenuePesewas));
    setText('[data-affiliate-stat-earned]', formatPesewas(overview.earnedPesewas));
    setText('[data-affiliate-stat-pending]', formatPesewas(overview.pendingPesewas));
    setText('[data-affiliate-stat-payable]', formatPesewas(overview.payablePesewas));
    setText('[data-affiliate-stat-paid]', formatPesewas(overview.paidPesewas));
    setText('[data-affiliate-code-display]', overview.affiliateCode);
    setText('[data-affiliate-rate-display]', `${overview.defaultCommissionPercent}%`);

    const rate = overview.clicks > 0 ? ((overview.conversions / overview.clicks) * 100).toFixed(1) : '0.0';
    setText('[data-affiliate-stat-conversion-rate]', `${rate}%`);
  } catch (error) {
    const errorEl = document.querySelector('[data-affiliate-error]');
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = error.message || 'Could not load your affiliate stats.';
    }
  }
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}

/**
 * Fired by dashboard-shell.js instead of `dashboard:ready` when
 * .dashboard-nav[data-optional-auth] finds no session (see
 * partials/affiliate-nav.html) — a logged-out visitor to /affiliate/,
 * who never gets the hard sign-in redirect every other dashboard page
 * still uses. Shows the guest landing state in place of the
 * loading/apply/pending/etc. states, which never start loading in
 * this case.
 */
function showGuestLanding() {
  const loadingEl = document.querySelector('[data-affiliate-loading]');
  if (loadingEl) loadingEl.hidden = true;
  const authedEl = document.querySelector('[data-affiliate-authed]');
  if (authedEl) authedEl.hidden = true;
  const guestEl = document.querySelector('[data-affiliate-guest]');
  if (guestEl) guestEl.hidden = false;
}

document.addEventListener('dashboard:ready', initAffiliateOverview);
document.addEventListener('dashboard:guest', showGuestLanding);

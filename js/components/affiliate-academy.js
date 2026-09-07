/**
 * Robayer WealthLab: Affiliate Academy Page Component — Affiliate
 * Programme 2.0. Drives affiliate/academy/index.html's three states:
 * guest (no session), not-applied (session but no affiliate row yet —
 * AFFILIATE_NOT_FOUND, same error code affiliate-overview.js already
 * branches on), and authed (an affiliate row exists, any status).
 *
 * On the authed state, fires POST /api/customer/affiliates/academy/start
 * once per page load (startAcademy() server-side is idempotent — see
 * affiliateService.ts — so a reload never re-triggers anything
 * observable beyond re-confirming 'in_progress'), then wires the
 * "I've completed the Affiliate Academy" button to POST
 * /api/customer/affiliates/academy/complete. Never implies completion
 * guarantees approval — the page copy and this script's status text
 * both say "may be considered," never "will be approved."
 */

function formatAcademyStatus(status) {
  if (status === 'completed') return 'Completed';
  if (status === 'in_progress') return 'In progress';
  return 'Not started';
}

async function initAffiliateAcademy() {
  const authedEl = document.querySelector('[data-academy-authed]');
  if (!authedEl || authedEl.hasAttribute('data-bound')) return;
  authedEl.setAttribute('data-bound', 'true');

  const notAppliedEl = document.querySelector('[data-academy-not-applied]');
  const statusLineEl = document.querySelector('[data-academy-status-line]');
  const completeButton = document.querySelector('[data-academy-complete-button]');
  const completePending = document.querySelector('[data-academy-complete-pending]');
  const completeDone = document.querySelector('[data-academy-complete-done]');
  const completeError = document.querySelector('[data-academy-complete-error]');

  try {
    // Idempotent on the server (see affiliateService.ts's startAcademy())
    // — safe to call unconditionally on every load, including a reload
    // after completion, without changing an already-'completed' status.
    await window.CustomerDashboard.customerFetch('/api/customer/affiliates/academy/start', { method: 'POST' });

    const academy = await window.CustomerDashboard.customerFetch('/api/customer/affiliates/academy');
    authedEl.hidden = false;

    if (statusLineEl) {
      statusLineEl.textContent = `Your progress: ${formatAcademyStatus(academy.status)}`;
    }

    if (academy.status === 'completed') {
      showCompleted();
    } else if (completeButton) {
      completeButton.addEventListener('click', async () => {
        completeButton.disabled = true;
        if (completeError) completeError.hidden = true;
        try {
          await window.CustomerDashboard.customerFetch('/api/customer/affiliates/academy/complete', { method: 'POST' });
          showCompleted();
          if (statusLineEl) statusLineEl.textContent = 'Your progress: Completed';
        } catch (error) {
          if (completeError) {
            completeError.hidden = false;
            completeError.textContent = error.message || 'Something went wrong. Please try again.';
          }
          completeButton.disabled = false;
        }
      });
    }
  } catch (error) {
    if (error.code === 'AFFILIATE_NOT_FOUND' || error.code === 'NOT_APPLIED') {
      if (notAppliedEl) notAppliedEl.hidden = false;
      return;
    }
    // Any other failure (network, unexpected server error): show the
    // authed shell anyway rather than a dead end, with the status line
    // repurposed as an error message.
    authedEl.hidden = false;
    if (statusLineEl) statusLineEl.textContent = error.message || 'Could not load your Academy progress.';
  }

  function showCompleted() {
    if (completePending) completePending.hidden = true;
    if (completeButton) completeButton.hidden = true;
    if (completeDone) completeDone.hidden = false;
  }
}

function showAcademyGuestLanding() {
  const guestEl = document.querySelector('[data-academy-guest]');
  if (guestEl) guestEl.hidden = false;
}

document.addEventListener('dashboard:ready', initAffiliateAcademy);
document.addEventListener('dashboard:guest', showAcademyGuestLanding);

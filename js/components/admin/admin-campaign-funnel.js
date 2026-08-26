/**
 * Robayer WealthLab — Campaign funnel card (Reliable Sales Funnel
 * Measurement pass). Drives the [data-campaign-funnel-root] card in
 * admin/analytics/index.html: the full delivered→opens→clicks→
 * visits→views→checkout→coupon→purchase→download chain for one
 * newsletter campaign, via GET /api/admin/analytics/campaigns/:id/funnel.
 * See services/admin/analyticsService.ts's getCampaignFunnel() for
 * exactly which stages are real vs. proxy vs. permanently unmeasurable.
 *
 * Not scoped to the page's date-range toolbar — a campaign's funnel is
 * a lifetime figure for that one send, not a range query, so this
 * fetches once rather than re-querying on preset/date changes.
 */

function initAdminCampaignFunnel() {
  const root = document.querySelector('[data-campaign-funnel-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const campaignId = root.getAttribute('data-campaign-id');
  if (!campaignId) return;

  const els = {
    loadError: root.querySelector('[data-campaign-funnel-load-error]'),
    subject: root.querySelector('[data-campaign-funnel-subject]'),
    tag: root.querySelector('[data-campaign-funnel-tag]'),
    recipients: root.querySelector('[data-campaign-funnel-recipients]'),
    delivered: root.querySelector('[data-campaign-funnel-delivered]'),
    bounced: root.querySelector('[data-campaign-funnel-bounced]'),
    opens: root.querySelector('[data-campaign-funnel-opens]'),
    opensNote: root.querySelector('[data-campaign-funnel-opens-note]'),
    clicks: root.querySelector('[data-campaign-funnel-clicks]'),
    clicksNote: root.querySelector('[data-campaign-funnel-clicks-note]'),
    visits: root.querySelector('[data-campaign-funnel-visits]'),
    views: root.querySelector('[data-campaign-funnel-views]'),
    checkout: root.querySelector('[data-campaign-funnel-checkout]'),
    coupon: root.querySelector('[data-campaign-funnel-coupon]'),
    purchases: root.querySelector('[data-campaign-funnel-purchases]'),
    revenue: root.querySelector('[data-campaign-funnel-revenue]'),
    downloads: root.querySelector('[data-campaign-funnel-downloads]'),
  };

  refresh();

  async function refresh() {
    els.loadError.hidden = true;

    try {
      const data = await window.AdminAuth.adminFetch(`/api/admin/analytics/campaigns/${campaignId}/funnel`);
      render(data);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load the campaign funnel.';
      els.loadError.hidden = false;
    }
  }

  function render(data) {
    els.subject.textContent = data.subject;
    els.tag.textContent = data.utmCampaign
      ? `Attribution tag: ${data.utmCampaign}`
      : 'No attribution tag set on this campaign — landing-page-onward figures cannot be attributed to it.';

    els.recipients.textContent = String(data.recipients);
    els.delivered.textContent = String(data.delivered);
    els.bounced.textContent = String(data.bounced);

    renderStage(els.opens, els.opensNote, data.trackedOpens);
    renderStage(els.clicks, els.clicksNote, data.ctaClicks);

    els.visits.textContent = formatStageValue(data.landingPageVisits);
    els.views.textContent = formatStageValue(data.productViews);
    els.checkout.textContent = formatStageValue(data.checkoutStarts);
    els.coupon.textContent = formatStageValue(data.couponApplications);
    els.purchases.textContent = formatStageValue(data.purchases);
    els.revenue.textContent = data.revenuePesewas === null ? 'Not available' : formatCurrency(data.revenuePesewas / 100);
    els.downloads.textContent = formatStageValue(data.downloads);
  }

  function renderStage(valueEl, noteEl, stage) {
    if (!stage || stage.value === null) {
      valueEl.textContent = 'Not available';
      noteEl.textContent = stage ? stage.label : '';
    } else {
      valueEl.textContent = String(stage.value);
      noteEl.textContent = stage.label || '';
    }
  }

  function formatStageValue(value) {
    return value === null || value === undefined ? 'Not available' : String(value);
  }
}

/** Same GH₵ formatting convention as admin-products-funnel.js's own formatCurrency() — a small local copy per independent script, not a shared utility. */
function formatCurrency(amount) {
  if (!isFinite(amount)) return 'GH₵0.00';
  const rounded = Math.round(amount * 100) / 100;
  const parts = Math.abs(rounded).toFixed(2).split('.');
  const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
}

document.addEventListener('partials:loaded', initAdminCampaignFunnel);

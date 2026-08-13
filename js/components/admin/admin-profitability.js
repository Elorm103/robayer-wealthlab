/**
 * Robayer WealthLab — Profitability page (P0-D, Business Intelligence
 * backbone). Drives admin/profitability/index.html: loads the platform
 * summary and campaign table from GET /api/admin/profitability/summary
 * and /campaigns, following the same date-range-toolbar/adminFetch/
 * empty-state conventions as js/components/admin/admin-traffic.js.
 *
 * Currency formatting is deliberately generic here (unlike most of this
 * admin, which is GHS-only) — see formatMinorUnits() below, same
 * reasoning as admin-ad-spend.js's own copy of this helper: ad spend
 * can be any currency and must never be silently relabeled GHS.
 */

const SUMMARY_API = '/api/admin/profitability/summary';
const CAMPAIGNS_API = '/api/admin/profitability/campaigns';
const REVENUE_CURRENCY = 'GHS';

function formatMinorUnits(minorUnits, currency) {
  const major = Math.round(minorUnits) / 100;
  const withSeparators = major.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${withSeparators}`;
}

function formatPesewas(pesewas) {
  return formatMinorUnits(pesewas, REVENUE_CURRENCY);
}

function formatPercent(value) {
  return value === null || value === undefined ? 'N/A' : `${value}%`;
}

function formatRoas(value) {
  return value === null || value === undefined ? 'N/A' : `${value}×`;
}

function formatMoneyOrNA(pesewasOrNull) {
  return pesewasOrNull === null || pesewasOrNull === undefined ? 'N/A' : formatPesewas(pesewasOrNull);
}

function initAdminProfitability() {
  const root = document.querySelector('[data-profitability-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const dateFrom = root.querySelector('[data-profitability-date-from]');
  const dateTo = root.querySelector('[data-profitability-date-to]');
  const presetChips = Array.from(root.querySelectorAll('[data-profitability-preset]'));

  const els = {
    loadError: root.querySelector('[data-profitability-load-error]'),
    grossRevenue: root.querySelector('[data-stat-gross-revenue]'),
    paystackFees: root.querySelector('[data-stat-paystack-fees]'),
    feeMeta: root.querySelector('[data-stat-fee-meta]'),
    adSpend: root.querySelector('[data-stat-ad-spend]'),
    contribution: root.querySelector('[data-stat-contribution]'),
    contributionMargin: root.querySelector('[data-stat-contribution-margin]'),
    attributedRevenue: root.querySelector('[data-stat-attributed-revenue]'),
    unattributedRevenue: root.querySelector('[data-stat-unattributed-revenue]'),
    feeCaveat: root.querySelector('[data-fee-caveat]'),
    currencyCaveat: root.querySelector('[data-currency-caveat]'),
    campaignsEmpty: root.querySelector('[data-campaigns-empty]'),
    campaignsWrap: root.querySelector('[data-campaigns-table-wrap]'),
    campaignsBody: root.querySelector('[data-campaigns-table-body]'),
  };

  applyPreset(30, false);
  refresh();

  presetChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      applyPreset(Number(chip.getAttribute('data-profitability-preset')), true);
      refresh();
    });
  });
  if (dateFrom) dateFrom.addEventListener('change', () => { setActivePreset(null); refresh(); });
  if (dateTo) dateTo.addEventListener('change', () => { setActivePreset(null); refresh(); });

  function setActivePreset(days) {
    presetChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(Number(chip.getAttribute('data-profitability-preset')) === days));
    });
  }

  function applyPreset(days, markActive) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    if (dateFrom) dateFrom.value = from.toISOString().slice(0, 10);
    if (dateTo) dateTo.value = to.toISOString().slice(0, 10);
    if (markActive) setActivePreset(days);
  }

  async function refresh() {
    els.loadError.hidden = true;
    const params = new URLSearchParams();
    if (dateFrom && dateFrom.value) params.set('from', dateFrom.value);
    if (dateTo && dateTo.value) params.set('to', dateTo.value);

    try {
      const [summary, campaignsResult] = await Promise.all([
        window.AdminAuth.adminFetch(`${SUMMARY_API}?${params.toString()}`),
        window.AdminAuth.adminFetch(`${CAMPAIGNS_API}?${params.toString()}`),
      ]);
      renderSummary(summary);
      renderCampaigns(campaignsResult);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load profitability data.';
      els.loadError.hidden = false;
    }
  }

  function renderSummary(summary) {
    els.grossRevenue.textContent = formatPesewas(summary.grossRevenuePesewas);
    els.paystackFees.textContent = formatPesewas(summary.paystackFeesPesewas);
    els.adSpend.textContent = summary.adSpendByCurrency.length
      ? summary.adSpendByCurrency.map((row) => formatMinorUnits(row.amountMinorUnits, row.currency)).join(' + ')
      : formatMinorUnits(0, REVENUE_CURRENCY);
    els.contribution.textContent = formatPesewas(summary.contributionPesewas);
    els.contributionMargin.textContent = formatPercent(summary.contributionMarginPercent);
    els.attributedRevenue.textContent = formatPesewas(summary.attributedRevenuePesewas);
    els.unattributedRevenue.textContent = formatPesewas(summary.unattributedRevenuePesewas);

    if (summary.feeUnknownPurchaseCount > 0) {
      els.feeMeta.textContent = `Fee data unavailable for ${summary.feeUnknownPurchaseCount} verified purchase(s)`;
      els.feeCaveat.textContent = `Fee data unavailable for ${summary.feeUnknownPurchaseCount} verified purchase${summary.feeUnknownPurchaseCount === 1 ? '' : 's'} (administratively reprocessed, with no recorded Paystack transaction). Contribution may be overstated for those purchases.`;
      els.feeCaveat.hidden = false;
    } else {
      els.feeMeta.textContent = 'All verified purchases have a recorded fee';
      els.feeCaveat.hidden = true;
    }

    const nonGhs = summary.adSpendByCurrency.filter((row) => row.currency !== REVENUE_CURRENCY && row.amountMinorUnits > 0);
    if (nonGhs.length > 0) {
      els.currencyCaveat.textContent = `Non-GHS advertising spend (${nonGhs.map((row) => formatMinorUnits(row.amountMinorUnits, row.currency)).join(', ')}) is shown separately above and is not converted into GHS or included in Contribution.`;
      els.currencyCaveat.hidden = false;
    } else {
      els.currencyCaveat.hidden = true;
    }
  }

  function renderCampaigns(result) {
    const campaigns = result.campaigns || [];
    const hasRows = campaigns.length > 0;
    els.campaignsEmpty.hidden = hasRows;
    els.campaignsWrap.hidden = !hasRows;
    if (!hasRows) return;

    els.campaignsBody.innerHTML = '';
    campaigns.forEach((c) => {
      const tr = document.createElement('tr');
      const cells = [
        c.campaignLabel,
        formatMinorUnits(c.ghsSpendMinorUnits, REVENUE_CURRENCY),
        String(c.purchaseCount),
        formatPesewas(c.attributedRevenuePesewas),
        formatPesewas(c.paystackFeesPesewas),
        formatPesewas(c.contributionPesewas),
        formatRoas(c.revenueRoas),
        formatRoas(c.contributionRoas),
        formatMoneyOrNA(c.costPerAttributedPurchasePesewas),
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      els.campaignsBody.appendChild(tr);
    });
  }
}

document.addEventListener('partials:loaded', initAdminProfitability);

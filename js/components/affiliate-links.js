/**
 * Robayer WealthLab: Affiliate Links Component. Drives
 * affiliate/links/index.html. Pure client-side URL construction (no
 * dedicated "generate link" backend endpoint needed: the code is
 * fetched once, product options come from the existing
 * window.RobayerProducts loader already used by the homepage).
 * buildUrl() and the copy-to-clipboard micro-interaction now live in
 * js/components/affiliate-shared.js (window.RobayerAffiliate), the one
 * canonical referral-link mechanism, also used by
 * affiliate-resources.js. This file must load after that script.
 */

async function initAffiliateLinks() {
  const root = document.querySelector('[data-affiliate-links-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-affiliate-links-loading]');
  const errorEl = document.querySelector('[data-affiliate-links-error]');
  const select = document.querySelector('[data-affiliate-destination-select]');
  const urlOutput = document.querySelector('[data-affiliate-generated-url]');
  const copyBtn = document.querySelector('[data-affiliate-copy-btn]');

  let affiliateCode;
  try {
    const profile = await window.CustomerDashboard.customerFetch('/api/customer/affiliates/me');
    if (profile.status !== 'approved') {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = 'Your affiliate application needs to be approved before you can generate links.';
      return;
    }
    affiliateCode = profile.affiliateCode;
  } catch (error) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = error.message || 'Could not load your affiliate profile.';
    return;
  }

  try {
    const products = await window.RobayerProducts.loadAll();
    const active = window.RobayerProducts.getActive(products);
    active.forEach((product) => {
      const option = document.createElement('option');
      option.value = product.slug;
      option.textContent = product.title;
      select.appendChild(option);
    });
  } catch {
    // A products fetch failure still leaves the "Homepage" option usable, not fatal.
  }

  function updateUrl() {
    urlOutput.textContent = window.RobayerAffiliate.buildUrl(affiliateCode, select.value);
  }

  select.addEventListener('change', updateUrl);
  updateUrl();

  loadingEl.hidden = true;
  root.hidden = false;

  copyBtn.addEventListener('click', () => window.RobayerAffiliate.copyToClipboard(urlOutput.textContent, copyBtn));
}

document.addEventListener('dashboard:ready', initAffiliateLinks);

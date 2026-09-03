/**
 * Robayer WealthLab: Affiliate Links Component. Drives
 * affiliate/links/index.html. Pure client-side URL construction (no
 * dedicated "generate link" backend endpoint needed: the code is
 * fetched once, product options come from the existing
 * window.RobayerProducts loader already used by the homepage). Reuses
 * the same copy-to-clipboard micro-interaction already established in
 * js/components/licenses-list.js.
 */

function copyToClipboard(text, button) {
  const defaultLabel = button.textContent;
  const done = () => {
    button.textContent = 'Copied!';
    window.setTimeout(() => {
      button.textContent = defaultLabel;
    }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } catch {
      // no-op: nothing else reasonable to do without Clipboard API support
    }
    document.body.removeChild(textarea);
    done();
  }
}

function buildUrl(code, destination) {
  const origin = window.location.origin;
  const path = destination === 'homepage' ? '/' : `/books/${destination}/`;
  return `${origin}${path}?ref=${encodeURIComponent(code)}`;
}

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
    urlOutput.textContent = buildUrl(affiliateCode, select.value);
  }

  select.addEventListener('change', updateUrl);
  updateUrl();

  loadingEl.hidden = true;
  root.hidden = false;

  copyBtn.addEventListener('click', () => copyToClipboard(urlOutput.textContent, copyBtn));
}

document.addEventListener('dashboard:ready', initAffiliateLinks);

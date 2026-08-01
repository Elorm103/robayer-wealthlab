/**
 * Robayer WealthLab: Licenses Component — Version 3.1 Milestone M3.
 * Drives dashboard/licenses/index.html. Read-only — `GET
 * /api/customer/licenses` needs no further data for this MVP; the
 * ratified Blueprint's "view/print certificate" action is deferred, per
 * docs/v3.1-m3-ux-strategy.md's own explicit "nice-to-have, not
 * required for M3's own MVP scope" note.
 */

function initLicensesList() {
  const root = document.querySelector('[data-licenses-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = root.querySelector('[data-licenses-loading]');
  const listEl = root.querySelector('[data-licenses-list]');
  const emptyEl = root.querySelector('[data-licenses-empty]');
  const errorEl = root.querySelector('[data-licenses-error]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let result;
    try {
      result = await window.CustomerDashboard.customerFetch('/api/customer/licenses');
    } catch (error) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = error.message || 'Something went wrong. Please refresh and try again.';
      return;
    }

    loadingEl.hidden = true;

    if (result.licenses.length === 0) {
      emptyEl.hidden = false;
      return;
    }

    listEl.hidden = false;
    listEl.innerHTML = '';
    result.licenses.forEach((license) => listEl.appendChild(renderRow(license)));
  }

  /** Version 3.6 (Platform Hardening, Phase 3 — Dashboard UI Consistency) - see purchase-history-list.js's own header comment on this same change: the labeled detail strip reuses .library-card__details exactly as established for the Customer Library in V3.5.4. The status badge now sits above the details strip (matching the Library's own "badge first" hierarchy) rather than inside the actions row; Copy Key's behavior is unchanged. */
  function renderRow(license) {
    const row = document.createElement('div');
    row.className = 'library-row';

    const meta = document.createElement('div');
    meta.className = 'library-row__meta';

    const title = document.createElement('h2');
    title.className = 'library-card__title';
    title.textContent = license.productTitle;
    meta.appendChild(title);

    const badge = document.createElement('span');
    badge.className = license.status === 'active' ? 'badge badge--success mb-2' : 'badge badge--error mb-2';
    badge.textContent = license.status === 'active' ? 'Active' : 'Revoked';
    meta.appendChild(badge);

    const details = document.createElement('dl');
    details.className = 'library-card__details';
    appendDetail(details, 'License type', license.licenseType);
    appendDetail(details, 'Issued', formatDate(license.issuedAt));
    appendDetail(details, 'License key', truncateKey(license.licenseKey));
    meta.appendChild(details);

    row.appendChild(meta);

    if (license.status === 'active') {
      const actions = document.createElement('div');
      actions.className = 'library-card__actions';
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'btn btn--secondary';
      copyButton.textContent = 'Copy key';
      copyButton.addEventListener('click', () => copyKey(license.licenseKey, copyButton));
      actions.appendChild(copyButton);
      row.appendChild(actions);
    }

    return row;
  }

  function appendDetail(list, label, value) {
    const pair = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.style.fontFamily = label === 'License key' ? 'var(--font-mono)' : '';
    dd.textContent = value;
    pair.appendChild(dt);
    pair.appendChild(dd);
    list.appendChild(pair);
  }

  function truncateKey(key) {
    if (key.length <= 16) return key;
    return `${key.slice(0, 8)}…${key.slice(-8)}`;
  }

  function copyKey(key, button) {
    const defaultLabel = button.textContent;
    const done = () => {
      button.textContent = 'Copied!';
      window.setTimeout(() => {
        button.textContent = defaultLabel;
      }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(key).then(done).catch(done);
    } else {
      done();
    }
  }

  /** Normalizes both `datetime('now')` (SQL) and `toISOString()` formats — see js/components/admin/admin-account.js's own header comment for the exact mixed-format issue this avoids re-discovering. */
  function formatDate(isoString) {
    try {
      const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
      return new Date(normalized).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return isoString;
    }
  }
}

document.addEventListener('partials:loaded', initLicensesList);
document.addEventListener('DOMContentLoaded', initLicensesList);

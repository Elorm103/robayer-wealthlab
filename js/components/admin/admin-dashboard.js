/**
 * Robayer WealthLab — Admin Dashboard Component
 *
 * Drives admin/index.html specifically. Fetches the one real endpoint
 * this page needs (GET /api/admin/dashboard/summary) and renders each
 * card from what actually came back — per the Phase 0.2 brief's "no
 * fake data" rule, any figure the API returns as `null` renders as
 * "No data yet", never an invented number or a silently blank card.
 *
 * Runs after admin-shell.js's `requireSession()` gate has already
 * confirmed a valid session (both listen for `partials:loaded`; shell
 * script order in admin/index.html guarantees the gate runs first) —
 * this component only ever runs for an authenticated admin.
 */

function initAdminDashboard() {
  const root = document.querySelector('[data-dashboard-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  loadSummary();

  async function loadSummary() {
    let summary;
    try {
      summary = await window.AdminAuth.adminFetch('/api/admin/dashboard/summary');
    } catch (error) {
      showSystemStatus(false);
      showLoadError(error.message);
      return;
    }

    showSystemStatus(true);
    renderRevenue(summary.orders);
    renderOrders(summary.orders);
    renderSubscribers(summary.subscribers);
    renderConsultations(summary.consultations);
    renderContacts(summary.contacts);
    renderRecentActivity(summary.recentActivity);
  }

  function renderRevenue(orders) {
    const valueEl = root.querySelector('[data-stat-revenue-value]');
    const metaEl = root.querySelector('[data-stat-revenue-meta]');
    if (!orders) return showNoData(valueEl, metaEl);
    valueEl.textContent = formatCurrency(orders.revenuePesewas / 100);
    metaEl.textContent = 'From ' + orders.count + ' verified order' + (orders.count === 1 ? '' : 's');
  }

  function renderOrders(orders) {
    const valueEl = root.querySelector('[data-stat-orders-value]');
    const metaEl = root.querySelector('[data-stat-orders-meta]');
    if (!orders) return showNoData(valueEl, metaEl);
    valueEl.textContent = String(orders.count);
    metaEl.textContent = 'Verified purchases';
  }

  function renderSubscribers(subscribers) {
    const valueEl = root.querySelector('[data-stat-subscribers-value]');
    const metaEl = root.querySelector('[data-stat-subscribers-meta]');
    if (!subscribers) return showNoData(valueEl, metaEl);
    valueEl.textContent = String(subscribers.count);
    metaEl.textContent = 'Active subscribers';
  }

  function renderConsultations(consultations) {
    const valueEl = root.querySelector('[data-stat-consultations-value]');
    const metaEl = root.querySelector('[data-stat-consultations-meta]');
    if (!consultations) return showNoData(valueEl, metaEl);
    valueEl.textContent = String(consultations.count);
    metaEl.textContent = consultations.newCount + ' awaiting review';
  }

  function renderContacts(contacts) {
    const valueEl = root.querySelector('[data-stat-contacts-value]');
    const metaEl = root.querySelector('[data-stat-contacts-meta]');
    if (!contacts) return showNoData(valueEl, metaEl);
    valueEl.textContent = String(contacts.count);
    metaEl.textContent = contacts.newCount + ' awaiting review';
  }

  function showNoData(valueEl, metaEl) {
    valueEl.textContent = 'No data yet';
    valueEl.classList.add('stat-card__value--muted');
    if (metaEl) metaEl.textContent = '';
  }

  function renderRecentActivity(items) {
    const listEl = root.querySelector('[data-recent-activity-list]');
    const emptyEl = root.querySelector('[data-recent-activity-empty]');
    if (!items || items.length === 0) {
      listEl.hidden = true;
      emptyEl.hidden = false;
      return;
    }

    emptyEl.hidden = true;
    listEl.hidden = false;
    listEl.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'admin-activity-item';
      const label = document.createElement('span');
      label.textContent = describeAction(item.action);
      const time = document.createElement('span');
      time.className = 'text-secondary text-small';
      time.textContent = formatRelativeTime(item.createdAt);
      li.append(label, time);
      listEl.append(li);
    });
  }

  function showSystemStatus(ok) {
    const badge = root.querySelector('[data-system-status]');
    if (!badge) return;
    badge.textContent = ok ? 'Operational' : 'Unavailable';
    badge.classList.toggle('badge--success', ok);
    badge.classList.toggle('badge--error', !ok);
  }

  function showLoadError(message) {
    const errorEl = root.querySelector('[data-dashboard-error]');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
}

/** Same GH₵ formatting convention as js/components/calculator-utils.js's formatCurrency() and product-loader.js's local fallback — not shared as a common utility across those unrelated page contexts, matching the existing pattern of a small local copy per independent page family. */
function formatCurrency(amount) {
  if (!isFinite(amount)) return 'GH₵0.00';
  const rounded = Math.round(amount * 100) / 100;
  const parts = Math.abs(rounded).toFixed(2).split('.');
  const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
}

const ACTION_LABELS = {
  'admin.login': 'signed in',
  'admin.logout': 'signed out',
  'admin.login_failed': 'failed sign-in attempt',
  'admin.unauthorized_access': 'blocked unauthorized request',
  'admin.forbidden_access': 'blocked out-of-role request',
  'admin.csrf_rejected': 'blocked unverified request',
};

function describeAction(action) {
  return ACTION_LABELS[action] || action;
}

function formatRelativeTime(isoString) {
  const then = new Date(isoString.replace(' ', 'T') + 'Z').getTime();
  const diffSeconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return diffMinutes + 'm ago';
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return diffHours + 'h ago';
  const diffDays = Math.round(diffHours / 24);
  return diffDays + 'd ago';
}

document.addEventListener('partials:loaded', initAdminDashboard);

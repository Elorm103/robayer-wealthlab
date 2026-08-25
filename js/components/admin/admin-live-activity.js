/**
 * Robayer WealthLab — Live Activity section (Analytics & User-Activity
 * Baseline). Drives the [data-live-activity-root] card in
 * admin/analytics/index.html: a single "Online now" stat, polling
 * GET /api/admin/analytics/online-now on its own short interval,
 * independent of the page's date-range toolbar (this metric has no
 * date range — it's inherently "right now"). Backed by a KV-only
 * heartbeat count, never a new database row per heartbeat — see
 * backend/routes/analytics.ts's handleAnalyticsHeartbeat().
 *
 * A second, independent small script, matching this project's
 * convention of one script per admin-page section (admin-traffic.js,
 * admin-conversions.js).
 */

const ONLINE_NOW_API = '/api/admin/analytics/online-now';
const POLL_INTERVAL_MS = 25_000;

function initAdminLiveActivity() {
  const root = document.querySelector('[data-live-activity-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const valueEl = root.querySelector('[data-live-online-value]');

  async function refresh() {
    try {
      const data = await window.AdminAuth.adminFetch(ONLINE_NOW_API);
      valueEl.textContent = String(data.count);
    } catch {
      // A stale "online now" reading is harmless and shouldn't disrupt
      // the rest of the dashboard — leave the last known value in
      // place rather than showing an error state for a non-critical
      // metric that will self-correct on the next poll.
    }
  }

  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
}

document.addEventListener('partials:loaded', initAdminLiveActivity);

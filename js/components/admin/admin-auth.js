/**
 * Robayer WealthLab — Admin Auth Helper
 *
 * The one file that ever calls `/api/admin/auth/*` — every other admin
 * script (admin-shell.js, admin-login.js, admin-dashboard.js, and every
 * future module script) goes through `window.AdminAuth`, the same
 * "one file per concern" discipline the backend itself follows
 * (backend/services/admin/authService.ts is the only code that writes
 * to admin_sessions; this is its frontend mirror).
 *
 * Exposed as a single global object (this codebase has no module
 * system — see js/README conventions) rather than a `<script type="module">`,
 * consistent with every other component here.
 *
 * Cross-origin note: the admin frontend (robayerwealthlab.com) and the
 * Worker API (robayer-wealthlab-api.robayerwealthlab.workers.dev) are
 * different origins, so every call here needs `credentials: 'include'`
 * to send the session cookie at all — see
 * docs/v2-admin-shell-architecture.md's "Critical finding" for why the
 * cookie itself had to move from SameSite=Strict to SameSite=None to
 * make this possible, and middleware/csrf.ts for why that's still safe
 * (the double-submit X-CSRF-Token header below is the real CSRF
 * defense, not SameSite).
 */

window.AdminAuth = (function () {
  const API_BASE = 'https://robayer-wealthlab-api.robayerwealthlab.workers.dev';
  const CSRF_COOKIE_NAME = 'admin_csrf';
  const LOGIN_PATH = '/admin/login/';

  function getCsrfToken() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Fetches an `/api/admin/*` endpoint with credentials + (for mutating
   * methods) the CSRF header attached automatically, and unwraps the
   * standard `{ success, data }` / `{ success: false, error }` envelope
   * into a resolved value or a thrown `Error` carrying `.code` — same
   * shape as every other component's `fetchJson()` helper on this site
   * (see js/components/unsubscribe-status.js), so callers branch on
   * `error.code` the same familiar way.
   */
  async function adminFetch(path, options) {
    options = options || {};
    const method = (options.method || 'GET').toUpperCase();
    const headers = Object.assign({}, options.headers);

    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = getCsrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    let response;
    try {
      response = await fetch(API_BASE + path, {
        method,
        credentials: 'include',
        headers,
        body: options.body,
      });
    } catch {
      throw new Error('Could not reach the server. Please check your connection and try again.');
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.success) {
      const error = new Error((body && body.error && body.error.message) || 'Something went wrong. Please try again.');
      error.code = body && body.error && body.error.code;
      error.status = response.status;
      throw error;
    }
    return body.data;
  }

  function loginUrlWithNext() {
    const next = window.location.pathname + window.location.search;
    return LOGIN_PATH + '?next=' + encodeURIComponent(next);
  }

  /**
   * Called by every protected admin page, before any admin content
   * renders. A 401 (missing/expired/invalid session — requireAuth's
   * single, deliberately generic outcome, see
   * backend/middleware/requireAuth.ts) redirects to login immediately;
   * this function never resolves in that case, so callers can simply
   * `await` it without an explicit "did it fail" branch.
   */
  async function requireSession() {
    try {
      return await adminFetch('/api/admin/auth/session');
    } catch {
      window.location.replace(loginUrlWithNext());
      return new Promise(() => {}); // never resolves — a redirect is already in flight
    }
  }

  /** Called only by the login page: if a valid session already exists, skip the form and go straight in. */
  async function redirectIfAuthenticated() {
    try {
      await adminFetch('/api/admin/auth/session');
    } catch {
      return; // not authenticated — show the login form as normal
    }
    const params = new URLSearchParams(window.location.search);
    window.location.replace(params.get('next') || '/admin/');
  }

  async function login(email, password) {
    return adminFetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  async function logout() {
    try {
      await adminFetch('/api/admin/auth/logout', { method: 'POST' });
    } catch {
      // Logout is best-effort client-side regardless — even if the
      // request fails (network error, already-expired session), the
      // user's intent is to leave the admin area, so still redirect.
    }
    window.location.href = LOGIN_PATH;
  }

  return { adminFetch, requireSession, redirectIfAuthenticated, login, logout, getCsrfToken };
})();

/**
 * Robayer WealthLab — Customer Dashboard Auth Helper — Version 3.1
 * Milestone M3 (Checkout Auto-Provisioning & Dashboard MVP).
 *
 * The one file that ever calls `/api/customer/auth/*` or
 * `/api/customer/sessions*` on behalf of the dashboard — every other
 * dashboard script goes through `window.CustomerDashboard`, direct
 * mirror of `js/components/admin/admin-auth.js`'s own `window.AdminAuth`
 * (see that file's header comment for the full reasoning this
 * reuses unchanged: one shared CSRF-aware fetch wrapper, one shared
 * session guard, same-origin so no CORS/credentials complexity).
 *
 * Exposed as a single global object, not a module — this codebase has
 * no module system (see js/README conventions).
 */

window.CustomerDashboard = (function () {
  const API_BASE = '';
  const SIGN_IN_PATH = '/checkout/sign-in/';
  const CSRF_COOKIE_NAME = 'customer_csrf';

  /** Reads the CSRF token straight from its cookie — safe, same-origin frontend/API (see this file's header comment). */
  function getCsrfToken() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Fetches an `/api/customer/*` endpoint with the CSRF header attached
   * automatically for mutating methods, and unwraps the standard
   * `{success, data}` / `{success: false, error}` envelope into a
   * resolved value or a thrown `Error` carrying `.code` — same shape as
   * `AdminAuth.adminFetch()`, so every dashboard component branches on
   * `error.code` the same familiar way the admin side already does.
   */
  async function customerFetch(path, options) {
    options = options || {};
    const method = (options.method || 'GET').toUpperCase();
    const headers = Object.assign({}, options.headers);

    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = getCsrfToken();
      if (csrf) headers['X-Customer-CSRF-Token'] = csrf;
    }

    let response;
    try {
      response = await fetch(API_BASE + path, { method, headers, body: options.body });
    } catch {
      throw new Error('Could not reach the server. Please check your connection and try again.');
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.success) {
      const error = new Error((body && body.error && body.error.message) || 'Something went wrong. Please try again.');
      error.code = body && body.error && body.error.code;
      error.status = response.status;
      if (body && Array.isArray(body.fields)) error.fields = body.fields;
      throw error;
    }
    return body.data;
  }

  function signInUrlWithRedirect() {
    return SIGN_IN_PATH + '?redirect=' + encodeURIComponent(window.location.pathname);
  }

  /**
   * Called by every /dashboard/* page (via dashboard-shell.js), before
   * any authenticated content renders. A missing/expired/invalid
   * session redirects to sign-in immediately; this function never
   * resolves in that case, so callers can simply `await` it with no
   * explicit "did it fail" branch — direct mirror of
   * `AdminAuth.requireSession()`.
   */
  async function requireSession() {
    let session;
    try {
      session = await customerFetch('/api/customer/auth/session');
    } catch {
      window.location.replace(signInUrlWithRedirect());
      return new Promise(() => {}); // never resolves — a redirect is already in flight
    }
    return session;
  }

  async function logout() {
    try {
      await customerFetch('/api/customer/auth/logout', { method: 'POST' });
    } catch {
      // Logout is best-effort client-side regardless — even a failed
      // request (network error, already-expired session) still means
      // the customer's intent is to leave the dashboard.
    }
    window.location.href = '/';
  }

  return { customerFetch, requireSession, logout, getCsrfToken };
})();

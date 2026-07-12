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
 * Same-origin: the admin frontend and this Worker are both served from
 * robayerwealthlab.com (the API via a Cloudflare Workers Route matching
 * /api/*, see backend/wrangler.jsonc) — a plain same-origin fetch(),
 * with the standard double-submit-cookie CSRF pattern working exactly
 * as documented (see middleware/csrf.ts). See
 * docs/v2-same-origin-migration-audit.md for the migration this
 * replaced (a temporary cross-origin workaround that existed while the
 * API was on a separate workers.dev domain).
 */

window.AdminAuth = (function () {
  const API_BASE = '';
  const LOGIN_PATH = '/admin/login/';
  const CSRF_COOKIE_NAME = 'admin_csrf';

  /** Reads the CSRF token straight from its cookie — safe now that the frontend and API share an origin (see this file's header comment). */
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
   * Validates a `?next=` value before it's ever used as a navigation
   * target. Found during the Phase 0.2 independent audit: both this
   * file's `redirectIfAuthenticated()` and admin-login.js's post-login
   * redirect previously assigned `params.get('next')` straight to
   * `window.location.href` with no validation — a classic open
   * redirect (CWE-601). `?next=https://evil.com` (or the protocol-
   * relative `?next=//evil.com`, which browsers resolve identically to
   * a full cross-origin URL) would silently send an authenticated
   * admin off-site, a real phishing vector against exactly the
   * people with the most to lose. Only a value starting with the
   * literal path `/admin/` — never a scheme, never `//` — is accepted;
   * anything else falls back to the dashboard root. A leading single
   * `/admin/` can never be reinterpreted as a different origin by any
   * browser, regardless of encoding.
   */
  function sanitizeNextPath(rawNext) {
    if (typeof rawNext === 'string' && /^\/admin\/(?!\/)/.test(rawNext)) {
      return rawNext;
    }
    return '/admin/';
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
    window.location.replace(sanitizeNextPath(params.get('next')));
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

  return { adminFetch, requireSession, redirectIfAuthenticated, login, logout, getCsrfToken, sanitizeNextPath };
})();

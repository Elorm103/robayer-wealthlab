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
  const LOGIN_PATH = '/admin/login/';

  /**
   * Holds the CSRF token in memory rather than reading it from the
   * `admin_csrf` cookie's `document.cookie`. Found during the Phase 0.2
   * independent audit: this cookie is set on the API's origin
   * (robayer-wealthlab-api.robayerwealthlab.workers.dev), a different
   * registrable domain from the frontend (robayerwealthlab.com) — a
   * cookie is only readable via `document.cookie` by script running on
   * the exact origin that owns it, regardless of `SameSite`, so
   * `document.cookie` here could never see it and the X-CSRF-Token
   * header was silently never sent, making every mutation (starting
   * with logout) fail with FORBIDDEN. The token now travels in the
   * (CORS-readable) JSON response body of login/session instead — see
   * backend/routes/admin/auth.ts's matching comment.
   */
  let cachedCsrfToken = null;

  function getCsrfToken() {
    return cachedCsrfToken;
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
    // Login and session-check both carry a fresh csrfToken (see the
    // cachedCsrfToken comment above) — cache it here, in the one place
    // every response already passes through, rather than in each caller.
    if (body.data && typeof body.data.csrfToken === 'string') {
      cachedCsrfToken = body.data.csrfToken;
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
    cachedCsrfToken = null;
    window.location.href = LOGIN_PATH;
  }

  return { adminFetch, requireSession, redirectIfAuthenticated, login, logout, getCsrfToken, sanitizeNextPath };
})();

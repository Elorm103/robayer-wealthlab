/**
 * Cookie parsing/serialization — pure string transforms, no HTTP/D1/
 * network dependency (per utils/README.md's "utilities vs. services"
 * distinction). The first cookie-handling code in this codebase: every
 * prior endpoint is a stateless JSON API with no session concept.
 * Added for Version 2.0 Phase 0.1 (Authentication Foundation) — see
 * docs/v2-authentication-design.md's "Sessions" and "CSRF".
 */

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  /** Seconds until expiry. Omit (along with maxAgeSeconds: 0) to clear the cookie immediately. */
  maxAgeSeconds?: number;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join('; ');
}

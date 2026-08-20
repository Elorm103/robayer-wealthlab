/**
 * Unit tests: the announcement portion of settingsService — Phase C
 * (Announcement / Notification System). Mirrors
 * settingsServiceAiGateway.test.ts's own scoping convention: focused
 * only on what this phase added (announcement default/validate/
 * read/write), not a general settingsService test file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { updateSettings, getEditableSettings, getAnnouncement } from '../../services/admin/settingsService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');
const CTX = { ip: null, userAgent: null };

const VALID_ANNOUNCEMENT = {
  enabled: true,
  type: 'promotion',
  title: 'NEW:',
  message: 'Treasury Bills Made Simple is now available.',
  buttonText: 'Get the book',
  buttonUrl: '/books/treasury-bills-made-simple/',
  dismissible: true,
};

describe('settingsService — announcement', () => {
  let adminId: number;

  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM site_settings WHERE key IN ('announcement', 'hero_content')`);
    await env.DB.exec('DELETE FROM admin_users');
    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('announcement-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    adminId = Number(adminInsert.meta.last_row_id);
  });

  it('defaults to disabled, empty fields when never set', async () => {
    const settings = await getEditableSettings(env as any);
    expect(settings.announcement.value.enabled).toBe(false);
    expect(settings.announcement.value.title).toBe('');
    expect(settings.announcement.value.dismissible).toBe(true);

    const publicView = await getAnnouncement(env as any);
    expect(publicView.enabled).toBe(false);
    expect(publicView.version).toBeNull();
  });

  it('accepts a fully valid announcement and round-trips it through the public read', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: VALID_ANNOUNCEMENT }, CTX);
    expect(result.ok).toBe(true);

    const publicView = await getAnnouncement(env as any);
    expect(publicView.enabled).toBe(true);
    expect(publicView.type).toBe('promotion');
    expect(publicView.title).toBe('NEW:');
    expect(publicView.buttonUrl).toBe('/books/treasury-bills-made-simple/');
    expect(publicView.version).toBeTruthy(); // real updated_at timestamp, not null once a row exists
  });

  it('a second update changes the version, so an old client-side dismissal would no longer match', async () => {
    await updateSettings(env as any, logger, adminId, { announcement: VALID_ANNOUNCEMENT }, CTX);
    const first = await getAnnouncement(env as any);

    // A real clock tick is needed since updated_at has second resolution.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, title: 'UPDATED:' } }, CTX);
    const second = await getAnnouncement(env as any);

    expect(second.version).not.toBe(first.version);
    expect(second.title).toBe('UPDATED:');
  });

  it('rejects a javascript: buttonUrl — the exact stored-XSS/open-redirect vector this reuses validateHeroHref to prevent', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, buttonUrl: 'javascript:alert(1)' } }, CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === 'announcement.buttonUrl')).toBe(true);

    // Nothing was written — the previously-stored value (none yet) is unaffected.
    const publicView = await getAnnouncement(env as any);
    expect(publicView.enabled).toBe(false);
  });

  it('rejects an absolute external buttonUrl, same reasoning as javascript:', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, buttonUrl: 'https://evil.example.com/' } }, CTX);
    expect(result.ok).toBe(false);
  });

  it('allows an empty buttonUrl (no button configured)', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, buttonText: '', buttonUrl: '' } }, CTX);
    expect(result.ok).toBe(true);
    const publicView = await getAnnouncement(env as any);
    expect(publicView.buttonUrl).toBe('');
  });

  it('rejects an invalid type', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, type: 'danger' } }, CTX);
    expect(result.ok).toBe(false);
  });

  it('rejects a title over the length limit', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, title: 'x'.repeat(151) } }, CTX);
    expect(result.ok).toBe(false);
  });

  it('rejects a message over the length limit', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, message: 'x'.repeat(501) } }, CTX);
    expect(result.ok).toBe(false);
  });

  it('accepts an empty title/message (does not require non-empty content to save the record itself)', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, enabled: false, title: '', message: '' } }, CTX);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-boolean enabled/dismissible', async () => {
    const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, enabled: 'yes' } }, CTX);
    expect(result.ok).toBe(false);
  });

  it('leaves other settings (e.g. hero content) completely unaffected by an announcement update', async () => {
    await env.DB.exec(`DELETE FROM site_settings WHERE key = 'hero_content'`);
    await updateSettings(env as any, logger, adminId, { announcement: VALID_ANNOUNCEMENT }, CTX);

    const settings = await getEditableSettings(env as any);
    // Still the safe default — proves the announcement write path never touches this key.
    expect(settings.heroContent.value.headline).toBe('Financial education built for everyday Ghanaians.');
  });

  // ============================================================
  // Phase C Final Review — adversarial payloads run through the REAL
  // validation function, not reasoned about statically. title/message/
  // buttonText are stored as literal text regardless of content (safe
  // ONLY because the renderer uses textContent, never innerHTML — see
  // site-announcement.js and the corresponding client-side note in the
  // review report); buttonUrl is the one field where the SERVER must
  // reject a dangerous scheme outright, since it becomes a real `.href`.
  // ============================================================
  describe('adversarial payloads', () => {
    const XSS_STRINGS = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
    ];

    it('accepts XSS-shaped strings in title/message/buttonText as inert literal text (safe because the renderer only ever uses textContent)', async () => {
      for (const payload of XSS_STRINGS) {
        const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, title: payload, message: payload, buttonText: payload.slice(0, 60) } }, CTX);
        expect(result.ok).toBe(true);
        const publicView = await getAnnouncement(env as any);
        // Stored verbatim, not sanitized/stripped — confirms this field
        // relies entirely on the client rendering it as text, never HTML.
        expect(publicView.title).toBe(payload);
      }
    });

    const DANGEROUS_URL_SCHEMES = [
      'javascript:alert(1)',
      'javascript:alert(String.fromCharCode(88,83,83))',
      'JaVaScRiPt:alert(1)', // case-insensitivity check
      ' javascript:alert(1)', // leading whitespace
      '\tjavascript:alert(1)', // leading control character
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'https://evil.example.com/',
      'http://evil.example.com/',
      // Phase C.1 — protocol-relative URLs, closed by the (?!\/)
      // lookahead added to HERO_HREF_PATTERN. Browsers treat these as
      // full external navigations, not same-site paths.
      '//evil.example.com/',
      '//evil.example.com/phishing',
      '///evil.example.com/', // triple slash — must not slip past the lookahead either
    ];

    it('rejects every dangerous URL scheme for buttonUrl, including protocol-relative URLs (Phase C.1 fix)', async () => {
      for (const payload of DANGEROUS_URL_SCHEMES) {
        const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, buttonUrl: payload } }, CTX);
        expect(result.ok, `expected "${payload}" to be rejected`).toBe(false);
      }
    });

    it('accepts every legitimate relative-path and mailto:/tel: form — the exact ALLOW list from the review', async () => {
      for (const payload of [
        '/',
        '/books/',
        '/books/example/',
        '/books/treasury-bills-made-simple/',
        '/dashboard/',
        '/foo?x=1',
        '/foo#section',
        '/resources/#faq',
        'mailto:test@example.com',
        'mailto:hello@robayerwealthlab.com',
        'tel:+233000000000',
        'tel:+233537806352',
      ]) {
        const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, buttonUrl: payload } }, CTX);
        expect(result.ok, `expected "${payload}" to be accepted`).toBe(true);
      }
    });

    it('rejects a null announcement object, and an array masquerading as one', async () => {
      const nullResult = await updateSettings(env as any, logger, adminId, { announcement: null }, CTX);
      expect(nullResult.ok).toBe(false);
      const arrayResult = await updateSettings(env as any, logger, adminId, { announcement: [1, 2, 3] }, CTX);
      expect(arrayResult.ok).toBe(false);
    });

    it('rejects wrong JSON types for every field (numbers/objects/arrays where a string/boolean is expected)', async () => {
      const mutations: Record<string, unknown>[] = [
        { title: 12345 },
        { title: { nested: 'object' } },
        { title: ['array'] },
        { message: null },
        { enabled: 1 }, // truthy number, not a real boolean
        { enabled: 'true' }, // string, not a real boolean
        { dismissible: null },
        { type: 123 },
        { type: ['info'] },
        { buttonUrl: 42 },
        { buttonUrl: {} },
      ];
      for (const mutation of mutations) {
        const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, ...mutation } }, CTX);
        expect(result.ok, `expected mutation ${JSON.stringify(mutation)} to be rejected`).toBe(false);
      }
    });

    it('silently drops unexpected/extra fields rather than storing or echoing them back — no prototype pollution vector', async () => {
      const result = await updateSettings(
        env as any,
        logger,
        adminId,
        { announcement: { ...VALID_ANNOUNCEMENT, __proto__: { polluted: true }, unexpectedField: 'should be dropped', isAdmin: true } },
        CTX
      );
      expect(result.ok).toBe(true);

      const publicView = await getAnnouncement(env as any);
      const keys = Object.keys(publicView).sort();
      expect(keys).toEqual(['buttonText', 'buttonUrl', 'dismissible', 'enabled', 'message', 'title', 'type', 'version']);
      expect((publicView as any).unexpectedField).toBeUndefined();
      expect((publicView as any).isAdmin).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined(); // Object.prototype itself was never touched
    });

    it('an oversized buttonUrl within the URL pattern is still capped by the same practical limits as hero_content (no dedicated length cap of its own — a pre-existing, shared characteristic, not new to this field)', async () => {
      const longPath = '/' + 'a'.repeat(5000);
      const result = await updateSettings(env as any, logger, adminId, { announcement: { ...VALID_ANNOUNCEMENT, buttonUrl: longPath } }, CTX);
      // Documents actual current behavior rather than asserting a
      // desired one — see the review report's finding on this.
      expect(result.ok).toBe(true);
    });
  });

  // ============================================================
  // Phase C.1 — proves the HERO_HREF_PATTERN fix protects
  // hero_content's own CTAs too, not just announcement.buttonUrl.
  // This settings group had no dedicated test file before this fix
  // (confirmed: settingsServiceAiGateway.test.ts's own header comment
  // explicitly scopes itself away from hero_content) — added here
  // since this file is what changed the shared validator both depend
  // on, not because hero_content otherwise belongs in this file.
  // ============================================================
  describe('hero_content — same HERO_HREF_PATTERN fix, verified independently', () => {
    const VALID_HERO = {
      eyebrow: 'Financial education for Ghana',
      headline: 'Financial education built for everyday Ghanaians.',
      subheading: 'Practical, honest guidance.',
      primaryCtaText: 'Explore Free Resources',
      primaryCtaHref: '/resources/',
      secondaryCtaText: 'Get in Touch',
      secondaryCtaHref: '/contact/',
    };

    it('rejects a protocol-relative primaryCtaHref/secondaryCtaHref', async () => {
      const result1 = await updateSettings(env as any, logger, adminId, { heroContent: { ...VALID_HERO, primaryCtaHref: '//evil.example.com/' } }, CTX);
      expect(result1.ok).toBe(false);

      const result2 = await updateSettings(env as any, logger, adminId, { heroContent: { ...VALID_HERO, secondaryCtaHref: '//evil.example.com/phishing' } }, CTX);
      expect(result2.ok).toBe(false);
    });

    it('still accepts legitimate relative-path and mailto:/tel: hero CTAs after the fix', async () => {
      for (const payload of ['/resources/', '/contact/', '/', '/books/?ref=hero', 'mailto:hello@robayerwealthlab.com', 'tel:+233537806352']) {
        const result = await updateSettings(env as any, logger, adminId, { heroContent: { ...VALID_HERO, primaryCtaHref: payload } }, CTX);
        expect(result.ok, `expected "${payload}" to be accepted`).toBe(true);
      }
    });
  });
});

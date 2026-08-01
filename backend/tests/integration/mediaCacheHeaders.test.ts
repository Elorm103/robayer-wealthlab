/**
 * Version 4.2.1 (Hero Cover Flicker Instrumentation) regression test.
 *
 * Root cause: middleware/securityHeaders.ts unconditionally overwrote
 * Cache-Control on every non-HTML response with `no-store`, including
 * routes/media.ts's own deliberate `public, max-age=31536000,
 * immutable` for real, content-addressed media files — meaning every
 * uploaded image (the homepage hero's book cover included) was fully
 * re-downloaded on every single page view, with no caching anywhere.
 * Guards against that global rule regressing back to overwriting a
 * route's own public caching opt-in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

const STORAGE_KEY = 'media/images/uncategorized/test-cache-headers.png';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM media_assets WHERE storage_key = ?').bind(STORAGE_KEY).run();
  await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-cache-headers.png', 'test-cache-headers.png', 'image/png', 42, 'test-hash', ?, 'https://example.com/test-cache-headers.png', 'image', 'uncategorized', 'ready')`
  )
    .bind(STORAGE_KEY)
    .run();
  await env.STORAGE.put(STORAGE_KEY, new Uint8Array([1, 2, 3, 4]));
});

describe('GET /api/media/file/:key — Cache-Control', () => {
  it('serves the route\'s own public, immutable Cache-Control, not the global no-store default', async () => {
    const res = await SELF.fetch(`https://example.com/api/media/file/${STORAGE_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('Pragma')).not.toBe('no-cache');
  });

  it('a genuinely uncacheable JSON response still gets the safe no-store default', async () => {
    const res = await SELF.fetch('https://example.com/api/media/file/does-not-exist.png');
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
  });
});

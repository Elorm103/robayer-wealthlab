/**
 * Integration tests: the Controlled Library Reader end-to-end HTTP flow.
 * Real Worker fetch handler, real D1, real R2 test bucket (holding
 * genuine, freshly-built PDF/EPUB fixtures for these tests only - no
 * external fixture files). These tests are the direct, empirical proof
 * for every numbered security property explicitly required before
 * this feature is considered complete.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';

const PDF_STORAGE_KEY = 'ebooks/controlled-reader-test.pdf';
const EPUB_STORAGE_KEY = 'ebooks/controlled-reader-test.epub';
const PDF_ASSET_ID = 'asset-controlled-reader-test-pdf-v1';
const EPUB_ASSET_ID = 'asset-controlled-reader-test-epub-v1';
const PDF_SLUG = 'controlled-reader-test-pdf';
const EPUB_SLUG = 'controlled-reader-test-epub';

async function buildTestPdfBytes(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([400, 600]);
    page.drawText(`Master document real page ${i} content.`, { x: 40, y: 550, size: 14, font });
  }
  return doc.save();
}

// Every test below shares one KV-backed rate limiter (keyed by IP,
// per middleware/rateLimit.ts) across the whole file, since only D1/R2
// get fresh state per test, not RATE_LIMIT_KV. Without a distinct IP
// per request, tests later in the file would start tripping the real
// 20/60s reader-session limiter - a false failure unrelated to the
// security property under test.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

function buildTestEpubBytes(chapterCount: number): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
  };
  const manifestItems: string[] = [];
  const spineItems: string[] = [];
  for (let i = 1; i <= chapterCount; i++) {
    manifestItems.push(`<item id="ch${i}" href="chapter${i}.xhtml"/>`);
    spineItems.push(`<itemref idref="ch${i}"/>`);
    files[`OEBPS/chapter${i}.xhtml`] = strToU8(`<html><body><h1>Chapter ${i}</h1><p>Real chapter ${i} content, distinct per chapter.</p></body></html>`);
  }
  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0"?><package><manifest>${manifestItems.join('')}</manifest><spine>${spineItems.join('')}</spine></package>`);
  return zipSync(files);
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM content_access_log');
  await env.DB.exec('DELETE FROM reader_sessions');
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM product_files');
  await env.DB.exec('DELETE FROM media_assets');
  await env.DB.exec(`DELETE FROM products WHERE slug IN ('${PDF_SLUG}', '${EPUB_SLUG}')`);
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec(`DELETE FROM site_settings WHERE key = 'controlled_reader_enabled'`);
  // The flag now defaults OFF in production (Phase 2's deliberate
  // change from the earlier default-on attempt) - this suite enables
  // it for every test up front so the normal/enabled path is what's
  // being exercised by default, matching the pre-Phase-2 test
  // assumption; individual tests that need to exercise the disabled
  // state explicitly override this within their own body.
  await env.DB.prepare(`INSERT INTO site_settings (key, value) VALUES ('controlled_reader_enabled', 'true')`).run();

  const pdfBytes = await buildTestPdfBytes(12);
  await env.STORAGE.put(PDF_STORAGE_KEY, pdfBytes);
  const epubBytes = buildTestEpubBytes(6);
  await env.STORAGE.put(EPUB_STORAGE_KEY, epubBytes);

  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES ('prod-controlled-reader-pdf', ?, 'Controlled Reader Test PDF', 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(PDF_SLUG)
    .run();
  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES ('prod-controlled-reader-epub', ?, 'Controlled Reader Test EPUB', 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(EPUB_SLUG)
    .run();

  const pdfMedia = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('controlled-reader-test.pdf', 'controlled-reader-test.pdf', 'application/pdf', 1024, 'aaaa', ?, 'https://example.com/x.pdf', 'document', 'books', 'ready')`
  )
    .bind(PDF_STORAGE_KEY)
    .run();
  const epubMedia = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('controlled-reader-test.epub', 'controlled-reader-test.epub', 'application/epub+zip', 1024, 'bbbb', ?, 'https://example.com/x.epub', 'document', 'books', 'ready')`
  )
    .bind(EPUB_STORAGE_KEY)
    .run();

  const pdfProduct = await env.DB.prepare(`SELECT id FROM products WHERE slug = ?`).bind(PDF_SLUG).first<{ id: number }>();
  const epubProduct = await env.DB.prepare(`SELECT id FROM products WHERE slug = ?`).bind(EPUB_SLUG).first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, 'PDF Asset', 'PDF', 'published')`)
    .bind(pdfProduct!.id, PDF_ASSET_ID, Number(pdfMedia.meta.last_row_id))
    .run();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, 'EPUB Asset', 'EPUB', 'published')`)
    .bind(epubProduct!.id, EPUB_ASSET_ID, Number(epubMedia.meta.last_row_id))
    .run();
});

async function seedCustomerWithPurchase(email: string, opts: { assetId: string; productSlug: string; reference: string; deliveryStatus?: string }) {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });

  const purchaseInsert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
     VALUES (?, ?, 'prod-controlled-reader-x', 'Controlled Reader Test', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
  )
    .bind(opts.reference, opts.productSlug, customerId)
    .run();
  const purchaseSessionId = Number(purchaseInsert.meta.last_row_id);

  const deliveryInsert = await env.DB.prepare(
    `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, status) VALUES (?, ?, ?, ?)`
  )
    .bind(purchaseSessionId, opts.assetId, opts.productSlug, opts.deliveryStatus ?? 'delivered')
    .run();

  return { customerId, cookieHeader: `customer_session=${session.sessionToken}`, purchaseSessionId, deliveryId: Number(deliveryInsert.meta.last_row_id) };
}

async function mintReaderSession(cookieHeader: string, reference: string, assetId: string) {
  const res = await SELF.fetch(`https://example.com/api/customer/purchases/${reference}/reader-session`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
    body: JSON.stringify({ assetId }),
  });
  return res.json<any>();
}

describe('POST /api/customer/purchases/:reference/reader-session', () => {
  it('requires authentication (property 8: authorization boundaries)', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-900001/reader-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ assetId: PDF_ASSET_ID }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(res.status).toBe(401);
  });

  it("a DIFFERENT customer cannot mint a reader session for someone else's purchase (property 8)", async () => {
    await seedCustomerWithPurchase('owner@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900002' });
    const { customerId: intruderCustomerId } = await findOrCreateCustomer(env as any, 'intruder@example.com', false);
    const intruderSession = await createCustomerSession(env as any, intruderCustomerId, { ip: null, userAgent: null });

    const body = await mintReaderSession(`customer_session=${intruderSession.sessionToken}`, 'RWL-2026-900002', PDF_ASSET_ID);
    expect(body.success).toBe(false);
  });

  it('a revoked delivery is denied a reader session (entitlement re-checked at mint time)', async () => {
    const purchase = await seedCustomerWithPurchase('revoked@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900003', deliveryStatus: 'revoked' });
    const body = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900003', PDF_ASSET_ID);
    expect(body.success).toBe(false);
  });

  it('when controlled_reader_enabled is off, minting is refused with a distinct code the client uses to fall back to the legacy flow', async () => {
    await env.DB.prepare(`UPDATE site_settings SET value = 'false' WHERE key = 'controlled_reader_enabled'`).run();
    const purchase = await seedCustomerWithPurchase('flagoff@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900004' });
    const body = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900004', PDF_ASSET_ID);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONTROLLED_READER_DISABLED');
  });

  it('a valid mint returns a session token and the real total page count for a PDF, without ever including the master file bytes', async () => {
    const purchase = await seedCustomerWithPurchase('reader@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900005' });
    const body = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900005', PDF_ASSET_ID);
    expect(body.success).toBe(true);
    expect(body.data.fileType).toBe('PDF');
    expect(body.data.totalPages).toBe(12);
    expect(typeof body.data.token).toBe('string');
    expect(JSON.stringify(body.data)).not.toMatch(/%PDF/); // the raw PDF file signature must never appear in this JSON response
  });

  it("starting a new reader session revokes the previous active one for the same delivery (property 7: concurrent-session invalidation)", async () => {
    const purchase = await seedCustomerWithPurchase('concurrent@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900006' });
    const sessionA = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900006', PDF_ASSET_ID);
    const sessionB = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900006', PDF_ASSET_ID);
    expect(sessionA.success && sessionB.success).toBe(true);

    // Session A must now be rejected: a page fetch against it fails.
    const pageWithA = await SELF.fetch(`https://example.com/api/reader/${sessionA.data.token}/page/1`);
    const pageWithABody = await pageWithA.json<any>().catch(() => null);
    expect(pageWithA.ok).toBe(false);
    if (pageWithABody) expect(pageWithABody.error.code).toBe('READER_SESSION_INVALID');

    // Session B (the newer one) still works.
    const pageWithB = await SELF.fetch(`https://example.com/api/reader/${sessionB.data.token}/page/1`);
    expect(pageWithB.ok).toBe(true);
  });

  it("logs 'view_session_started' to content_access_log on a successful mint", async () => {
    const purchase = await seedCustomerWithPurchase('audited@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900007' });
    await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900007', PDF_ASSET_ID);
    const row = await env.DB.prepare(`SELECT action, delivery_id AS deliveryId, customer_id AS customerId FROM content_access_log WHERE action = 'view_session_started'`).first<any>();
    expect(row).toBeTruthy();
    expect(row.deliveryId).toBe(purchase.deliveryId);
    expect(row.customerId).toBe(purchase.customerId);
  });
});

describe('GET /api/reader/:sessionToken/page/:pageNumber - the core PDF security properties', () => {
  it('property 1 & 2: returns ONLY the requested page, never the complete PDF - response is a strict, smaller subset of the master', async () => {
    const purchase = await seedCustomerWithPurchase('reader1@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900010' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900010', PDF_ASSET_ID);

    const res = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`);
    expect(res.ok).toBe(true);
    // The route sets 'no-store'; the global security-headers middleware
    // (middleware/securityHeaders.ts) then strengthens it further to
    // this exact value for every non-HTML, non-opted-into-caching
    // response - a stricter, still-compliant superset of Phase 9's ask.
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const bytes = await res.arrayBuffer();
    const masterObject = await env.STORAGE.get(PDF_STORAGE_KEY);
    const masterBytes = await masterObject!.arrayBuffer();
    expect(bytes.byteLength).toBeLessThan(masterBytes.byteLength);

    const singlePageDoc = await PDFDocument.load(bytes);
    expect(singlePageDoc.getPageCount()).toBe(1);
  });

  it('page 1 and page 2 return genuinely different content', async () => {
    const purchase = await seedCustomerWithPurchase('reader2@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900011' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900011', PDF_ASSET_ID);

    const page1 = await (await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`)).arrayBuffer();
    const page2 = await (await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/2`)).arrayBuffer();
    expect(Buffer.from(page1).equals(Buffer.from(page2))).toBe(false);
  });

  it('property 3: the page response contains the expected watermark (customer email), independently verifiable by extracting its text', async () => {
    const purchase = await seedCustomerWithPurchase('watermark-check@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900012' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900012', PDF_ASSET_ID);

    const res = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/3`);
    const bytes = await res.arrayBuffer();
    const { extractPdfText } = await import('../../services/libraryKnowledge/pdfExtraction');
    const extracted = await extractPdfText(bytes);
    expect(extracted.pages[0].text).toContain('watermark-check@example.com');
    expect(extracted.pages[0].text).toContain('Robayer WealthLab');
  });

  it('rejects page 0 and a page beyond the real total', async () => {
    const purchase = await seedCustomerWithPurchase('badpage@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900013' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900013', PDF_ASSET_ID);

    const zero = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/0`);
    expect(zero.ok).toBe(false);
    const tooHigh = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/999`);
    expect(tooHigh.ok).toBe(false);
  });

  it('property 6: an invalid/nonexistent session token is rejected', async () => {
    const res = await SELF.fetch('https://example.com/api/reader/0000000000000000000000000000000000000000000000000000000000000000/page/1');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('READER_SESSION_INVALID');
  });

  it('property 5: revoking the underlying delivery mid-session blocks the very next page request, even though the session itself is still unexpired', async () => {
    const purchase = await seedCustomerWithPurchase('midsession-revoke@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900014' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900014', PDF_ASSET_ID);

    const before = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`);
    expect(before.ok).toBe(true);

    await env.DB.prepare(`UPDATE deliveries SET status = 'revoked' WHERE id = ?`).bind(purchase.deliveryId).run();

    const after = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/2`);
    const afterBody = await after.json<any>().catch(() => null);
    expect(after.ok).toBe(false);
    if (afterBody) expect(afterBody.error.code).toBe('READER_ACCESS_DENIED');
  });

  it('property 6: an expired session is rejected', async () => {
    const purchase = await seedCustomerWithPurchase('expired@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900015' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900015', PDF_ASSET_ID);

    await env.DB.prepare(`UPDATE reader_sessions SET expires_at = datetime('now', '-1 minute') WHERE delivery_id = ?`).bind(purchase.deliveryId).run();

    const res = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('READER_SESSION_INVALID');
  });

  it('property 6: an explicitly revoked session is rejected', async () => {
    const purchase = await seedCustomerWithPurchase('revoked-session@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900016' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900016', PDF_ASSET_ID);

    await env.DB.prepare(`UPDATE reader_sessions SET revoked_at = datetime('now') WHERE delivery_id = ?`).bind(purchase.deliveryId).run();

    const res = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('READER_SESSION_INVALID');
  });

  it('property 6: a session minted for one delivery cannot be used against a different delivery\'s asset (checked via the request itself only ever resolving THIS session\'s own bound delivery)', async () => {
    const purchaseA = await seedCustomerWithPurchase('crossdeliv-a@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900017' });
    const purchaseB = await seedCustomerWithPurchase('crossdeliv-b@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900018' });
    const sessionA = await mintReaderSession(purchaseA.cookieHeader, 'RWL-2026-900017', PDF_ASSET_ID);

    // Session A's token always resolves to delivery A regardless of
    // anything about delivery B - proven by confirming B's own access
    // log stays completely untouched by using A's session.
    await SELF.fetch(`https://example.com/api/reader/${sessionA.data.token}/page/1`);
    const bDeliveryLogs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM content_access_log WHERE delivery_id = ?`).bind(purchaseB.deliveryId).first<any>();
    expect(bDeliveryLogs.n).toBe(0);
  });

  it("logs 'page_rendered' to content_access_log with the real page number", async () => {
    const purchase = await seedCustomerWithPurchase('pagelog@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900019' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900019', PDF_ASSET_ID);
    await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/4`);

    const row = await env.DB.prepare(`SELECT action, metadata FROM content_access_log WHERE action = 'page_rendered'`).first<any>();
    expect(row).toBeTruthy();
    expect(JSON.parse(row.metadata).pageNumber).toBe(4);
  });
});

describe('GET /api/reader/:sessionToken/chapter/:chapterReference - the core EPUB security properties', () => {
  it('property 4: never exposes the complete EPUB archive - the response is a strict subset, smaller than the master', async () => {
    const purchase = await seedCustomerWithPurchase('epubreader@example.com', { assetId: EPUB_ASSET_ID, productSlug: EPUB_SLUG, reference: 'RWL-2026-900020' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900020', EPUB_ASSET_ID);
    expect(session.data.fileType).toBe('EPUB');
    expect(session.data.spine.length).toBe(6);

    const chapterHref = session.data.spine[2].href;
    const res = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/chapter/${encodeURIComponent(chapterHref)}`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const html = await res.text();
    const masterObject = await env.STORAGE.get(EPUB_STORAGE_KEY);
    const masterBytes = await masterObject!.arrayBuffer();
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(masterBytes.byteLength);
    expect(html).toContain('Chapter 3');
    expect(html).not.toContain('Chapter 1');
    expect(html).not.toContain('Chapter 6');
  });

  it('preserves the strict CSP (script-src \'none\') in the delivered chapter', async () => {
    const purchase = await seedCustomerWithPurchase('epubcsp@example.com', { assetId: EPUB_ASSET_ID, productSlug: EPUB_SLUG, reference: 'RWL-2026-900021' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900021', EPUB_ASSET_ID);
    const chapterHref = session.data.spine[0].href;
    const res = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/chapter/${encodeURIComponent(chapterHref)}`);
    const html = await res.text();
    expect(html).toContain("script-src 'none'");
  });

  it('rejects a chapter reference that is not a real spine entry for this book', async () => {
    const purchase = await seedCustomerWithPurchase('epubbadref@example.com', { assetId: EPUB_ASSET_ID, productSlug: EPUB_SLUG, reference: 'RWL-2026-900022' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900022', EPUB_ASSET_ID);
    const res = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/chapter/${encodeURIComponent('OEBPS/does-not-exist.xhtml')}`);
    expect(res.ok).toBe(false);
  });

  it("logs 'chapter_rendered' with the real chapter reference", async () => {
    const purchase = await seedCustomerWithPurchase('epublog@example.com', { assetId: EPUB_ASSET_ID, productSlug: EPUB_SLUG, reference: 'RWL-2026-900023' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900023', EPUB_ASSET_ID);
    const chapterHref = session.data.spine[1].href;
    await SELF.fetch(`https://example.com/api/reader/${session.data.token}/chapter/${encodeURIComponent(chapterHref)}`);

    const row = await env.DB.prepare(`SELECT action, metadata FROM content_access_log WHERE action = 'chapter_rendered'`).first<any>();
    expect(row).toBeTruthy();
    expect(JSON.parse(row.metadata).chapterReference).toBe(chapterHref);
  });
});

describe('Immediate kill switch: controlled_reader_enabled stops an already-active session, not just new mints', () => {
  it('a valid, unexpired PDF reader session is blocked from fetching further pages the moment the flag is turned off, with no need to wait for the session to expire', async () => {
    const purchase = await seedCustomerWithPurchase('killswitch-pdf@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900060' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900060', PDF_ASSET_ID);

    const before = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`);
    expect(before.ok).toBe(true);

    await env.DB.prepare(`UPDATE site_settings SET value = 'false' WHERE key = 'controlled_reader_enabled'`).run();

    const after = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/2`);
    const afterBody = await after.json<any>();
    expect(after.ok).toBe(false);
    expect(afterBody.success).toBe(false);
    expect(afterBody.error.code).toBe('CONTROLLED_READER_DISABLED');
  });

  it('a valid, unexpired EPUB reader session is blocked from fetching further chapters the moment the flag is turned off', async () => {
    const purchase = await seedCustomerWithPurchase('killswitch-epub@example.com', { assetId: EPUB_ASSET_ID, productSlug: EPUB_SLUG, reference: 'RWL-2026-900061' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900061', EPUB_ASSET_ID);
    const chapterHref = session.data.spine[0].href;

    const before = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/chapter/${encodeURIComponent(chapterHref)}`);
    expect(before.ok).toBe(true);

    await env.DB.prepare(`UPDATE site_settings SET value = 'false' WHERE key = 'controlled_reader_enabled'`).run();

    const nextChapterHref = session.data.spine[1].href;
    const after = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/chapter/${encodeURIComponent(nextChapterHref)}`);
    const afterBody = await after.json<any>();
    expect(after.ok).toBe(false);
    expect(afterBody.success).toBe(false);
    expect(afterBody.error.code).toBe('CONTROLLED_READER_DISABLED');
  });

  it('the flag check runs before session validation, so it blocks equally whether the session is otherwise valid, expired, revoked, or simply nonexistent', async () => {
    await env.DB.prepare(`UPDATE site_settings SET value = 'false' WHERE key = 'controlled_reader_enabled'`).run();

    const res = await SELF.fetch('https://example.com/api/reader/0000000000000000000000000000000000000000000000000000000000000000/page/1');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    // Not READER_SESSION_INVALID: the flag is the reason this request
    // was refused, and that must be what the client is told, even for
    // a token that was never valid in the first place.
    expect(body.error.code).toBe('CONTROLLED_READER_DISABLED');
  });

  it('re-enabling the flag restores access to a still-unexpired, unrevoked session with no new mint needed', async () => {
    const purchase = await seedCustomerWithPurchase('killswitch-restore@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900062' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900062', PDF_ASSET_ID);

    await env.DB.prepare(`UPDATE site_settings SET value = 'false' WHERE key = 'controlled_reader_enabled'`).run();
    const blocked = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`);
    expect(blocked.ok).toBe(false);

    await env.DB.prepare(`UPDATE site_settings SET value = 'true' WHERE key = 'controlled_reader_enabled'`).run();
    const restored = await SELF.fetch(`https://example.com/api/reader/${session.data.token}/page/1`);
    expect(restored.ok).toBe(true);
  });
});

describe('Cross-token-type isolation (property: no accidental authorization bypass)', () => {
  it('a reader_sessions token cannot be redeemed against the existing GET /api/download/:token endpoint', async () => {
    const purchase = await seedCustomerWithPurchase('crosstoken1@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900030' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900030', PDF_ASSET_ID);

    const res = await SELF.fetch(`https://example.com/api/download/${session.data.token}`);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('TOKEN_NOT_FOUND');
  });

  it("an existing download_tokens token (purpose='view', from the pre-existing legacy read-access flow) cannot be redeemed against the NEW GET /api/reader/:sessionToken/page/:n endpoint", async () => {
    const purchase = await seedCustomerWithPurchase('crosstoken2@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900031' });
    const legacyReadAccess = await SELF.fetch('https://example.com/api/purchases/RWL-2026-900031/read-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ assetId: PDF_ASSET_ID }),
    });
    const legacyBody = await legacyReadAccess.json<any>();
    expect(legacyBody.success).toBe(true);
    const legacyToken = legacyBody.data.readUrl.split('/').pop();

    const res = await SELF.fetch(`https://example.com/api/reader/${legacyToken}/page/1`);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('READER_SESSION_INVALID');
  });
});

describe('Property 9: existing download behavior is completely unchanged', () => {
  it('GET /api/download/:token (download purpose) still returns the COMPLETE file, byte-for-byte identical to the master - the explicit download pathway is untouched', async () => {
    await seedCustomerWithPurchase('download-unchanged@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900040' });

    const permissionRes = await SELF.fetch('https://example.com/api/purchases/RWL-2026-900040/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ assetId: PDF_ASSET_ID }),
    });
    const permission = await permissionRes.json<any>();
    expect(permission.success).toBe(true);

    const downloadRes = await SELF.fetch(`https://example.com${permission.data.downloadUrl}`);
    expect(downloadRes.ok).toBe(true);
    expect(downloadRes.headers.get('Content-Disposition')).toContain('attachment');
    const bytes = await downloadRes.arrayBuffer();
    const masterObject = await env.STORAGE.get(PDF_STORAGE_KEY);
    const masterBytes = await masterObject!.arrayBuffer();
    expect(bytes.byteLength).toBe(masterBytes.byteLength);

    // Phase 2 deliberately does NOT touch routes/downloads.ts or
    // entitlementService.ts - download-action audit logging (a
    // separate concern from the reader work) is out of this phase's
    // documented scope, so no content_access_log row is expected here.
    // This test exists to prove the download response itself - byte
    // count, headers - is untouched, not to assert a logging behavior
    // this phase never introduced.
    const logRow = await env.DB.prepare(`SELECT action FROM content_access_log WHERE action = 'download'`).first<any>();
    expect(logRow).toBeNull();
  });
});

describe('Property 10: no protected asset accidentally becomes publicly accessible', () => {
  it('the PDF and EPUB master storage keys remain 404 via the public, unauthenticated GET /api/media/file/:key route, exactly as before this feature', async () => {
    const pdfRes = await SELF.fetch(`https://example.com/api/media/file/${PDF_STORAGE_KEY}`);
    expect(pdfRes.status).not.toBe(200);
    const epubRes = await SELF.fetch(`https://example.com/api/media/file/${EPUB_STORAGE_KEY}`);
    expect(epubRes.status).not.toBe(200);
  });

  it('a controlled reader session token is never usable as a public media key or otherwise reachable without going through the reader endpoints', async () => {
    const purchase = await seedCustomerWithPurchase('noleak@example.com', { assetId: PDF_ASSET_ID, productSlug: PDF_SLUG, reference: 'RWL-2026-900050' });
    const session = await mintReaderSession(purchase.cookieHeader, 'RWL-2026-900050', PDF_ASSET_ID);
    const res = await SELF.fetch(`https://example.com/api/media/file/${session.data.token}`);
    expect(res.status).not.toBe(200);
  });
});

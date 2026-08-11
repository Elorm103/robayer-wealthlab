/**
 * Server-side rich-text HTML sanitizer — Version 2.0 Phase 2 (Products
 * Module). Applied to `products.description` before it is ever stored,
 * so the value is safe to render as raw HTML on a public product page
 * (routes/books.ts) reaching every site visitor, not just the admin
 * who wrote it.
 *
 * The admin product editor (js/components/admin/admin-product-editor.js)
 * already runs an equivalent allowlist sanitizer client-side before
 * submitting — but that is a UX courtesy, not a security boundary: a
 * compromised admin session, a browser extension, or a bug in that
 * client code could all submit unsanitized HTML directly to this API.
 * "Never trust frontend input" (this project's own stated security
 * posture) means the server must independently enforce the same
 * allowlist, not assume the client already did.
 *
 * Built on `HTMLRewriter` — a native Workers Web API (this project's
 * stated zero-runtime-dependency posture; see wrangler.jsonc's own
 * comment on why no npm dependency was added for this), not a DOM
 * (unavailable in the Workers runtime) and not a third-party sanitizer
 * library.
 */

/**
 * `table`/`thead`/`tbody`/`tr`/`th`/`td` added in Version 2.1 Phase 2
 * (Blog CMS) — a real, low-risk allowlist extension (comparison
 * tables are common, legitimate personal-finance content, not a new
 * mechanism: the same attribute-stripping rule below already applies
 * to them, no new attribute needs to survive on any of these tags).
 * No admin-editor toolbar button inserts a table (contenteditable has
 * no native `insertTable` command) — this only allows a table to
 * survive sanitization if it's already present in stored HTML (e.g.
 * this phase's own one-time content migration), not a promise of a
 * full table-authoring UI.
 */
const ALLOWED_TAGS = new Set([
  'p', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'blockquote', 'code', 'a', 'img', 'br', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

function isSafeUrl(value: string | null): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value) || value.startsWith('/');
}

/**
 * Removes every element not on the allowlist (unwrapping — keeping its
 * text/children — rather than deleting, so a stray disallowed wrapper
 * never eats real content) and strips every attribute except href (on
 * `<a>`) and src/alt (on `<img>`), rejecting non-http(s)/relative URLs
 * (blocks `javascript:`/`data:` schemes). Matches the client-side
 * sanitizer's exact rules so a value that passes one passes the other.
 */
export async function sanitizeRichTextHtml(html: string | null): Promise<string | null> {
  if (!html) return html;

  // `a` and `img` are handled entirely within their own single-pass
  // handler below (read the attribute, strip everything, re-apply the
  // validated value — all inside one element() call) rather than
  // splitting the read and the strip across two separately-registered
  // `.on()` handlers. An earlier version relied on `.on('a', ...)` and
  // `.on('*', ...)` both matching `<a>` and assumed HTMLRewriter would
  // run them in registration order per element — it does not
  // reliably do so across independently-registered selectors, which in
  // production silently stripped every `href` a real save ever wrote
  // (confirmed: a live PATCH with correct `href="https://..."` values
  // came back with bare `<a>` tags). Keeping each tag's full
  // read-strip-reapply sequence inside a single handler removes any
  // dependency on cross-handler ordering.
  class ElementSanitizer {
    element(element: Element) {
      const tag = element.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        element.removeAndKeepContent();
        return;
      }
      if (tag === 'a' || tag === 'img') return; // handled below, in their own single-pass handlers
      // Remove every attribute first, then re-add only what's allowed —
      // simpler and safer than an attribute denylist, which would need
      // updating every time a new dangerous attribute is invented.
      // Names are snapshotted into a plain array before removing any of
      // them — `element.attributes` is a live iterator, and
      // HTMLRewriter throws ("attributes ... modified during
      // iteration") if removeAttribute() is called while still
      // iterating it directly, a real bug found via adversarial testing
      // with a multi-attribute payload.
      const attributeNames = [...element.attributes].map(([name]) => name);
      for (const name of attributeNames) {
        element.removeAttribute(name);
      }
    }
  }

  class AnchorHrefSanitizer {
    element(element: Element) {
      const href = element.getAttribute('href');
      const safe = isSafeUrl(href);
      const attributeNames = [...element.attributes].map(([name]) => name);
      for (const name of attributeNames) {
        element.removeAttribute(name);
      }
      if (safe) {
        element.setAttribute('href', href as string);
        element.setAttribute('rel', 'noopener noreferrer');
        element.setAttribute('target', '_blank');
      }
    }
  }

  class ImgSrcSanitizer {
    element(element: Element) {
      const src = element.getAttribute('src');
      const alt = element.getAttribute('alt') ?? '';
      const safe = isSafeUrl(src);
      if (!safe) {
        element.remove();
        return;
      }
      const attributeNames = [...element.attributes].map(([name]) => name);
      for (const name of attributeNames) {
        element.removeAttribute(name);
      }
      element.setAttribute('src', src as string);
      element.setAttribute('alt', alt);
    }
  }

  const rewriter = new HTMLRewriter()
    .on('a', new AnchorHrefSanitizer())
    .on('img', new ImgSrcSanitizer())
    .on('*', new ElementSanitizer());

  const response = rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  return await response.text();
}

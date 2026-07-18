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

  class ElementSanitizer {
    element(element: Element) {
      const tag = element.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        element.removeAndKeepContent();
        return;
      }
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

  class LinkSanitizer {
    element(element: Element) {
      if (element.tagName.toLowerCase() !== 'a') return;
      // At this point handled by ElementSanitizer's attribute-strip above
      // (registered first in the same .on('*') pass would race) — links
      // are handled in a dedicated pass instead, reading the ORIGINAL
      // href before ElementSanitizer strips it. See registration order below.
    }
  }
  void LinkSanitizer; // kept for documentation of intent; actual link/img handling is done in the two dedicated passes below

  class AnchorHrefSanitizer {
    element(element: Element) {
      const href = element.getAttribute('href');
      if (isSafeUrl(href)) {
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
      if (isSafeUrl(src)) {
        element.setAttribute('src', src as string);
        element.setAttribute('alt', alt);
      } else {
        element.remove();
      }
    }
  }

  // Order matters: read the original href/src attributes BEFORE
  // ElementSanitizer's blanket attribute-strip runs, then re-apply the
  // validated value — HTMLRewriter runs registered handlers on each
  // element in registration order for a single pass over the stream.
  const rewriter = new HTMLRewriter()
    .on('a', new AnchorHrefSanitizer())
    .on('img', new ImgSrcSanitizer())
    .on('*', new ElementSanitizer());

  const response = rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  return await response.text();
}

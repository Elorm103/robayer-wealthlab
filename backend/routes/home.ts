/**
 * GET / — Version 4.2.6 (Worker-Rendered Homepage). Extends the same
 * pattern already proven for `/books/*`, `/resources/*`, `/blog/*`,
 * `/free-guide/*` (backend/wrangler.jsonc) to the homepage's hero and
 * Featured eBook sections — the two places on the site that used to
 * depend entirely on a client-side `/api/products` fetch (see
 * docs/v4.2.5-hero-cover-flicker-root-cause-report.md) before the
 * browser could show the real, current featured product's cover.
 *
 * Deliberately does NOT fetch `index.html` from GitHub Pages at
 * request time — routes/books.ts's own header comment explains why: a
 * Worker subrequest to a URL matching one of this zone's own Routes
 * re-enters that same Route rather than reaching the static origin,
 * and this repository has no verified record of the actual GitHub
 * Pages DNS/origin topology to build a safe alternate-hostname proxy
 * against. Instead, `index.html` is imported as a build-time TEXT
 * module (the exact mechanism services/emailService.ts already uses
 * for its email templates — see types/html-modules.d.ts and
 * wrangler.jsonc's `rules`), so there is exactly one source of truth
 * for the homepage's markup and zero network fetch involved. Every
 * other section of the page (nav, footer, every non-hero section, all
 * CSS/JS) passes through completely untouched — only the hero and
 * Featured eBook cover/title/subtitle/description/CTA elements are
 * ever rewritten, via HTMLRewriter, using the exact same
 * [data-feature-*] attribute hooks js/components/product-loader.js's
 * initFeatureBanners() already reads and writes — that script still
 * runs on every load and still keeps things in sync if the featured
 * product changes in the narrow window between this response being
 * generated and the client's own /api/products fetch resolving, but
 * for every normal page load, the correct cover is already fully
 * decoded and visible in the very first HTML byte the browser
 * receives, before any JavaScript has to run at all.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { getHomepageFeaturedProduct } from '../services/productService';
import homepageTemplate from '../../index.html';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function formatGHS(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const withSeparators = Math.abs(rounded).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `GH₵${withSeparators}`;
}

class SetImageSrc {
  constructor(private url: string) {}
  element(el: Element) {
    el.setAttribute('src', this.url);
    el.removeAttribute('hidden');
  }
}

class Hide {
  element(el: Element) {
    el.setAttribute('hidden', '');
  }
}

class SetText {
  constructor(private value: string) {}
  element(el: Element) {
    el.setInnerContent(this.value);
  }
}

class SetHref {
  constructor(private href: string) {}
  element(el: Element) {
    el.setAttribute('href', this.href);
  }
}

/**
 * `<link rel=preload as=image>` for the cover — the Worker already
 * knows the exact URL, so the browser can start the request the
 * instant it parses <head>, before it even reaches the hero markup
 * further down the body.
 */
class InjectPreload {
  constructor(private url: string) {}
  element(head: Element) {
    head.append(`<link rel="preload" as="image" href="${escapeAttr(this.url)}">`, { html: true });
  }
}

export async function handleHomepage(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  const featured = await getHomepageFeaturedProduct(env);

  const baseHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    // Same reasoning as routes/books.ts's htmlResponse(): an admin
    // changing the featured product, its price, or its cover must show
    // up on the very next request, not whenever an edge cache entry
    // happens to expire. The one D1 query this route needs is a single
    // indexed row lookup (WHERE featured = 1 AND status = 'active',
    // LIMIT 1) - cheap enough on its own that trading correctness for
    // a cache layer isn't a trade worth making at this site's traffic
    // volume. If that ever changes, a short edge-cache TTL purged from
    // the admin product-save handler would be the next step - not
    // implemented now because there is no evidence it is needed yet.
    'Cache-Control': 'no-store',
  };

  // No eligible featured product (a genuinely empty catalog, or the
  // one product currently featured isn't `active`) - the template's
  // own static fallback content (the typographic placeholder, the
  // static copy already in index.html) is the same honest "nothing to
  // show yet" behavior this codebase already uses everywhere else, so
  // just serve it untouched. product-loader.js's own client-side fetch
  // still gets a chance to find something if the data changes a moment
  // later.
  if (!featured) {
    return new Response(homepageTemplate, { headers: baseHeaders });
  }

  const priceLabel = featured.price === 0 ? 'Free' : featured.onSale ? formatGHS(featured.salePrice as number) : featured.price !== null ? formatGHS(featured.price) : null;
  const ctaLabel = priceLabel ? `Get the guide: ${priceLabel}` : 'Get the guide';
  const featuredEbookCtaLabel = priceLabel ? `Get the guide (${priceLabel})` : 'Get the guide';
  const productHref = `/books/${featured.slug}/`;

  const templateResponse = new Response(homepageTemplate, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  const rewriter = new HTMLRewriter();

  if (featured.coverPublicUrl) {
    rewriter.on('head', new InjectPreload(featured.coverPublicUrl));
    rewriter.on('img[data-feature-cover-img]', new SetImageSrc(featured.coverPublicUrl));
    rewriter.on('[data-feature-placeholder]', new Hide());
  }

  rewriter
    .on('[data-feature-title]', new SetText(featured.title))
    .on('[data-feature-subtitle]', new SetText(featured.subtitle ?? featured.shortDescription ?? ''))
    .on('[data-feature-description]', new SetText(featured.shortDescription ?? featured.subtitle ?? ''))
    .on('a[data-feature-cta]', new SetHref(productHref));

  // Hero's CTA label and the Featured eBook's CTA label read the same
  // attribute but need different copy (Hero: "Get the guide: {price}";
  // Featured eBook: "Get the guide ({price})", matching
  // initFeatureBanners()'s own existing formatting for each) - handled
  // by giving each its own element handler keyed on which section
  // wraps it, since HTMLRewriter has no "Nth match" selector.
  rewriter.on('.hero__book-cta[data-feature-cta-label]', new SetText(ctaLabel));
  rewriter.on('.feature-banner__cta-label[data-feature-cta-label]', new SetText(featuredEbookCtaLabel));

  const rewritten = rewriter.transform(templateResponse);
  const html = await rewritten.text();

  return new Response(html, { headers: baseHeaders });
}

/**
 * GET /books/*, Version 2.0 Phase 2 (Products Module) — public site
 * integration. See docs/v2-books-route-architecture.md.
 *
 * Full owner of the `/books/*` path via a new Cloudflare Workers Route
 * (backend/wrangler.jsonc), extending the same pattern already proven
 * for `/api/*` (docs/v2-same-origin-architecture.md). Deliberately does
 * NOT proxy/fetch back to `robayerwealthlab.com` for any fallback case
 * — a Worker subrequest to a URL matching one of its own zone's Routes
 * re-enters that same Route rather than reaching the static origin
 * directly (a well-known Workers behavior), and this repository has no
 * verified record of the actual GitHub Pages DNS/origin topology
 * (see the Phase 2 fresh architectural review) to build a safe
 * alternate-hostname proxy against. Every request under `/books/*` is
 * therefore rendered or 404'd entirely from D1, in this file, with no
 * origin fetch at all — eliminating that risk by construction rather
 * than working around it.
 *
 * The two products migrated in Phase 2 (migration 0009) replace their
 * previously hand-authored static HTML at the exact same URLs — those
 * static files under books/ in the repo become unreachable dead code
 * once this Route is live (shadowed, not deleted, matching how
 * content/products/*.json was left in place after Phase 1's own
 * JSON-to-D1 cutover elsewhere).
 *
 * Every dynamic value interpolated into HTML here is either from a
 * fixed, developer-authored template (safe by construction) or a
 * database column — `description` is the one rich-HTML column and is
 * sanitized server-side at write time (services/productService.ts,
 * utils/richTextSanitizer.ts) specifically so it's safe to emit here
 * unescaped; every other product field is plain text, HTML-escaped via
 * escapeHtml() below before interpolation.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { RouteParams } from '../worker/index';
import * as productService from '../services/productService';
import { isPubliclyListedStatus } from '../services/productService';
import type { ProductRecord } from '../services/productService';

const SITE_NAME = 'Robayer WealthLab';
const SITE_ORIGIN = 'https://robayerwealthlab.com';

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatGHS(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const withSeparators = Math.abs(rounded).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `GH₵${withSeparators}`;
}

/**
 * Every /books/* HTML response goes through this — explicit `no-store`
 * rather than relying on Cloudflare's/the browser's implicit default
 * for an uncached-Content-Type response. Found during adversarial
 * review: this route replaced a static-file system whose own default
 * caching was GitHub Pages' concern, not this Worker's; leaving
 * Cache-Control unset here would mean an admin editing a price or
 * publishing a product has no guarantee the change appears promptly —
 * the same "never risk stale prices" instinct this codebase already
 * applies to checkout/purchase responses. Media Library's own
 * `routes/media.ts` deliberately does the opposite (`immutable`, a
 * year) for the same reason in the other direction: a real UUID-keyed
 * file's bytes genuinely never change, so aggressive caching there is
 * correct, not an oversight.
 */
function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const HEAD_ASSETS = `
  <link rel="icon" type="image/svg+xml" href="/assets/icons/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32.png">
  <link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,500;0,600;1,500&family=Space+Grotesk:wght@500&family=Work+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">

  <link rel="stylesheet" href="/css/tokens.css">
  <link rel="stylesheet" href="/css/base.css">
  <link rel="stylesheet" href="/css/layout.css">
  <link rel="stylesheet" href="/css/components.css">
  <link rel="stylesheet" href="/css/utilities.css">
`;

const ORGANIZATION_JSON_LD = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Robayer WealthLab",
    "url": "${SITE_ORIGIN}",
    "logo": "${SITE_ORIGIN}/assets/branding/logo/logo.png",
    "description": "Financial education for ordinary Ghanaians — practical, honest guidance on saving, investing, and building wealth.",
    "telephone": "+233 53 780 6352",
    "address": { "@type": "PostalAddress", "addressLocality": "Accra", "addressCountry": "GH" },
    "founder": { "@type": "Person", "name": "Robert Loh Kobla" },
    "sameAs": [
      "https://facebook.com/RobayerWealthLab",
      "https://www.instagram.com/robayerwealthlab/",
      "https://linkedin.com/company/robayerwealthlab",
      "https://www.youtube.com/@RobayerWealthLab",
      "https://wa.me/233537806352",
      "https://www.tiktok.com/@robayerwealthlab"
    ]
  }
  </script>
`;

interface ShellOptions {
  title: string;
  description: string;
  // Twitter cards historically carried their own, shorter copy on the
  // original hand-authored pages (see git history of books/index.html
  // and books/starting-to-invest-with-gh100/index.html) — defaults to
  // `description` so callers that don't need the distinction can omit it.
  twitterDescription?: string;
  canonical: string;
  ogImage: string;
  extraHead?: string;
  breadcrumb?: string;
  bodyContent: string;
  scripts: string[];
}

function renderShell(opts: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}">
  <link rel="canonical" href="${escapeHtml(opts.canonical)}">

  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(opts.title)}">
  <meta property="og:description" content="${escapeHtml(opts.description)}">
  <meta property="og:url" content="${escapeHtml(opts.canonical)}">
  <meta property="og:image" content="${escapeHtml(opts.ogImage)}">
  <meta property="og:site_name" content="${SITE_NAME}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(opts.title)}">
  <meta name="twitter:description" content="${escapeHtml(opts.twitterDescription ?? opts.description)}">
${HEAD_ASSETS}${ORGANIZATION_JSON_LD}${opts.extraHead ?? ''}
</head>
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>

  <div data-include="/partials/header.html"></div>
${opts.breadcrumb ?? ''}
  <main id="main-content">
${opts.bodyContent}
  </main>

  <div data-include="/partials/footer.html"></div>

  <script src="/js/includes.js"></script>
  <script src="/js/components/nav.js"></script>
  <script src="/js/components/theme-toggle.js"></script>
  <script src="/js/content-inject.js"></script>
  <script src="/js/components/newsletter-form.js"></script>
${opts.scripts.map((s) => `  <script src="${s}"></script>`).join('\n')}
</body>
</html>`;
}

const NEWSLETTER_BAND = `
    <section class="section section--tight">
      <div class="container">
        <div class="newsletter-band">
          <div>
            <h2 class="mb-2">Get one better money tip</h2>
            <p>Weekly, free, no spam. Unsubscribe any time.</p>
          </div>
          <form class="cluster gap-2" data-newsletter-form novalidate aria-label="Newsletter signup">
            <label for="newsletter-email" class="sr-only">Email address</label>
            <input type="email" id="newsletter-email" class="field__input newsletter-band__input" placeholder="name@example.com" required>
            <button type="submit" class="btn btn--accent">Subscribe</button>
            <span class="field__error" hidden>Enter a valid email to subscribe.</span>
          </form>
        </div>
      </div>
    </section>`;

// ============================================================
// Product card — mirrors js/components/product-loader.js's
// renderCard() exactly (same CSS classes, same data attributes), so
// js/components/content-filters.js's pill/search filtering works
// unmodified against server-rendered cards.
// ============================================================
function renderProductCard(product: Omit<ProductRecord, 'files' | 'gallery' | 'relations'>): string {
  const isUpcoming = product.status === 'coming-soon';
  const priceLabel = isUpcoming ? null : product.pricePesewas === null ? null : product.pricePesewas === 0 ? 'Free' : formatGHS(product.pricePesewas / 100);
  const href = `/books/${product.slug}/`;

  const cardClasses = ['book-card'];
  if (product.featured) cardClasses.push('book-card--featured');
  if (isUpcoming) cardClasses.push('book-card--upcoming');

  const badges: string[] = [];
  if (isUpcoming) badges.push('<span class="badge badge--warning mb-2">Coming soon</span>');
  if (product.newRelease) badges.push('<span class="badge badge--info mb-2">New</span>');
  if (product.bestseller) badges.push('<span class="badge badge--success mb-2">Bestseller</span>');
  if (!isUpcoming && product.pricePesewas === 0) badges.push('<span class="badge badge--success mb-2">Free</span>');

  const coverStyle = product.coverPublicUrl
    ? ` style="background-image:url('${escapeHtml(product.coverPublicUrl)}');background-size:cover;background-position:center;"`
    : '';

  const cta = isUpcoming
    ? '<a href="/newsletter/" class="btn btn--secondary">Get notified</a>'
    : `<a href="${href}" class="btn btn--primary">Get the guide</a>`;

  return `<div class="${cardClasses.join(' ')}" data-topic="${escapeHtml(product.topic)}" data-product-type="${escapeHtml(product.productType)}" data-category="${escapeHtml(product.topic)}" data-title="${escapeHtml(product.title)}">
  <div class="book-card__cover"${coverStyle}></div>
  ${badges.join('\n  ')}
  <p class="book-card__title">${escapeHtml(product.title)}</p>
  ${priceLabel ? `<p class="book-card__price">${escapeHtml(priceLabel)}</p>` : ''}
  ${product.shortDescription ? `<p class="book-card__description">${escapeHtml(product.shortDescription)}</p>` : ''}
  ${cta}
</div>`;
}

// ============================================================
// GET /books/ — listing page
// ============================================================

async function renderBooksIndex(env: Env): Promise<Response> {
  const result = await productService.listProducts(env, {
    search: null,
    status: null,
    statuses: ['active', 'coming-soon'],
    topic: null,
    productType: null,
    featured: null,
    showDeleted: false,
    sort: 'newest',
    page: 1,
    pageSize: 100,
  });

  const cardsHtml = result.items.length > 0 ? result.items.map(renderProductCard).join('\n') : '';
  const featured = result.items.find((p) => p.featured && p.status === 'active');

  const featuredSection = featured
    ? `
    <section class="section bg-navy" aria-labelledby="featured-book-heading">
      <div class="container feature-banner">
        <div class="book-card__cover book-card__cover--compact" aria-hidden="true"${featured.coverPublicUrl ? ` style="background-image:url('${escapeHtml(featured.coverPublicUrl)}');background-size:cover;background-position:center;"` : ''}></div>
        <div>
          <span class="eyebrow feature-banner__eyebrow">Featured eBook</span>
          <h2 id="featured-book-heading" class="mt-2 mb-2 feature-banner__title">${escapeHtml(featured.title)}</h2>
          <p class="mb-4 feature-banner__copy">${escapeHtml(featured.shortDescription ?? featured.subtitle ?? '')}</p>
          <a href="/books/${escapeHtml(featured.slug)}/" class="btn btn--accent">Get the guide${featured.pricePesewas !== null ? ` — ${formatGHS(featured.pricePesewas / 100)}` : ''}</a>
        </div>
      </div>
    </section>`
    : '';

  const body = `
    <section class="hero bg-paper">
      <div class="container hero__content">
        <span class="eyebrow hero__eyebrow">Books</span>
        <h1 class="hero__title">Guides for wherever you're starting</h1>
        <p class="hero__subtitle">Practical, honest eBooks on saving, investing, and building wealth — start with the one that matches where you are.</p>
        <div class="hero__actions">
          <a href="#book-grid" class="btn btn--primary">Browse guides</a>
          <a href="/newsletter/" class="btn btn--secondary">Get notified about new guides</a>
        </div>
      </div>
    </section>
${featuredSection}
    <section class="section" id="book-grid" aria-labelledby="all-books-heading">
      <div class="container">
        <span class="eyebrow">The library</span>
        <h2 id="all-books-heading" class="mt-2 mb-4">All guides</h2>

        <div class="cluster gap-3 mb-5">
          <span id="filter-label" class="text-secondary text-small">Filter by topic:</span>
          <div class="filter-bar" role="group" aria-labelledby="filter-label" data-filter-controls>
            <button type="button" class="filter-pill" data-filter="all" aria-pressed="true">All</button>
            <button type="button" class="filter-pill" data-filter="investing" aria-pressed="false">Investing</button>
            <button type="button" class="filter-pill" data-filter="personal-finance" aria-pressed="false">Personal Finance</button>
            <button type="button" class="filter-pill" data-filter="budgeting" aria-pressed="false">Budgeting</button>
            <button type="button" class="filter-pill" data-filter="business" aria-pressed="false">Business</button>
            <button type="button" class="filter-pill" data-filter="mindset" aria-pressed="false">Mindset</button>
          </div>
        </div>

        <p class="alert alert--info hidden" data-filter-empty aria-live="polite">No guides in this category yet — <a href="/newsletter/">subscribe</a> to hear when one arrives.</p>

        <div class="grid grid--3" data-filter-grid>
          ${cardsHtml || '<p class="text-secondary col-span-full">No guides published yet — check back soon.</p>'}
        </div>
      </div>
    </section>

    <section class="section bg-paper" aria-labelledby="coming-soon-heading">
      <div class="container">
        <div class="content-column text-center">
          <span class="eyebrow text-center">More on the way</span>
          <h2 id="coming-soon-heading" class="mt-2 mb-3">New guides are in the works</h2>
          <p class="mb-4 text-secondary">We're building out the library one honest guide at a time.</p>
          <a href="/newsletter/" class="btn btn--secondary">Get notified about new guides</a>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="faq-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Questions</span>
        <h2 id="faq-heading" class="mt-2 mb-5 text-center">Frequently asked questions</h2>
        <div class="faq">
          <details class="faq__item"><summary class="faq__question">How do I get a guide?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Tap "Get the guide" on any book, complete the simple checkout, and you'll get digital access right away — no shipping, no waiting.</p></details>
          <details class="faq__item"><summary class="faq__question">How much do the guides cost?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Most guides are GH&#8373;39. A number of free templates, calculators, and articles are also available on the Resources page.</p></details>
          <details class="faq__item"><summary class="faq__question">Is this financial advice?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">No. Robayer WealthLab provides financial education, not licensed financial advice — always do your own research before making investment decisions.</p></details>
          <details class="faq__item"><summary class="faq__question">Can I read guides on my phone?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Yes. Every guide is designed to be read comfortably on mobile, since that's how most readers use the site.</p></details>
          <details class="faq__item"><summary class="faq__question">When will new guides be added?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Regularly. Subscribe to the newsletter below to be the first to know when a new one is ready.</p></details>
        </div>
      </div>
    </section>
${NEWSLETTER_BAND}`;

  // Matches the FAQ accordion actually rendered on this page above —
  // real structured data, not invented content (see the detail page's
  // own FAQPage block for the same discipline).
  const faqJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      { "@type": "Question", "name": "How do I get a guide?", "acceptedAnswer": { "@type": "Answer", "text": "Tap \\"Get the guide\\" on any book, complete the simple checkout, and you'll get digital access right away — no shipping, no waiting." } },
      { "@type": "Question", "name": "How much do the guides cost?", "acceptedAnswer": { "@type": "Answer", "text": "Most guides are GH\\u20b539. A number of free templates, calculators, and articles are also available on the Resources page." } },
      { "@type": "Question", "name": "Is this financial advice?", "acceptedAnswer": { "@type": "Answer", "text": "No. Robayer WealthLab provides financial education, not licensed financial advice — always do your own research before making investment decisions." } },
      { "@type": "Question", "name": "Can I read guides on my phone?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. Every guide is designed to be read comfortably on mobile, since that's how most readers use the site." } },
      { "@type": "Question", "name": "When will new guides be added?", "acceptedAnswer": { "@type": "Answer", "text": "Regularly. Subscribe to the newsletter below to be the first to know when a new one is ready." } }
    ]
  }
  </script>`;

  const html = renderShell({
    title: 'Financial eBooks for Ghana | Robayer WealthLab',
    description:
      'Practical eBooks on saving, investing, and building wealth in Ghana — starting with Starting to Invest with GH₵100. Honest guidance, no hype, from GH₵39.',
    twitterDescription: 'Practical eBooks on saving, investing, and building wealth in Ghana — honest guidance, no hype, from GH₵39.',
    canonical: `${SITE_ORIGIN}/books/`,
    ogImage: `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    extraHead: faqJsonLd,
    bodyContent: body,
    scripts: ['/js/components/content-filters.js', '/js/main.js'],
  });

  return htmlResponse(html, 200);
}

// ============================================================
// GET /books/{slug}/ — detail page
// ============================================================

const GENERIC_FAQ = `
    <section class="section" aria-labelledby="faq-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Questions</span>
        <h2 id="faq-heading" class="mt-2 mb-5 text-center">Frequently asked questions</h2>
        <div class="faq">
          <details class="faq__item"><summary class="faq__question">What exactly do I get when I buy this guide?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">A downloadable digital guide you can start reading right away, plus any updates we make to it later — at no extra cost.</p></details>
          <details class="faq__item"><summary class="faq__question">Can I read it on my phone?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Yes — it's designed to be comfortable to read on any device, phone included.</p></details>
          <details class="faq__item"><summary class="faq__question">Is this financial advice?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">No. Robayer WealthLab provides financial education, not licensed financial advice — always do your own research before making investment decisions.</p></details>
          <details class="faq__item"><summary class="faq__question">What if I have questions after reading?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Subscribe to the newsletter — we regularly answer reader questions there.</p></details>
        </div>
      </div>
    </section>`;

const ABOUT_AUTHOR = `
    <section class="section bg-paper" aria-labelledby="author-heading">
      <div class="container grid grid--2 gap-5">
        <div class="rounded-lg bg-sand aspect-4-5" aria-hidden="true"></div>
        <div>
          <span class="eyebrow">About the author</span>
          <h2 id="author-heading" class="mt-2 mb-3">Robert Loh Kobla</h2>
          <p class="mb-4">Robert founded Robayer WealthLab to simplify financial education for ordinary Ghanaians — practical knowledge, disciplined investing, and honest guidance, one step at a time.</p>
          <a href="/about/" class="btn btn--secondary">Read the full story</a>
        </div>
      </div>
    </section>`;

function render404(env: Env, slug: string): Response {
  const html = renderShell({
    title: 'Guide not found | Robayer WealthLab',
    description: 'This guide could not be found.',
    canonical: `${SITE_ORIGIN}/books/`,
    ogImage: `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    bodyContent: `
    <section class="section">
      <div class="container content-column text-center">
        <h1 class="mb-3">We couldn't find that guide</h1>
        <p class="mb-4 text-secondary">"${escapeHtml(slug)}" may have been moved, renamed, or is no longer available.</p>
        <a href="/books/" class="btn btn--primary">Browse all guides</a>
      </div>
    </section>`,
    scripts: ['/js/main.js'],
  });
  return htmlResponse(html, 404);
}

async function renderBookDetail(env: Env, slug: string): Promise<Response> {
  const product = await productService.getProductBySlug(env, slug);
  if (!product || !isPubliclyListedStatus(product.status)) {
    return render404(env, slug);
  }

  const isUpcoming = product.status === 'coming-soon';
  const priceLabel = product.pricePesewas === null ? null : product.pricePesewas === 0 ? 'Free' : formatGHS(product.pricePesewas / 100);
  const metaBits = [labelize(product.topic), labelize(product.productType)];
  if (product.estimatedReadingTime) metaBits.push(`~${product.estimatedReadingTime} min read`);
  if (product.version) metaBits.push(`Version ${escapeHtml(product.version)}`);
  metaBits.push(product.language === 'en' ? 'English' : escapeHtml(product.language));
  metaBits.push(product.publishedAt ? 'Available now' : isUpcoming ? 'Coming soon' : 'Available now');

  const buyAction = isUpcoming
    ? '<a href="/newsletter/" class="btn btn--accent">Get notified when this launches</a>'
    : priceLabel === null
      ? '<span class="badge badge--warning">Price coming soon</span>'
      : `<a href="#" class="btn btn--accent" data-buy-button data-product-slug="${escapeHtml(product.slug)}">Buy the guide — ${escapeHtml(priceLabel)}</a>`;

  const tagsLine = product.tags
    ? `<p class="text-secondary text-small mb-3">Tags: ${escapeHtml(
        product.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .join(', ')
      )}</p>`
    : '';

  const relatedItems = product.relations.filter((r) => r.relationType === 'related');
  const relatedSection =
    relatedItems.length > 0
      ? `
    <section class="section bg-sand" aria-labelledby="related-heading">
      <div class="container">
        <span class="eyebrow">Keep going</span>
        <h2 id="related-heading" class="mt-2 mb-4">You might also like</h2>
        <div class="grid grid--3">
          ${(
            await Promise.all(
              relatedItems.map(async (r) => {
                const relatedProduct = await productService.getProductBySlug(env, r.relatedProductSlug);
                return relatedProduct ? renderProductCard(relatedProduct) : '';
              })
            )
          )
            .filter(Boolean)
            .join('\n')}
        </div>
      </div>
    </section>`
      : '';

  const galleryHtml =
    product.gallery.length > 0
      ? `
    <section class="section" aria-labelledby="gallery-heading">
      <div class="container">
        <span class="eyebrow">Preview</span>
        <h2 id="gallery-heading" class="mt-2 mb-4">A closer look</h2>
        <div class="grid grid--3">
          ${product.gallery.map((g) => `<img src="${escapeHtml(g.publicUrl)}" alt="" loading="lazy" class="rounded-lg">`).join('\n')}
        </div>
      </div>
    </section>`
      : '';

  const coverStyle = product.coverPublicUrl
    ? ` style="background-image:url('${escapeHtml(product.coverPublicUrl)}');background-size:cover;background-position:center;"`
    : '';

  const body = `
    <section class="hero hero--split bg-paper">
      <div class="container">
        <div class="hero__content">
          <div>
            <span class="eyebrow hero__eyebrow">${isUpcoming ? 'Coming soon' : 'eBook'}</span>
            <h1 class="hero__title">${escapeHtml(product.title)}</h1>
            <p class="hero__subtitle">${escapeHtml(product.subtitle ?? product.shortDescription ?? '')}</p>
            <p class="text-secondary text-small mb-2">${metaBits.map(escapeHtml).join(' &bull; ')}</p>
            ${tagsLine}
            ${priceLabel !== null ? `<p class="book-card__price text-body-lg mb-3">${escapeHtml(priceLabel)}</p>` : ''}
            <div class="hero__actions">${buyAction}</div>
            <p class="text-secondary text-small mt-3">Instant digital access &bull; Read on any device &bull; Secure checkout via Paystack</p>
          </div>
          <div class="book-card__cover"${coverStyle} aria-hidden="true"></div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="about-heading">
      <div class="container content-column">
        <span class="eyebrow">About this guide</span>
        <h2 id="about-heading" class="mt-2 mb-4 sr-only">About this guide</h2>
        ${product.description ?? `<p>${escapeHtml(product.shortDescription ?? '')}</p>`}
      </div>
    </section>
${galleryHtml}${ABOUT_AUTHOR}${GENERIC_FAQ}${relatedSection}
    <section class="section--tight">
      <div class="container content-column">
        <p class="alert alert--warning">Robayer WealthLab provides financial education, not licensed financial advice. This guide is for informational purposes only — always do your own research and consider your personal circumstances before making investment decisions.</p>
      </div>
    </section>
${NEWSLETTER_BAND}`;

  const breadcrumb = `
  <nav class="breadcrumbs container" aria-label="Breadcrumb">
    <a href="/">Home</a><span class="breadcrumbs__separator" aria-hidden="true">/</span><a href="/books/">Books</a><span class="breadcrumbs__separator" aria-hidden="true">/</span><span aria-current="page">${escapeHtml(product.title)}</span>
  </nav>`;

  const bookJsonLd =
    priceLabel !== null && !isUpcoming
      ? `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Book",
    "name": ${JSON.stringify(product.title)},
    "description": ${JSON.stringify(product.subtitle ?? product.shortDescription ?? '')},
    "inLanguage": ${JSON.stringify(product.language)},
    "author": { "@type": "Person", "name": ${JSON.stringify(product.author ?? 'Robert Loh Kobla')} },
    "offers": {
      "@type": "Offer",
      "url": ${JSON.stringify(`${SITE_ORIGIN}/books/${product.slug}/`)},
      "priceCurrency": "GHS",
      "price": ${JSON.stringify(String((product.pricePesewas ?? 0) / 100))},
      "availability": "https://schema.org/InStock"
    }
  }
  </script>`
      : '';

  // BreadcrumbList + FAQPage — the two structured-data blocks every
  // hand-authored product page also carried (see this route's header
  // comment on preserving SEO surface, not just visible content).
  // FAQPage mirrors GENERIC_FAQ's own rendered questions exactly (real
  // structured data matching what's actually on the page), not a
  // per-product custom Q&A set the data model has no field for.
  const breadcrumbJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": ${JSON.stringify(SITE_ORIGIN + '/')} },
      { "@type": "ListItem", "position": 2, "name": "Books", "item": ${JSON.stringify(SITE_ORIGIN + '/books/')} },
      { "@type": "ListItem", "position": 3, "name": ${JSON.stringify(product.title)}, "item": ${JSON.stringify(`${SITE_ORIGIN}/books/${product.slug}/`)} }
    ]
  }
  </script>`;

  const faqJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      { "@type": "Question", "name": "What exactly do I get when I buy this guide?", "acceptedAnswer": { "@type": "Answer", "text": "A downloadable digital guide you can start reading right away, plus any updates we make to it later — at no extra cost." } },
      { "@type": "Question", "name": "Can I read it on my phone?", "acceptedAnswer": { "@type": "Answer", "text": "Yes — it's designed to be comfortable to read on any device, phone included." } },
      { "@type": "Question", "name": "Is this financial advice?", "acceptedAnswer": { "@type": "Answer", "text": "No. Robayer WealthLab provides financial education, not licensed financial advice — always do your own research before making investment decisions." } },
      { "@type": "Question", "name": "What if I have questions after reading?", "acceptedAnswer": { "@type": "Answer", "text": "Subscribe to the newsletter — we regularly answer reader questions there." } }
    ]
  }
  </script>`;

  const html = renderShell({
    title: product.seoTitle ?? `${product.title} | ${SITE_NAME}`,
    description: product.seoDescription ?? product.shortDescription ?? product.subtitle ?? '',
    canonical: product.seoCanonicalUrl ?? `${SITE_ORIGIN}/books/${product.slug}/`,
    ogImage: product.ogPublicUrl ?? product.coverPublicUrl ?? `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    extraHead: breadcrumbJsonLd + bookJsonLd + faqJsonLd,
    breadcrumb,
    bodyContent: body,
    scripts: ['/js/components/buy-button.js', '/js/main.js'],
  });

  return htmlResponse(html, 200);
}

function labelize(value: string): string {
  return value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================
// Dispatcher
// ============================================================

export async function handleBooksIndex(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  return renderBooksIndex(env);
}

export async function handleBookDetail(_request: Request, env: Env, _logger: Logger, params: RouteParams): Promise<Response> {
  const slug = params.slug ?? '';
  if (!slug) return render404(env, '');
  return renderBookDetail(env, slug);
}

/** `/books/{slug}` (no trailing slash) — 301s to the canonical `/books/{slug}/` form, matching every other URL on this site and avoiding a duplicate-content SEO issue now that this Worker (not GitHub Pages' own normalization) owns the whole `/books/*` path. */
export async function handleBookRedirect(request: Request, _env: Env, _logger: Logger, params: RouteParams): Promise<Response> {
  const slug = params.slug ?? '';
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/books/${slug}/`, 301);
}

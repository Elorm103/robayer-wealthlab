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
import { isPubliclyListedStatus, computeSaleState } from '../services/productService';
import type { ProductRecord } from '../services/productService';
import { listPublicReviews, getReviewSummary } from '../services/reviewService';

const SITE_NAME = 'Robayer WealthLab';
const SITE_ORIGIN = 'https://robayerwealthlab.com';

// media_assets.public_url is always site-relative (/api/media/file/...) —
// correct for CSS background-image (resolves against the current page),
// but og:image must be absolute for social crawlers to resolve it.
// Same fix already applied to blog.ts; see that file's comment for the
// original bug this mirrors (relative og:image on published content).
function absoluteMediaUrl(url: string): string {
  return url.startsWith('/') ? `${SITE_ORIGIN}${url}` : url;
}

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

// Version 3.2 Milestone M4 (Reviews & Coupons) — same server-side date
// formatting convention as routes/blog.ts's own formatDate().
function formatReviewDate(isoDate: string): string {
  const d = new Date(isoDate.includes('T') ? isoDate : isoDate.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function renderStars(rating: number): string {
  const full = Math.round(rating);
  return '&#9733;'.repeat(full) + '&#9734;'.repeat(5 - full);
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
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,600;1,500&family=Space+Grotesk:wght@500&family=Work+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">

  <link rel="stylesheet" href="/css/tokens.css?v=9c1fa2346d">
  <link rel="stylesheet" href="/css/base.css?v=57a963bc6f">
  <link rel="stylesheet" href="/css/layout.css?v=a6fb0c7359">
  <link rel="stylesheet" href="/css/components.css?v=abc0d769d5">
  <link rel="stylesheet" href="/css/utilities.css?v=406dfe7300">
`;

const ORGANIZATION_JSON_LD = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Robayer WealthLab",
    "url": "${SITE_ORIGIN}",
    "logo": "${SITE_ORIGIN}/assets/branding/logo/logo.png",
    "description": "Financial education for ordinary Ghanaians: practical, honest guidance on saving, investing, and building wealth.",
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

  <script src="/js/includes.js?v=cba95d9aa1"></script>
  <script src="/js/components/analytics.js?v=dd6f93b38e"></script>
  <script src="/js/components/nav.js?v=bf1e013818"></script>
  <script src="/js/components/theme-toggle.js?v=eebe98960c"></script>
  <script src="/js/components/branding.js?v=483b048741"></script>
  <script src="/js/content-inject.js?v=10a4d215c2"></script>
  <script src="/js/components/newsletter-form.js?v=f95c689ae8"></script>
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
            <p>Free, practical money tips. Unsubscribe any time.</p>
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
// renderCard() exactly (same CSS classes, same data attributes,
// same sale-pricing/star-rating markup as of Version 3.4.2
// Milestone M6.2), so js/components/content-filters.js's
// pill/search filtering works unmodified against server-rendered
// cards, and a customer sees an identical card whether it was
// rendered here or client-side by product-loader.js.
// ============================================================
async function renderProductCard(env: Env, product: Omit<ProductRecord, 'files' | 'gallery' | 'relations' | 'bundleItems'>): Promise<string> {
  const isUpcoming = product.status === 'coming-soon';
  const href = `/books/${product.slug}/`;

  const cardClasses = ['book-card'];
  if (product.featured) cardClasses.push('book-card--featured');
  if (isUpcoming) cardClasses.push('book-card--upcoming');

  const badges: string[] = [];
  if (isUpcoming) badges.push('<span class="badge badge--warning mb-2">Coming soon</span>');
  // Version 4.0 Milestone D — shown alongside, not instead of, the other
  // badges: a bundle can also be new/a bestseller in its own right.
  if (product.isBundle) badges.push('<span class="badge badge--info mb-2">Bundle</span>');
  if (product.newRelease) badges.push('<span class="badge badge--info mb-2">New</span>');
  if (product.bestseller) badges.push('<span class="badge badge--success mb-2">Bestseller</span>');
  if (!isUpcoming && product.pricePesewas === 0) badges.push('<span class="badge badge--success mb-2">Free</span>');

  const coverStyle = product.coverPublicUrl
    ? ` style="background-image:url('${escapeHtml(product.coverPublicUrl)}');background-size:cover;background-position:center;"`
    : '';

  const priceLabel = isUpcoming || product.pricePesewas === null ? null : product.pricePesewas === 0 ? 'Free' : formatGHS(product.pricePesewas / 100);
  const sale = computeSaleState(product);

  let priceBlockHtml = '';
  if (!isUpcoming && priceLabel !== null) {
    if (product.pricePesewas === 0) {
      priceBlockHtml = '<p class="book-card__price">Free</p>';
    } else if (!sale.isActive) {
      priceBlockHtml = `<div class="price-block" data-sale-scope><p class="book-card__price" data-regular-price-only>${escapeHtml(priceLabel)}</p></div>`;
    } else {
      const saleLabel = formatGHS((sale.effectivePricePesewas as number) / 100);
      const savedLabel = formatGHS((sale.amountSavedPesewas as number) / 100);
      priceBlockHtml = `
      <div class="price-block" data-sale-scope>
        <p class="book-card__price price-block__regular-strike" data-sale-only>${escapeHtml(priceLabel)}</p>
        <p class="book-card__price" data-regular-price-only hidden>${escapeHtml(priceLabel)}</p>
        <p class="price-block__now-label" data-sale-only>Now</p>
        <p class="price-block__sale-price" data-sale-only>${escapeHtml(saleLabel)}</p>
        <div class="price-block__meta" data-sale-only>
          <span class="price-block__saved">Save ${escapeHtml(savedLabel)}</span>
          ${sale.discountPercent ? `<span class="price-block__discount-badge">${sale.discountPercent}% OFF</span>` : ''}
        </div>
        ${
          sale.saleEndsAt
            ? `<div class="countdown" data-sale-only data-sale-ends-at="${escapeHtml(sale.saleEndsAt)}">
          <div class="countdown__unit"><span class="countdown__value" data-countdown-days>00</span><span class="countdown__label">Days</span></div>
          <div class="countdown__unit"><span class="countdown__value" data-countdown-hours>00</span><span class="countdown__label">Hrs</span></div>
          <div class="countdown__unit"><span class="countdown__value" data-countdown-minutes>00</span><span class="countdown__label">Min</span></div>
          <div class="countdown__unit"><span class="countdown__value" data-countdown-seconds>00</span><span class="countdown__label">Sec</span></div>
        </div>`
            : ''
        }
      </div>`;
    }
  }

  const reviewSummary = await getReviewSummary(env, product.id);
  const starRatingHtml =
    reviewSummary.count > 0 && reviewSummary.averageRating !== null
      ? `<p class="star-rating"><span class="star-rating__stars" aria-hidden="true">${renderStars(reviewSummary.averageRating)}</span><span class="sr-only">Rating: ${reviewSummary.averageRating} out of 5</span><span class="star-rating__count">${escapeHtml(reviewSummary.averageRating.toFixed(1))} (${reviewSummary.count} review${reviewSummary.count === 1 ? '' : 's'})</span></p>`
      : '';

  // Both buttons used to link to the exact same URL — no real
  // difference in behaviour despite the different labels. There is no
  // separate standalone checkout page in this architecture (buying
  // requires the product page's own buy-button.js widget: consent
  // checkboxes + email, then POST /api/checkout/sessions) — so "Buy
  // Now" now jumps straight to that widget via the #buy anchor added
  // to its container above, while "Learn More" still lands at the top
  // of the page to read first. Same destination page, genuinely
  // different arrival point — not two links to the same place.
  const actions = isUpcoming
    ? '<a href="/newsletter/" class="btn btn--secondary">Get notified</a>'
    : `<a href="${href}#buy" class="btn btn--primary">Buy Now</a><a href="${href}" class="btn btn--secondary">Learn More</a>`;

  return `<div class="${cardClasses.join(' ')}" data-topic="${escapeHtml(product.topic)}" data-product-type="${escapeHtml(product.productType)}" data-category="${escapeHtml(product.topic)}" data-title="${escapeHtml(product.title)}">
  <div class="book-card__cover"${coverStyle}></div>
  ${product.topic ? `<span class="book-card__category">${escapeHtml(product.topic.replace(/-/g, ' '))}</span>` : ''}
  ${badges.join('\n  ')}
  <p class="book-card__title">${escapeHtml(product.title)}</p>
  ${product.subtitle ? `<p class="book-card__description">${escapeHtml(product.subtitle)}</p>` : ''}
  ${product.author ? `<p class="book-card__author">${escapeHtml(product.author)}</p>` : ''}
  ${starRatingHtml}
  ${priceBlockHtml}
  <div class="book-card__actions">${actions}</div>
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

  const cardsHtml = result.items.length > 0 ? (await Promise.all(result.items.map((p) => renderProductCard(env, p)))).join('\n') : '';
  const featured = result.items.find((p) => p.featured && p.status === 'active');

  // Version 3.4.2 Milestone M6.2 - the featured banner's own CTA price
  // must reflect an active sale exactly like every book-card and the
  // book detail page's own Buy button, or a customer could see "on
  // sale" everywhere else but the regular price here.
  const featuredSale = featured ? computeSaleState(featured) : null;
  const featuredChargeablePesewas = featured
    ? featuredSale!.isActive
      ? featuredSale!.effectivePricePesewas
      : featured.pricePesewas
    : null;

  const featuredSection = featured
    ? `
    <section class="section bg-navy" aria-labelledby="featured-book-heading">
      <div class="container feature-banner">
        <div class="book-card__cover book-card__cover--compact" aria-hidden="true"${featured.coverPublicUrl ? ` style="background-image:url('${escapeHtml(featured.coverPublicUrl)}');background-size:cover;background-position:center;"` : ''}></div>
        <div>
          <span class="eyebrow feature-banner__eyebrow">Featured eBook</span>
          <h2 id="featured-book-heading" class="mt-2 mb-2 feature-banner__title">${escapeHtml(featured.title)}</h2>
          <p class="mb-4 feature-banner__copy">${escapeHtml(featured.shortDescription ?? featured.subtitle ?? '')}</p>
          <a href="/books/${escapeHtml(featured.slug)}/" class="btn btn--accent">Get the guide${featuredChargeablePesewas !== null ? ` (${formatGHS(featuredChargeablePesewas / 100)})` : ''}</a>
        </div>
      </div>
    </section>`
    : '';

  const body = `
    <section class="hero bg-paper">
      <div class="container hero__content">
        <span class="eyebrow hero__eyebrow">Books</span>
        <h1 class="hero__title">Guides for wherever you're starting</h1>
        <p class="hero__subtitle">Practical, honest eBooks on saving, investing, and building wealth. Start with the one that matches where you are.</p>
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

        <p class="alert alert--info hidden" data-filter-empty aria-live="polite">No guides in this category yet. <a href="/newsletter/">Subscribe</a> to hear when one arrives.</p>

        <div class="grid grid--3" data-filter-grid>
          ${cardsHtml || '<p class="text-secondary col-span-full">No guides published yet. Check back soon.</p>'}
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
          <details class="faq__item"><summary class="faq__question">How do I get a guide?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Tap "Get the guide" on any book, complete the simple checkout, and you'll get digital access right away, with no shipping and no waiting.</p></details>
          <details class="faq__item"><summary class="faq__question">How much do the guides cost?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Most guides are GH&#8373;39. A number of free templates, calculators, and articles are also available on the Resources page.</p></details>
          <details class="faq__item"><summary class="faq__question">Is this financial advice?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">No. Robayer WealthLab provides financial education, not licensed financial advice. Always do your own research before making investment decisions.</p></details>
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
      { "@type": "Question", "name": "How do I get a guide?", "acceptedAnswer": { "@type": "Answer", "text": "Tap \\"Get the guide\\" on any book, complete the simple checkout, and you'll get digital access right away, with no shipping and no waiting." } },
      { "@type": "Question", "name": "How much do the guides cost?", "acceptedAnswer": { "@type": "Answer", "text": "Most guides are GH\\u20b539. A number of free templates, calculators, and articles are also available on the Resources page." } },
      { "@type": "Question", "name": "Is this financial advice?", "acceptedAnswer": { "@type": "Answer", "text": "No. Robayer WealthLab provides financial education, not licensed financial advice. Always do your own research before making investment decisions." } },
      { "@type": "Question", "name": "Can I read guides on my phone?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. Every guide is designed to be read comfortably on mobile, since that's how most readers use the site." } },
      { "@type": "Question", "name": "When will new guides be added?", "acceptedAnswer": { "@type": "Answer", "text": "Regularly. Subscribe to the newsletter below to be the first to know when a new one is ready." } }
    ]
  }
  </script>`;

  const html = renderShell({
    title: 'Financial eBooks for Ghana | Robayer WealthLab',
    description:
      'Practical eBooks on saving, investing, and building wealth in Ghana, starting with Starting to Invest with GH₵100. Honest guidance, no hype, from GH₵39.',
    twitterDescription: 'Practical eBooks on saving, investing, and building wealth in Ghana: honest guidance, no hype, from GH₵39.',
    canonical: `${SITE_ORIGIN}/books/`,
    ogImage: `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    extraHead: faqJsonLd,
    bodyContent: body,
    // Version 3.4.2 Milestone M6.2's countdown.js was never added to this
    // page's own scripts list — renderProductCard() above already emits
    // the exact same [data-sale-ends-at]/countdown markup the book detail
    // page uses (same function, same data), so without this script every
    // card's countdown just sat frozen at its server-rendered "00:00:00:00"
    // starting value instead of ticking live, while the detail page (which
    // does load it) worked correctly. Same script, no new/duplicate
    // countdown logic — just wiring this page into the one that already
    // exists.
    scripts: ['/js/components/content-filters.js?v=bff036747e', '/js/components/countdown.js?v=b2f79caeca', '/js/main.js?v=a1b2c3d5e0'],
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
          <details class="faq__item"><summary class="faq__question">Can I read it on my phone?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Yes. It's designed to be comfortable to read on any device, phone included.</p></details>
          <details class="faq__item"><summary class="faq__question">Is this financial advice?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">No. Robayer WealthLab provides financial education, not licensed financial advice. Always do your own research before making investment decisions.</p></details>
          <details class="faq__item"><summary class="faq__question">What if I have questions after reading?<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">Subscribe to the newsletter. We regularly answer reader questions there.</p></details>
        </div>
      </div>
    </section>`;

// Reuses content/founder/bio.json — the exact same single-source-of-truth
// component already live on /about/ (js/components/founder-bio.js) —
// rather than a second, hardcoded bio duplicated here. The [data-founder-bio]
// attributes are hydrated client-side after partials load; the text
// below is the pre-hydration fallback (matches founder-bio.js's own
// "existing hand-written text is the fallback" contract), not a second
// source of truth.
const ABOUT_AUTHOR = `
    <section class="section bg-paper" aria-labelledby="author-heading">
      <div class="container grid grid--2 gap-5">
        <img src="/assets/branding/founder/founder-portrait.jpg" alt="Robert Loh Kobla, Founder of Robayer WealthLab" class="rounded-lg aspect-4-5" style="width:100%;object-fit:cover;">
        <div>
          <span class="eyebrow">About the author</span>
          <h2 id="author-heading" class="mt-2 mb-3">Robert Loh Kobla</h2>
          <p class="mb-4" data-founder-bio="short">Robert founded Robayer WealthLab to simplify financial education for ordinary Ghanaians: practical knowledge, disciplined investing, and honest guidance, one step at a time.</p>
          <a href="/about/" class="btn btn--secondary">Read the full story</a>
        </div>
      </div>
    </section>`;

// Concise, non-exaggerated trust indicators (Founder Edition launch-
// readiness refinement — "reinforce credibility without fabricating
// claims"). Every line here is checked directly against the real
// manuscript and this platform's own governance policy
// (docs/v3-marketplace-governance.md), not invented marketing copy.
// A generic, reusable component in the same style as GENERIC_FAQ —
// worth revisiting once a second product with different real
// properties exists, so this isn't silently applied to a future book
// these specific claims don't hold for.
const TRUST_SIGNALS = `
    <section class="section--tight bg-sand" aria-label="Why readers trust this guide">
      <div class="container">
        <div class="grid grid--3 gap-3 text-center">
          <div>&#127468;&#127469;&nbsp;&nbsp;Written specifically for Ghanaian readers</div>
          <div>&#9989;&nbsp;&nbsp;Covers only regulated, licensed institutions</div>
          <div>&#128683;&nbsp;&nbsp;No guaranteed-return promises</div>
          <div>&#128203;&nbsp;&nbsp;Includes real worksheets and checklists</div>
          <div>&#128218;&nbsp;&nbsp;Plain-language, practical guidance</div>
          <div>&#128274;&nbsp;&nbsp;Instant, secure digital delivery</div>
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
    scripts: ['/js/main.js?v=a1b2c3d5e0'],
  });
  return htmlResponse(html, 404);
}

// ============================================================
// Description section parsing — the premium product page (Version 3.0
// Founder Edition Phase 2) reads "What you'll learn" / "Inside the
// guide" / "Who this guide is for" / "Frequently asked questions" as
// distinct, purpose-styled sections rather than one undifferentiated
// blob. Deliberately parses the SAME `products.description` rich-text
// field already edited through the existing admin editor, rather than
// adding new schema columns for each section — the content model
// doesn't change, only how this route presents it (this project's
// standing "generalize what exists" discipline). A product whose
// description doesn't use these headings still renders correctly: the
// whole thing falls back to the original single "About this guide"
// block, and FAQ falls back to GENERIC_FAQ — nothing regresses for any
// other product in the catalog.
// ============================================================

interface DescriptionSection {
  heading: string;
  html: string;
}

function parseDescriptionSections(descriptionHtml: string | null): { intro: string; sections: DescriptionSection[] } {
  if (!descriptionHtml) return { intro: '', sections: [] };
  const parts = descriptionHtml.split(/<h2>([\s\S]*?)<\/h2>/);
  const intro = (parts[0] ?? '').trim();
  const sections: DescriptionSection[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({ heading: (parts[i] ?? '').trim(), html: (parts[i + 1] ?? '').trim() });
  }
  return { intro, sections };
}

function findSection(sections: DescriptionSection[], match: RegExp): DescriptionSection | undefined {
  return sections.find((s) => match.test(s.heading));
}

function extractListItems(html: string): string[] {
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].trim());
}

interface FaqPair {
  question: string;
  answer: string;
}

/** Strips the tags a rich-text answer might legitimately contain (bold, links) down to plain text for JSON-LD, where a raw `<strong>` tag would be invalid as displayed text in a Google rich-result preview. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

function parseFaqPairs(html: string): FaqPair[] {
  return [...html.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => ({
    question: stripTags(m[1]),
    answer: stripTags(m[2]),
  }));
}

export async function renderBookDetail(env: Env, slug: string): Promise<Response> {
  const product = await productService.getProductBySlug(env, slug);
  if (!product || !isPubliclyListedStatus(product.status)) {
    return render404(env, slug);
  }

  const isUpcoming = product.status === 'coming-soon';
  const priceLabel = product.pricePesewas === null ? null : product.pricePesewas === 0 ? 'Free' : formatGHS(product.pricePesewas / 100);

  // Version 3.4.2 Milestone M6.2 (Dynamic Pricing) - the one place this
  // page decides whether a sale is active, reusing the exact same
  // computeSaleState() checkout itself calls (via productCatalogService.ts),
  // so the price this page displays and the price a customer is actually
  // charged can never disagree.
  const sale = computeSaleState(product);
  // What the Buy button must actually charge - the sale price while
  // active, the regular price otherwise. Never priceLabel directly:
  // that stays the always-visible "regular price" display value.
  const chargeableAmountPesewas = sale.isActive ? sale.effectivePricePesewas : product.pricePesewas;
  const chargeableLabel = chargeableAmountPesewas === null ? null : chargeableAmountPesewas === 0 ? 'Free' : formatGHS(chargeableAmountPesewas / 100);

  const priceBlockHtml =
    priceLabel === null
      ? ''
      : !sale.isActive
        ? `<p class="book-card__price text-body-lg mb-3" data-regular-price-only>${escapeHtml(priceLabel)}</p>`
        : `
          <div class="price-block mb-3" data-sale-scope>
            <p class="book-card__price price-block__regular-strike" data-sale-only>${escapeHtml(priceLabel)}</p>
            <p class="book-card__price text-body-lg" data-regular-price-only hidden>${escapeHtml(priceLabel)}</p>
            <p class="price-block__now-label" data-sale-only>Now</p>
            <p class="price-block__sale-price" data-sale-only>${escapeHtml(formatGHS((sale.effectivePricePesewas as number) / 100))}</p>
            <div class="price-block__meta" data-sale-only>
              <span class="price-block__saved">Save ${escapeHtml(formatGHS((sale.amountSavedPesewas as number) / 100))}</span>
              ${sale.discountPercent ? `<span class="price-block__discount-badge">${sale.discountPercent}% OFF</span>` : ''}
            </div>
            ${
              sale.saleEndsAt
                ? `<div class="countdown" data-sale-only data-sale-ends-at="${escapeHtml(sale.saleEndsAt)}">
                     <p class="countdown__heading" style="width:100%;">Offer Ends In</p>
                     <div class="countdown__unit"><span class="countdown__value" data-countdown-days>00</span><span class="countdown__label">Days</span></div>
                     <div class="countdown__unit"><span class="countdown__value" data-countdown-hours>00</span><span class="countdown__label">Hrs</span></div>
                     <div class="countdown__unit"><span class="countdown__value" data-countdown-minutes>00</span><span class="countdown__label">Min</span></div>
                     <div class="countdown__unit"><span class="countdown__value" data-countdown-seconds>00</span><span class="countdown__label">Sec</span></div>
                   </div>`
                : ''
            }
          </div>`;
  // 'ebook' displays as "Digital Guide" here (and "Digital Wealth Guide"
  // in the hero eyebrow above) rather than the raw labelize() output
  // "Ebook" — a display-only mapping; product.productType itself, the
  // admin dropdown, and the database enum are all untouched.
  const productTypeLabel = product.productType === 'ebook' ? 'Digital Guide' : labelize(product.productType);
  const metaBits = [labelize(product.topic), productTypeLabel];
  if (product.estimatedReadingTime) metaBits.push(`~${product.estimatedReadingTime} min read`);
  if (product.version) metaBits.push(`Version ${escapeHtml(product.version)}`);
  metaBits.push(product.language === 'en' ? 'English' : escapeHtml(product.language));
  metaBits.push(product.publishedAt ? 'Available now' : isUpcoming ? 'Coming soon' : 'Available now');

  // Version 3.0.2 Milestone M1 (Customer Identity & Guest Checkout) —
  // see docs/v3.0.2-commerce-architecture-blueprint.md's ratified
  // Checkout Architecture. Deliberately NOT a required checkbox:
  // clicking Buy with this statement visibly attached IS the consent
  // action (js/components/buy-button.js sends termsAccepted/
  // licenseAccepted: true unconditionally) — ADR-002's zero-added-
  // friction checkout decision stays intact. The marketing checkbox is
  // the one genuinely optional, interactive, unchecked-by-default
  // element; it's page-singleton (id="purchase-marketing-optin",
  // read by buy-button.js regardless of which of this page's two Buy
  // buttons is actually clicked — see the closing CTA below, which
  // reuses the same statement without a second checkbox to avoid a
  // duplicate element id).
  //
  // Version 3.2 Milestone M4 (Reviews & Coupons) — the coupon code
  // input follows the exact same page-singleton pattern
  // (id="purchase-coupon-code"): one field, read by buy-button.js
  // regardless of which Buy button is clicked. "Apply" calls the
  // public, non-mutating /api/coupons/validate preview endpoint (see
  // routes/coupons.ts) purely to show the discount before checkout —
  // the actual discount is always re-validated and locked server-side
  // inside createCheckoutSession(), never trusted from this preview.
  //
  // Version 3.4.3 Milestone M6.3 (Production Authentication & Email
  // Recovery) — id="purchase-email", same page-singleton pattern as
  // the two fields below, but required (not optional/skippable): a
  // real, live production purchase proved that relying on the payment
  // provider's own hosted page to collect an email left every
  // mobile_money customer completely unreachable afterward - no
  // confirmation, no receipt, no ebook delivery email, no way to ever
  // set a password, sign in, or leave a review. See
  // js/components/buy-button.js's click handler and
  // backend/services/payments/paystackProvider.ts's header comment for
  // the full root-cause trace. This is the one field ADR-002's
  // "zero-form checkout" could not stay zero-form without leaving that
  // defect in place.
  const purchaseConsentBlock = `
    <div class="stack gap-2 mt-3" style="max-width:420px;">
      <div class="field mb-0" data-guest-email-field>
        <label class="field__label" for="purchase-email">Email address</label>
        <input type="email" id="purchase-email" class="field__input" placeholder="you@example.com" autocomplete="email" required>
        <p class="field__hint mt-1 mb-0">We'll send your receipt and ebook download link here.</p>
      </div>
      <p class="mb-0 purchase-logged-in-row" data-logged-in-email-display hidden>
        <svg class="icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--color-success);flex-shrink:0;"><path d="M20 6L9 17l-5-5"/></svg>
        <span>Purchasing as <strong data-logged-in-email></strong>. <a href="#" data-logged-in-not-you>Not you?</a></span>
      </p>
      <p class="text-secondary text-small mb-0">By purchasing, you agree to our <a href="/legal/terms-of-use/">Terms of Service</a> and <a href="/legal/license-agreement/">License Agreement</a>.</p>
      <div class="field field--checkbox mb-0">
        <input type="checkbox" id="purchase-marketing-optin" class="field__input">
        <label for="purchase-marketing-optin" class="field__label">Send me occasional emails about new guides and money tips (optional)</label>
      </div>
      <div class="field mb-0">
        <button type="button" class="text-small" style="background:none;border:none;padding:0;color:var(--color-accent);cursor:pointer;text-decoration:underline;" data-coupon-toggle aria-expanded="false" aria-controls="purchase-coupon-panel">Have a coupon?</button>
        <div id="purchase-coupon-panel" class="mt-2" data-coupon-panel hidden>
          <label for="purchase-coupon-code" class="field__label">Coupon code</label>
          <div style="display:flex;gap:var(--space-2);">
            <input type="text" id="purchase-coupon-code" class="field__input" placeholder="Enter code" autocomplete="off" style="flex:1;">
            <button type="button" class="btn btn--secondary" data-apply-coupon>Apply</button>
          </div>
          <p class="text-small mt-1 mb-0" data-coupon-feedback hidden></p>
        </div>
      </div>
    </div>`;
  const purchaseConsentNote = `<p class="text-secondary text-small mt-3" style="color:rgba(255,255,255,0.7);">By purchasing, you agree to our <a href="/legal/terms-of-use/" style="color:#fff;text-decoration:underline;">Terms of Service</a> and <a href="/legal/license-agreement/" style="color:#fff;text-decoration:underline;">License Agreement</a>.</p>`;

  // Version 3.5.3 (Customer Experience Separation) - the page has
  // exactly two mutually exclusive purchase states, never both at
  // once: [data-sales-mode] (the default, server-rendered state - a
  // guest, an authenticated non-owner, or an authenticated owner
  // before js/components/book-purchase-state.js has resolved) and
  // [data-owner-mode] (rendered hidden, revealed only after a real
  // 'ready' purchase is confirmed via GET /api/customer/purchases -
  // the same ownership signal this page has trusted since V3.5.1,
  // unchanged). See css/components.css's generalized
  // [data-sales-mode][hidden]/[data-owner-mode][hidden] rule, which
  // replaces the old one-off-per-element [hidden] overrides
  // (.purchase-logged-in-row[hidden], .book-card__actions[hidden])
  // V3.5.1/V3.5.2 each had to add by hand - every element carrying
  // either attribute is now covered by construction, not case by case.
  const ownerActionsBlock = `
    <div class="book-card__actions" data-owner-mode hidden>
      <a href="#" class="btn btn--accent" data-owned-read-action target="_blank" rel="noopener">Read eBook</a>
      <a href="#" class="btn btn--secondary" data-owned-download-action>Download PDF</a>
      <a href="#reviews" class="btn btn--secondary" data-owned-review-action>Leave a Review</a>
      <a href="/dashboard/" class="btn btn--secondary">View My Library</a>
    </div>
    <p class="text-small mt-2 mb-0" data-download-status role="status" aria-live="polite" hidden></p>`;

  // Version 3.5.3 - Sales Mode's own purchased-ownership badge/summary
  // sits directly above the price block it replaces, so the "you
  // already own this" fact is the very first thing an owner sees on
  // load, before Read/Download/Review even come into view - matching
  // Phase 7's requested hierarchy (Purchased badge -> Purchase details
  // -> Actions -> Product information).
  const ownerSummaryBlock = `
    <div class="mb-3" data-owner-mode hidden>
      <p class="badge badge--success mb-2" style="font-size:var(--text-body);padding:var(--space-2) var(--space-3);">&#10003;&nbsp; Purchased</p>
      <dl class="owner-purchase-summary">
        <div><dt>Purchased on</dt><dd data-owner-purchased-date>&mdash;</dd></div>
        <div><dt>Reference</dt><dd data-owner-reference>&mdash;</dd></div>
      </dl>
    </div>`;

  const buyAction = isUpcoming
    ? '<a href="/newsletter/" class="btn btn--accent">Get notified when this launches</a>'
    : priceLabel === null
      ? '<span class="badge badge--warning">Price coming soon</span>'
      : `<div id="buy" data-sales-mode><div class="book-card__actions"><a href="#" class="btn btn--accent" data-buy-button data-product-slug="${escapeHtml(product.slug)}">Buy Now (${escapeHtml(chargeableLabel ?? '')})</a></div>${purchaseConsentBlock}</div>${ownerActionsBlock}`;

  const tagsLine = product.tags
    ? `<p class="text-secondary text-small mb-3">Tags: ${escapeHtml(
        product.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .join(', ')
      )}</p>`
    : '';

  // Version 3.2 Milestone M4 (Reviews & Coupons) — approved reviews
  // only, no reviewer identity exposed (see reviewService.listPublicReviews()'s
  // own header comment). The "write a review" form itself is rendered
  // client-side (js/components/product-reviews.js) into the
  // [data-product-reviews-root] container below, since it needs to
  // check the visitor's own customer-session state — not something
  // this server-rendered page has at request time (no cookie forwarded
  // into this handler's own logic beyond routing).
  const reviewsResult = await listPublicReviews(env, slug);
  const reviewsHtml =
    !isUpcoming && priceLabel !== null
      ? `
    <section class="section bg-sand" aria-labelledby="reviews-heading" id="reviews">
      <div class="container content-column">
        <span class="eyebrow">Reader reviews</span>
        <h2 id="reviews-heading" class="mt-2 mb-4">${
          reviewsResult.count > 0
            ? `${renderStars(reviewsResult.averageRating ?? 0)} ${escapeHtml(String(reviewsResult.averageRating))} out of 5 (${reviewsResult.count} review${reviewsResult.count === 1 ? '' : 's'})`
            : 'Reader reviews'
        }</h2>
        ${
          reviewsResult.count === 0
            ? '<p class="text-secondary mb-4">No reviews yet — be the first to share what you thought.</p>'
            : `<div class="stack gap-3 mb-4">${reviewsResult.reviews
                .map(
                  (r) => `
          <div class="rounded-lg bg-paper" style="padding:var(--space-3);">
            <p class="mb-1"><span aria-hidden="true">${renderStars(r.rating)}</span><span class="sr-only">Rating: ${r.rating} out of 5</span></p>
            <p class="mb-1">${escapeHtml(r.body)}</p>
            <p class="text-secondary text-small mb-0">${formatReviewDate(r.createdAt)}</p>
          </div>`
                )
                .join('\n')}</div>`
        }
        <div data-product-reviews-root data-product-slug="${escapeHtml(product.slug)}"></div>
      </div>
    </section>`
      : '';

  // Version 4.0 Milestone D (Second Product Ecosystem & Bundles) —
  // shown for every bundle regardless of item count (even a
  // still-being-assembled draft bundle with 0-1 items, since this is a
  // detail page render, not a purchase gate — transitionProductStatus()
  // is what actually prevents an under-stocked bundle from ever
  // reaching 'active'/publicly-listed status in the first place).
  const bundleContentsSection =
    product.isBundle && product.bundleItems.length > 0
      ? `
    <section class="section" aria-labelledby="bundle-contents-heading">
      <div class="container">
        <span class="eyebrow">This bundle includes</span>
        <h2 id="bundle-contents-heading" class="mt-2 mb-4">What's inside</h2>
        <div class="grid grid--3">
          ${(
            await Promise.all(
              product.bundleItems.map(async (item) => {
                const itemProduct = await productService.getProductBySlug(env, item.itemProductSlug);
                return itemProduct ? renderProductCard(env, itemProduct) : '';
              })
            )
          )
            .filter(Boolean)
            .join('\n')}
        </div>
      </div>
    </section>`
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
                return relatedProduct ? renderProductCard(env, relatedProduct) : '';
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

  // No real cover image exists yet for any product (docs/flagship-cover-design-brief.md
  // covers the real artwork brief) — rather than an empty box, an honest typographic
  // placeholder built from the product's own real title/subtitle renders when no
  // cover has been uploaded, so the hero doesn't look broken or unfinished.
  const coverPlaceholder = product.coverPublicUrl
    ? ''
    : `<div class="book-card__cover-placeholder-text" aria-hidden="true">
         <span class="book-card__cover-placeholder-eyebrow">Robayer WealthLab</span>
         <span class="book-card__cover-placeholder-title">${escapeHtml(product.title)}</span>
         <span class="book-card__cover-placeholder-subtitle">${escapeHtml(product.subtitle ?? '')}</span>
       </div>`;

  const { intro, sections } = parseDescriptionSections(product.description);
  const learnSection = findSection(sections, /what you'?ll learn/i);
  const insideSection = findSection(sections, /inside the guide|what'?s inside/i);
  const audienceSection = findSection(sections, /who this (guide|book) is for/i);
  const faqSection = findSection(sections, /frequently asked questions/i);
  const whySection = findSection(sections, /why (this|the) guide was written/i);
  const recognizedHeadings = new Set(
    [learnSection, insideSection, audienceSection, faqSection, whySection]
      .filter((s): s is DescriptionSection => !!s)
      .map((s) => s.heading)
  );
  const otherSections = sections.filter((s) => !recognizedHeadings.has(s.heading));

  // "Why this guide was written" — a trust-building narrative section
  // (Version 3.0 Founder Edition, flagship launch-readiness refinement).
  // Deliberately built as a recognized description section rather than a
  // separate page, same pattern as every other section here — the
  // founder's real motivation (from the manuscript's own "Why I Wrote
  // This Book"), ending in a CTA that references Chapter 8 by name
  // without describing its actual content, so the page builds urgency
  // to buy rather than substituting for the chapter itself.
  const whyHtml = whySection
    ? `
    <section class="section bg-navy" aria-labelledby="why-heading">
      <div class="container content-column">
        <span class="eyebrow" style="color:rgba(255,255,255,0.7);">Why this guide exists</span>
        <h2 id="why-heading" class="mt-2 mb-4" style="color:#fff;">Why This Guide Was Written</h2>
        <div style="color:rgba(255,255,255,0.85);">${whySection.html}</div>
      </div>
    </section>`
    : '';

  const learnItems = learnSection ? extractListItems(learnSection.html) : [];
  const learnHtml =
    learnItems.length > 0
      ? `
    <section class="section bg-sand" aria-labelledby="learn-heading">
      <div class="container">
        <span class="eyebrow">Why this guide</span>
        <h2 id="learn-heading" class="mt-2 mb-4">What you'll learn</h2>
        <div class="grid grid--2 gap-3">
          ${learnItems.map((item) => `<div class="rounded-lg bg-paper" style="padding:var(--space-3);">&#10003;&nbsp;&nbsp;${item}</div>`).join('\n')}
        </div>
      </div>
    </section>`
      : '';

  // Scoped to just the <ol>...</ol> chapter list — extractListItems on the
  // whole section would also pick up the "Bonus resources included" <ul>
  // below it, double-counting those items as extra numbered "chapters".
  const chapterListMatch = insideSection ? insideSection.html.match(/<ol>[\s\S]*?<\/ol>/) : null;
  const chapterItems = chapterListMatch ? extractListItems(chapterListMatch[0]) : [];
  // A "Bonus resources included" <h3> + <ul> sub-block, if the description
  // has one, is parsed out and rendered as its own visual grid rather than
  // a plain list — this is the CMS-driven answer to "no testimonials exist,
  // so replace social proof with transparency" (Founder Edition launch-
  // readiness refinement): showing prospective buyers exactly what they
  // get, concretely, instead of leaving it as one line of prose.
  const bonusMatch = insideSection ? insideSection.html.match(/<h3>\s*Bonus resources[^<]*<\/h3>\s*<ul>([\s\S]*?)<\/ul>/i) : null;
  const bonusItems = bonusMatch ? extractListItems(`<ul>${bonusMatch[1]}</ul>`) : [];
  // Anything left in the "Inside the guide" section besides the <ol> and
  // the bonus-resources sub-block (a real fallback for future CMS content
  // this route doesn't have a bespoke layout for) is preserved as-is.
  const insideExtra = insideSection
    ? insideSection.html
        .replace(/<ol>[\s\S]*?<\/ol>/, '')
        .replace(/<h3>\s*Bonus resources[^<]*<\/h3>\s*<ul>[\s\S]*?<\/ul>/i, '')
        .trim()
    : '';
  const BONUS_ICONS = ['&#128203;', '&#128197;', '&#9989;', '&#127919;', '&#128279;', '&#128218;'];
  const insideHtml =
    chapterItems.length > 0
      ? `
    <section class="section" aria-labelledby="inside-heading">
      <div class="container content-column">
        <span class="eyebrow">What's inside</span>
        <h2 id="inside-heading" class="mt-2 mb-4">Inside the guide</h2>
        <ol style="list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2);">
          ${chapterItems
            .map(
              (item, i) =>
                `<li style="display:flex;gap:var(--space-3);align-items:flex-start;"><span class="badge" aria-hidden="true">${i + 1}</span><span>${item}</span></li>`
            )
            .join('\n')}
        </ol>
        ${
          bonusItems.length > 0
            ? `
        <h3 class="mt-5 mb-3">Bonus resources included</h3>
        <div class="grid grid--3 gap-3">
          ${bonusItems
            .map((item, i) => `<div class="rounded-lg bg-sand" style="padding:var(--space-3);">${BONUS_ICONS[i % BONUS_ICONS.length]}&nbsp;&nbsp;${item}</div>`)
            .join('\n')}
        </div>`
            : ''
        }
        ${insideExtra}
      </div>
    </section>`
      : '';

  const audienceHtml = audienceSection
    ? `
    <section class="section bg-paper" aria-labelledby="audience-heading">
      <div class="container content-column">
        <span class="eyebrow">Is this for you?</span>
        <h2 id="audience-heading" class="mt-2 mb-4">Who this guide is for</h2>
        ${audienceSection.html}
      </div>
    </section>`
    : '';

  const faqPairs = faqSection ? parseFaqPairs(faqSection.html) : [];
  const faqHtml =
    faqPairs.length > 0
      ? `
    <section class="section" aria-labelledby="faq-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Questions</span>
        <h2 id="faq-heading" class="mt-2 mb-5 text-center">Frequently asked questions</h2>
        <div class="faq">
          ${faqPairs
            .map(
              (f) =>
                `<details class="faq__item"><summary class="faq__question">${escapeHtml(f.question)}<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">${escapeHtml(f.answer)}</p></details>`
            )
            .join('\n')}
        </div>
      </div>
    </section>`
      : GENERIC_FAQ;

  // Any h2 section in the description this route doesn't specifically
  // recognize (a product with different structure than the four named
  // sections above) still renders — nothing authored in the CMS is
  // silently dropped just because this page doesn't have a bespoke
  // layout for it yet.
  const otherSectionsHtml = otherSections
    .map(
      (s) => `
    <section class="section" aria-labelledby="section-${escapeHtml(s.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">
      <div class="container content-column">
        <h2 id="section-${escapeHtml(s.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}" class="mt-2 mb-4">${escapeHtml(s.heading)}</h2>
        ${s.html}
      </div>
    </section>`
    )
    .join('\n');

  const closingCta =
    !isUpcoming && priceLabel !== null
      ? `
    <section class="section bg-navy" aria-labelledby="cta-heading">
      <div class="container content-column text-center">
        <div data-sales-mode>
          <h2 id="cta-heading" class="mt-2 mb-3" style="color:#fff;">Ready to start with GH&#8373;1?</h2>
          <p class="mb-4" style="color:rgba(255,255,255,0.8);">Instant digital access &bull; Read on any device &bull; Secure checkout via Paystack</p>
          <a href="#" class="btn btn--accent" data-buy-button data-product-slug="${escapeHtml(product.slug)}">Buy Now (${escapeHtml(chargeableLabel ?? '')})</a>
          ${purchaseConsentNote}
        </div>
        <div data-owner-mode hidden>
          <h2 class="mt-2 mb-3" style="color:#fff;">You already own this guide</h2>
          <p class="mb-4" style="color:rgba(255,255,255,0.8);">Head to your library any time to read, download, or manage this purchase.</p>
          <a href="/dashboard/" class="btn btn--accent">Go to My Library</a>
        </div>
      </div>
    </section>`
      : '';

  // "Digital Wealth Guide" — the customer-facing term, not "eBook" (see
  // docs/flagship-launch-checklist.md's terminology note for the full
  // reasoning). The underlying product_type taxonomy value ('ebook')
  // and the /books/ route are deliberately left unchanged — this is a
  // display-label change only, not an infrastructure rename, so no
  // existing URL, schema enum, or indexed link is affected.
  const productLabel = isUpcoming ? 'Coming soon' : 'Digital Wealth Guide';

  const body = `
    <section class="hero hero--split bg-paper">
      <div class="container">
        <div class="hero__content">
          <div>
            <span class="eyebrow hero__eyebrow">${productLabel}</span>
            ${
              !isUpcoming && reviewsResult.count > 0
                ? `<a class="star-rating mb-2" href="#reviews" style="text-decoration:none;color:inherit;cursor:pointer;"><span class="star-rating__stars" aria-hidden="true">${renderStars(reviewsResult.averageRating ?? 0)}</span><span class="sr-only">Rating: ${reviewsResult.averageRating} out of 5. Jump to reviews.</span><span class="star-rating__count" aria-hidden="true">${escapeHtml(String(reviewsResult.averageRating))} (${reviewsResult.count} review${reviewsResult.count === 1 ? '' : 's'})</span></a>`
                : ''
            }
            <h1 class="hero__title">${escapeHtml(product.title)}</h1>
            <p class="hero__subtitle">${escapeHtml(product.subtitle ?? product.shortDescription ?? '')}</p>
            <p class="text-secondary text-small mb-2">${metaBits.map(escapeHtml).join(' &bull; ')}</p>
            ${tagsLine}
            ${ownerSummaryBlock}
            <div data-sales-mode>${priceBlockHtml}</div>
            <div class="hero__actions">${buyAction}</div>
            <div data-sales-mode>
              <p class="text-secondary text-small mt-3">Written specifically for Ghana &bull; Instant digital access &bull; Secure checkout via Paystack</p>
              ${
                !isUpcoming && priceLabel !== null
                  ? `<p class="text-secondary text-small mt-1">Full refund within 7 days if you haven't downloaded more than once. See the <a href="/legal/terms-of-use/#refund-policy">refund policy</a>.</p>`
                  : ''
              }
            </div>
            ${
              !isUpcoming && priceLabel !== null
                ? `<p class="text-secondary text-small mt-3" data-owner-mode hidden>Version ${escapeHtml(product.version || '1.0')} &bull; Purchased licence</p>`
                : ''
            }
          </div>
          <div class="book-card__cover"${coverStyle} aria-hidden="true">${coverPlaceholder}</div>
        </div>
      </div>
    </section>

    <section class="section--tight" aria-labelledby="about-heading">
      <div class="container content-column">
        <span class="eyebrow">About this guide</span>
        <h2 id="about-heading" class="mt-2 mb-4 sr-only">About this guide</h2>
        ${intro || (product.description ?? `<p>${escapeHtml(product.shortDescription ?? '')}</p>`)}
      </div>
    </section>
${whyHtml}${learnHtml}${TRUST_SIGNALS}${audienceHtml}${insideHtml}${otherSectionsHtml}${bundleContentsSection}${galleryHtml}${ABOUT_AUTHOR}${faqHtml}${reviewsHtml}${relatedSection}
    <section class="section--tight">
      <div class="container content-column">
        <p class="alert alert--warning">Robayer WealthLab provides financial education, not licensed financial advice. This guide is for informational purposes only. Always do your own research and consider your personal circumstances before making investment decisions.</p>
      </div>
    </section>
${closingCta}
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
      "price": ${JSON.stringify(String((chargeableAmountPesewas ?? 0) / 100))},
      "availability": "https://schema.org/InStock"
    }${
      // Version 3.2 Milestone M4 — only emitted when real reviews exist;
      // schema.org disallows a fabricated/empty aggregateRating.
      reviewsResult.count > 0
        ? `,
    "aggregateRating": {
      "@type": "AggregateRating",
      "ratingValue": ${JSON.stringify(String(reviewsResult.averageRating))},
      "reviewCount": ${JSON.stringify(String(reviewsResult.count))}
    }`
        : ''
    }
  }
  </script>`
      : '';

  // BreadcrumbList + FAQPage — the two structured-data blocks every
  // hand-authored product page also carried (see this route's header
  // comment on preserving SEO surface, not just visible content).
  // FAQPage now mirrors whichever FAQ actually rendered above — the
  // product's own real, CMS-authored questions when present (faqPairs),
  // falling back to the same generic four questions GENERIC_FAQ renders
  // for a product with no FAQ section yet. Always real structured data
  // matching what's actually on the page, never invented independently.
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

  const faqEntities =
    faqPairs.length > 0
      ? faqPairs
      : [
          { question: 'What exactly do I get when I buy this guide?', answer: 'A downloadable digital guide you can start reading right away, plus any updates we make to it later — at no extra cost.' },
          { question: 'Can I read it on my phone?', answer: "Yes. It's designed to be comfortable to read on any device, phone included." },
          { question: 'Is this financial advice?', answer: 'No. Robayer WealthLab provides financial education, not licensed financial advice. Always do your own research before making investment decisions.' },
          { question: 'What if I have questions after reading?', answer: 'Subscribe to the newsletter. We regularly answer reader questions there.' },
        ];

  const faqJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      ${faqEntities
        .map(
          (f) =>
            `{ "@type": "Question", "name": ${JSON.stringify(f.question)}, "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(f.answer)} } }`
        )
        .join(',\n      ')}
    ]
  }
  </script>`;

  // Version 5.0 (Customer Acquisition Phase 2) — the ViewContent
  // signal js/components/meta-pixel.js reads. A <meta> tag, not an
  // inline <script>: this site's own Content-Security-Policy
  // (script-src 'self', no 'unsafe-inline' — see
  // backend/middleware/securityHeaders.ts) blocks inline scripts by
  // design, confirmed the hard way when an earlier inline-script
  // version of this signal was silently CSP-blocked in production. A
  // <meta> tag isn't subject to that directive at all.
  const pageContentScript = `
  <meta name="robayer-page-content" content="${escapeHtml(
    JSON.stringify({
      contentType: 'product',
      contentId: product.slug,
      contentName: product.title,
      value: product.pricePesewas !== null ? Number((product.pricePesewas / 100).toFixed(2)) : undefined,
    })
  )}">`;

  const html = renderShell({
    title: product.seoTitle ?? `${product.title} | ${SITE_NAME}`,
    description: product.seoDescription ?? product.shortDescription ?? product.subtitle ?? '',
    canonical: product.seoCanonicalUrl ?? `${SITE_ORIGIN}/books/${product.slug}/`,
    ogImage: (() => {
      const url = product.ogPublicUrl ?? product.coverPublicUrl;
      return url ? absoluteMediaUrl(url) : `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`;
    })(),
    extraHead: breadcrumbJsonLd + bookJsonLd + faqJsonLd + pageContentScript,
    breadcrumb,
    bodyContent: body,
    scripts: [
      '/js/components/buy-button.js?v=d791f2a3b4',
      '/js/components/founder-bio.js?v=4e2cad6615',
      '/js/components/product-reviews.js?v=52dfc03feb',
      '/js/components/countdown.js?v=b2f79caeca',
      '/js/components/ownership-helpers.js?v=9272ea5c97',
      '/js/components/book-purchase-state.js?v=25f3d3e770',
      '/js/main.js?v=a1b2c3d5e0',
    ],
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

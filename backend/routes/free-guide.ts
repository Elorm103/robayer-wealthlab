/**
 * GET /free-guide/ — public site integration, mirroring
 * `routes/resources.ts`'s exact pattern: full owner of `/free-guide/*`
 * via a new Cloudflare Workers Route (backend/wrangler.jsonc), every
 * request rendered entirely from D1, never proxied to the static
 * origin.
 *
 * The hand-authored static `free-guide/index.html` becomes unreachable
 * dead code once this Route is live (shadowed, not deleted — same
 * convention `routes/books.ts` established for `books/index.html`).
 *
 * The free guide is stored as a real `resources` row (slug
 * `free-guide-7-money-mistakes`, format `guide`) so it's editable
 * through the existing Media Library + Resources admin UI exactly like
 * every other resource — title, description, and the PDF file itself
 * can all be replaced in admin without touching code. Deliberately
 * does NOT use `routes/resources.ts`'s own public download route: the
 * free guide keeps its own email-gated delivery model (see
 * `services/newsletterService.ts`'s `isFreeGuideSource` branch), a
 * real, deliberate product decision (docs/lead-magnet-architecture.md,
 * "Why the PDF isn't linked from the page yet"), not something this
 * phase should silently override just because the generic resource
 * infrastructure happens to support open downloads.
 *
 * Everything below the title/description/CTA-to-book is intentionally
 * kept as fixed, developer-authored markup (trust section, TOC,
 * FAQ) — content that hasn't ever needed to change independent of a
 * code deploy, matching the same judgment call `routes/resources.ts`
 * made for its Financial Calculators section.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as resourceService from '../services/resourceService';
import * as productService from '../services/productService';

const SITE_NAME = 'Robayer WealthLab';
const SITE_ORIGIN = 'https://robayerwealthlab.com';
const RESOURCE_SLUG = 'free-guide-7-money-mistakes';
const FALLBACK_BOOK_TITLE = 'Small Cedis, Big Wealth';
const FALLBACK_BOOK_SLUG = 'starting-to-invest-with-gh100';

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  <meta name="twitter:description" content="${escapeHtml(opts.description)}">
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
  <script src="/js/components/branding.js"></script>
  <script src="/js/content-inject.js"></script>
  <script src="/js/components/newsletter-form.js"></script>
${opts.scripts.map((s) => `  <script src="${s}"></script>`).join('\n')}
</body>
</html>`;
}

const FAQ_QA: Array<{ q: string; a: string }> = [
  { q: 'Is this guide really free?', a: 'Yes: no payment, no card details, no catch. Just your email address.' },
  { q: 'How do I get the guide after signing up?', a: 'The guide arrives by email within a few minutes of signing up, with a direct download link. Check your inbox (and spam folder, just in case).' },
  {
    q: 'Who is this guide for?',
    a: 'Young professionals, National Service personnel, university graduates, first-time investors, small business owners, and salaried workers in Ghana: anyone who wants practical financial guidance without jargon or hype.',
  },
  { q: 'Is this financial advice?', a: 'No. This guide provides financial education, not licensed financial advice. It teaches principles and decision-making, not personalised recommendations.' },
  { q: 'Will I be spammed after signing up?', a: "No. You'll join the same weekly, free, no-spam newsletter used across the site, and you can unsubscribe at any time." },
];

function faqJsonLd(): string {
  return `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      ${FAQ_QA.map((qa) => `{ "@type": "Question", "name": ${JSON.stringify(qa.q)}, "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(qa.a)} } }`).join(',\n      ')}
    ]
  }
  </script>`;
}

async function renderFreeGuideIndex(env: Env): Promise<Response> {
  const resource = await resourceService.getResourceBySlug(env, RESOURCE_SLUG);

  const title = resource?.title ?? 'The 7 Money Mistakes That Keep Many Ghanaians Broke';
  const shortDescription =
    resource?.shortDescription ??
    'A free, practical guide to the seven money mistakes keeping many Ghanaians stuck, with one honest fix and one immediate action for each. No jargon, no hype, no get-rich-quick promises.';
  const seoTitle = resource?.seoTitle ?? `${title} | ${SITE_NAME}`;
  const seoDescription = resource?.seoDescription ?? shortDescription;

  // The "Ready to go further?" invitation reads the flagship book's
  // real, current title live from the products table (not hardcoded),
  // so a future rename can never leave this page stale again the way
  // "Starting to Invest with GH₵100" did after the book was renamed to
  // Small Cedis, Big Wealth.
  const book = await productService.getProductBySlug(env, FALLBACK_BOOK_SLUG);
  const bookTitle = book?.title ?? FALLBACK_BOOK_TITLE;

  const body = `
    <section class="hero hero--split bg-paper">
      <div class="container">
        <div class="hero__content">
          <div>
            <span class="eyebrow hero__eyebrow">Free Guide</span>
            <h1 class="hero__title">${escapeHtml(title)}</h1>
            <p class="hero__subtitle">(And How to Avoid Them.) ${escapeHtml(shortDescription.replace(/^A free,? ?/i, ''))}</p>

            <ul class="grid grid--2 gap-3 mb-4" aria-label="What's inside the guide">
              <li class="check-item"><svg class="icon check-item__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg><span class="check-item__text">The 7 mistakes, explained without judgment</span></li>
              <li class="check-item"><svg class="icon check-item__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg><span class="check-item__text">Real Ghana context for each one</span></li>
              <li class="check-item"><svg class="icon check-item__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg><span class="check-item__text">A practical fix, not just theory</span></li>
              <li class="check-item"><svg class="icon check-item__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg><span class="check-item__text">A one-page Quick Wealth Checklist</span></li>
            </ul>

            <form class="stack gap-3" data-newsletter-form data-confirmation-message="Check your email to receive your free guide." novalidate aria-label="Free guide signup">
              <div class="cluster gap-2">
                <label for="free-guide-email" class="sr-only">Email address</label>
                <input type="email" id="free-guide-email" class="field__input newsletter-band__input" placeholder="name@example.com" required>
                <button type="submit" class="btn btn--accent">Send Me the Guide</button>
              </div>
              <span class="field__error" hidden>Enter a valid email to get the guide.</span>
              <p class="text-secondary text-small">Free, no spam, unsubscribe any time.</p>
            </form>
          </div>

          <div>
            <div class="book-card__cover" aria-hidden="true"></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section bg-sand" aria-labelledby="preview-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Inside the guide</span>
        <h2 id="preview-heading" class="mt-2 mb-4 text-center">What you'll find inside</h2>
        <ol class="toc">
          <li class="toc__item"><span class="toc__number numeric">01</span><span class="toc__title">Why most people never build wealth</span></li>
          <li class="toc__item"><span class="toc__number numeric">02</span><span class="toc__title">Spending without a plan</span></li>
          <li class="toc__item"><span class="toc__number numeric">03</span><span class="toc__title">Treating saving as whatever is left over</span></li>
          <li class="toc__item"><span class="toc__number numeric">04</span><span class="toc__title">Having no emergency fund</span></li>
          <li class="toc__item"><span class="toc__number numeric">05</span><span class="toc__title">Avoiding investing because it feels complicated</span></li>
          <li class="toc__item"><span class="toc__number numeric">06</span><span class="toc__title">Letting lifestyle grow as fast as income</span></li>
          <li class="toc__item"><span class="toc__number numeric">07</span><span class="toc__title">Depending on a single source of income</span></li>
          <li class="toc__item"><span class="toc__number numeric">08</span><span class="toc__title">Good debt vs. bad debt</span></li>
          <li class="toc__item"><span class="toc__number numeric">09</span><span class="toc__title">Your Quick Wealth Checklist</span></li>
        </ol>
      </div>
    </section>

    <section class="section" aria-labelledby="trust-heading">
      <div class="container text-center">
        <span class="eyebrow">Why trust this guide</span>
        <h2 id="trust-heading" class="mt-2 mb-5">Built to be useful, not just downloaded</h2>
        <ul class="grid grid--4 text-left">
          <li><svg class="icon icon--lg mb-2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/></svg><h3 class="mb-2 font-body font-medium text-body-lg">Founder-written</h3><p class="text-secondary text-small">Written by Robert Loh Kobla, not assembled from generic templates.</p></li>
          <li><svg class="icon icon--lg mb-2" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><h3 class="mb-2 font-body font-medium text-body-lg">No fear tactics</h3><p class="text-secondary text-small">No exaggerated returns, no scare stories, just practical education.</p></li>
          <li><svg class="icon icon--lg mb-2" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-9.5-8.5C.8 8 2.5 4.5 6 4.5c2 0 3.3 1.1 4 2.2.7-1.1 2-2.2 4-2.2 3.5 0 5.2 3.5 3.5 7C19 15.6 12 20 12 20z"/></svg><h3 class="mb-2 font-body font-medium text-body-lg">Ghana-first</h3><p class="text-secondary text-small">Written around MoMo, susu, treasury bills, and real Ghanaian income patterns.</p></li>
          <li><svg class="icon icon--lg mb-2" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.2-5.4 3.2 1.3-6-4.6-4.1 6.1-.6z"/></svg><h3 class="mb-2 font-body font-medium text-body-lg">Genuinely free</h3><p class="text-secondary text-small">No card details, no trial, no catch, just your email address.</p></li>
        </ul>
      </div>
    </section>

    <section class="section bg-sand" aria-labelledby="testimonials-heading">
      <div class="container text-center content-column">
        <span class="eyebrow">What readers say</span>
        <h2 id="testimonials-heading" class="mt-2 mb-4">Reader stories, coming soon</h2>
        <p class="text-secondary">This guide just launched, so we don't have reader stories to share yet. We'd rather leave this section honestly empty than invent ones. Once real readers share their experience, we'll feature them here.</p>
      </div>
    </section>

    <section class="section" aria-labelledby="faq-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Questions</span>
        <h2 id="faq-heading" class="mt-2 mb-5 text-center">Frequently asked questions</h2>
        <div class="faq">
          ${FAQ_QA.map((qa) => `<details class="faq__item"><summary class="faq__question">${escapeHtml(qa.q)}<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">${escapeHtml(qa.a)}</p></details>`).join('\n          ')}
        </div>
      </div>
    </section>

    <section class="section bg-navy" aria-labelledby="next-step-heading">
      <div class="container feature-banner">
        <div class="book-card__cover book-card__cover--compact" aria-hidden="true"></div>
        <div>
          <span class="eyebrow feature-banner__eyebrow">Ready to go further?</span>
          <h2 id="next-step-heading" class="mt-2 mb-2 feature-banner__title">${escapeHtml(bookTitle)}</h2>
          <p class="mb-4 feature-banner__copy">This guide covers the mistakes to avoid. Our eBook is the structured next step: growing whatever you have today, even GH₵1, through treasury bills, mobile money savings, and the Ghana Stock Exchange, explained the same plain way.</p>
          <a href="/books/${escapeHtml(FALLBACK_BOOK_SLUG)}/" class="btn btn--primary">See the guide</a>
        </div>
      </div>
    </section>

    <section class="section--tight">
      <div class="container content-column">
        <p class="alert alert--warning">Robayer WealthLab provides financial education, not licensed financial advice. This guide is for informational purposes only. Always do your own research and consider your personal circumstances before making financial decisions.</p>
      </div>
    </section>

    <section class="section section--tight">
      <div class="container">
        <div class="newsletter-band">
          <div>
            <h2 class="mb-2">Get your free guide</h2>
            <p>Seven mistakes, one guide, zero cost. Unsubscribe any time.</p>
          </div>
          <form class="cluster gap-2" data-newsletter-form data-confirmation-message="Check your email to receive your free guide." novalidate aria-label="Free guide signup">
            <label for="newsletter-email" class="sr-only">Email address</label>
            <input type="email" id="newsletter-email" class="field__input newsletter-band__input" placeholder="name@example.com" required>
            <button type="submit" class="btn btn--accent">Send Me the Guide</button>
            <span class="field__error" hidden>Enter a valid email to get the guide.</span>
          </form>
        </div>
      </div>
    </section>`;

  const breadcrumb = `
  <nav class="breadcrumbs container" aria-label="Breadcrumb">
    <a href="/">Home</a><span class="breadcrumbs__separator" aria-hidden="true">/</span><span aria-current="page">Free Guide</span>
  </nav>`;

  const breadcrumbJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": ${JSON.stringify(SITE_ORIGIN + '/')} },
      { "@type": "ListItem", "position": 2, "name": "Free Guide", "item": ${JSON.stringify(SITE_ORIGIN + '/free-guide/')} }
    ]
  }
  </script>`;

  const html = renderShell({
    title: seoTitle,
    description: seoDescription,
    canonical: `${SITE_ORIGIN}/free-guide/`,
    ogImage: `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    extraHead: breadcrumbJsonLd + faqJsonLd(),
    breadcrumb,
    bodyContent: body,
    scripts: ['/js/main.js'],
  });

  return htmlResponse(html, 200);
}

export async function handleFreeGuideIndex(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  return renderFreeGuideIndex(env);
}

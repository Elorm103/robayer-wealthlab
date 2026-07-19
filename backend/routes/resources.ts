/**
 * GET /resources/*, Version 2.1 Phase 1 (Resources CMS) — public site
 * integration. See docs/v2.1-architecture-plan.md Section 3.
 *
 * Full owner of the `/resources/*` path via a new Cloudflare Workers
 * Route (backend/wrangler.jsonc), mirroring `routes/books.ts`'s exact
 * pattern and its own reasoning for never proxying/fetching back to
 * the static origin — every request under `/resources/*` is rendered
 * or 404'd entirely from D1, in this file.
 *
 * The hand-authored static `resources/index.html` becomes unreachable
 * dead code once this Route is live (shadowed, not deleted — same
 * convention `routes/books.ts` established for `books/index.html`).
 * That static page's "Download" buttons were `data-placeholder-action`
 * stubs (no real resource has ever been downloadable there); this
 * route makes downloads real for the first time.
 *
 * Hero copy, the Financial Calculators section, and the FAQ are
 * carried over verbatim from the real, hand-authored static page —
 * this phase's job is making the resource grid data-driven, not
 * rewriting content that already exists and is correct.
 *
 * Every dynamic value is either a fixed, developer-authored template
 * (safe by construction) or a database column — `description` is
 * sanitized server-side at write time (services/resourceService.ts,
 * utils/richTextSanitizer.ts) so it's safe to emit here unescaped;
 * every other resource field is plain text, HTML-escaped via
 * escapeHtml() before interpolation.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { RouteParams } from '../worker/index';
import * as resourceService from '../services/resourceService';
import { isPubliclyVisibleStatus } from '../services/resourceService';
import type { ResourceRecord } from '../services/resourceService';

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

/** Explicit no-store — see routes/books.ts's identical header comment on why this Worker never risks a stale price/status the way GitHub Pages' own static caching could. */
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

const CALCULATORS_SECTION = `
    <section class="section bg-sand" aria-labelledby="calculators-heading">
      <div class="container">
        <span class="eyebrow">Free tools</span>
        <h2 id="calculators-heading" class="mt-2 mb-3">Financial calculators</h2>
        <p class="mb-5 text-secondary">Our first calculators are live. Try <a href="/calculators/">Compound Interest, Savings Goal, and Investment Growth</a> now, no login required. Not sure which one fits your situation? Try the <a href="/goal-planner/">Goal Planner</a>: pick a goal and get pointed to the right tool. More calculators are on the way, including these:</p>

        <div class="grid grid--3">
          <div class="resource-card resource-card--upcoming" data-category="investing" data-title="Treasury Bills Calculator">
            <svg class="resource-card__icon icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>
            <span class="badge badge--warning resource-card__format">Coming soon</span>
            <p class="resource-card__title">Treasury Bills Calculator</p>
            <p class="text-secondary text-small mt-2 mb-3">See what a T-bill actually pays before you buy one.</p>
            <a href="/newsletter/" class="btn btn--secondary">Get notified</a>
          </div>
          <div class="resource-card resource-card--upcoming" data-category="investing" data-title="Personal Net Worth Calculator">
            <svg class="resource-card__icon icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>
            <span class="badge badge--warning resource-card__format">Coming soon</span>
            <p class="resource-card__title">Personal Net Worth Calculator</p>
            <p class="text-secondary text-small mt-2 mb-3">Add up what you own and owe to see where you really stand.</p>
            <a href="/newsletter/" class="btn btn--secondary">Get notified</a>
          </div>
          <div class="resource-card resource-card--upcoming" data-category="investing" data-title="Retirement Planning Guide">
            <svg class="resource-card__icon icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/></svg>
            <span class="badge badge--warning resource-card__format">Coming soon</span>
            <p class="resource-card__title">Retirement Planning Guide</p>
            <p class="text-secondary text-small mt-2 mb-3">A plain-language walkthrough of planning for retirement in Ghana.</p>
            <a href="/newsletter/" class="btn btn--secondary">Get notified</a>
          </div>
        </div>
      </div>
    </section>`;

const FAQ_QA: Array<{ q: string; a: string }> = [
  { q: 'Are these resources really free?', a: 'Yes, every checklist, worksheet, and tracker on this page is free. Only the eBooks in the Books section are paid.' },
  {
    q: 'Do I need to make an account to download something?',
    a: "No. Just tap download, no sign-up required, though subscribing to the newsletter means you'll hear about new resources first.",
  },
  { q: 'What format are the downloads?', a: 'Most are simple, printable documents designed to work whether you prefer pen and paper or typing on your phone.' },
  { q: 'When will the calculators be ready?', a: "We're building them now. Subscribe to the newsletter to be the first to try them when they launch." },
  { q: 'Can I suggest a resource?', a: 'Yes, reach out through the Contact page. Reader requests are exactly how new resources get made.' },
];

const FAQ_SECTION = `
    <section class="section" aria-labelledby="faq-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Questions</span>
        <h2 id="faq-heading" class="mt-2 mb-5 text-center">Frequently asked questions</h2>
        <div class="faq">
          ${FAQ_QA.map((qa) => `<details class="faq__item"><summary class="faq__question">${escapeHtml(qa.q)}<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">${escapeHtml(qa.a)}</p></details>`).join('\n          ')}
        </div>
      </div>
    </section>`;

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

const FORMAT_BADGE_VARIANT: Record<string, string> = {
  template: 'badge--info',
  checklist: 'badge--success',
  tracker: 'badge--info',
  worksheet: 'badge--success',
  guide: 'badge--info',
};

function labelize(value: string): string {
  return value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================
// Resource card — mirrors js/components/content-filters.js's expected
// data-category/data-title attributes exactly (same shape the static
// page already used), so the existing filter/search script works
// unmodified against these server-rendered cards.
// ============================================================
function renderResourceCard(resource: ResourceRecord): string {
  const iconSvg =
    resource.format === 'checklist' || resource.format === 'worksheet'
      ? '<path d="M5 12l4 4 10-10"/>'
      : resource.format === 'tracker'
        ? '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>'
        : '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>';

  const downloadHref = resource.fileMediaId ? `/resources/${resource.slug}/download` : '#';
  const downloadAttrs = resource.fileMediaId ? 'download' : 'aria-disabled="true"';

  return `<div class="resource-card" id="${escapeHtml(resource.slug)}" data-category="${escapeHtml(resource.category)}" data-title="${escapeHtml(resource.title)}">
  <svg class="resource-card__icon icon" viewBox="0 0 24 24" aria-hidden="true">${iconSvg}</svg>
  <span class="badge ${FORMAT_BADGE_VARIANT[resource.format] ?? 'badge--info'} resource-card__format">${escapeHtml(labelize(resource.format))}</span>
  <p class="resource-card__title">${escapeHtml(resource.title)}</p>
  ${resource.shortDescription ? `<p class="text-secondary text-small mt-2 mb-3">${escapeHtml(resource.shortDescription)}</p>` : ''}
  <a href="${downloadHref}" class="btn btn--secondary" ${downloadAttrs}>Download: Free</a>
</div>`;
}

// ============================================================
// GET /resources/ — listing page
// ============================================================

async function renderResourcesIndex(env: Env): Promise<Response> {
  const result = await resourceService.listResources(env, {
    search: null,
    status: 'published',
    category: null,
    format: null,
    featured: null,
    showDeleted: false,
    sort: 'newest',
    page: 1,
    pageSize: 100,
  });

  const cardsHtml = result.items.length > 0 ? result.items.map(renderResourceCard).join('\n') : '';
  const featured = result.items.find((r) => r.featured) ?? null;

  const featuredSection = featured
    ? `
    <section class="section bg-navy" aria-labelledby="featured-resource-heading">
      <div class="container content-column text-center">
        <span class="eyebrow feature-banner__eyebrow">Free resource</span>
        <h2 id="featured-resource-heading" class="mt-2 mb-2 feature-banner__title">${escapeHtml(featured.title)}</h2>
        <p class="mb-4 feature-banner__copy mx-auto">${escapeHtml(featured.shortDescription ?? '')}</p>
        <a href="${featured.fileMediaId ? `/resources/${escapeHtml(featured.slug)}/download` : '#'}" class="btn btn--accent"${featured.fileMediaId ? ' download' : ' aria-disabled="true"'}>Download: Free</a>
      </div>
    </section>`
    : '';

  const popular = [...result.items].sort((a, b) => b.downloadCount - a.downloadCount).slice(0, 3);
  const popularSection =
    popular.length > 0
      ? `
    <section class="section" aria-labelledby="popular-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Reader favorites</span>
        <h2 id="popular-heading" class="mt-2 mb-4 text-center">Popular resources</h2>
        <ol class="toc">
          ${popular.map((r, i) => `<li class="toc__item"><span class="toc__number numeric">0${i + 1}</span><span class="toc__title"><a href="#${escapeHtml(r.slug)}">${escapeHtml(r.title)}</a></span></li>`).join('\n          ')}
        </ol>
      </div>
    </section>`
      : '';

  const body = `
    <section class="hero bg-paper">
      <div class="container hero__content">
        <span class="eyebrow hero__eyebrow">Resources</span>
        <h1 class="hero__title">Free tools for wherever you're starting</h1>
        <p class="hero__subtitle">Checklists, worksheets, and calculators to help you save, budget, and invest, no sign-up required.</p>
        <div class="hero__actions">
          <a href="#resources-grid" class="btn btn--primary">Browse resources</a>
        </div>
      </div>
    </section>
${featuredSection}
    <section class="section" id="resources-grid" aria-labelledby="resources-grid-heading">
      <div class="container">
        <span class="eyebrow">Downloadable resources</span>
        <h2 id="resources-grid-heading" class="mt-2 mb-4">Templates &amp; checklists</h2>

        <div class="stack gap-4 mb-5">
          <div class="cluster gap-2">
            <label for="resource-search" class="sr-only">Search resources</label>
            <input type="search" id="resource-search" class="field__input flex-1" placeholder="Search resources…" data-filter-search>
          </div>

          <div class="cluster gap-3">
            <span id="filter-label" class="text-secondary text-small">Filter by topic:</span>
            <div class="filter-bar" role="group" aria-labelledby="filter-label" data-filter-controls>
              <button type="button" class="filter-pill" data-filter="all" aria-pressed="true">All</button>
              <button type="button" class="filter-pill" data-filter="budgeting" aria-pressed="false">Budgeting</button>
              <button type="button" class="filter-pill" data-filter="saving" aria-pressed="false">Saving</button>
              <button type="button" class="filter-pill" data-filter="debt" aria-pressed="false">Debt</button>
              <button type="button" class="filter-pill" data-filter="investing" aria-pressed="false">Investing</button>
            </div>
          </div>
        </div>

        <p class="alert alert--info hidden" data-filter-empty aria-live="polite">No resources match. Try a different term, or <a href="/newsletter/">subscribe</a> to request one.</p>

        <div class="grid grid--3" data-filter-grid>
          ${cardsHtml || '<p class="text-secondary col-span-full">No resources published yet. Check back soon.</p>'}
        </div>
      </div>
    </section>
${CALCULATORS_SECTION}
${popularSection}
${FAQ_SECTION}
${NEWSLETTER_BAND}`;

  const html = renderShell({
    title: 'Free Financial Resources & Tools | Robayer WealthLab',
    description: 'Free checklists, worksheets, and calculators to help you budget, save, and invest in Ghana, no sign-up required. Browse the resource library.',
    canonical: `${SITE_ORIGIN}/resources/`,
    ogImage: `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    extraHead: faqJsonLd(),
    bodyContent: body,
    scripts: ['/js/components/content-filters.js', '/js/main.js'],
  });

  return htmlResponse(html, 200);
}

// ============================================================
// GET /resources/{slug}/download — real file download
// ============================================================

/** Streams the resource's file straight through from Media Library's own public file route logic — never a duplicated copy, matches how free products' files are served today. Increments the real, server-side download counter (never client-trusted) before redirecting. */
async function handleResourceDownload(env: Env, slug: string): Promise<Response> {
  const resource = await resourceService.getResourceBySlug(env, slug);
  if (!resource || !isPubliclyVisibleStatus(resource.status) || !resource.fileMediaId || !resource.filePublicUrl) {
    return new Response('Not found', { status: 404 });
  }

  await resourceService.incrementDownloadCount(env, resource.id);

  // The file itself already lives at a real, public Media Library URL
  // (GET /api/media/file/:key) — redirecting there rather than
  // re-streaming the bytes through this route avoids duplicating
  // Media Library's own byte-serving logic for no benefit.
  //
  // Real defect found during local verification: `Response.redirect()`
  // requires a fully-qualified absolute URL (the Fetch spec has no
  // `document.baseURI` to resolve a relative one against in the
  // Workers runtime) and throws a `TypeError` on the root-relative
  // `filePublicUrl` this app stores everywhere else — confirmed via a
  // 500 on every real download attempt. Fixed by constructing the
  // Response by hand; an HTTP `Location` header is not
  // constructor-validated the way `Response.redirect()`'s argument is,
  // and every browser/fetch client correctly resolves a relative
  // `Location` against the response's own origin per RFC 7231.
  return new Response(null, { status: 302, headers: { Location: resource.filePublicUrl } });
}

// ============================================================
// Dispatcher
// ============================================================

export async function handleResourcesIndex(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  return renderResourcesIndex(env);
}

export async function handleResourceDownloadRoute(_request: Request, env: Env, _logger: Logger, params: RouteParams): Promise<Response> {
  const slug = params.slug ?? '';
  if (!slug) return new Response('Not found', { status: 404 });
  return handleResourceDownload(env, slug);
}

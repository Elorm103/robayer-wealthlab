/**
 * GET /blog/*, Version 2.1 Phase 2 (Blog CMS) — public site
 * integration. See docs/v2.1-architecture-plan.md Section 4 and
 * docs/v2.1-phase2-implementation.md.
 *
 * Full owner of the `/blog/*` path via a new Cloudflare Workers Route
 * (backend/wrangler.jsonc), mirroring `routes/books.ts`'s and
 * `routes/resources.ts`'s exact pattern — every request is rendered
 * or 404'd entirely from D1, no proxy/fetch to the static origin.
 *
 * The hand-authored static `blog/index.html` and
 * `blog/what-are-treasury-bills-in-ghana/index.html` become
 * unreachable dead code once this Route is live (shadowed, not
 * deleted). Hero/FAQ copy on the listing page is carried over
 * verbatim; the one real article's content was migrated into
 * `blog_posts` with intentionally reduced fidelity (its pull-quote/
 * alert-box styling, "Key takeaways" card, sticky table-of-contents,
 * and per-article FAQ block are not reproducible through this
 * phase's plain rich-text schema — a deliberate, explicitly-approved
 * trade-off; see the implementation log).
 *
 * Preview: `?preview=1` on a detail page bypasses the
 * published-only filter if (and only if) the request carries a valid
 * admin session — reusing `requireAuth()` directly rather than
 * building a separate preview-token table/mechanism. A non-admin
 * visitor hitting the same URL still gets an honest 404 (a draft's
 * existence is never revealed to a logged-out visitor).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { RouteParams } from '../worker/index';
import * as blogService from '../services/blogService';
import { isPubliclyVisibleStatus, estimateReadingTimeMinutes } from '../services/blogService';
import type { BlogPostRecord } from '../services/blogService';
import { requireAuth } from '../middleware/requireAuth';

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

const LISTING_FAQ_QA: Array<{ q: string; a: string }> = [
  { q: 'How often do you publish new articles?', a: "Weekly, alongside the newsletter. Subscribe above to get each one as it's published." },
  { q: 'Do I need any background knowledge to follow along?', a: 'No, articles are written for complete beginners first, with more advanced topics clearly marked.' },
  { q: 'Can I suggest a topic?', a: 'Yes, reach out through the Contact page. Reader questions are where most articles start.' },
  { q: 'Are these articles the same as the free resources?', a: 'No. Resources are practical templates and checklists; articles are explanations and stories written to build understanding.' },
  { q: 'Is the advice in these articles personalized to me?', a: 'No. Articles are financial education, not licensed financial advice; always consider your own circumstances.' },
];

function labelize(value: string): string {
  return value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ============================================================
// Blog card — mirrors js/components/content-filters.js's expected
// data-category/data-title attributes exactly, matching the static
// page's original convention, so the filter/search script works
// unmodified against these server-rendered cards.
// ============================================================
function renderBlogCard(post: BlogPostRecord): string {
  const coverStyle = post.coverPublicUrl ? ` style="background-image:url('${escapeHtml(post.coverPublicUrl)}');background-size:cover;background-position:center;"` : '';
  const readingTime = estimateReadingTimeMinutes(post.body);
  const dateLine = post.publishedAt ? `<time datetime="${escapeHtml(post.publishedAt.slice(0, 10))}">${escapeHtml(formatDate(post.publishedAt))}</time> &bull; ${readingTime} min read` : '';

  return `<div class="blog-card" id="${escapeHtml(post.slug)}" data-category="${escapeHtml(post.category)}" data-title="${escapeHtml(post.title)}">
  <div class="blog-card__image"${coverStyle}></div>
  <span class="eyebrow">${escapeHtml(labelize(post.category))}</span>
  <p class="blog-card__title"><a href="/blog/${escapeHtml(post.slug)}/">${escapeHtml(post.title)}</a></p>
  ${post.excerpt ? `<p class="blog-card__excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
  <span class="blog-card__meta">${dateLine}</span>
  <a href="/blog/${escapeHtml(post.slug)}/" class="cluster gap-2">Read article <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m0 0l-5-5m5 5l-5 5"/></svg></a>
</div>`;
}

// ============================================================
// GET /blog/ — listing page
// ============================================================

async function renderBlogIndex(env: Env): Promise<Response> {
  const result = await blogService.listPosts(env, {
    search: null,
    status: 'published',
    category: null,
    featured: null,
    showDeleted: false,
    sort: 'newest',
    page: 1,
    pageSize: 100,
  });

  const cardsHtml = result.items.length > 0 ? result.items.map(renderBlogCard).join('\n') : '';
  const featured = result.items.find((p) => p.featured) ?? result.items[0] ?? null;

  const featuredSection = featured
    ? `
    <section class="section bg-navy" aria-labelledby="featured-article-heading">
      <div class="container feature-banner">
        <div class="blog-card__image" aria-hidden="true"${featured.coverPublicUrl ? ` style="background-image:url('${escapeHtml(featured.coverPublicUrl)}');background-size:cover;background-position:center;"` : ''}></div>
        <div>
          <span class="eyebrow feature-banner__eyebrow">Featured article</span>
          <h2 id="featured-article-heading" class="mt-2 mb-2 feature-banner__title">${escapeHtml(featured.title)}</h2>
          <p class="mb-2 feature-banner__copy">${escapeHtml(featured.excerpt ?? '')}</p>
          ${featured.publishedAt ? `<p class="mb-4 feature-banner__copy text-small"><time datetime="${escapeHtml(featured.publishedAt.slice(0, 10))}">${escapeHtml(formatDate(featured.publishedAt))}</time> &bull; ${estimateReadingTimeMinutes(featured.body)} min read</p>` : ''}
          <a href="/blog/${escapeHtml(featured.slug)}/" class="btn btn--accent">Read the article</a>
        </div>
      </div>
    </section>`
    : '';

  const popular = result.items.slice(0, 3);
  const popularSection =
    popular.length > 0
      ? `
    <section class="section bg-sand" aria-labelledby="popular-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Reader favorites</span>
        <h2 id="popular-heading" class="mt-2 mb-4 text-center">Popular articles</h2>
        <ol class="toc">
          ${popular.map((p, i) => `<li class="toc__item"><span class="toc__number numeric">0${i + 1}</span><span class="toc__title"><a href="#${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></span></li>`).join('\n          ')}
        </ol>
      </div>
    </section>`
      : '';

  const body = `
    <section class="hero bg-paper">
      <div class="container hero__content">
        <span class="eyebrow hero__eyebrow">Blog</span>
        <h1 class="hero__title">Real answers to real money questions</h1>
        <p class="hero__subtitle">Plain-language articles on saving, investing, and building wealth in Ghana, written for wherever you're starting.</p>
        <div class="hero__actions">
          <a href="#articles-grid" class="btn btn--primary">Browse articles</a>
        </div>
      </div>
    </section>
${featuredSection}
    <section class="section" id="articles-grid" aria-labelledby="articles-grid-heading">
      <div class="container">
        <span class="eyebrow">Latest articles</span>
        <h2 id="articles-grid-heading" class="mt-2 mb-4">Everything we've published</h2>

        <div class="stack gap-4 mb-5">
          <div class="cluster gap-2">
            <label for="article-search" class="sr-only">Search articles</label>
            <input type="search" id="article-search" class="field__input flex-1" placeholder="Search articles…" data-filter-search>
          </div>
          <div class="cluster gap-3">
            <span id="filter-label" class="text-secondary text-small">Filter by topic:</span>
            <div class="filter-bar" role="group" aria-labelledby="filter-label" data-filter-controls>
              <button type="button" class="filter-pill" data-filter="all" aria-pressed="true">All</button>
              <button type="button" class="filter-pill" data-filter="saving" aria-pressed="false">Saving</button>
              <button type="button" class="filter-pill" data-filter="investing" aria-pressed="false">Investing</button>
              <button type="button" class="filter-pill" data-filter="budgeting" aria-pressed="false">Budgeting</button>
            </div>
          </div>
        </div>

        <p class="alert alert--info hidden" data-filter-empty aria-live="polite">No articles match. Try a different term, or <a href="/newsletter/">subscribe</a> to request one.</p>

        <div class="grid grid--3" data-filter-grid>
          ${cardsHtml || '<p class="text-secondary col-span-full">No articles published yet. Check back soon.</p>'}
        </div>
      </div>
    </section>
${popularSection}
${NEWSLETTER_BAND}
    <section class="section" aria-labelledby="faq-heading">
      <div class="container content-column">
        <span class="eyebrow text-center">Questions</span>
        <h2 id="faq-heading" class="mt-2 mb-5 text-center">Frequently asked questions</h2>
        <div class="faq">
          ${LISTING_FAQ_QA.map((qa) => `<details class="faq__item"><summary class="faq__question">${escapeHtml(qa.q)}<span class="faq__icon" aria-hidden="true"></span></summary><p class="faq__answer">${escapeHtml(qa.a)}</p></details>`).join('\n          ')}
        </div>
      </div>
    </section>`;

  const faqJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      ${LISTING_FAQ_QA.map((qa) => `{ "@type": "Question", "name": ${JSON.stringify(qa.q)}, "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(qa.a)} } }`).join(',\n      ')}
    ]
  }
  </script>`;

  const html = renderShell({
    title: 'Financial Lessons & Guides | Robayer WealthLab',
    description: 'Plain-language articles on saving, investing, and building wealth in Ghana: treasury bills, mobile money, budgeting, and more.',
    canonical: `${SITE_ORIGIN}/blog/`,
    ogImage: `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    extraHead: faqJsonLd,
    bodyContent: body,
    scripts: ['/js/components/content-filters.js', '/js/main.js'],
  });

  return htmlResponse(html, 200);
}

// ============================================================
// GET /blog/{slug}/ — detail page
// ============================================================

function render404(slug: string): Response {
  const html = renderShell({
    title: 'Article not found | Robayer WealthLab',
    description: 'This article could not be found.',
    canonical: `${SITE_ORIGIN}/blog/`,
    ogImage: `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    bodyContent: `
    <section class="section">
      <div class="container content-column text-center">
        <h1 class="mb-3">We couldn't find that article</h1>
        <p class="mb-4 text-secondary">"${escapeHtml(slug)}" may have been moved, renamed, or is no longer available.</p>
        <a href="/blog/" class="btn btn--primary">Browse all articles</a>
      </div>
    </section>`,
    scripts: ['/js/main.js'],
  });
  return htmlResponse(html, 404);
}

async function renderPostDetail(request: Request, env: Env, logger: Logger, slug: string): Promise<Response> {
  const post = await blogService.getPostBySlug(env, slug);
  if (!post) return render404(slug);

  const isPreviewRequest = new URL(request.url).searchParams.get('preview') === '1';
  let isPreview = false;
  if (!isPubliclyVisibleStatus(post.status)) {
    // A draft is only ever revealed to a real, authenticated admin
    // session requesting the exact preview URL — never to a logged-out
    // visitor, and never just because the slug is guessed. No new
    // token table: this reuses the same session check every admin
    // route already performs.
    if (!isPreviewRequest) return render404(slug);
    const auth = await requireAuth(request, env, logger);
    if (!auth.ok) return render404(slug);
    isPreview = true;
  }

  const readingTime = estimateReadingTimeMinutes(post.body);
  const coverStyle = post.coverPublicUrl ? ` style="background-image:url('${escapeHtml(post.coverPublicUrl)}');background-size:cover;background-position:center;"` : '';
  const authorInitial = (post.authorName ?? 'R').trim().charAt(0).toUpperCase() || 'R';

  const previewBanner = isPreview
    ? `<div class="container mt-3"><p class="alert alert--warning">Preview: this post is <strong>${escapeHtml(labelize(post.status))}</strong> and is not visible to the public.</p></div>`
    : '';

  const body = `
${previewBanner}
    <section class="hero bg-paper">
      <div class="container hero__content">
        <span class="eyebrow hero__eyebrow">${escapeHtml(labelize(post.category))}</span>
        <h1 class="hero__title">${escapeHtml(post.title)}</h1>
        ${post.excerpt ? `<p class="hero__subtitle">${escapeHtml(post.excerpt)}</p>` : ''}
        <div class="testimonial__attribution cluster--center">
          <div class="testimonial__avatar" aria-hidden="true">${escapeHtml(authorInitial)}</div>
          <div class="text-left">
            <p class="testimonial__name">${escapeHtml(post.authorName ?? 'Robayer WealthLab')}</p>
            <p class="testimonial__context">${post.publishedAt ? `Published <time datetime="${escapeHtml(post.publishedAt.slice(0, 10))}">${escapeHtml(formatDate(post.publishedAt))}</time> &bull; ` : ''}${readingTime} min read</p>
          </div>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="container content-column">
        <div class="blog-card__image mb-5"${coverStyle} role="img" aria-label=""></div>
        <div class="article-body">
          ${post.body ?? ''}
        </div>
        <p class="alert alert--warning mt-5">Robayer WealthLab provides financial education, not licensed financial advice. This article is for informational purposes only; always do your own research and consider your personal circumstances before making investment decisions.</p>
      </div>
    </section>
${NEWSLETTER_BAND}`;

  const breadcrumb = `
  <nav class="breadcrumbs container" aria-label="Breadcrumb">
    <a href="/">Home</a><span class="breadcrumbs__separator" aria-hidden="true">/</span><a href="/blog/">Blog</a><span class="breadcrumbs__separator" aria-hidden="true">/</span><span aria-current="page">${escapeHtml(post.title)}</span>
  </nav>`;

  const breadcrumbJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": ${JSON.stringify(SITE_ORIGIN + '/')} },
      { "@type": "ListItem", "position": 2, "name": "Blog", "item": ${JSON.stringify(SITE_ORIGIN + '/blog/')} },
      { "@type": "ListItem", "position": 3, "name": ${JSON.stringify(post.title)}, "item": ${JSON.stringify(`${SITE_ORIGIN}/blog/${post.slug}/`)} }
    ]
  }
  </script>`;

  const articleJsonLd = `
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": ${JSON.stringify(post.title)},
    "description": ${JSON.stringify(post.excerpt ?? '')},
    "image": ${JSON.stringify(post.coverPublicUrl ?? `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`)},
    "author": { "@type": "Person", "name": ${JSON.stringify(post.authorName ?? 'Robayer WealthLab')} },
    "publisher": {
      "@type": "Organization",
      "name": "Robayer WealthLab",
      "logo": { "@type": "ImageObject", "url": "${SITE_ORIGIN}/assets/branding/logo/logo.png" }
    },
    "datePublished": ${JSON.stringify(post.publishedAt ?? '')},
    "dateModified": ${JSON.stringify(post.updatedAt)},
    "mainEntityOfPage": { "@type": "WebPage", "@id": ${JSON.stringify(`${SITE_ORIGIN}/blog/${post.slug}/`)} }
  }
  </script>`;

  const html = renderShell({
    title: post.seoTitle ?? `${post.title} | ${SITE_NAME}`,
    description: post.seoDescription ?? post.excerpt ?? '',
    canonical: post.seoCanonicalUrl ?? `${SITE_ORIGIN}/blog/${post.slug}/`,
    ogImage: post.coverPublicUrl ?? `${SITE_ORIGIN}/assets/branding/social/og-image.jpg`,
    extraHead: breadcrumbJsonLd + (isPreview ? '' : articleJsonLd),
    breadcrumb,
    bodyContent: body,
    scripts: ['/js/components/article-reading.js', '/js/main.js'],
  });

  return htmlResponse(html, isPreview ? 200 : 200);
}

// ============================================================
// Dispatcher
// ============================================================

export async function handleBlogIndex(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  return renderBlogIndex(env);
}

export async function handleBlogDetail(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const slug = params.slug ?? '';
  if (!slug) return render404('');
  return renderPostDetail(request, env, logger, slug);
}

/** `/blog/{slug}` (no trailing slash) — 301s to the canonical `/blog/{slug}/` form, matching every other URL on this site. */
export async function handleBlogRedirect(request: Request, _env: Env, _logger: Logger, params: RouteParams): Promise<Response> {
  const slug = params.slug ?? '';
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/blog/${slug}/`, 301);
}

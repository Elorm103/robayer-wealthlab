/**
 * Document source readers — Version 5.0 Milestone 2 (Knowledge Base).
 * One function per `source_type`, each returning a normalized
 * `SourceDocument[]` — the single shape services/knowledge/indexingService.ts
 * consumes regardless of where the content actually came from.
 *
 * Verified against the REAL platform content model before writing any
 * of this (not assumed): `blog_posts` and `resources` are genuine
 * D1-backed CMS tables (read directly, cheap, has real status/id
 * metadata). `products` is transactional-only in D1 (no description
 * column) — the real marketing copy lives on the live, Worker-rendered
 * `/books/{slug}/` page, so getProductDocuments() reads the D1 row for
 * the authoritative active-product list and then fetches the
 * corresponding live page for its actual content. Investment Centre,
 * Policies, Services, Calculators, and most other public pages are
 * hand-authored static HTML with no database record at all — indexed
 * by crawling the site's own real `sitemap.xml` (getStaticPageDocuments()),
 * per the founder's explicit confirmation that crawl-based indexing
 * (not a new CMS table) is acceptable for this milestone.
 */

import type { Env } from '../../worker/env';
import { extractPageContent, extractFaqsFromJsonLd } from './htmlExtraction';

export type KnowledgeSourceType = 'blog_post' | 'resource' | 'product' | 'static_page' | 'cms_setting';

export interface SourceDocument {
  documentKey: string;
  sourceType: KnowledgeSourceType;
  sourceId: number | null;
  url: string | null;
  title: string;
  text: string;
  faqs: { question: string; answer: string }[];
  /** PRODUCTION/INTERNAL/DEVELOPMENT/UNKNOWN — see migration 0036's header comment on why every source this milestone indexes is honestly PRODUCTION (only published/active content is ever read; nothing draft/test is ever a candidate). */
  dataClassification: 'PRODUCTION' | 'INTERNAL' | 'DEVELOPMENT' | 'UNKNOWN';
}

/** Strips tags from this project's own sanitizeRichTextHtml()-sanitized rich text (blog_posts.body / resources.description) — safe to strip naively since the source is already sanitized, not arbitrary untrusted HTML. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getBlogPostDocuments(env: Env): Promise<SourceDocument[]> {
  const { results } = await env.DB.prepare(`SELECT id, slug, title, excerpt, body FROM blog_posts WHERE status = 'published' AND deleted_at IS NULL`).all<{
    id: number;
    slug: string;
    title: string;
    excerpt: string | null;
    body: string | null;
  }>();

  return results
    .map((row) => ({
      documentKey: `blog_post:${row.id}`,
      sourceType: 'blog_post' as const,
      sourceId: row.id,
      url: `${env.SITE_BASE_URL}/blog/${row.slug}/`,
      title: row.title,
      text: [row.excerpt?.trim(), stripHtml(row.body ?? '')].filter((s) => s && s.length > 0).join('\n\n'),
      faqs: [],
      dataClassification: 'PRODUCTION' as const,
    }))
    .filter((doc) => doc.text.length > 0);
}

export async function getResourceDocuments(env: Env): Promise<SourceDocument[]> {
  const { results } = await env.DB.prepare(`SELECT id, slug, title, short_description, description FROM resources WHERE status = 'published' AND deleted_at IS NULL`).all<{
    id: number;
    slug: string;
    title: string;
    short_description: string | null;
    description: string | null;
  }>();

  return results
    .map((row) => ({
      documentKey: `resource:${row.id}`,
      sourceType: 'resource' as const,
      sourceId: row.id,
      // No individual resource detail page exists on this platform today
      // (confirmed: only /resources/ itself is routed) — the listing
      // page, with an anchor, is the honest citation target.
      url: `${env.SITE_BASE_URL}/resources/#${row.slug}`,
      title: row.title,
      text: [row.short_description?.trim(), stripHtml(row.description ?? '')].filter((s) => s && s.length > 0).join('\n\n'),
      faqs: [],
      dataClassification: 'PRODUCTION' as const,
    }))
    .filter((doc) => doc.text.length > 0);
}

/**
 * The D1 `products` table has no description column (confirmed during
 * this milestone's content-inventory verification) — it's a
 * transactional record (price, SKU, R2 keys), not a content record.
 * The real marketing copy lives on the live `/books/{slug}/` page,
 * which this Worker itself renders (routes/books.ts) from a template,
 * not from any single stored text field. Fetching that live page is
 * therefore the only honest way to index "product descriptions" —
 * D1 supplies the authoritative list of which slugs are active.
 */
export async function getProductDocuments(env: Env, logger: { error(msg: string, ctx?: Record<string, unknown>): void }): Promise<SourceDocument[]> {
  const { results } = await env.DB.prepare(`SELECT id, slug, title FROM products WHERE status = 'active' AND deleted_at IS NULL`).all<{ id: number; slug: string; title: string }>();

  const documents: SourceDocument[] = [];
  for (const row of results) {
    const url = `${env.SITE_BASE_URL}/books/${row.slug}/`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.error('knowledge.product_fetch_failed', { slug: row.slug, status: response.status });
        continue;
      }
      const extracted = await extractPageContent(response);
      if (extracted.mainText.length === 0) {
        logger.error('knowledge.product_page_empty_main', { slug: row.slug });
        continue;
      }
      documents.push({
        documentKey: `product:${row.id}`,
        sourceType: 'product',
        sourceId: row.id,
        url,
        title: extracted.title || row.title,
        text: extracted.mainText,
        faqs: extractFaqsFromJsonLd(extracted.jsonLd),
        dataClassification: 'PRODUCTION',
      });
    } catch (err) {
      logger.error('knowledge.product_fetch_error', { slug: row.slug, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return documents;
}

const SITEMAP_URL_PATTERN = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

/**
 * Crawls the site's own real, live `sitemap.xml` — the canonical list
 * of public URLs this site itself claims to have (confirmed: 38 real
 * URLs as of this milestone's implementation, covering Investment
 * Centre, Services, Calculators, Legal/Policies, and every other
 * top-level public page). Excludes any URL already covered by a
 * richer, D1-backed reader above (`/blog/{slug}/` for a real
 * published post, `/books/{slug}/` for a real active product) so the
 * same content is never indexed twice under two different
 * document_keys.
 *
 * The `/resources/` LISTING page itself is deliberately included, not
 * excluded — Version 5.0 Milestone 2.2's real production verification
 * found "What resources are available?" retrieved only adjacent static
 * pages, never the one indexed resource item. Root cause, confirmed
 * with hard evidence (raising Vectorize's oversampling to cover 89% of
 * the entire corpus still didn't surface it): the resource item's own
 * title/description share essentially no vocabulary with how someone
 * asks "what's available," so no amount of reranking or wider
 * candidate pooling helps — the query needs a genuine catalog-level
 * document to match against. The sitemap has exactly one URL
 * containing "resources" (confirmed directly against the real
 * sitemap.xml) — the listing page — so including it here adds one new
 * `static_page:/resources/` document with no risk of colliding with or
 * duplicating the individual `resource:{id}` documents
 * getResourceDocuments() already indexes.
 */
export async function getStaticPageDocuments(
  env: Env,
  excludeUrls: Set<string>,
  logger: { error(msg: string, ctx?: Record<string, unknown>): void }
): Promise<SourceDocument[]> {
  const sitemapResponse = await fetch(`${env.SITE_BASE_URL}/sitemap.xml`);
  if (!sitemapResponse.ok) {
    throw new Error(`Could not fetch sitemap.xml (HTTP ${sitemapResponse.status}) — static-page indexing cannot proceed without it.`);
  }
  const sitemapXml = await sitemapResponse.text();

  const urls: string[] = [];
  let match: RegExpExecArray | null;
  SITEMAP_URL_PATTERN.lastIndex = 0;
  while ((match = SITEMAP_URL_PATTERN.exec(sitemapXml)) !== null) {
    urls.push(match[1]);
  }

  const documents: SourceDocument[] = [];
  for (const url of urls) {
    if (excludeUrls.has(url)) continue;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.error('knowledge.static_page_fetch_failed', { url, status: response.status });
        continue;
      }
      const extracted = await extractPageContent(response);
      if (extracted.mainText.length === 0) {
        logger.error('knowledge.static_page_empty_main', { url });
        continue;
      }
      documents.push({
        documentKey: `static_page:${new URL(url).pathname}`,
        sourceType: 'static_page',
        sourceId: null,
        url,
        title: extracted.title,
        text: extracted.mainText,
        faqs: extractFaqsFromJsonLd(extracted.jsonLd),
        dataClassification: 'PRODUCTION',
      });
    } catch (err) {
      logger.error('knowledge.static_page_fetch_error', { url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return documents;
}

interface HeroContentValue {
  eyebrow: string;
  headline: string;
  subheading: string;
}

/** The one genuinely admin-editable "content" in site_settings (heroContent) — small, but real and admin-controlled, unlike everything else this milestone indexes. */
export async function getCmsSettingDocuments(env: Env): Promise<SourceDocument[]> {
  const row = await env.DB.prepare(`SELECT value FROM site_settings WHERE key = 'hero_content'`).first<{ value: string }>();
  if (!row) return [];

  let hero: HeroContentValue;
  try {
    hero = JSON.parse(row.value);
  } catch {
    return [];
  }

  const text = [hero.eyebrow, hero.headline, hero.subheading].filter((s) => s && s.trim().length > 0).join('\n\n');
  if (text.length === 0) return [];

  return [
    {
      documentKey: 'cms_setting:hero_content',
      sourceType: 'cms_setting',
      sourceId: null,
      url: env.SITE_BASE_URL,
      title: hero.headline || 'Homepage',
      text,
      faqs: [],
      dataClassification: 'PRODUCTION',
    },
  ];
}

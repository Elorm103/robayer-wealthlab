/**
 * Digital Library Modernization (Phase 5), extended in Digital Library
 * 2.0 Phase G (Book Discovery + Recommendations) — "Recommended for
 * You" on the authenticated customer's My Library.
 *
 * Two real, deterministic signal sources, tried in this order:
 *
 * 1. Explicit product_relations (unchanged since Phase 5) — an
 *    admin-curated related/cross_sell/recommended table, already
 *    driving the public book page's own "You might also like" section
 *    (backend/routes/books.ts). Admin intent is trusted first: a
 *    human deliberately said "these two belong together," which is a
 *    stronger signal than an automatic match.
 * 2. Topic match (Phase G) — only fills whatever slots explicit
 *    relations leave empty. products.topic is a real, required,
 *    5-value enum every product already has (never a missing-metadata
 *    case to handle); this reads it directly, no new column, no new
 *    table. Deliberately NOT layered with product_type/tags — topic is
 *    the one field that actually represents "what is this book about"
 *    consistently across the whole catalog; product_type is a format
 *    distinction (ebook/guide/template/...) and tags is a free-text
 *    search field, neither is a reliable *topical* signal.
 *
 * Both sources are scoped strictly to what THIS customer owns, exclude
 * anything already owned, and exclude anything not in a purchasable
 * ('active') state — recommending a product the customer cannot
 * actually buy right now would undercut the "here is a real next step"
 * framing this whole feature is built around.
 *
 * Every recommendation carries a real, deterministic `reason` string,
 * built server-side from real data only (never an internal score,
 * never fabricated social proof) — see buildReason() below. The
 * customer's real reading progress (library_progress) is read here
 * only to pick the more relevant of several owned anchors and to
 * phrase the reason ("you're reading" vs "you finished" vs "you
 * have") — it never changes WHICH products are eligible, only which
 * owned product gets credited as the "why."
 */

import type { Env } from '../../worker/env';
import { isPurchasableStatus } from '../productService';

const TOPIC_LABELS: Record<string, string> = {
  investing: 'Investing',
  'personal-finance': 'Personal Finance',
  budgeting: 'Budgeting',
  business: 'Business',
  mindset: 'Mindset',
};

export interface LibraryRecommendation {
  slug: string;
  title: string;
  /** The product's own real short_description, unmodified - null when the product genuinely has none, never a fabricated blurb. */
  shortDescription: string | null;
  coverImageUrl: string | null;
  /** 'topic_match' is Phase G's own fallback source - honestly distinct from an admin-curated relation, never presented as one. */
  relationType: 'related' | 'cross_sell' | 'recommended' | 'topic_match';
  /** The title of the owned product this recommendation is attached to - never fabricated, always a real owned product. Kept for backward compatibility; `reason` is the full, ready-to-display sentence. */
  becauseOfProductTitle: string;
  /** A real, deterministic, one-sentence explanation - see buildReason(). Never an internal score, never invented social proof. */
  reason: string;
}

interface OwnedProductRow {
  productId: number;
  productTitle: string;
  topic: string;
}

interface RelationRow {
  sourceProductId: number;
  relatedProductId: number;
  relationType: string;
  slug: string;
  title: string;
  shortDescription: string | null;
  status: string;
  coverImageUrl: string | null;
}

interface ProgressStatusRow {
  productId: number;
  readingStatus: string;
  lastReadAt: string | null;
}

interface TopicMatchRow {
  productId: number;
  slug: string;
  title: string;
  shortDescription: string | null;
  coverImageUrl: string | null;
}

const MAX_RECOMMENDATIONS = 3;

type ReadingState = 'in_progress' | 'completed' | null;

/**
 * Every phrase here is built only from real values already in scope
 * (a real owned title, a real topic label, a real reading status) -
 * no internal scoring, no invented purchase-pattern claims like
 * "customers who bought this also bought."
 */
function buildReason(anchorTitle: string, readingState: ReadingState, source: 'relation' | 'topic', topicLabel: string): string {
  if (source === 'topic') {
    if (readingState === 'in_progress') return `Builds on what you're already reading in ${anchorTitle}.`;
    if (readingState === 'completed') return `You finished ${anchorTitle} — continue your ${topicLabel} journey.`;
    return `Another guide in ${topicLabel}.`;
  }
  if (readingState === 'in_progress') return `Because you're reading ${anchorTitle}.`;
  if (readingState === 'completed') return `Because you finished ${anchorTitle}.`;
  return `Because you have ${anchorTitle}.`;
}

export async function getLibraryRecommendations(env: Env, customerId: number): Promise<LibraryRecommendation[]> {
  const { results: owned } = await env.DB.prepare(
    `SELECT DISTINCT p.id AS productId, p.title AS productTitle, p.topic AS topic
     FROM purchase_sessions ps
     JOIN products p ON p.slug = ps.product_slug
     WHERE ps.customer_id = ? AND ps.status = 'verified'`
  )
    .bind(customerId)
    .all<OwnedProductRow>();

  if (owned.length === 0) return [];

  const ownedProductIds = owned.map((row) => row.productId);
  const ownedProductIdSet = new Set(ownedProductIds);
  const ownedTitleByProductId = new Map(owned.map((row) => [row.productId, row.productTitle]));

  // Real reading progress, read only to choose the more relevant owned
  // anchor and to phrase the reason - never to decide which products
  // are eligible. A product can have more than one progress row (a
  // PDF and an EPUB of the same book); in_progress beats completed
  // beats not_started, ties broken by the more recently read.
  const placeholders = ownedProductIds.map(() => '?').join(', ');
  const { results: progressRows } = await env.DB.prepare(
    `SELECT p.id AS productId, lp.status AS readingStatus, lp.last_read_at AS lastReadAt
     FROM library_progress lp
     JOIN deliveries d ON d.id = lp.delivery_id
     JOIN purchase_sessions ps ON ps.id = d.purchase_session_id
     JOIN products p ON p.slug = ps.product_slug
     WHERE lp.customer_id = ? AND p.id IN (${placeholders})`
  )
    .bind(customerId, ...ownedProductIds)
    .all<ProgressStatusRow>();

  const rank = (status: string) => (status === 'in_progress' ? 2 : status === 'completed' ? 1 : 0);
  const readingByProductId = new Map<number, { status: string; lastReadAt: string | null }>();
  for (const row of progressRows) {
    const existing = readingByProductId.get(row.productId);
    if (!existing || rank(row.readingStatus) > rank(existing.status) || (rank(row.readingStatus) === rank(existing.status) && (row.lastReadAt ?? '') > (existing.lastReadAt ?? ''))) {
      readingByProductId.set(row.productId, { status: row.readingStatus, lastReadAt: row.lastReadAt });
    }
  }
  const readingStateFor = (productId: number): ReadingState => {
    const status = readingByProductId.get(productId)?.status;
    return status === 'in_progress' || status === 'completed' ? status : null;
  };

  const seenRelatedProductIds = new Set<number>();
  const recommendations: LibraryRecommendation[] = [];

  // --- Signal 1: explicit, admin-curated relations (unchanged logic) ---
  const { results: relations } = await env.DB.prepare(
    `SELECT pr.product_id AS sourceProductId, pr.related_product_id AS relatedProductId, pr.relation_type AS relationType,
            p.slug, p.title, p.short_description AS shortDescription, p.status, cover.public_url AS coverImageUrl
     FROM product_relations pr
     JOIN products p ON p.id = pr.related_product_id
     LEFT JOIN media_assets cover ON cover.id = p.cover_media_id
     WHERE pr.product_id IN (${placeholders}) AND p.deleted_at IS NULL
     ORDER BY pr.relation_type ASC, pr.sort_order ASC, pr.id ASC`
  )
    .bind(...ownedProductIds)
    .all<RelationRow>();

  for (const row of relations) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    if (ownedProductIdSet.has(row.relatedProductId)) continue; // never recommend something already owned
    if (seenRelatedProductIds.has(row.relatedProductId)) continue; // one card per product, even if related to more than one owned product
    if (!isPurchasableStatus(row.status)) continue; // never recommend a product the customer cannot actually buy right now

    seenRelatedProductIds.add(row.relatedProductId);
    const anchorTitle = ownedTitleByProductId.get(row.sourceProductId) ?? '';
    recommendations.push({
      slug: row.slug,
      title: row.title,
      shortDescription: row.shortDescription,
      coverImageUrl: row.coverImageUrl,
      relationType: row.relationType as LibraryRecommendation['relationType'],
      becauseOfProductTitle: anchorTitle,
      reason: buildReason(anchorTitle, readingStateFor(row.sourceProductId), 'relation', ''),
    });
  }

  // --- Signal 2: topic match, fallback only (Phase G) ---
  // Owned products are considered as candidate "anchors" in relevance
  // order - the book currently being read first, then a completed
  // book, then whatever else is owned - and each topic is only
  // "claimed" once, by its highest-priority owned anchor, so a
  // customer owning three investing books doesn't get three separate,
  // redundant "another Investing guide" reasons.
  if (recommendations.length < MAX_RECOMMENDATIONS) {
    const sortedOwned = owned.slice().sort((a, b) => {
      const rankDiff = rank(readingByProductId.get(b.productId)?.status ?? '') - rank(readingByProductId.get(a.productId)?.status ?? '');
      if (rankDiff !== 0) return rankDiff;
      const aLastRead = readingByProductId.get(a.productId)?.lastReadAt ?? '';
      const bLastRead = readingByProductId.get(b.productId)?.lastReadAt ?? '';
      return bLastRead.localeCompare(aLastRead);
    });

    const topicsClaimed = new Set<string>();
    for (const ownedProduct of sortedOwned) {
      if (recommendations.length >= MAX_RECOMMENDATIONS) break;
      if (topicsClaimed.has(ownedProduct.topic)) continue;
      topicsClaimed.add(ownedProduct.topic);

      const { results: topicMatches } = await env.DB.prepare(
        `SELECT p.id AS productId, p.slug, p.title, p.short_description AS shortDescription, cover.public_url AS coverImageUrl
         FROM products p
         LEFT JOIN media_assets cover ON cover.id = p.cover_media_id
         WHERE p.topic = ? AND p.status = 'active' AND p.deleted_at IS NULL
         ORDER BY p.id ASC`
      )
        .bind(ownedProduct.topic)
        .all<TopicMatchRow>();

      for (const candidate of topicMatches) {
        if (recommendations.length >= MAX_RECOMMENDATIONS) break;
        if (ownedProductIdSet.has(candidate.productId)) continue;
        if (seenRelatedProductIds.has(candidate.productId)) continue;

        seenRelatedProductIds.add(candidate.productId);
        recommendations.push({
          slug: candidate.slug,
          title: candidate.title,
          shortDescription: candidate.shortDescription,
          coverImageUrl: candidate.coverImageUrl,
          relationType: 'topic_match',
          becauseOfProductTitle: ownedProduct.productTitle,
          reason: buildReason(ownedProduct.productTitle, readingStateFor(ownedProduct.productId), 'topic', TOPIC_LABELS[ownedProduct.topic] ?? ownedProduct.topic),
        });
      }
    }
  }

  return recommendations;
}

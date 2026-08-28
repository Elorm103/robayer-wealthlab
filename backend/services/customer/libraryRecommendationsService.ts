/**
 * Digital Library Modernization (Phase 5) — "Continue your learning"
 * recommendations for the authenticated customer's My Library.
 *
 * Deliberately reuses the existing `product_relations` table and its
 * existing admin tooling (backend/routes/admin/products.ts's relation
 * editor) rather than introducing a new recommendation system —
 * see docs/v3.0.2-m2-customer-library-ux-plan.md's sibling audit
 * report for why: an admin-curated related/cross_sell/recommended
 * table already exists and already drives the public book page's own
 * "You may also like" section (backend/routes/books.ts), it has simply
 * never been read by the customer dashboard until now.
 *
 * Scoped strictly to what THIS customer owns: reads product_relations
 * only for products this customer has a verified purchase of, excludes
 * anything already owned, and excludes anything not in a purchasable
 * state — recommending a product the customer cannot actually buy yet
 * (draft, coming-soon, archived, hidden, unavailable) would undercut
 * the "here is a real next step" framing the redesign is built around.
 */

import type { Env } from '../../worker/env';
import { isPurchasableStatus } from '../productService';

export interface LibraryRecommendation {
  slug: string;
  title: string;
  coverImageUrl: string | null;
  relationType: 'related' | 'cross_sell' | 'recommended';
  /** The title of the owned product this recommendation is attached to, e.g. "Because you have Understanding the Ghana Stock Exchange" — never fabricated, always the real product_relations row's own source product. */
  becauseOfProductTitle: string;
}

interface OwnedProductRow {
  productId: number;
  productTitle: string;
}

interface RelationRow {
  sourceProductId: number;
  relatedProductId: number;
  relationType: string;
  slug: string;
  title: string;
  status: string;
  coverImageUrl: string | null;
}

const MAX_RECOMMENDATIONS = 3;

export async function getLibraryRecommendations(env: Env, customerId: number): Promise<LibraryRecommendation[]> {
  const { results: owned } = await env.DB.prepare(
    `SELECT DISTINCT p.id AS productId, p.title AS productTitle
     FROM purchase_sessions ps
     JOIN products p ON p.slug = ps.product_slug
     WHERE ps.customer_id = ? AND ps.status = 'verified'`
  )
    .bind(customerId)
    .all<OwnedProductRow>();

  if (owned.length === 0) return [];

  const ownedProductIds = owned.map((row) => row.productId);
  const ownedTitleByProductId = new Map(owned.map((row) => [row.productId, row.productTitle]));

  const placeholders = ownedProductIds.map(() => '?').join(', ');
  const { results: relations } = await env.DB.prepare(
    `SELECT pr.product_id AS sourceProductId, pr.related_product_id AS relatedProductId, pr.relation_type AS relationType,
            p.slug, p.title, p.status, cover.public_url AS coverImageUrl
     FROM product_relations pr
     JOIN products p ON p.id = pr.related_product_id
     LEFT JOIN media_assets cover ON cover.id = p.cover_media_id
     WHERE pr.product_id IN (${placeholders}) AND p.deleted_at IS NULL
     ORDER BY pr.relation_type ASC, pr.sort_order ASC, pr.id ASC`
  )
    .bind(...ownedProductIds)
    .all<RelationRow>();

  const ownedProductIdSet = new Set(ownedProductIds);
  const seenRelatedProductIds = new Set<number>();
  const recommendations: LibraryRecommendation[] = [];

  for (const row of relations) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    if (ownedProductIdSet.has(row.relatedProductId)) continue; // never recommend something already owned
    if (seenRelatedProductIds.has(row.relatedProductId)) continue; // one card per product, even if related to more than one owned product
    if (!isPurchasableStatus(row.status)) continue; // never recommend a product the customer cannot actually buy right now

    seenRelatedProductIds.add(row.relatedProductId);
    recommendations.push({
      slug: row.slug,
      title: row.title,
      coverImageUrl: row.coverImageUrl,
      relationType: row.relationType as LibraryRecommendation['relationType'],
      becauseOfProductTitle: ownedTitleByProductId.get(row.sourceProductId) ?? '',
    });
  }

  return recommendations;
}

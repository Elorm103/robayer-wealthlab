/**
 * Robayer WealthLab — Product Loader
 * (Version 1.2 Sprint 1, rebuilt Sprint 2.1, extended Sprint 2.2,
 * migrated off content/products/*.json to the D1-backed public API
 * in Version 2.0 Phase 2 — see backend/routes/products.ts.)
 *
 * As of Phase 2, only index.html (homepage) still uses this script for
 * its feature banner + coming-soon grid — the Books listing and
 * individual product pages are now server-rendered directly from D1
 * by the Worker (backend/routes/books.ts), not client-hydrated. This
 * file is kept for the homepage's sake and for any future page that
 * wants a lightweight, client-rendered product grid without a full
 * server-rendered page.
 *
 * No Paystack code here. This loader only reads and renders product
 * *content* — price, cover, description. A future storefront wires
 * "Buy" buttons to Paystack separately (see docs/paystack-integration.md).
 *
 * Public API (window.RobayerProducts):
 *   loadAll()                            -> Promise<Product[]>  (valid products only, invalid entries dropped + warned)
 *   fetchProduct(slug)                   -> Promise<Product|null>  (single-file fetch, for a future detail page)
 *   getBySlug(products, slug)            -> Product|null
 *   getFeatured(products)                -> Product[]
 *   getBestsellers(products)             -> Product[]
 *   getNewReleases(products)             -> Product[]
 *   getFree(products)                    -> Product[]  (price === 0)
 *   getUpdated(products)                 -> Product[]  (updatedDate genuinely after publishedDate)
 *   getComingSoon(products)              -> Product[]
 *   getActive(products)                  -> Product[]
 *   getByType(products, productType)     -> Product[]
 *   getByTopic(products, topic)          -> Product[]
 *   getNewest(products, limit)           -> Product[]  (active products, newest publishedDate first)
 *   sortByDate(products, direction)      -> Product[]  (direction: 'desc' default, or 'asc')
 *   sortByPrice(products, direction)     -> Product[]  (direction: 'asc' default, or 'desc')
 *   getRelatedProducts(products, product, limit) -> Product[]  (see ranking strategy below)
 *   getProductPageState(product)         -> { state, message }
 *   renderCard(product)                  -> HTML string (the one reusable product card)
 *   validateProduct(product)             -> { valid: boolean, errors: string[] }
 *
 * Related-product ranking strategy (getRelatedProducts), documented in
 * full in docs/product-discovery-architecture.md:
 *   1. Same topic as the source product (excluding itself)
 *   2. Same productType as the source product (excluding itself and
 *      anything already picked in step 1)
 *   3. Featured products, as a fallback to fill remaining slots
 *      (excluding itself and anything already picked)
 *   4. Anything else at all, as a final catch-all — with a very small
 *      catalog, steps 1-3 can legitimately match nothing; showing
 *      "something else in the library" beats an empty section.
 *   Draws from active + coming-soon products (never draft/archived) —
 *   should never recommend a draft or archived item.
 */

(function () {
  const REQUIRED_FIELDS = ['id', 'slug', 'title', 'productType', 'status'];
  const VALID_STATUSES = ['draft', 'active', 'archived', 'coming-soon', 'hidden', 'unavailable'];

  function validateProduct(product) {
    const errors = [];
    if (!product || typeof product !== 'object') {
      return { valid: false, errors: ['Product is not an object.'] };
    }
    REQUIRED_FIELDS.forEach((field) => {
      if (product[field] === undefined || product[field] === null || product[field] === '') {
        errors.push('Missing required field: ' + field);
      }
    });
    if (product.status && !VALID_STATUSES.includes(product.status)) {
      errors.push('Invalid status: ' + product.status);
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Reads one page of the public product API (backend/routes/products.ts
   * — GET /api/products, publicly-listed statuses only, D1-backed).
   * Always returns an array — a fetch/parse failure is an honest empty
   * result here, matching this file's existing "never throw a caller
   * must remember to catch" pattern for the old JSON registry fetch.
   */
  function loadAll() {
    return fetch('/api/products?pageSize=100')
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load products.');
        return response.json();
      })
      .then((body) => {
        if (!body || body.success !== true || !body.data || !Array.isArray(body.data.items)) return [];
        const valid = [];
        body.data.items.forEach((product, index) => {
          const result = validateProduct(product);
          if (result.valid) {
            valid.push(product);
          } else if (window.console && console.warn) {
            console.warn('[RobayerProducts] Skipping invalid product at index ' + index + ':', result.errors, product);
          }
        });
        return valid;
      })
      .catch(() => []);
  }

  /** Single-product fetch, by slug — publicly-listed statuses only (see routes/products.ts). Returns null for anything not found, not just a fetch failure — a caller never needs to distinguish "404" from "network error." */
  function fetchProduct(slug) {
    return fetch('/api/products/' + encodeURIComponent(slug))
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => (body && body.success === true ? body.data : null))
      .catch(() => null);
  }

  function getBySlug(products, slug) {
    return (products || []).find((p) => p.slug === slug) || null;
  }

  function getFeatured(products) {
    return (products || []).filter((p) => p.featured === true);
  }

  function getBestsellers(products) {
    return (products || []).filter((p) => p.bestseller === true);
  }

  function getNewReleases(products) {
    return (products || []).filter((p) => p.newRelease === true);
  }

  function getFree(products) {
    return (products || []).filter((p) => p.price === 0);
  }

  function isGenuinelyUpdated(product) {
    if (!product.updatedAt || !product.publishedAt) return false;
    return new Date(product.updatedAt).getTime() > new Date(product.publishedAt).getTime();
  }

  function getUpdated(products) {
    return (products || []).filter(isGenuinelyUpdated);
  }

  function getComingSoon(products) {
    return (products || []).filter((p) => p.status === 'coming-soon');
  }

  function getActive(products) {
    return (products || []).filter((p) => p.status === 'active');
  }

  // Everything a public listing page (e.g. /books/) should ever show —
  // active AND coming-soon (a real, honest "here's what's next" teaser
  // — see the .book-card--upcoming treatment), but never draft or
  // archived. Distinct from getActive(), which specifically means
  // "currently purchasable" (used for Featured/Related, where teasing
  // an unavailable item would be misleading).
  function getPubliclyListed(products) {
    return (products || []).filter((p) => p.status === 'active' || p.status === 'coming-soon');
  }

  function getByType(products, productType) {
    return (products || []).filter((p) => p.productType === productType);
  }

  function getByTopic(products, topic) {
    return (products || []).filter((p) => p.topic === topic);
  }

  function sortByDate(products, direction) {
    const dir = direction === 'asc' ? 1 : -1;
    return [...(products || [])].sort((a, b) => {
      const dateA = a.publishedDate ? new Date(a.publishedDate).getTime() : 0;
      const dateB = b.publishedDate ? new Date(b.publishedDate).getTime() : 0;
      return (dateA - dateB) * dir;
    });
  }

  function sortByPrice(products, direction) {
    const dir = direction === 'desc' ? -1 : 1;
    return [...(products || [])].sort((a, b) => ((a.price || 0) - (b.price || 0)) * dir);
  }

  function getNewest(products, limit) {
    const result = sortByDate(getActive(products), 'desc');
    return typeof limit === 'number' ? result.slice(0, limit) : result;
  }

  // Related-product ranking strategy — see file header comment and
  // docs/product-discovery-architecture.md for the full rationale.
  function getRelatedProducts(products, product, limit) {
    const max = typeof limit === 'number' ? limit : 3;
    if (!product) return [];
    // Draws from active + coming-soon (not active-only) — a
    // genuinely related "coming soon" title is an honest, useful
    // recommendation ("you might also like this, coming soon"), not
    // a misleading one. Featured/Related deliberately differ here:
    // *featuring* something unavailable would overstate it; *relating*
    // it to something the visitor is already looking at does not.
    const pool = getPubliclyListed(products).filter((p) => p.slug !== product.slug);
    const picked = [];
    const pickedSlugs = new Set();

    function addFrom(candidates) {
      for (const candidate of candidates) {
        if (picked.length >= max) return;
        if (pickedSlugs.has(candidate.slug)) continue;
        picked.push(candidate);
        pickedSlugs.add(candidate.slug);
      }
    }

    addFrom(pool.filter((p) => p.topic === product.topic));
    addFrom(pool.filter((p) => p.productType === product.productType));
    addFrom(pool.filter((p) => p.featured === true));
    // Final catch-all: anything else at all. A related-products rail
    // should degrade gracefully as the catalog grows from 2 products
    // to 50 — with very few products, topic/type/featured can all
    // legitimately match nothing (found via real testing: two
    // products with different topics, different types, and the only
    // other item not featured, would otherwise render an empty
    // section). Showing "something else in the library" beats an
    // empty "You might also like."
    addFrom(pool);

    return picked;
  }

  // Empty-state classifier — used wherever a single product is looked
  // up by slug (a future detail page, or anything using fetchProduct()
  // directly). Not yet exercised by a live dynamic route today (detail
  // pages remain hand-authored HTML per this project's established
  // content convention — see docs/product-discovery-architecture.md),
  // but the grid/related-product rendering already relies on the same
  // "state, not just data" thinking: an item that resolves to anything
  // other than 'active' is handled explicitly, never silently broken.
  function getProductPageState(product) {
    if (!product) {
      return { state: 'not-found', message: "We couldn't find that product. It may have been moved or the link may be incorrect." };
    }
    if (product.status === 'archived') {
      return { state: 'archived', message: 'This product is no longer available.' };
    }
    if (product.status === 'draft') {
      return { state: 'unavailable', message: "This product isn't available yet." };
    }
    if (product.status === 'coming-soon') {
      return { state: 'coming-soon', message: 'This product is coming soon. Check back, or subscribe to the newsletter to know the moment it launches.' };
    }
    return { state: 'active', message: null };
  }

  // The one reusable product card — matches the real, live .book-card
  // markup on /books/index.html exactly. Powers Homepage / Books /
  // future category pages / related products / search results — no
  // duplicated markup once a real page actually calls this.
  function renderCard(product) {
    const isUpcoming = product.status === 'coming-soon';
    const priceLabel = isUpcoming
      ? null
      : product.price === 0
        ? 'Free'
        : formatCurrency(product.price, product.currency);
    const href = '/books/' + product.slug + '/'; // Matches the real Books URL convention (not a placeholder /store/ route).
    const cardClasses = ['book-card'];
    if (product.featured) cardClasses.push('book-card--featured');
    if (isUpcoming) cardClasses.push('book-card--upcoming');

    // Badges come entirely from product metadata — no hardcoded labels
    // per product. See docs/product-discovery-architecture.md's "Badge
    // system" for the full precedence/co-occurrence rules.
    const badges = [];
    if (isUpcoming) badges.push('<span class="badge badge--warning mb-2">Coming soon</span>');
    if (product.newRelease) badges.push('<span class="badge badge--info mb-2">New</span>');
    if (product.bestseller) badges.push('<span class="badge badge--success mb-2">Bestseller</span>');
    if (!isUpcoming && product.price === 0) badges.push('<span class="badge badge--success mb-2">Free</span>');
    if (isGenuinelyUpdated(product)) badges.push('<span class="badge badge--info mb-2">Updated</span>');

    const cardImage = product.thumbnailImage || product.coverImage;
    const coverStyle = cardImage
      ? ' style="background-image:url(\'' + escapeHtml(cardImage) + '\');background-size:cover;background-position:center;"'
      : '';

    const cta = isUpcoming
      ? '<a href="/newsletter/" class="btn btn--secondary">Get notified</a>'
      : '<a href="' + href + '" class="btn btn--primary">Get the guide</a>';

    return (
      // data-category aliases data-topic and data-title exposes the
      // title — both purely so this card slots into the existing,
      // shared js/components/content-filters.js (pills + search)
      // without that file needing to know anything about Product
      // records specifically. data-topic/data-product-type remain the
      // "real" attribute names for anything querying by this loader's
      // own vocabulary.
      '<div class="' + cardClasses.join(' ') + '" data-topic="' + escapeHtml(product.topic || '') + '" data-product-type="' + escapeHtml(product.productType || '') + '" data-category="' + escapeHtml(product.topic || '') + '" data-title="' + escapeHtml(product.title || '') + '">' +
      '<div class="book-card__cover"' + coverStyle + '></div>' +
      badges.join('') +
      '<p class="book-card__title">' + escapeHtml(product.title) + '</p>' +
      (priceLabel ? '<p class="book-card__price">' + escapeHtml(priceLabel) + '</p>' : '') +
      (product.shortDescription ? '<p class="book-card__description">' + escapeHtml(product.shortDescription) + '</p>' : '') +
      cta +
      '</div>'
    );
  }

  // Prefers the shared formatter already used by the calculators
  // (window.RobayerCalc.formatCurrency) when it happens to be loaded
  // on the same page, but never requires it.
  function formatCurrency(amount, currency) {
    if (window.RobayerCalc && typeof window.RobayerCalc.formatCurrency === 'function' && currency === 'GHS') {
      return window.RobayerCalc.formatCurrency(amount);
    }
    const symbol = currency === 'GHS' ? 'GH₵' : (currency || '') + ' ';
    const rounded = Math.round(amount * 100) / 100;
    const withSeparators = Math.abs(rounded).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return symbol + withSeparators;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  // ---------- Auto-render for [data-product-grid] containers ----------
  // Supported filter attributes on the grid element:
  //   data-product-type="ebook"     — only this productType
  //   data-topic="investing"        — only this topic
  //   data-featured="true"          — only featured === true
  //   data-coming-soon="true"       — only status === "coming-soon"
  //   data-related-to="{slug}"      — getRelatedProducts() for that slug
  //   data-empty-message="…"        — shown (as a plain paragraph) if the
  //                                    filtered result is empty, instead
  //                                    of silently leaving old markup —
  //                                    opt-in, since a grid with no
  //                                    fallback message keeps today's
  //                                    "leave existing markup as-is" default.
  //   data-hide-section-if-empty="true" — hides the grid's closest
  //                                    <section> ancestor entirely if
  //                                    the filtered result is empty,
  //                                    for a section (e.g. a homepage
  //                                    "Coming Soon" block) that
  //                                    shouldn't show a bare heading
  //                                    over nothing. Mutually
  //                                    exclusive in effect with
  //                                    data-empty-message (hiding wins).
  function initProductGrids() {
    const grids = document.querySelectorAll('[data-product-grid]:not([data-bound])');
    if (!grids.length) return; // No storefront container on this page — no-op.

    grids.forEach((grid) => {
      grid.setAttribute('data-bound', 'true');
      const typeFilter = grid.getAttribute('data-product-type');
      const topicFilter = grid.getAttribute('data-topic');
      const featuredOnly = grid.getAttribute('data-featured') === 'true';
      const comingSoonOnly = grid.getAttribute('data-coming-soon') === 'true';
      const relatedToSlug = grid.getAttribute('data-related-to');
      const emptyMessage = grid.getAttribute('data-empty-message');
      const hideSectionIfEmpty = grid.getAttribute('data-hide-section-if-empty') === 'true';

      loadAll().then((products) => {
        let filtered;
        if (relatedToSlug) {
          const source = getBySlug(products, relatedToSlug);
          filtered = getRelatedProducts(products, source, 3);
        } else if (comingSoonOnly) {
          filtered = getComingSoon(products);
        } else {
          filtered = featuredOnly ? getFeatured(getActive(products)) : getPubliclyListed(products);
          if (typeFilter) filtered = getByType(filtered, typeFilter);
          if (topicFilter) filtered = getByTopic(filtered, topicFilter);
        }

        if (filtered.length === 0) {
          if (hideSectionIfEmpty) {
            const section = grid.closest('section');
            if (section) section.classList.add('hidden');
          } else if (emptyMessage) {
            grid.innerHTML = '<p class="text-secondary col-span-full">' + escapeHtml(emptyMessage) + '</p>';
          }
          return; // Neither opt-in — leave existing markup as-is (today's default, unchanged from Sprint 2.1).
        }
        grid.innerHTML = filtered.map(renderCard).join('');
      });
    });
  }

  // ---------- Auto-render for [data-feature-banner] slots ----------
  // A "featured product" section that keeps its exact existing markup
  // (e.g. the homepage's .feature-banner, a different layout from the
  // .book-card grid) but has its content genuinely come from the
  // Product Loader — not hand-selected. Fills [data-feature-title] /
  // [data-feature-description] / [data-feature-cta] (updates its href
  // and, if it has no other children, its text) with the first
  // getFeatured() result. If there is none, the banner's existing
  // static HTML is left completely untouched — that text doubles as
  // the honest fallback, never a blank section.
  function initFeatureBanners() {
    const banners = document.querySelectorAll('[data-feature-banner]:not([data-bound])');
    if (!banners.length) return;

    banners.forEach((banner) => {
      banner.setAttribute('data-bound', 'true');

      loadAll().then((products) => {
        const featured = getFeatured(getActive(products))[0];
        if (!featured) return; // Leave the existing static content as-is.

        const titleEl = banner.querySelector('[data-feature-title]');
        const descriptionEl = banner.querySelector('[data-feature-description]');
        const ctaEl = banner.querySelector('[data-feature-cta]');

        if (titleEl) titleEl.textContent = featured.title;
        if (descriptionEl && featured.shortDescription) descriptionEl.textContent = featured.shortDescription;
        if (ctaEl) {
          ctaEl.setAttribute('href', '/books/' + featured.slug + '/');
          const priceLabel = featured.price === 0 ? 'Free' : formatCurrency(featured.price, featured.currency);
          ctaEl.textContent = 'Get the guide: ' + priceLabel;
        }
      });
    });
  }

  document.addEventListener('partials:loaded', initProductGrids);
  document.addEventListener('DOMContentLoaded', initProductGrids);
  document.addEventListener('partials:loaded', initFeatureBanners);
  document.addEventListener('DOMContentLoaded', initFeatureBanners);

  window.RobayerProducts = {
    loadAll,
    fetchProduct,
    getBySlug,
    getFeatured,
    getBestsellers,
    getNewReleases,
    getFree,
    getUpdated,
    getComingSoon,
    getActive,
    getPubliclyListed,
    getByType,
    getByTopic,
    getNewest,
    sortByDate,
    sortByPrice,
    getRelatedProducts,
    getProductPageState,
    renderCard,
    validateProduct,
  };
})();

/**
 * Robayer WealthLab — Product Loader (Version 1.2 Sprint 1, rebuilt Sprint 2.1)
 *
 * Architecture for a future storefront, written now and wired to
 * nothing live. Not included in any page's <script> tags — there is no
 * Shop/Store page with a product grid yet, so loading this file
 * anywhere today would be dead weight. See
 * docs/product-platform-architecture.md for the full loader API and
 * how to add a real product when the time comes.
 *
 * This file has zero effect on any existing page even if it were
 * mistakenly included, because:
 *   - the grid auto-render only ever acts on [data-product-grid],
 *     which doesn't exist anywhere in the current site, and
 *   - content/products/index.json is a real, empty [] today, so even
 *     a page that did add the container would render nothing rather
 *     than break.
 *
 * No Paystack code here. This loader only reads and renders product
 * *content* — price, cover, description. A future storefront wires
 * "Buy" buttons to Paystack separately (see docs/paystack-integration.md).
 *
 * Public API (window.RobayerProducts):
 *   loadAll()                          -> Promise<Product[]>  (valid products only, invalid entries dropped + warned)
 *   fetchProduct(slug)                 -> Promise<Product|null>  (single-file fetch, for a future detail page)
 *   getBySlug(products, slug)          -> Product|null
 *   getFeatured(products)              -> Product[]
 *   getBestsellers(products)           -> Product[]
 *   getNewReleases(products)           -> Product[]
 *   getActive(products)                -> Product[]
 *   getByType(products, productType)   -> Product[]
 *   getByTopic(products, topic)        -> Product[]
 *   sortByDate(products, direction)    -> Product[]  (direction: 'desc' default, or 'asc')
 *   sortByPrice(products, direction)   -> Product[]  (direction: 'asc' default, or 'desc')
 *   renderCard(product)                -> HTML string (the one reusable product card)
 *   validateProduct(product)           -> { valid: boolean, errors: string[] }
 */

(function () {
  const REQUIRED_FIELDS = ['id', 'slug', 'title', 'productType', 'status', 'price', 'currency'];

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
    if (product.status && !['draft', 'active', 'archived', 'coming-soon'].includes(product.status)) {
      errors.push('Invalid status: ' + product.status);
    }
    return { valid: errors.length === 0, errors };
  }

  function fetchProduct(slug) {
    return fetch('/content/products/' + slug + '.json')
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }

  function loadAll() {
    return fetch('/content/products/index.json')
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load product registry.');
        return response.json();
      })
      .then((slugs) => {
        if (!Array.isArray(slugs) || slugs.length === 0) return [];
        return Promise.all(slugs.map(fetchProduct));
      })
      .then((products) => {
        const valid = [];
        products.forEach((product, index) => {
          if (!product) return; // fetch failed for this slug — skip silently, matches honest-failure pattern elsewhere
          const result = validateProduct(product);
          if (result.valid) {
            valid.push(product);
          } else if (window.console && console.warn) {
            console.warn('[RobayerProducts] Skipping invalid product at index ' + index + ':', result.errors, product);
          }
        });
        return valid;
      })
      .catch(() => []); // Registry fetch itself failed — honest empty result, not a thrown error a caller must remember to catch.
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

  function getActive(products) {
    return (products || []).filter((p) => p.status === 'active');
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

  // The one reusable product card — matches the REAL, already-live
  // .book-card markup on /books/index.html exactly (not .resource-card,
  // which Sprint 1's original version incorrectly generated without
  // checking the actual live page). Powers Homepage / Books / future
  // category pages / related products / search results — no duplicated
  // markup once a real page actually calls this.
  function renderCard(product) {
    const priceLabel = product.price === 0 ? 'Free' : formatCurrency(product.price, product.currency);
    const href = '/store/' + product.slug + '/'; // Placeholder route — no /store/ page exists yet.
    const isUpcoming = product.status === 'coming-soon';
    const cardClasses = ['book-card'];
    if (product.featured) cardClasses.push('book-card--featured');
    if (isUpcoming) cardClasses.push('book-card--upcoming');

    const badges = [];
    if (isUpcoming) badges.push('<span class="badge badge--warning mb-2">Coming soon</span>');
    if (product.newRelease) badges.push('<span class="badge badge--info mb-2">New</span>');
    if (product.bestseller) badges.push('<span class="badge badge--success mb-2">Bestseller</span>');

    const coverStyle = product.thumbnail
      ? ' style="background-image:url(\'' + escapeHtml(product.thumbnail) + '\');background-size:cover;background-position:center;"'
      : '';

    const cta = isUpcoming
      ? '<a href="/newsletter/" class="btn btn--secondary">Get notified</a>'
      : '<a href="' + href + '" class="btn btn--primary">Get the guide</a>';

    return (
      '<div class="' + cardClasses.join(' ') + '" data-topic="' + escapeHtml(product.topic || '') + '" data-product-type="' + escapeHtml(product.productType || '') + '">' +
      '<div class="book-card__cover"' + coverStyle + '></div>' +
      badges.join('') +
      '<p class="book-card__title">' + escapeHtml(product.title) + '</p>' +
      '<p class="book-card__price">' + escapeHtml(priceLabel) + '</p>' +
      (product.shortDescription ? '<p class="book-card__description">' + escapeHtml(product.shortDescription) + '</p>' : '') +
      cta +
      '</div>'
    );
  }

  // Prefers the shared formatter already used by the calculators
  // (window.RobayerCalc.formatCurrency) when it happens to be loaded
  // on the same page, but never requires it — a future Store page may
  // not load calculator-utils.js at all.
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

  // ---------- Optional auto-render for a future [data-product-grid] container ----------
  function initProductGrids() {
    const grids = document.querySelectorAll('[data-product-grid]:not([data-bound])');
    if (!grids.length) return; // No storefront container on this page — no-op, exactly like today.

    grids.forEach((grid) => {
      grid.setAttribute('data-bound', 'true');
      const typeFilter = grid.getAttribute('data-product-type');
      const topicFilter = grid.getAttribute('data-topic');

      loadAll().then((products) => {
        let filtered = getActive(products);
        if (typeFilter) filtered = getByType(filtered, typeFilter);
        if (topicFilter) filtered = getByTopic(filtered, topicFilter);
        if (filtered.length === 0) return; // No published products (or none matching) — leave existing markup as-is.
        grid.innerHTML = filtered.map(renderCard).join('');
      });
    });
  }

  document.addEventListener('partials:loaded', initProductGrids);
  document.addEventListener('DOMContentLoaded', initProductGrids);

  window.RobayerProducts = {
    loadAll,
    fetchProduct,
    getBySlug,
    getFeatured,
    getBestsellers,
    getNewReleases,
    getActive,
    getByType,
    getByTopic,
    sortByDate,
    sortByPrice,
    renderCard,
    validateProduct,
  };
})();

/**
 * Robayer WealthLab: Affiliate Resources Component. Drives
 * affiliate/resources/index.html: the admin-curated marketing
 * materials library (product kits plus ready-to-use copy: WhatsApp,
 * Facebook, TikTok, Instagram, LinkedIn, short hooks).
 *
 * Resources are grouped by product_slug (affiliate_resources.product_slug,
 * see affiliateResourceService.ts). Product facts (cover, title,
 * description) come from window.RobayerProducts, never duplicated into
 * affiliate_resources itself. Referral links use the one canonical
 * window.RobayerAffiliate.buildUrl() (js/components/affiliate-shared.js)
 * with the viewer's own affiliateCode, fetched fresh from
 * GET /api/customer/affiliates/me, never a hardcoded or shared code.
 * Any `{{link}}` token inside a resource's body is substituted with
 * that generated URL before display, so an affiliate never has to
 * construct or paste a link by hand.
 *
 * Product filtering reuses the existing generic content-filters.js
 * (.filter-pill / [data-filter-grid] / data-category), no new
 * filtering logic. Pills are generated dynamically from whichever
 * product_slugs are actually present in the fetched resources, so a
 * future third product needs no frontend change, only more seeded rows.
 */

const CATEGORY_LABELS = {
  social_caption: 'Social Caption',
  script: 'Script',
  message_template: 'Message Template',
  product_copy: 'Promotional Kit',
  image: 'Image',
  guidance: 'Hook',
};

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/** Substitutes a literal `{{link}}` token in a resource body with this viewer's real referral URL for that resource's product (or the homepage, if the resource isn't tied to one). A resource with no token is returned unchanged. */
function personalize(body, affiliateCode, productSlug) {
  if (!body) return body;
  const url = window.RobayerAffiliate.buildUrl(affiliateCode, productSlug || 'homepage');
  return body.replace(/\{\{link\}\}/g, url);
}

function renderCopyCard(resource, affiliateCode) {
  const card = document.createElement('div');
  card.className = 'card mb-3';
  card.setAttribute('data-category', resource.productSlug || 'general');
  card.setAttribute('data-title', resource.title);

  const bodyText = personalize(resource.body, affiliateCode, resource.productSlug);
  const bodyHtml = bodyText ? `<p class="text-secondary" style="white-space:pre-wrap;">${escapeHtml(bodyText)}</p>` : '';
  const imageHtml = resource.mediaUrl ? `<img src="${escapeHtml(resource.mediaUrl)}" alt="${escapeHtml(resource.title)}" style="max-width:100%;border-radius:var(--radius-sm);margin-bottom:var(--space-2);">` : '';

  card.innerHTML = `
    <span class="badge badge--info mb-2">${escapeHtml(CATEGORY_LABELS[resource.category] || resource.category)}</span>
    <h3 class="mt-0 mb-2">${escapeHtml(resource.title)}</h3>
    ${imageHtml}
    ${bodyHtml}
    ${bodyText ? '<button type="button" class="btn btn--secondary">Copy text</button>' : ''}
  `;
  if (bodyText) {
    card.querySelector('button').addEventListener('click', (event) => window.RobayerAffiliate.copyToClipboard(bodyText, event.target));
  }
  return card;
}

/** The enriched product-kit card: product cover/title/description from RobayerProducts, the kit resource's own "who it's for / selling points / angle" body, and a ready referral link with its own Copy button. */
function renderKitCard(kitResource, product, affiliateCode) {
  const slug = kitResource.productSlug;
  const card = document.createElement('div');
  card.className = 'card mb-3';
  card.setAttribute('data-category', slug || 'general');
  card.setAttribute('data-title', (product && product.title) || kitResource.title);

  const title = (product && product.title) || kitResource.title;
  const description = product && product.shortDescription ? `<p class="text-secondary mb-3">${escapeHtml(product.shortDescription)}</p>` : '';
  const coverSrc = product && (product.coverImage || product.thumbnailImage);
  const coverHtml = coverSrc
    ? `<img src="${escapeHtml(coverSrc)}" alt="${escapeHtml(title)}" style="max-width:160px;width:100%;border-radius:var(--radius-sm);margin-bottom:var(--space-3);">`
    : '';
  const kitBodyHtml = kitResource.body ? `<p class="text-secondary" style="white-space:pre-wrap;">${escapeHtml(kitResource.body)}</p>` : '';
  const referralUrl = window.RobayerAffiliate.buildUrl(affiliateCode, slug || 'homepage');

  card.innerHTML = `
    <span class="badge badge--success mb-2">Promotional Kit</span>
    ${coverHtml}
    <h2 class="mt-0 mb-2">${escapeHtml(title)}</h2>
    ${description}
    ${kitBodyHtml}
    <div class="field mb-3">
      <span class="field__label">Your referral link for this product</span>
      <p class="text-mono" data-kit-referral-url style="word-break:break-all;">${escapeHtml(referralUrl)}</p>
    </div>
    <button type="button" class="btn btn--accent" data-kit-copy-btn>Get my referral link</button>
  `;
  card.querySelector('[data-kit-copy-btn]').addEventListener('click', (event) => window.RobayerAffiliate.copyToClipboard(referralUrl, event.target));
  return card;
}

function renderFilterPills(container, groups, products) {
  container.innerHTML = '';
  const allPill = document.createElement('button');
  allPill.type = 'button';
  allPill.className = 'filter-pill';
  allPill.setAttribute('data-filter', 'all');
  allPill.setAttribute('aria-pressed', 'true');
  allPill.textContent = 'All';
  container.appendChild(allPill);

  groups.forEach((resources, slug) => {
    if (slug === 'general') return;
    const product = window.RobayerProducts.getBySlug(products, slug);
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'filter-pill';
    pill.setAttribute('data-filter', slug);
    pill.setAttribute('aria-pressed', 'false');
    pill.textContent = (product && product.title) || slug;
    container.appendChild(pill);
  });

  if (groups.has('general')) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'filter-pill';
    pill.setAttribute('data-filter', 'general');
    pill.setAttribute('aria-pressed', 'false');
    pill.textContent = 'General';
    container.appendChild(pill);
  }
}

async function initAffiliateResources() {
  const root = document.querySelector('[data-affiliate-resources-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-affiliate-resources-loading]');
  const errorEl = document.querySelector('[data-affiliate-resources-error]');
  const listEl = document.querySelector('[data-affiliate-resources-list]');
  const emptyEl = document.querySelector('[data-affiliate-resources-empty]');
  const filtersEl = document.querySelector('[data-affiliate-resources-filters]');
  const disclosureEl = document.querySelector('[data-affiliate-disclosure]');

  let affiliateCode;
  try {
    const profile = await window.CustomerDashboard.customerFetch('/api/customer/affiliates/me');
    if (profile.status !== 'approved') {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = 'Your affiliate application needs to be approved before you can access marketing resources.';
      return;
    }
    affiliateCode = profile.affiliateCode;
  } catch (error) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = error.message || 'Could not load your affiliate profile.';
    return;
  }

  try {
    const [result, products] = await Promise.all([
      window.CustomerDashboard.customerFetch('/api/customer/affiliates/resources'),
      window.RobayerProducts.loadAll().catch(() => []),
    ]);
    loadingEl.hidden = true;
    root.hidden = false;

    if (!result.resources.length) {
      emptyEl.hidden = false;
      return;
    }
    if (disclosureEl) disclosureEl.hidden = false;

    // Group in first-seen order (resources already arrive sorted by
    // sort_order ASC from listPublishedResources(), so a product's kit
    // row precedes its own copy variants within its group).
    const groups = new Map();
    result.resources.forEach((resource) => {
      const key = resource.productSlug || 'general';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(resource);
    });

    if (filtersEl) renderFilterPills(filtersEl, groups, products);

    groups.forEach((resources, slug) => {
      const product = slug === 'general' ? null : window.RobayerProducts.getBySlug(products, slug);
      resources.forEach((resource) => {
        const card = resource.category === 'product_copy'
          ? renderKitCard(resource, product, affiliateCode)
          : renderCopyCard(resource, affiliateCode);
        listEl.appendChild(card);
      });
    });
  } catch (error) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = error.message || 'Could not load resources.';
  }
}

document.addEventListener('dashboard:ready', initAffiliateResources);

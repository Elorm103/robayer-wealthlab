/**
 * Robayer WealthLab: Affiliate Resources Component. Drives
 * affiliate/resources/index.html: the admin-curated marketing
 * materials library (captions, scripts, product copy, images).
 */

const CATEGORY_LABELS = {
  social_caption: 'Social Caption',
  script: 'Script',
  message_template: 'Message Template',
  product_copy: 'Product Copy',
  image: 'Image',
  guidance: 'Guidance',
};

function copyText(text, button) {
  const defaultLabel = button.textContent;
  const done = () => {
    button.textContent = 'Copied!';
    window.setTimeout(() => {
      button.textContent = defaultLabel;
    }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  }
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

async function initAffiliateResources() {
  const root = document.querySelector('[data-affiliate-resources-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-affiliate-resources-loading]');
  const errorEl = document.querySelector('[data-affiliate-resources-error]');
  const listEl = document.querySelector('[data-affiliate-resources-list]');
  const emptyEl = document.querySelector('[data-affiliate-resources-empty]');

  try {
    const result = await window.CustomerDashboard.customerFetch('/api/customer/affiliates/resources');
    loadingEl.hidden = true;
    root.hidden = false;

    if (!result.resources.length) {
      emptyEl.hidden = false;
      return;
    }

    result.resources.forEach((resource) => {
      const card = document.createElement('div');
      card.className = 'card mb-3';
      const bodyHtml = resource.body ? `<p class="text-secondary" style="white-space:pre-wrap;">${escapeHtml(resource.body)}</p>` : '';
      const imageHtml = resource.mediaUrl ? `<img src="${resource.mediaUrl}" alt="${escapeHtml(resource.title)}" style="max-width:100%;border-radius:var(--radius-sm);margin-bottom:var(--space-2);">` : '';
      card.innerHTML = `
        <span class="badge badge--info mb-2">${CATEGORY_LABELS[resource.category] || resource.category}</span>
        <h3 class="mt-0 mb-2">${escapeHtml(resource.title)}</h3>
        ${imageHtml}
        ${bodyHtml}
        ${resource.body ? '<button type="button" class="btn btn--secondary">Copy text</button>' : ''}
      `;
      if (resource.body) {
        card.querySelector('button').addEventListener('click', (event) => copyText(resource.body, event.target));
      }
      listEl.appendChild(card);
    });
  } catch (error) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = error.message || 'Could not load resources.';
  }
}

document.addEventListener('dashboard:ready', initAffiliateResources);

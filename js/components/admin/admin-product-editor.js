/**
 * Robayer WealthLab — Product editor (create + edit), Version 2.0
 * Phase 2 (Products Module).
 *
 * Drives both admin/products/new/index.html and
 * admin/products/edit/index.html — nearly identical markup (this
 * codebase's established "duplicate static HTML per page" convention,
 * already used for every hand-authored book detail page), distinguished
 * only by `data-product-editor-mode` and, for edit, a `?id=` query
 * param. GitHub Pages has no server-side dynamic routing for a literal
 * `/admin/products/:id/edit/` path, so the id travels as a query
 * string instead — the same pattern this codebase already uses for
 * `js/components/fulfilment-status.js`'s `?ref=`.
 *
 * Runs after admin-shell.js's `requireSession()` gate, matching every
 * other admin module script here.
 */

const PRODUCTS_API_BASE = '/api/admin/products';
const MEDIA_API_BASE = '/api/admin/media';

function initProductEditor() {
  const root = document.querySelector('[data-product-editor-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const initialMode = root.getAttribute('data-product-editor-mode');
  const idParam = new URLSearchParams(window.location.search).get('id');
  const parsedId = idParam ? parseInt(idParam, 10) : null;

  const state = {
    mode: initialMode === 'edit' && Number.isInteger(parsedId) ? 'edit' : 'new',
    id: initialMode === 'edit' && Number.isInteger(parsedId) ? parsedId : null,
    mediaRefs: { cover: null, thumbnail: null, preview: null, og: null },
    files: [],
    gallery: [],
    relations: [],
  };

  const els = {
    loadError: root.querySelector('[data-editor-load-error]'),
    saveSuccess: root.querySelector('[data-editor-save-success]'),

    title: root.querySelector('[data-pe-title]'),
    slug: root.querySelector('[data-pe-slug]'),
    subtitle: root.querySelector('[data-pe-subtitle]'),
    shortDescription: root.querySelector('[data-pe-short-description]'),
    topic: root.querySelector('[data-pe-topic]'),
    productType: root.querySelector('[data-pe-product-type]'),
    author: root.querySelector('[data-pe-author]'),
    language: root.querySelector('[data-pe-language]'),
    version: root.querySelector('[data-pe-version]'),
    readingTime: root.querySelector('[data-pe-reading-time]'),

    rtToolbar: root.querySelector('[data-rt-toolbar]'),
    rtEditor: root.querySelector('[data-rt-editor]'),

    price: root.querySelector('[data-pe-price]'),
    comparePrice: root.querySelector('[data-pe-compare-price]'),
    taxBehavior: root.querySelector('[data-pe-tax-behavior]'),
    sku: root.querySelector('[data-pe-sku]'),

    filesList: root.querySelector('[data-pe-files-list]'),
    addFileButton: root.querySelector('[data-pe-add-file]'),
    filesHint: root.querySelector('[data-pe-files-hint]'),

    galleryList: root.querySelector('[data-pe-gallery-list]'),
    addGalleryButton: root.querySelector('[data-pe-add-gallery-image]'),
    galleryHint: root.querySelector('[data-pe-gallery-hint]'),

    seoTitle: root.querySelector('[data-pe-seo-title]'),
    seoDescription: root.querySelector('[data-pe-seo-description]'),
    seoCanonical: root.querySelector('[data-pe-seo-canonical]'),

    relationSearch: root.querySelector('[data-pe-relation-search]'),
    relationResults: root.querySelector('[data-pe-relation-results]'),
    relationsList: root.querySelector('[data-pe-relations-list]'),

    tags: root.querySelector('[data-pe-tags]'),
    featured: root.querySelector('[data-pe-featured]'),
    bestseller: root.querySelector('[data-pe-bestseller]'),
    newRelease: root.querySelector('[data-pe-new-release]'),
    maxDownloads: root.querySelector('[data-pe-max-downloads]'),
    downloadExpires: root.querySelector('[data-pe-download-expires]'),

    statusBadge: root.querySelector('[data-pe-status-badge]'),
    status: root.querySelector('[data-pe-status]'),
    saveButton: root.querySelector('[data-pe-save]'),
    savedAt: root.querySelector('[data-pe-saved-at]'),

    livePreviewCover: root.querySelector('[data-pe-live-cover]'),
    livePreviewTopic: root.querySelector('[data-pe-live-topic]'),
    livePreviewTitle: root.querySelector('[data-pe-live-title]'),
    livePreviewSubtitle: root.querySelector('[data-pe-live-subtitle]'),
    livePreviewPrice: root.querySelector('[data-pe-live-price]'),

    dangerZone: root.querySelector('[data-pe-danger-zone]'),
    duplicateButton: root.querySelector('[data-pe-duplicate]'),
    deleteButton: root.querySelector('[data-pe-delete]'),
  };

  const mediaPickerModal = document.querySelector('[data-media-picker-modal]');
  const deleteModal = document.querySelector('[data-pe-delete-modal]');

  bindStaticControls();
  bindRichText();
  bindMediaRefPickers();
  bindFileSection();
  bindGallerySection();
  bindRelationsSection();
  bindSeoCharCounters();
  bindLivePreviewListeners();
  bindSave();
  bindDangerZone();
  bindModalShells();

  loadMeta().then(() => {
    if (state.mode === 'edit') {
      loadProduct(state.id);
    } else {
      updateModeUi();
      updateLivePreview();
    }
  });

  // ============================================================
  // Meta
  // ============================================================

  async function loadMeta() {
    try {
      const meta = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/meta`);
      populateSelect(els.topic, meta.topics);
      populateSelect(els.productType, meta.productTypes);
      populateSelect(els.status, meta.statuses);
      els.status.value = 'draft';
    } catch (error) {
      showLoadError(error.message || 'Could not load form options.');
    }
  }

  function populateSelect(select, values) {
    select.innerHTML = '';
    values.forEach((value) => select.appendChild(new Option(labelize(value), value)));
  }

  function labelize(value) {
    return value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ============================================================
  // Load (edit mode)
  // ============================================================

  async function loadProduct(id) {
    try {
      const product = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${id}`);
      applyProductToForm(product);
    } catch (error) {
      showLoadError(error.message || 'Could not load this product.');
    }
  }

  function applyProductToForm(product) {
    state.id = product.id;
    state.mode = 'edit';

    els.title.value = product.title || '';
    els.slug.value = product.slug || '';
    els.subtitle.value = product.subtitle || '';
    els.shortDescription.value = product.shortDescription || '';
    els.rtEditor.innerHTML = product.description || '';
    els.topic.value = product.topic;
    els.productType.value = product.productType;
    els.author.value = product.author || '';
    els.language.value = product.language || 'en';
    els.version.value = product.version || '';
    els.readingTime.value = product.estimatedReadingTime ?? '';

    els.price.value = product.price ?? '';
    els.comparePrice.value = product.compareAtPrice ?? '';
    els.taxBehavior.value = product.taxBehavior || 'inclusive';
    els.sku.value = product.sku || '';

    els.seoTitle.value = product.seoTitle || '';
    els.seoDescription.value = product.seoDescription || '';
    els.seoCanonical.value = product.seoCanonicalUrl || '';
    updateCharCount('seoTitle');
    updateCharCount('seoDescription');

    els.tags.value = product.tags || '';
    els.featured.checked = Boolean(product.featured);
    els.bestseller.checked = Boolean(product.bestseller);
    els.newRelease.checked = Boolean(product.newRelease);
    els.maxDownloads.value = product.maxDownloads ?? '';
    els.downloadExpires.value = product.downloadExpiresDays ?? '';

    els.status.value = product.status;

    state.mediaRefs.cover = product.coverMediaId ? { mediaId: product.coverMediaId, publicUrl: product.coverPublicUrl } : null;
    state.mediaRefs.thumbnail = product.thumbnailMediaId ? { mediaId: product.thumbnailMediaId, publicUrl: product.thumbnailPublicUrl } : null;
    state.mediaRefs.preview = product.previewMediaId ? { mediaId: product.previewMediaId, publicUrl: product.previewPublicUrl } : null;
    state.mediaRefs.og = product.ogMediaId ? { mediaId: product.ogMediaId, publicUrl: product.ogPublicUrl } : null;
    renderMediaRef('cover');
    renderMediaRef('thumbnail');
    renderMediaRef('preview');
    renderMediaRef('og');

    state.files = product.files.map((f) => ({ ...f }));
    state.gallery = product.gallery.map((g) => ({ ...g }));
    state.relations = product.relations.map((r) => ({ ...r }));
    renderFilesList();
    renderGalleryList();
    renderRelationsList();

    updateModeUi();
    updateStatusBadge(product.status, product.deletedAt);
    updateLivePreview();
  }

  function updateModeUi() {
    const isEdit = state.mode === 'edit';
    els.filesHint.hidden = isEdit;
    els.galleryHint.hidden = isEdit;
    els.addFileButton.hidden = !isEdit;
    els.addGalleryButton.hidden = !isEdit;
    els.dangerZone.hidden = !isEdit;
    els.saveButton.textContent = isEdit ? 'Save changes' : 'Create product';
  }

  // ============================================================
  // Basic fields
  // ============================================================

  function bindStaticControls() {
    let slugManuallyEdited = false;
    els.slug.addEventListener('input', () => {
      slugManuallyEdited = true;
    });
    els.title.addEventListener('blur', () => {
      if (state.mode === 'new' && !slugManuallyEdited && els.title.value.trim() && !els.slug.value.trim()) {
        els.slug.value = slugify(els.title.value);
      }
    });
  }

  function slugify(value) {
    return value
      .toLowerCase()
      .trim()
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100);
  }

  // ============================================================
  // Rich text editor — lightweight, contenteditable + document.execCommand.
  // No framework, matching the Phase 2 brief's explicit requirement.
  // ============================================================

  const RICHTEXT_ALLOWED_TAGS = new Set(['P', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'A', 'IMG', 'BR', 'DIV']);

  function bindRichText() {
    // Paste-as-plain-text: a contenteditable region otherwise accepts
    // arbitrary pasted HTML (styles, event-handler attributes, even
    // <script> in some browsers) straight from the clipboard. Since
    // this field's saved HTML is rendered on the *public* product page
    // (routes/products.ts) for every site visitor — not just shown
    // back to this admin — an admin pasting from an untrusted source
    // could otherwise introduce stored XSS against every visitor.
    // Combined with sanitizeRichText() below (a second, independent
    // layer applied at save time) rather than relying on paste
    // handling alone.
    els.rtEditor.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    els.rtToolbar.querySelectorAll('[data-rt-cmd]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the editor's selection intact
      button.addEventListener('click', () => {
        const cmd = button.getAttribute('data-rt-cmd');
        els.rtEditor.focus();
        if (cmd === 'link') {
          const url = window.prompt('Link URL:'); // eslint-disable-line no-alert -- no rich dialog component exists yet
          if (url) document.execCommand('createLink', false, url);
        } else if (cmd === 'image') {
          openMediaPicker('image', (item) => {
            els.rtEditor.focus();
            const img = document.createElement('img');
            img.src = item.publicUrl;
            img.alt = item.altText || '';
            insertNodeAtSelection(img);
          });
        } else if (cmd === 'code') {
          wrapSelectionInCode();
        } else {
          const value = button.getAttribute('data-rt-value');
          document.execCommand(cmd, false, value || undefined);
        }
        updateLivePreview();
      });
    });

    els.rtEditor.addEventListener('input', updateLivePreview);
  }

  function insertNodeAtSelection(node) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      els.rtEditor.appendChild(node);
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function wrapSelectionInCode() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const code = document.createElement('code');
    try {
      range.surroundContents(code);
    } catch {
      // A selection spanning multiple block elements can't be wrapped
      // by surroundContents() (DOM spec restriction) — silently no-op
      // rather than throwing, matching this codebase's "drop invalid,
      // don't break everything" posture for best-effort UI actions.
    }
  }

  /**
   * Strict allowlist sanitizer, applied to the rich text editor's HTML
   * right before it's sent to the server — a second, independent layer
   * beyond the paste handler above (defense in depth: this also catches
   * anything the toolbar's own execCommand calls could produce that
   * isn't on the allowlist, e.g. a pasted image with a data: URL, or a
   * browser-specific execCommand quirk). Unknown elements are unwrapped
   * (their children kept, the wrapping tag removed) rather than deleted
   * outright, so a stray <span> from a formatBlock quirk doesn't eat
   * real content. Only href/src/alt survive on the elements that need
   * them; every other attribute (style, on*, class) is stripped.
   */
  function sanitizeRichText(html) {
    const container = document.createElement('div');
    container.innerHTML = html;
    sanitizeNode(container);
    return container.innerHTML;
  }

  function sanitizeNode(parent) {
    Array.from(parent.childNodes).forEach((child) => {
      if (child.nodeType === Node.COMMENT_NODE) {
        parent.removeChild(child);
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (!RICHTEXT_ALLOWED_TAGS.has(child.tagName)) {
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        parent.removeChild(child);
        return;
      }
      Array.from(child.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const keep = (child.tagName === 'A' && name === 'href') || (child.tagName === 'IMG' && (name === 'src' || name === 'alt'));
        if (!keep) child.removeAttribute(attr.name);
      });
      if (child.tagName === 'A') {
        const href = child.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(href) && !href.startsWith('/')) child.removeAttribute('href');
        else {
          child.setAttribute('rel', 'noopener noreferrer');
          child.setAttribute('target', '_blank');
        }
      }
      if (child.tagName === 'IMG') {
        const src = child.getAttribute('src') || '';
        if (!/^https?:\/\//i.test(src) && !src.startsWith('/')) child.remove();
      }
      sanitizeNode(child);
    });
  }

  // ============================================================
  // Media reference pickers (cover / thumbnail / preview / OG)
  // ============================================================

  function bindMediaRefPickers() {
    root.querySelectorAll('[data-pe-media-choose]').forEach((button) => {
      const slot = button.getAttribute('data-pe-media-choose');
      button.addEventListener('click', () => {
        openMediaPicker('image', (item) => {
          state.mediaRefs[slot] = { mediaId: item.id, publicUrl: item.publicUrl };
          renderMediaRef(slot);
          updateLivePreview();
        });
      });
    });
    root.querySelectorAll('[data-pe-media-remove]').forEach((button) => {
      const slot = button.getAttribute('data-pe-media-remove');
      button.addEventListener('click', () => {
        state.mediaRefs[slot] = null;
        renderMediaRef(slot);
        updateLivePreview();
      });
    });
  }

  function renderMediaRef(slot) {
    const preview = root.querySelector(`[data-pe-media-ref="${slot}"]`);
    const removeButton = root.querySelector(`[data-pe-media-remove="${slot}"]`);
    const ref = state.mediaRefs[slot];
    preview.innerHTML = '';
    if (ref) {
      const img = document.createElement('img');
      img.src = ref.publicUrl;
      img.alt = '';
      preview.appendChild(img);
      removeButton.hidden = false;
    } else {
      removeButton.hidden = true;
    }
  }

  // ============================================================
  // Files
  // ============================================================

  function bindFileSection() {
    els.addFileButton.addEventListener('click', () => {
      if (state.mode !== 'edit') return;
      openMediaPicker(null, (item) => {
        state.files.push({
          assetId: null,
          mediaId: item.id,
          displayName: item.title || item.originalFilename,
          fileType: (item.originalFilename.split('.').pop() || 'FILE').toUpperCase(),
          version: null,
          status: 'draft',
          publicUrl: item.publicUrl,
        });
        renderFilesList();
      });
    });
  }

  function renderFilesList() {
    els.filesList.innerHTML = '';
    state.files.forEach((file, index) => {
      const row = document.createElement('div');
      row.className = 'editor-list-row';

      const icon = document.createElement('span');
      icon.className = 'editor-list-row__thumb';
      icon.innerHTML = '<svg class="icon" width="40" height="40" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

      const info = document.createElement('div');
      info.className = 'editor-list-row__info';
      const title = document.createElement('p');
      title.className = 'editor-list-row__title';
      title.textContent = file.displayName;
      const meta = document.createElement('p');
      meta.className = 'editor-list-row__meta';
      meta.textContent = `${file.fileType}${file.version ? ` · v${file.version}` : ''} · ${file.status}`;
      info.append(title, meta);

      const statusSelect = document.createElement('select');
      statusSelect.className = 'field__select';
      statusSelect.style.minHeight = '36px';
      ['draft', 'published', 'archived'].forEach((s) => statusSelect.appendChild(new Option(labelize(s), s, false, s === file.status)));
      statusSelect.addEventListener('change', () => {
        state.files[index].status = statusSelect.value;
        renderFilesList();
      });

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'btn btn--secondary';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => {
        state.files.splice(index, 1);
        renderFilesList();
      });

      row.append(icon, info, statusSelect, removeButton);
      els.filesList.appendChild(row);
    });
  }

  // ============================================================
  // Gallery
  // ============================================================

  function bindGallerySection() {
    els.addGalleryButton.addEventListener('click', () => {
      if (state.mode !== 'edit') return;
      openMediaPicker('image', (item) => {
        if (state.gallery.some((g) => g.mediaId === item.id)) return;
        state.gallery.push({ mediaId: item.id, publicUrl: item.publicUrl, thumbnailPublicUrl: item.thumbnailPublicUrl });
        renderGalleryList();
      });
    });
  }

  function renderGalleryList() {
    els.galleryList.innerHTML = '';
    state.gallery.forEach((image, index) => {
      const row = document.createElement('div');
      row.className = 'editor-list-row';

      const thumb = document.createElement('img');
      thumb.className = 'editor-list-row__thumb';
      thumb.src = image.thumbnailPublicUrl || image.publicUrl;
      thumb.alt = '';

      const info = document.createElement('div');
      info.className = 'editor-list-row__info';
      const meta = document.createElement('p');
      meta.className = 'editor-list-row__meta';
      meta.textContent = `Gallery image ${index + 1}`;
      info.appendChild(meta);

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'btn btn--secondary';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => {
        state.gallery.splice(index, 1);
        renderGalleryList();
      });

      row.append(thumb, info, removeButton);
      els.galleryList.appendChild(row);
    });
  }

  // ============================================================
  // Relations
  // ============================================================

  const RELATION_TYPE_LABELS = { related: 'Related', cross_sell: 'Cross-sell', recommended: 'Recommended' };

  function bindRelationsSection() {
    let searchTimer = null;
    els.relationSearch.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      const query = els.relationSearch.value.trim();
      if (!query) {
        els.relationResults.hidden = true;
        return;
      }
      searchTimer = window.setTimeout(() => runRelationSearch(query), 300);
    });

    document.addEventListener('click', (event) => {
      if (!els.relationResults.contains(event.target) && event.target !== els.relationSearch) {
        els.relationResults.hidden = true;
      }
    });
  }

  async function runRelationSearch(query) {
    try {
      const result = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}?search=${encodeURIComponent(query)}&pageSize=8`);
      const existingIds = new Set(state.relations.map((r) => r.relatedProductId));
      const items = result.items.filter((item) => item.id !== state.id && !existingIds.has(item.id));
      els.relationResults.innerHTML = '';
      if (items.length === 0) {
        els.relationResults.hidden = true;
        return;
      }
      items.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'relation-search__result';
        button.textContent = `${item.title} (${item.slug})`;
        button.addEventListener('click', () => {
          state.relations.push({ relatedProductId: item.id, relatedProductSlug: item.slug, relatedProductTitle: item.title, relationType: 'related' });
          renderRelationsList();
          els.relationSearch.value = '';
          els.relationResults.hidden = true;
        });
        els.relationResults.appendChild(button);
      });
      els.relationResults.hidden = false;
    } catch {
      els.relationResults.hidden = true;
    }
  }

  function renderRelationsList() {
    els.relationsList.innerHTML = '';
    state.relations.forEach((relation, index) => {
      const row = document.createElement('div');
      row.className = 'editor-list-row';

      const info = document.createElement('div');
      info.className = 'editor-list-row__info';
      const title = document.createElement('p');
      title.className = 'editor-list-row__title';
      title.textContent = relation.relatedProductTitle;
      const meta = document.createElement('p');
      meta.className = 'editor-list-row__meta';
      meta.textContent = relation.relatedProductSlug;
      info.append(title, meta);

      const typeSelect = document.createElement('select');
      typeSelect.className = 'field__select';
      typeSelect.style.minHeight = '36px';
      Object.entries(RELATION_TYPE_LABELS).forEach(([value, label]) => {
        typeSelect.appendChild(new Option(label, value, false, value === relation.relationType));
      });
      typeSelect.addEventListener('change', () => {
        state.relations[index].relationType = typeSelect.value;
      });

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'btn btn--secondary';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => {
        state.relations.splice(index, 1);
        renderRelationsList();
      });

      row.append(info, typeSelect, removeButton);
      els.relationsList.appendChild(row);
    });
  }

  // ============================================================
  // SEO char counters
  // ============================================================

  const SEO_LIMITS = { seoTitle: 70, seoDescription: 160 };

  function bindSeoCharCounters() {
    els.seoTitle.addEventListener('input', () => updateCharCount('seoTitle'));
    els.seoDescription.addEventListener('input', () => updateCharCount('seoDescription'));
  }

  function updateCharCount(field) {
    const input = field === 'seoTitle' ? els.seoTitle : els.seoDescription;
    const counter = root.querySelector(`[data-pe-char-count="${field}"]`);
    const limit = SEO_LIMITS[field];
    const length = input.value.length;
    counter.textContent = `${length} / ${limit}`;
    counter.setAttribute('data-over-limit', String(length > limit));
  }

  // ============================================================
  // Live preview
  // ============================================================

  function bindLivePreviewListeners() {
    [els.title, els.subtitle, els.topic, els.price].forEach((el) => el.addEventListener('input', updateLivePreview));
    els.topic.addEventListener('change', updateLivePreview);
  }

  function updateLivePreview() {
    els.livePreviewTitle.textContent = els.title.value.trim() || 'Untitled product';
    els.livePreviewSubtitle.textContent = els.subtitle.value.trim();
    els.livePreviewTopic.textContent = els.topic.value ? labelize(els.topic.value) : ' ';
    const price = els.price.value.trim();
    els.livePreviewPrice.textContent = price === '' ? 'Not yet priced' : `GHS ${Number(price).toFixed(2)}`;

    const coverRef = state.mediaRefs.cover;
    if (coverRef) {
      els.livePreviewCover.src = coverRef.publicUrl;
      els.livePreviewCover.hidden = false;
    } else {
      els.livePreviewCover.hidden = true;
    }
  }

  // ============================================================
  // Status badge
  // ============================================================

  const STATUS_BADGE_VARIANT = {
    active: 'badge--success',
    draft: 'badge--info',
    'coming-soon': 'badge--info',
    archived: 'badge--warning',
    hidden: 'badge--warning',
    unavailable: 'badge--error',
  };

  function updateStatusBadge(status, deletedAt) {
    els.statusBadge.className = `badge ${deletedAt ? 'badge--error' : STATUS_BADGE_VARIANT[status] || 'badge--info'}`;
    els.statusBadge.textContent = deletedAt ? 'Deleted' : labelize(status);
  }

  // ============================================================
  // Save
  // ============================================================

  function gatherProductInput() {
    const priceRaw = els.price.value.trim();
    const compareRaw = els.comparePrice.value.trim();
    return {
      slug: els.slug.value.trim().toLowerCase(),
      title: els.title.value.trim(),
      subtitle: els.subtitle.value.trim() || null,
      shortDescription: els.shortDescription.value.trim() || null,
      description: sanitizeRichText(els.rtEditor.innerHTML) || null,
      topic: els.topic.value,
      productType: els.productType.value,
      status: els.status.value,
      price: priceRaw === '' ? null : Number(priceRaw),
      compareAtPrice: compareRaw === '' ? null : Number(compareRaw),
      taxBehavior: els.taxBehavior.value,
      sku: els.sku.value.trim() || null,
      version: els.version.value.trim() || null,
      language: els.language.value.trim() || 'en',
      estimatedReadingTime: els.readingTime.value === '' ? null : Number(els.readingTime.value),
      author: els.author.value.trim() || null,
      coverMediaId: state.mediaRefs.cover ? state.mediaRefs.cover.mediaId : null,
      thumbnailMediaId: state.mediaRefs.thumbnail ? state.mediaRefs.thumbnail.mediaId : null,
      previewMediaId: state.mediaRefs.preview ? state.mediaRefs.preview.mediaId : null,
      ogMediaId: state.mediaRefs.og ? state.mediaRefs.og.mediaId : null,
      featured: els.featured.checked,
      bestseller: els.bestseller.checked,
      newRelease: els.newRelease.checked,
      tags: els.tags.value.trim() || null,
      maxDownloads: els.maxDownloads.value === '' ? null : Number(els.maxDownloads.value),
      downloadExpiresDays: els.downloadExpires.value === '' ? null : Number(els.downloadExpires.value),
      seoTitle: els.seoTitle.value.trim() || null,
      seoDescription: els.seoDescription.value.trim() || null,
      seoCanonicalUrl: els.seoCanonical.value.trim() || null,
    };
  }

  function bindSave() {
    els.saveButton.addEventListener('click', save);
  }

  async function save() {
    clearValidationErrors();
    els.loadError.hidden = true;
    els.saveSuccess.hidden = true;

    const input = gatherProductInput();
    if (!input.title) return showFieldError('title', 'Title is required.');
    if (!input.slug) return showFieldError('slug', 'Slug is required.');

    els.saveButton.disabled = true;
    try {
      let product;
      if (state.mode === 'new') {
        product = await window.AdminAuth.adminFetch(PRODUCTS_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        state.id = product.id;
        state.mode = 'edit';
        window.history.replaceState({}, '', `/admin/products/edit/?id=${product.id}`);
        updateModeUi();
      } else {
        product = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${state.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      }

      await Promise.all([
        window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${state.id}/files`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: state.files.map((f) => ({
              assetId: f.assetId || null,
              mediaId: f.mediaId,
              displayName: f.displayName,
              fileType: f.fileType,
              version: f.version || null,
              status: f.status || 'draft',
            })),
          }),
        }),
        window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${state.id}/gallery`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaIds: state.gallery.map((g) => g.mediaId) }),
        }),
        window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${state.id}/relations`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relations: state.relations.map((r) => ({ relatedProductId: r.relatedProductId, relationType: r.relationType })) }),
        }),
      ]);

      const fresh = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${state.id}`);
      applyProductToForm(fresh);

      els.saveSuccess.textContent = 'Saved.';
      els.saveSuccess.hidden = false;
      els.savedAt.textContent = `Last saved ${new Date().toLocaleTimeString()}`;
      els.savedAt.hidden = false;
    } catch (error) {
      if (error.fields && error.fields.length > 0) {
        error.fields.forEach((f) => showFieldError(mapValidationField(f.field), f.message));
      } else {
        els.loadError.textContent = error.message || 'Could not save this product.';
        els.loadError.hidden = false;
      }
    } finally {
      els.saveButton.disabled = false;
    }
  }

  /** productService.ts's validation errors use the internal pesewas-based field names for price — mapped back to the form's own field-error slots. */
  function mapValidationField(field) {
    if (field === 'pricePesewas') return 'pricePesewas';
    if (field === 'compareAtPricePesewas') return 'compareAtPricePesewas';
    return field;
  }

  function showFieldError(field, message) {
    const el = root.querySelector(`[data-pe-error-field="${field}"]`);
    if (!el) {
      els.loadError.textContent = message;
      els.loadError.hidden = false;
      return;
    }
    el.textContent = message;
    el.hidden = false;
    el.closest('.field')?.classList.add('field--error');
  }

  function clearValidationErrors() {
    root.querySelectorAll('[data-pe-error-field]').forEach((el) => {
      el.hidden = true;
      el.textContent = '';
      el.closest('.field')?.classList.remove('field--error');
    });
  }

  function showLoadError(message) {
    els.loadError.textContent = message;
    els.loadError.hidden = false;
  }

  // ============================================================
  // Danger zone (edit mode only)
  // ============================================================

  function bindDangerZone() {
    els.duplicateButton.addEventListener('click', async () => {
      if (!state.id) return;
      els.duplicateButton.disabled = true;
      try {
        const duplicate = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${state.id}/duplicate`, { method: 'POST' });
        window.location.href = `/admin/products/edit/?id=${duplicate.id}`;
      } catch (error) {
        showLoadError(error.message || 'Could not duplicate this product.');
      } finally {
        els.duplicateButton.disabled = false;
      }
    });

    els.deleteButton.addEventListener('click', () => openModal(deleteModal));
    deleteModal.querySelector('[data-pe-delete-confirm]').addEventListener('click', async () => {
      if (!state.id) return;
      const button = deleteModal.querySelector('[data-pe-delete-confirm]');
      button.disabled = true;
      try {
        await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${state.id}`, { method: 'DELETE' });
        window.location.href = '/admin/products/';
      } catch (error) {
        showLoadError(error.message || 'Could not delete this product.');
        closeModal(deleteModal);
      } finally {
        button.disabled = false;
      }
    });
  }

  // ============================================================
  // Media picker modal (shared)
  // ============================================================

  let mediaPickerSearchTimer = null;

  function openMediaPicker(mediaType, onSelect) {
    mediaPickerModal.querySelector('[data-media-picker-title]').textContent = mediaType === 'image' ? 'Choose an image' : 'Choose media';
    const searchInput = mediaPickerModal.querySelector('[data-media-picker-search]');
    searchInput.value = '';
    searchInput.oninput = () => {
      window.clearTimeout(mediaPickerSearchTimer);
      mediaPickerSearchTimer = window.setTimeout(() => loadMediaPickerItems(mediaType, searchInput.value.trim(), onSelect), 300);
    };
    loadMediaPickerItems(mediaType, '', onSelect);
    openModal(mediaPickerModal);
  }

  async function loadMediaPickerItems(mediaType, search, onSelect) {
    const grid = mediaPickerModal.querySelector('[data-media-picker-grid]');
    grid.innerHTML = '';
    try {
      const params = new URLSearchParams();
      if (mediaType) params.set('type', mediaType);
      if (search) params.set('search', search);
      params.set('pageSize', '60');
      const result = await window.AdminAuth.adminFetch(`${MEDIA_API_BASE}?${params.toString()}`);
      result.items.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'media-picker-item';

        if (item.mediaType === 'image') {
          const thumb = document.createElement('img');
          thumb.className = 'media-picker-item__thumb';
          thumb.src = item.thumbnailPublicUrl || item.publicUrl;
          thumb.alt = '';
          button.appendChild(thumb);
        } else {
          const thumb = document.createElement('span');
          thumb.className = 'media-picker-item__thumb';
          thumb.style.display = 'flex';
          thumb.style.alignItems = 'center';
          thumb.style.justifyContent = 'center';
          thumb.innerHTML = '<svg class="icon" width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
          button.appendChild(thumb);
        }

        const name = document.createElement('span');
        name.className = 'media-picker-item__name';
        name.textContent = item.title || item.originalFilename;
        button.appendChild(name);

        button.addEventListener('click', () => {
          onSelect(item);
          closeModal(mediaPickerModal);
        });
        grid.appendChild(button);
      });
      if (result.items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'text-small text-secondary';
        empty.textContent = 'No media found. Upload files in the Media Library first.';
        grid.appendChild(empty);
      }
    } catch (error) {
      const errorEl = document.createElement('p');
      errorEl.className = 'text-small';
      errorEl.style.color = 'var(--color-error)';
      errorEl.textContent = error.message || 'Could not load media.';
      grid.appendChild(errorEl);
    }
  }

  // ============================================================
  // Modal shells (open/close/focus, matching admin-media.js's pattern)
  // ============================================================

  function bindModalShells() {
    [mediaPickerModal, deleteModal].forEach((modal) => {
      modal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(modal)));
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal);
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!mediaPickerModal.hidden) closeModal(mediaPickerModal);
      if (!deleteModal.hidden) closeModal(deleteModal);
    });
  }

  function openModal(modal) {
    modal.returnFocusTo = document.activeElement;
    modal.hidden = false;
    const focusable = modal.querySelector('button, [href], input, select, textarea');
    if (focusable) focusable.focus();
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (modal.returnFocusTo && document.contains(modal.returnFocusTo)) modal.returnFocusTo.focus();
    modal.returnFocusTo = null;
  }
}

document.addEventListener('partials:loaded', initProductEditor);

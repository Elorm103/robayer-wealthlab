/**
 * Robayer WealthLab — Resource editor (create + edit), Version 2.1
 * Phase 1 (Resources CMS).
 *
 * Drives both admin/resources/new/index.html and
 * admin/resources/edit/index.html — a trimmed copy of
 * admin-product-editor.js's exact pattern (same
 * contenteditable-rich-text/media-picker/modal conventions), minus
 * pricing and the files/gallery/relations join tables Resources has
 * never needed (at most one file, one cover — see the migration's own
 * header comment). Runs after admin-shell.js's `requireSession()`
 * gate, matching every other admin module script here.
 */

const RESOURCES_API_BASE = '/api/admin/resources';
const MEDIA_API_BASE = '/api/admin/media';

function initResourceEditor() {
  const root = document.querySelector('[data-resource-editor-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const initialMode = root.getAttribute('data-resource-editor-mode');
  const idParam = new URLSearchParams(window.location.search).get('id');
  const parsedId = idParam ? parseInt(idParam, 10) : null;

  const state = {
    mode: initialMode === 'edit' && Number.isInteger(parsedId) ? 'edit' : 'new',
    id: initialMode === 'edit' && Number.isInteger(parsedId) ? parsedId : null,
    mediaRefs: { cover: null, thumbnail: null },
    fileRef: null,
  };

  const els = {
    loadError: root.querySelector('[data-editor-load-error]'),
    saveSuccess: root.querySelector('[data-editor-save-success]'),

    title: root.querySelector('[data-re-title]'),
    slug: root.querySelector('[data-re-slug]'),
    shortDescription: root.querySelector('[data-re-short-description]'),
    category: root.querySelector('[data-re-category]'),
    format: root.querySelector('[data-re-format]'),

    rtToolbar: root.querySelector('[data-rt-toolbar]'),
    rtEditor: root.querySelector('[data-rt-editor]'),

    fileRefPreview: root.querySelector('[data-re-file-ref]'),
    fileChooseButton: root.querySelector('[data-re-file-choose]'),
    fileRemoveButton: root.querySelector('[data-re-file-remove]'),

    seoTitle: root.querySelector('[data-re-seo-title]'),
    seoDescription: root.querySelector('[data-re-seo-description]'),
    seoCanonical: root.querySelector('[data-re-seo-canonical]'),

    tags: root.querySelector('[data-re-tags]'),
    featured: root.querySelector('[data-re-featured]'),

    statusBadge: root.querySelector('[data-re-status-badge]'),
    status: root.querySelector('[data-re-status]'),
    saveButton: root.querySelector('[data-re-save]'),
    savedAt: root.querySelector('[data-re-saved-at]'),

    livePreviewCover: root.querySelector('[data-re-live-cover]'),
    livePreviewCategory: root.querySelector('[data-re-live-category]'),
    livePreviewTitle: root.querySelector('[data-re-live-title]'),
    livePreviewDescription: root.querySelector('[data-re-live-description]'),

    dangerZone: root.querySelector('[data-re-danger-zone]'),
    duplicateButton: root.querySelector('[data-re-duplicate]'),
    deleteButton: root.querySelector('[data-re-delete]'),
  };

  const mediaPickerModal = document.querySelector('[data-media-picker-modal]');
  const deleteModal = document.querySelector('[data-re-delete-modal]');

  bindStaticControls();
  bindRichText();
  bindFileRefPicker();
  bindMediaRefPickers();
  bindSeoCharCounters();
  bindLivePreviewListeners();
  bindSave();
  bindDangerZone();
  bindModalShells();

  loadMeta().then(() => {
    if (state.mode === 'edit') {
      loadResource(state.id);
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
      const meta = await window.AdminAuth.adminFetch(`${RESOURCES_API_BASE}/meta`);
      populateSelect(els.category, meta.categories);
      populateSelect(els.format, meta.formats);
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

  async function loadResource(id) {
    try {
      const resource = await window.AdminAuth.adminFetch(`${RESOURCES_API_BASE}/${id}`);
      applyResourceToForm(resource);
    } catch (error) {
      showLoadError(error.message || 'Could not load this resource.');
    }
  }

  function applyResourceToForm(resource) {
    state.id = resource.id;
    state.mode = 'edit';

    els.title.value = resource.title || '';
    els.slug.value = resource.slug || '';
    els.shortDescription.value = resource.shortDescription || '';
    els.rtEditor.innerHTML = resource.description || '';
    els.category.value = resource.category;
    els.format.value = resource.format;

    els.seoTitle.value = resource.seoTitle || '';
    els.seoDescription.value = resource.seoDescription || '';
    els.seoCanonical.value = resource.seoCanonicalUrl || '';
    updateCharCount('seoTitle');
    updateCharCount('seoDescription');

    els.tags.value = resource.tags || '';
    els.featured.checked = Boolean(resource.featured);

    els.status.value = resource.status;

    state.mediaRefs.cover = resource.coverMediaId ? { mediaId: resource.coverMediaId, publicUrl: resource.coverPublicUrl } : null;
    state.mediaRefs.thumbnail = resource.thumbnailMediaId ? { mediaId: resource.thumbnailMediaId, publicUrl: resource.thumbnailPublicUrl } : null;
    renderMediaRef('cover');
    renderMediaRef('thumbnail');

    state.fileRef = resource.fileMediaId
      ? { mediaId: resource.fileMediaId, displayName: resource.fileOriginalFilename || 'File', publicUrl: resource.filePublicUrl }
      : null;
    renderFileRef();

    updateModeUi();
    updateStatusBadge(resource.status, resource.deletedAt);
    updateLivePreview();
  }

  function updateModeUi() {
    const isEdit = state.mode === 'edit';
    els.dangerZone.hidden = !isEdit;
    els.saveButton.textContent = isEdit ? 'Save changes' : 'Create resource';
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
  // Identical pattern to admin-product-editor.js's own, minus the
  // image-insert toolbar button (a resource's description has never
  // needed inline images — the cover/thumbnail pickers cover this
  // content type's real needs).
  // ============================================================

  const RICHTEXT_ALLOWED_TAGS = new Set(['P', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'A', 'BR', 'DIV']);

  function bindRichText() {
    // Paste-as-plain-text — see admin-product-editor.js's identical
    // comment on why this matters (this field's HTML is rendered on the
    // public resource page for every visitor, not just shown back to
    // this admin).
    els.rtEditor.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    els.rtToolbar.querySelectorAll('[data-rt-cmd]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const cmd = button.getAttribute('data-rt-cmd');
        els.rtEditor.focus();
        if (cmd === 'link') {
          const url = window.prompt('Link URL:'); // eslint-disable-line no-alert -- no rich dialog component exists yet
          if (url) document.execCommand('createLink', false, url);
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

  function wrapSelectionInCode() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const code = document.createElement('code');
    try {
      range.surroundContents(code);
    } catch {
      // A selection spanning multiple block elements can't be wrapped —
      // silently no-op, matching admin-product-editor.js's own posture.
    }
  }

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
        const keep = child.tagName === 'A' && name === 'href';
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
      sanitizeNode(child);
    });
  }

  // ============================================================
  // File reference picker (the one downloadable file)
  // ============================================================

  function bindFileRefPicker() {
    els.fileChooseButton.addEventListener('click', () => {
      openMediaPicker(null, (item) => {
        state.fileRef = { mediaId: item.id, displayName: item.title || item.originalFilename, publicUrl: item.publicUrl };
        renderFileRef();
      });
    });
    els.fileRemoveButton.addEventListener('click', () => {
      state.fileRef = null;
      renderFileRef();
    });
  }

  function renderFileRef() {
    els.fileRefPreview.innerHTML = '';
    if (state.fileRef) {
      const row = document.createElement('div');
      row.className = 'editor-list-row';
      const icon = document.createElement('span');
      icon.className = 'editor-list-row__thumb';
      icon.innerHTML = '<svg class="icon" width="40" height="40" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
      const name = document.createElement('p');
      name.className = 'editor-list-row__title';
      name.textContent = state.fileRef.displayName;
      row.append(icon, name);
      els.fileRefPreview.appendChild(row);
      els.fileRemoveButton.hidden = false;
    } else {
      els.fileRemoveButton.hidden = true;
    }
  }

  // ============================================================
  // Media reference pickers (cover / thumbnail)
  // ============================================================

  function bindMediaRefPickers() {
    root.querySelectorAll('[data-re-media-choose]').forEach((button) => {
      const slot = button.getAttribute('data-re-media-choose');
      button.addEventListener('click', () => {
        openMediaPicker('image', (item) => {
          state.mediaRefs[slot] = { mediaId: item.id, publicUrl: item.publicUrl };
          renderMediaRef(slot);
          updateLivePreview();
        });
      });
    });
    root.querySelectorAll('[data-re-media-remove]').forEach((button) => {
      const slot = button.getAttribute('data-re-media-remove');
      button.addEventListener('click', () => {
        state.mediaRefs[slot] = null;
        renderMediaRef(slot);
        updateLivePreview();
      });
    });
  }

  function renderMediaRef(slot) {
    const preview = root.querySelector(`[data-re-media-ref="${slot}"]`);
    const removeButton = root.querySelector(`[data-re-media-remove="${slot}"]`);
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
  // SEO char counters
  // ============================================================

  const SEO_LIMITS = { seoTitle: 70, seoDescription: 160 };

  function bindSeoCharCounters() {
    els.seoTitle.addEventListener('input', () => updateCharCount('seoTitle'));
    els.seoDescription.addEventListener('input', () => updateCharCount('seoDescription'));
  }

  function updateCharCount(field) {
    const input = field === 'seoTitle' ? els.seoTitle : els.seoDescription;
    const counter = root.querySelector(`[data-re-char-count="${field}"]`);
    const limit = SEO_LIMITS[field];
    const length = input.value.length;
    counter.textContent = `${length} / ${limit}`;
    counter.setAttribute('data-over-limit', String(length > limit));
  }

  // ============================================================
  // Live preview
  // ============================================================

  function bindLivePreviewListeners() {
    [els.title, els.shortDescription, els.category].forEach((el) => el.addEventListener('input', updateLivePreview));
    els.category.addEventListener('change', updateLivePreview);
  }

  function updateLivePreview() {
    els.livePreviewTitle.textContent = els.title.value.trim() || 'Untitled resource';
    els.livePreviewCategory.textContent = els.category.value ? labelize(els.category.value) : ' ';
    els.livePreviewDescription.textContent = els.shortDescription.value.trim();

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

  const STATUS_BADGE_VARIANT = { published: 'badge--success', draft: 'badge--info', archived: 'badge--warning' };

  function updateStatusBadge(status, deletedAt) {
    els.statusBadge.className = `badge ${deletedAt ? 'badge--error' : STATUS_BADGE_VARIANT[status] || 'badge--info'}`;
    els.statusBadge.textContent = deletedAt ? 'Deleted' : labelize(status);
  }

  // ============================================================
  // Save
  // ============================================================

  function gatherResourceInput() {
    return {
      slug: els.slug.value.trim().toLowerCase(),
      title: els.title.value.trim(),
      shortDescription: els.shortDescription.value.trim() || null,
      description: sanitizeRichText(els.rtEditor.innerHTML) || null,
      category: els.category.value,
      format: els.format.value,
      status: els.status.value,
      fileMediaId: state.fileRef ? state.fileRef.mediaId : null,
      coverMediaId: state.mediaRefs.cover ? state.mediaRefs.cover.mediaId : null,
      thumbnailMediaId: state.mediaRefs.thumbnail ? state.mediaRefs.thumbnail.mediaId : null,
      tags: els.tags.value.trim() || null,
      featured: els.featured.checked,
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

    const input = gatherResourceInput();
    if (!input.title) return showFieldError('title', 'Title is required.');
    if (!input.slug) return showFieldError('slug', 'Slug is required.');

    els.saveButton.disabled = true;
    try {
      let resource;
      if (state.mode === 'new') {
        resource = await window.AdminAuth.adminFetch(RESOURCES_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        state.id = resource.id;
        state.mode = 'edit';
        window.history.replaceState({}, '', `/admin/resources/edit/?id=${resource.id}`);
        updateModeUi();
      } else {
        resource = await window.AdminAuth.adminFetch(`${RESOURCES_API_BASE}/${state.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      }

      applyResourceToForm(resource);

      els.saveSuccess.textContent = 'Saved.';
      els.saveSuccess.hidden = false;
      els.savedAt.textContent = `Last saved ${new Date().toLocaleTimeString()}`;
      els.savedAt.hidden = false;
    } catch (error) {
      if (error.fields && error.fields.length > 0) {
        error.fields.forEach((f) => showFieldError(f.field, f.message));
      } else {
        els.loadError.textContent = error.message || 'Could not save this resource.';
        els.loadError.hidden = false;
      }
    } finally {
      els.saveButton.disabled = false;
    }
  }

  function showFieldError(field, message) {
    const el = root.querySelector(`[data-re-error-field="${field}"]`);
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
    root.querySelectorAll('[data-re-error-field]').forEach((el) => {
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
        const duplicate = await window.AdminAuth.adminFetch(`${RESOURCES_API_BASE}/${state.id}/duplicate`, { method: 'POST' });
        window.location.href = `/admin/resources/edit/?id=${duplicate.id}`;
      } catch (error) {
        showLoadError(error.message || 'Could not duplicate this resource.');
      } finally {
        els.duplicateButton.disabled = false;
      }
    });

    els.deleteButton.addEventListener('click', () => openModal(deleteModal));
    deleteModal.querySelector('[data-re-delete-confirm]').addEventListener('click', async () => {
      if (!state.id) return;
      const button = deleteModal.querySelector('[data-re-delete-confirm]');
      button.disabled = true;
      try {
        await window.AdminAuth.adminFetch(`${RESOURCES_API_BASE}/${state.id}`, { method: 'DELETE' });
        window.location.href = '/admin/resources/';
      } catch (error) {
        showLoadError(error.message || 'Could not delete this resource.');
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
  // Modal shells (open/close/focus)
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

document.addEventListener('partials:loaded', initResourceEditor);

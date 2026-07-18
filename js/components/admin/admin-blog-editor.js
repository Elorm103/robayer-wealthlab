/**
 * Robayer WealthLab — Blog post editor (create + edit), Version 2.1
 * Phase 2 (Blog CMS).
 *
 * Drives both admin/blog/new/index.html and admin/blog/edit/index.html
 * — a trimmed, field-renamed copy of admin-resource-editor.js's exact
 * pattern (same contenteditable-rich-text/media-picker/modal
 * conventions), minus the file-ref picker (Blog has no downloadable
 * file) and the thumbnail slot (Blog only needs a cover image), plus
 * the two genuinely new pieces this content type needs: an author
 * select populated from /api/admin/blog/meta's `authors` list, and a
 * "Preview" link to the public detail page's `?preview=1` session-gated
 * view (see routes/blog.ts's renderPostDetail()). Runs after
 * admin-shell.js's `requireSession()` gate, matching every other admin
 * module script here.
 */

const BLOG_API_BASE = '/api/admin/blog';
const MEDIA_API_BASE = '/api/admin/media';

function initBlogEditor() {
  const root = document.querySelector('[data-blog-editor-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const initialMode = root.getAttribute('data-blog-editor-mode');
  const idParam = new URLSearchParams(window.location.search).get('id');
  const parsedId = idParam ? parseInt(idParam, 10) : null;

  const state = {
    mode: initialMode === 'edit' && Number.isInteger(parsedId) ? 'edit' : 'new',
    id: initialMode === 'edit' && Number.isInteger(parsedId) ? parsedId : null,
    slug: '',
    mediaRefs: { cover: null },
  };

  const els = {
    loadError: root.querySelector('[data-editor-load-error]'),
    saveSuccess: root.querySelector('[data-editor-save-success]'),

    title: root.querySelector('[data-be-title]'),
    slug: root.querySelector('[data-be-slug]'),
    excerpt: root.querySelector('[data-be-excerpt]'),
    category: root.querySelector('[data-be-category]'),
    author: root.querySelector('[data-be-author]'),

    rtToolbar: root.querySelector('[data-rt-toolbar]'),
    rtEditor: root.querySelector('[data-rt-editor]'),
    readingTime: root.querySelector('[data-be-reading-time]'),

    seoTitle: root.querySelector('[data-be-seo-title]'),
    seoDescription: root.querySelector('[data-be-seo-description]'),
    seoCanonical: root.querySelector('[data-be-seo-canonical]'),

    tags: root.querySelector('[data-be-tags]'),
    featured: root.querySelector('[data-be-featured]'),

    statusBadge: root.querySelector('[data-be-status-badge]'),
    status: root.querySelector('[data-be-status]'),
    saveButton: root.querySelector('[data-be-save]'),
    savedAt: root.querySelector('[data-be-saved-at]'),
    previewLink: root.querySelector('[data-be-preview-link]'),

    livePreviewCover: root.querySelector('[data-be-live-cover]'),
    livePreviewCategory: root.querySelector('[data-be-live-category]'),
    livePreviewTitle: root.querySelector('[data-be-live-title]'),
    livePreviewExcerpt: root.querySelector('[data-be-live-excerpt]'),

    dangerZone: root.querySelector('[data-be-danger-zone]'),
    duplicateButton: root.querySelector('[data-be-duplicate]'),
    deleteButton: root.querySelector('[data-be-delete]'),
  };

  const mediaPickerModal = document.querySelector('[data-media-picker-modal]');
  const deleteModal = document.querySelector('[data-be-delete-modal]');

  bindStaticControls();
  bindRichText();
  bindMediaRefPickers();
  bindSeoCharCounters();
  bindLivePreviewListeners();
  bindSave();
  bindDangerZone();
  bindModalShells();

  loadMeta().then(() => {
    if (state.mode === 'edit') {
      loadPost(state.id);
    } else {
      updateModeUi();
      updateLivePreview();
      updatePreviewLink();
    }
  });

  // ============================================================
  // Meta
  // ============================================================

  async function loadMeta() {
    try {
      const meta = await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/meta`);
      populateSelect(els.category, meta.categories);
      populateStatusSelect(meta.statuses);
      populateAuthorSelect(meta.authors);
      els.status.value = 'draft';
    } catch (error) {
      showLoadError(error.message || 'Could not load form options.');
    }
  }

  function populateSelect(select, values) {
    select.innerHTML = '';
    values.forEach((value) => select.appendChild(new Option(labelize(value), value)));
  }

  function populateStatusSelect(statuses) {
    els.status.innerHTML = '';
    statuses.forEach((value) => els.status.appendChild(new Option(labelize(value), value)));
  }

  function populateAuthorSelect(authors) {
    els.author.innerHTML = '';
    els.author.appendChild(new Option('No author', ''));
    authors.forEach((author) => els.author.appendChild(new Option(author.name || author.email, String(author.id))));
  }

  function labelize(value) {
    return value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ============================================================
  // Load (edit mode)
  // ============================================================

  async function loadPost(id) {
    try {
      const post = await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/${id}`);
      applyPostToForm(post);
    } catch (error) {
      showLoadError(error.message || 'Could not load this post.');
    }
  }

  function applyPostToForm(post) {
    state.id = post.id;
    state.mode = 'edit';
    state.slug = post.slug || '';

    els.title.value = post.title || '';
    els.slug.value = post.slug || '';
    els.excerpt.value = post.excerpt || '';
    els.rtEditor.innerHTML = post.body || '';
    els.category.value = post.category;
    els.author.value = post.authorId ? String(post.authorId) : '';

    els.seoTitle.value = post.seoTitle || '';
    els.seoDescription.value = post.seoDescription || '';
    els.seoCanonical.value = post.seoCanonicalUrl || '';
    updateCharCount('seoTitle');
    updateCharCount('seoDescription');

    els.tags.value = post.tags || '';
    els.featured.checked = Boolean(post.featured);

    els.status.value = post.status;

    state.mediaRefs.cover = post.coverMediaId ? { mediaId: post.coverMediaId, publicUrl: post.coverPublicUrl } : null;
    renderMediaRef('cover');

    updateModeUi();
    updateStatusBadge(post.status, post.deletedAt);
    updateLivePreview();
    updateReadingTime();
    updatePreviewLink();
  }

  function updateModeUi() {
    const isEdit = state.mode === 'edit';
    els.dangerZone.hidden = !isEdit;
    els.saveButton.textContent = isEdit ? 'Save changes' : 'Create post';
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
  // Same pattern as admin-resource-editor.js, extended with table tags
  // to mirror the server-side richTextSanitizer.ts allowlist extension
  // (see that file's header comment) — without this, re-saving a post
  // whose body contains a table (e.g. the migrated Treasury Bills
  // article) would silently strip the table client-side before the
  // PATCH request is ever sent.
  // ============================================================

  const RICHTEXT_ALLOWED_TAGS = new Set([
    'P', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'A', 'IMG', 'BR', 'DIV',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  ]);

  function bindRichText() {
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
        updateReadingTime();
      });
    });

    els.rtEditor.addEventListener('input', () => {
      updateLivePreview();
      updateReadingTime();
    });
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
      // silently no-op, matching admin-resource-editor.js's own posture.
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
  // Reading time — mirrors blogService.estimateReadingTimeMinutes()'s
  // exact strip-tags-then-count-words approach, purely for immediate
  // editor feedback; the server computes its own authoritative value.
  // ============================================================

  function updateReadingTime() {
    const text = els.rtEditor.innerHTML.replace(/<[^>]+>/g, ' ');
    const words = text.split(/\s+/).filter(Boolean).length;
    const minutes = words === 0 ? 0 : Math.max(1, Math.round(words / 200));
    els.readingTime.textContent = `~${minutes} min read`;
  }

  // ============================================================
  // Media reference picker (cover)
  // ============================================================

  function bindMediaRefPickers() {
    root.querySelectorAll('[data-be-media-choose]').forEach((button) => {
      const slot = button.getAttribute('data-be-media-choose');
      button.addEventListener('click', () => {
        openMediaPicker('image', (item) => {
          state.mediaRefs[slot] = { mediaId: item.id, publicUrl: item.publicUrl };
          renderMediaRef(slot);
          updateLivePreview();
        });
      });
    });
    root.querySelectorAll('[data-be-media-remove]').forEach((button) => {
      const slot = button.getAttribute('data-be-media-remove');
      button.addEventListener('click', () => {
        state.mediaRefs[slot] = null;
        renderMediaRef(slot);
        updateLivePreview();
      });
    });
  }

  function renderMediaRef(slot) {
    const preview = root.querySelector(`[data-be-media-ref="${slot}"]`);
    const removeButton = root.querySelector(`[data-be-media-remove="${slot}"]`);
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
    const counter = root.querySelector(`[data-be-char-count="${field}"]`);
    const limit = SEO_LIMITS[field];
    const length = input.value.length;
    counter.textContent = `${length} / ${limit}`;
    counter.setAttribute('data-over-limit', String(length > limit));
  }

  // ============================================================
  // Live preview
  // ============================================================

  function bindLivePreviewListeners() {
    [els.title, els.excerpt, els.category].forEach((el) => el.addEventListener('input', updateLivePreview));
    els.category.addEventListener('change', updateLivePreview);
    els.slug.addEventListener('input', updatePreviewLink);
  }

  function updateLivePreview() {
    els.livePreviewTitle.textContent = els.title.value.trim() || 'Untitled post';
    els.livePreviewCategory.textContent = els.category.value ? labelize(els.category.value) : ' ';
    els.livePreviewExcerpt.textContent = els.excerpt.value.trim();

    const coverRef = state.mediaRefs.cover;
    if (coverRef) {
      els.livePreviewCover.src = coverRef.publicUrl;
      els.livePreviewCover.hidden = false;
    } else {
      els.livePreviewCover.hidden = true;
    }
  }

  // ============================================================
  // Preview link — only meaningful once the post has a saved slug;
  // reuses the same admin session already authenticating this page
  // (see routes/blog.ts's renderPostDetail() `?preview=1` handling),
  // so no separate token exists to manage here.
  // ============================================================

  function updatePreviewLink() {
    const slug = state.mode === 'edit' ? state.slug : els.slug.value.trim();
    if (state.id && slug) {
      els.previewLink.href = `/blog/${slug}/?preview=1`;
      els.previewLink.hidden = false;
    } else {
      els.previewLink.hidden = true;
    }
  }

  // ============================================================
  // Status badge
  // ============================================================

  const STATUS_BADGE_VARIANT = { published: 'badge--success', draft: 'badge--info' };

  function updateStatusBadge(status, deletedAt) {
    els.statusBadge.className = `badge ${deletedAt ? 'badge--error' : STATUS_BADGE_VARIANT[status] || 'badge--info'}`;
    els.statusBadge.textContent = deletedAt ? 'Deleted' : labelize(status);
  }

  // ============================================================
  // Save
  // ============================================================

  function gatherPostInput() {
    return {
      slug: els.slug.value.trim().toLowerCase(),
      title: els.title.value.trim(),
      excerpt: els.excerpt.value.trim() || null,
      body: sanitizeRichText(els.rtEditor.innerHTML) || null,
      category: els.category.value,
      status: els.status.value,
      coverMediaId: state.mediaRefs.cover ? state.mediaRefs.cover.mediaId : null,
      authorId: els.author.value ? parseInt(els.author.value, 10) : null,
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

    const input = gatherPostInput();
    if (!input.title) return showFieldError('title', 'Title is required.');
    if (!input.slug) return showFieldError('slug', 'Slug is required.');

    els.saveButton.disabled = true;
    try {
      let post;
      if (state.mode === 'new') {
        post = await window.AdminAuth.adminFetch(BLOG_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        state.id = post.id;
        state.mode = 'edit';
        window.history.replaceState({}, '', `/admin/blog/edit/?id=${post.id}`);
        updateModeUi();
      } else {
        post = await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/${state.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      }

      applyPostToForm(post);

      els.saveSuccess.textContent = 'Saved.';
      els.saveSuccess.hidden = false;
      els.savedAt.textContent = `Last saved ${new Date().toLocaleTimeString()}`;
      els.savedAt.hidden = false;
    } catch (error) {
      if (error.fields && error.fields.length > 0) {
        error.fields.forEach((f) => showFieldError(f.field, f.message));
      } else {
        els.loadError.textContent = error.message || 'Could not save this post.';
        els.loadError.hidden = false;
      }
    } finally {
      els.saveButton.disabled = false;
    }
  }

  function showFieldError(field, message) {
    const el = root.querySelector(`[data-be-error-field="${field}"]`);
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
    root.querySelectorAll('[data-be-error-field]').forEach((el) => {
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
        const duplicate = await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/${state.id}/duplicate`, { method: 'POST' });
        window.location.href = `/admin/blog/edit/?id=${duplicate.id}`;
      } catch (error) {
        showLoadError(error.message || 'Could not duplicate this post.');
      } finally {
        els.duplicateButton.disabled = false;
      }
    });

    els.deleteButton.addEventListener('click', () => openModal(deleteModal));
    deleteModal.querySelector('[data-be-delete-confirm]').addEventListener('click', async () => {
      if (!state.id) return;
      const button = deleteModal.querySelector('[data-be-delete-confirm]');
      button.disabled = true;
      try {
        await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/${state.id}`, { method: 'DELETE' });
        window.location.href = '/admin/blog/';
      } catch (error) {
        showLoadError(error.message || 'Could not delete this post.');
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

document.addEventListener('partials:loaded', initBlogEditor);

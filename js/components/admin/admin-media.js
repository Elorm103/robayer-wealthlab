/**
 * Robayer WealthLab — Media Library (Version 2.0 Phase 1)
 *
 * Drives admin/media/index.html. Runs after admin-shell.js's
 * `requireSession()` gate (both listen for `partials:loaded`; shell
 * script order guarantees the gate runs first) — this component only
 * ever runs for an authenticated admin.
 *
 * Uploads go through raw `XMLHttpRequest`, not `window.AdminAuth.adminFetch()`
 * — `fetch()` has no reliable cross-browser upload-progress event, and
 * a progress bar is an explicit requirement here. Every other call
 * (list/get/patch/delete/restore) uses `adminFetch()` as normal.
 */

const MEDIA_API_BASE = '/api/admin/media';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'svg'];
const DOCUMENT_EXTENSIONS = ['pdf'];
const THUMBNAIL_MAX_DIMENSION = 400;

function initAdminMedia() {
  const root = document.querySelector('[data-media-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    search: '',
    type: null,
    folder: null,
    showDeleted: false,
    sort: 'newest',
    page: 1,
    pageSize: 24,
    view: localStorage.getItem('robayer-media-view') || 'grid',
    items: [],
    total: 0,
  };

  const els = {
    dropzone: root.querySelector('[data-media-dropzone]'),
    fileInput: root.querySelector('[data-media-file-input]'),
    browseButton: root.querySelector('[data-media-browse]'),
    uploadQueue: root.querySelector('[data-upload-queue]'),
    searchInput: root.querySelector('[data-media-search]'),
    filterChips: Array.from(root.querySelectorAll('[data-media-filter]')),
    sortSelect: root.querySelector('[data-media-sort]'),
    viewToggle: Array.from(root.querySelectorAll('[data-media-view]')),
    grid: root.querySelector('[data-media-grid]'),
    emptyState: root.querySelector('[data-media-empty]'),
    loadError: root.querySelector('[data-media-load-error]'),
    pagination: root.querySelector('[data-media-pagination]'),
    paginationLabel: root.querySelector('[data-media-pagination-label]'),
    paginationPrev: root.querySelector('[data-media-pagination-prev]'),
    paginationNext: root.querySelector('[data-media-pagination-next]'),
    resultCount: root.querySelector('[data-media-result-count]'),
  };

  const previewModal = document.querySelector('[data-media-preview-modal]');
  const deleteModal = document.querySelector('[data-media-delete-modal]');

  bindUpload();
  bindToolbar();
  bindModals();
  refresh();

  // ---------- Data loading ----------

  async function refresh() {
    els.loadError.hidden = true;
    try {
      const params = new URLSearchParams();
      if (state.search) params.set('search', state.search);
      if (state.type) params.set('type', state.type);
      if (state.folder) params.set('folder', state.folder);
      if (state.showDeleted) params.set('deleted', 'true');
      params.set('sort', state.sort);
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${MEDIA_API_BASE}?${params.toString()}`);
      state.items = result.items;
      state.total = result.total;
      renderGrid();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load media.';
      els.loadError.hidden = false;
    }
  }

  // ---------- Toolbar (search / filters / sort / view / pagination) ----------

  function bindToolbar() {
    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.search = els.searchInput.value.trim();
        state.page = 1;
        refresh();
      }, 300);
    });

    els.filterChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const filterType = chip.getAttribute('data-media-filter');
        const filterValue = chip.getAttribute('data-media-filter-value');
        applyFilterChip(filterType, filterValue, chip);
      });
    });

    els.sortSelect.addEventListener('change', () => {
      state.sort = els.sortSelect.value;
      state.page = 1;
      refresh();
    });

    els.viewToggle.forEach((button) => {
      button.addEventListener('click', () => {
        state.view = button.getAttribute('data-media-view');
        localStorage.setItem('robayer-media-view', state.view);
        syncViewToggle();
        renderGrid();
      });
    });
    syncViewToggle();

    els.paginationPrev.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        refresh();
      }
    });
    els.paginationNext.addEventListener('click', () => {
      if (state.page * state.pageSize < state.total) {
        state.page += 1;
        refresh();
      }
    });
  }

  function applyFilterChip(filterType, filterValue, chip) {
    state.page = 1;
    if (filterType === 'type') {
      state.type = state.type === filterValue ? null : filterValue;
      state.folder = null;
      state.showDeleted = false;
    } else if (filterType === 'folder') {
      state.folder = state.folder === filterValue ? null : filterValue;
      state.type = null;
      state.showDeleted = false;
    } else if (filterType === 'deleted') {
      state.showDeleted = !state.showDeleted;
      state.type = null;
      state.folder = null;
    } else if (filterType === 'recent') {
      state.sort = 'newest';
      state.type = null;
      state.folder = null;
      state.showDeleted = false;
      els.sortSelect.value = 'newest';
    }
    syncFilterChips();
    refresh();
  }

  function syncFilterChips() {
    els.filterChips.forEach((chip) => {
      const filterType = chip.getAttribute('data-media-filter');
      const filterValue = chip.getAttribute('data-media-filter-value');
      let pressed = false;
      if (filterType === 'type') pressed = state.type === filterValue;
      if (filterType === 'folder') pressed = state.folder === filterValue;
      if (filterType === 'deleted') pressed = state.showDeleted;
      chip.setAttribute('aria-pressed', String(pressed));
    });
  }

  function syncViewToggle() {
    els.viewToggle.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-media-view') === state.view));
    });
    els.grid.classList.toggle('media-grid', state.view === 'grid');
    els.grid.classList.toggle('media-list', state.view === 'list');
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 item' : `${state.total} items`;
  }

  // ---------- Grid rendering ----------

  function renderGrid() {
    els.grid.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.grid.hidden = !hasItems;
    if (!hasItems) return;

    state.items.forEach((item) => {
      els.grid.appendChild(state.view === 'grid' ? buildCard(item) : buildListRow(item));
    });
  }

  function buildCard(item) {
    const card = document.createElement('div');
    card.className = 'media-card' + (item.deletedAt ? ' media-card--deleted' : '');

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'media-card__thumb-wrap';

    if (item.mediaType === 'image') {
      const img = document.createElement('img');
      img.className = 'media-card__thumb';
      img.src = item.thumbnailPublicUrl || item.publicUrl;
      img.alt = item.altText || item.title || item.originalFilename;
      img.loading = 'lazy';
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.innerHTML = '<svg class="icon media-card__doc-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
    }

    if (item.deletedAt) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--error media-card__badge';
      badge.textContent = 'Deleted';
      thumbWrap.appendChild(badge);
    }

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'media-card__button';
    openButton.setAttribute('aria-label', `View ${item.title || item.originalFilename}`);
    openButton.addEventListener('click', () => openPreview(item));
    thumbWrap.appendChild(openButton);

    const body = document.createElement('div');
    body.className = 'media-card__body';
    const title = document.createElement('p');
    title.className = 'media-card__title';
    title.textContent = item.title || item.originalFilename;
    const meta = document.createElement('p');
    meta.className = 'media-card__meta';
    meta.textContent = formatFileSize(item.sizeBytes) + (item.width ? ` · ${item.width}×${item.height}` : '');
    body.append(title, meta);

    card.append(thumbWrap, body);
    return card;
  }

  function buildListRow(item) {
    const row = document.createElement('div');
    row.className = 'admin-activity-item media-list-row';

    let thumbEl;
    if (item.mediaType === 'image') {
      thumbEl = document.createElement('img');
      thumbEl.className = 'media-list-row__thumb';
      thumbEl.src = item.thumbnailPublicUrl || item.publicUrl;
      thumbEl.alt = '';
      thumbEl.loading = 'lazy';
    } else {
      thumbEl = document.createElement('span');
      thumbEl.className = 'media-list-row__thumb';
    }

    const info = document.createElement('div');
    info.style.flex = '1';
    const title = document.createElement('p');
    title.className = 'media-card__title';
    title.textContent = item.title || item.originalFilename;
    const meta = document.createElement('p');
    meta.className = 'media-card__meta';
    meta.textContent = `${item.folder} · ${formatFileSize(item.sizeBytes)} · ${formatDate(item.createdAt)}`;
    info.append(title, meta);

    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.className = 'btn btn--secondary';
    viewButton.textContent = 'View';
    viewButton.addEventListener('click', () => openPreview(item));

    row.append(thumbEl, info, viewButton);
    return row;
  }

  // ---------- Upload ----------

  function bindUpload() {
    els.browseButton.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
      handleFiles(Array.from(els.fileInput.files || []));
      els.fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      els.dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        els.dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      els.dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        els.dropzone.classList.remove('is-dragover');
      });
    });
    els.dropzone.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer ? event.dataTransfer.files : []);
      handleFiles(files);
    });
  }

  function handleFiles(files) {
    files.forEach((file) => queueUpload(file));
  }

  function clientValidate(file) {
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    const isImage = IMAGE_EXTENSIONS.includes(extension);
    const isDocument = DOCUMENT_EXTENSIONS.includes(extension);
    if (!isImage && !isDocument) {
      return { ok: false, message: 'Unsupported file type.' };
    }
    const limit = isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    if (file.size > limit) {
      return { ok: false, message: `File exceeds the ${Math.round(limit / (1024 * 1024))}MB limit.` };
    }
    return { ok: true, isImage };
  }

  async function queueUpload(file, replaceId) {
    const validation = clientValidate(file);
    const row = buildUploadRow(file, validation.ok ? null : validation.message);
    els.uploadQueue.hidden = false;
    els.uploadQueue.appendChild(row.el);
    if (!validation.ok) return;

    let thumbnailBlob = null;
    if (validation.isImage && !file.name.toLowerCase().endsWith('.svg')) {
      thumbnailBlob = await generateThumbnail(file).catch(() => null);
    }

    startUpload(file, row, replaceId, thumbnailBlob);
  }

  function buildUploadRow(file, immediateError) {
    const el = document.createElement('div');
    el.className = 'upload-queue__item';
    el.setAttribute('data-upload-state', immediateError ? 'error' : 'uploading');

    const info = document.createElement('div');
    info.className = 'upload-queue__info';
    const filename = document.createElement('p');
    filename.className = 'upload-queue__filename';
    filename.textContent = file.name;
    const meta = document.createElement('p');
    meta.className = 'upload-queue__meta';
    meta.textContent = immediateError || formatFileSize(file.size);
    const bar = document.createElement('div');
    bar.className = 'upload-queue__bar';
    const barFill = document.createElement('div');
    barFill.className = 'upload-queue__bar-fill';
    bar.appendChild(barFill);
    info.append(filename, meta, bar);

    const actions = document.createElement('div');
    actions.className = 'upload-queue__actions';

    el.append(info, actions);
    return { el, meta, barFill, actions };
  }

  function startUpload(file, row, replaceId, thumbnailBlob) {
    const xhr = new XMLHttpRequest();
    const url = replaceId ? `${MEDIA_API_BASE}/${replaceId}/replace` : MEDIA_API_BASE;
    xhr.open('POST', url);
    xhr.withCredentials = true;
    const csrf = window.AdminAuth.getCsrfToken();
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'upload-queue__icon-button';
    cancelButton.setAttribute('aria-label', 'Cancel upload');
    cancelButton.innerHTML = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    cancelButton.addEventListener('click', () => xhr.abort());
    row.actions.appendChild(cancelButton);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        row.barFill.style.width = `${percent}%`;
        row.meta.textContent = `${percent}% · ${formatFileSize(file.size)}`;
      }
    });

    xhr.addEventListener('abort', () => {
      row.el.setAttribute('data-upload-state', 'error');
      row.meta.textContent = 'Cancelled.';
      showRetry(row, () => {
        row.actions.innerHTML = '';
        row.el.setAttribute('data-upload-state', 'uploading');
        startUpload(file, row, replaceId, thumbnailBlob);
      });
    });

    xhr.addEventListener('error', () => {
      row.el.setAttribute('data-upload-state', 'error');
      row.meta.textContent = 'Upload failed. Check your connection.';
      showRetry(row, () => {
        row.actions.innerHTML = '';
        row.el.setAttribute('data-upload-state', 'uploading');
        startUpload(file, row, replaceId, thumbnailBlob);
      });
    });

    xhr.addEventListener('load', () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to generic error below
      }

      if (xhr.status >= 200 && xhr.status < 300 && body && body.success) {
        row.el.setAttribute('data-upload-state', 'done');
        row.meta.textContent = 'Done.';
        row.barFill.style.width = '100%';
        window.setTimeout(() => row.el.remove(), 2500);
        state.page = 1;
        refresh();
        return;
      }

      row.el.setAttribute('data-upload-state', 'error');
      if (body && body.error && body.error.code === 'DUPLICATE_ASSET') {
        row.meta.textContent = body.duplicate ? `Already uploaded as "${body.duplicate.originalFilename}".` : 'This file was already uploaded.';
      } else {
        row.meta.textContent = (body && body.error && body.error.message) || 'Upload failed.';
      }
      showRetry(row, () => {
        row.actions.innerHTML = '';
        row.el.setAttribute('data-upload-state', 'uploading');
        startUpload(file, row, replaceId, thumbnailBlob);
      });
    });

    const form = new FormData();
    form.append('file', file);
    if (!replaceId) form.append('folder', currentUploadFolder());
    if (thumbnailBlob) form.append('thumbnail', thumbnailBlob, 'thumb.webp');

    xhr.send(form);
  }

  function currentUploadFolder() {
    return state.folder || 'uncategorized';
  }

  function showRetry(row, onRetry) {
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'upload-queue__icon-button';
    retryButton.setAttribute('aria-label', 'Retry upload');
    retryButton.innerHTML = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v6h-6"/></svg>';
    retryButton.addEventListener('click', onRetry);
    row.actions.appendChild(retryButton);
  }

  /** Client-side downscaled copy — a real, separate file uploaded alongside the original, not a fake/placeholder. See backend/services/mediaService.ts's UploadParams.thumbnailBytes comment for why this is generated here rather than server-side. */
  function generateThumbnail(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(objectUrl);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('thumbnail failed'))), 'image/webp', 0.8);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('image failed to load'));
      };
      img.src = objectUrl;
    });
  }

  // ---------- Preview / metadata / delete / restore ----------

  function bindModals() {
    previewModal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(previewModal)));
    deleteModal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(deleteModal)));
    [previewModal, deleteModal].forEach((modal) => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal);
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!previewModal.hidden) closeModal(previewModal);
        if (!deleteModal.hidden) closeModal(deleteModal);
      }
    });

    previewModal.querySelector('[data-media-preview-image]').addEventListener('click', (event) => {
      event.target.classList.toggle('is-zoomed');
    });

    previewModal.querySelector('[data-media-save-metadata]').addEventListener('click', saveMetadata);
    previewModal.querySelector('[data-media-copy-url]').addEventListener('click', () => copyToClipboard(previewModal.querySelector('[data-media-url-input]')));
    previewModal.querySelector('[data-media-copy-key]').addEventListener('click', () => copyToClipboard(previewModal.querySelector('[data-media-key-input]')));
    previewModal.querySelector('[data-media-delete-trigger]').addEventListener('click', () => {
      closeModal(previewModal);
      openDeleteConfirm(previewModal.currentItem);
    });
    previewModal.querySelector('[data-media-restore-trigger]').addEventListener('click', async () => {
      await restoreItem(previewModal.currentItem);
      closeModal(previewModal);
    });

    const replaceInput = previewModal.querySelector('[data-media-replace-input]');
    previewModal.querySelector('[data-media-replace-trigger]').addEventListener('click', () => replaceInput.click());
    replaceInput.addEventListener('change', () => {
      const file = replaceInput.files && replaceInput.files[0];
      replaceInput.value = '';
      if (!file || !previewModal.currentItem) return;
      closeModal(previewModal);
      queueUpload(file, previewModal.currentItem.id);
    });

    deleteModal.querySelector('[data-media-delete-confirm]').addEventListener('click', async () => {
      await deleteItem(deleteModal.currentItem);
      closeModal(deleteModal);
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

  function openPreview(item) {
    previewModal.currentItem = item;
    const imageWrap = previewModal.querySelector('[data-media-preview-image-wrap]');
    const image = previewModal.querySelector('[data-media-preview-image]');
    const docCard = previewModal.querySelector('[data-media-preview-doc]');

    if (item.mediaType === 'image') {
      imageWrap.hidden = false;
      docCard.hidden = true;
      image.src = item.publicUrl;
      image.alt = item.altText || item.originalFilename;
      image.classList.remove('is-zoomed');
    } else {
      imageWrap.hidden = true;
      docCard.hidden = false;
      previewModal.querySelector('[data-media-preview-doc-name]').textContent = item.originalFilename;
      previewModal.querySelector('[data-media-preview-doc-link]').href = item.publicUrl;
    }

    previewModal.querySelector('[data-media-preview-size]').textContent = formatFileSize(item.sizeBytes) + (item.width ? ` · ${item.width}×${item.height}px` : '');
    previewModal.querySelector('[data-media-alt-input]').value = item.altText || '';
    previewModal.querySelector('[data-media-title-input]').value = item.title || '';
    previewModal.querySelector('[data-media-description-input]').value = item.description || '';
    previewModal.querySelector('[data-media-tags-input]').value = item.tags || '';
    previewModal.querySelector('[data-media-folder-select]').value = item.folder;
    previewModal.querySelector('[data-media-url-input]').value = new URL(item.publicUrl, window.location.origin).href;
    previewModal.querySelector('[data-media-key-input]').value = item.storageKey;

    const altGroup = previewModal.querySelector('[data-media-alt-group]');
    altGroup.hidden = item.mediaType !== 'image';

    previewModal.querySelector('[data-media-delete-trigger]').hidden = Boolean(item.deletedAt);
    previewModal.querySelector('[data-media-restore-trigger]').hidden = !item.deletedAt;
    previewModal.querySelector('[data-media-replace-trigger]').hidden = Boolean(item.deletedAt);

    openModal(previewModal);
  }

  async function saveMetadata() {
    const item = previewModal.currentItem;
    if (!item) return;
    const button = previewModal.querySelector('[data-media-save-metadata]');
    button.disabled = true;
    try {
      const patch = {
        altText: previewModal.querySelector('[data-media-alt-input]').value || null,
        title: previewModal.querySelector('[data-media-title-input]').value || null,
        description: previewModal.querySelector('[data-media-description-input]').value || null,
        tags: previewModal.querySelector('[data-media-tags-input]').value || null,
        folder: previewModal.querySelector('[data-media-folder-select]').value,
      };
      await window.AdminAuth.adminFetch(`${MEDIA_API_BASE}/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      closeModal(previewModal);
      refresh();
    } catch (error) {
      alert(error.message || 'Could not save changes.'); // eslint-disable-line no-alert -- no toast component exists yet; matches this codebase's current error-surfacing options
    } finally {
      button.disabled = false;
    }
  }

  function openDeleteConfirm(item) {
    deleteModal.currentItem = item;
    deleteModal.querySelector('[data-media-delete-name]').textContent = item.originalFilename;
    openModal(deleteModal);
  }

  async function deleteItem(item) {
    if (!item) return;
    try {
      await window.AdminAuth.adminFetch(`${MEDIA_API_BASE}/${item.id}`, { method: 'DELETE' });
      refresh();
    } catch (error) {
      alert(error.message || 'Could not delete this item.'); // eslint-disable-line no-alert
    }
  }

  async function restoreItem(item) {
    if (!item) return;
    try {
      await window.AdminAuth.adminFetch(`${MEDIA_API_BASE}/${item.id}/restore`, { method: 'POST' });
      refresh();
    } catch (error) {
      alert(error.message || 'Could not restore this item.'); // eslint-disable-line no-alert
    }
  }

  function copyToClipboard(input) {
    input.select();
    navigator.clipboard.writeText(input.value).catch(() => {
      document.execCommand('copy'); // fallback for non-secure/older contexts
    });
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString) {
  const date = new Date(isoString.replace(' ', 'T') + 'Z');
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

document.addEventListener('partials:loaded', initAdminMedia);

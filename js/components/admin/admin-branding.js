/**
 * Robayer WealthLab — Branding page, Homepage Modernization Part 4.
 * Drives admin/branding/index.html: lets an editor/super_admin assign a
 * Media Library image to each branding slot (primary logo, dark-mode
 * logo, favicon, and three reserved-for-future slots) without touching
 * any code. A trimmed copy of admin-resource-editor.js's exact
 * media-picker/modal conventions, per this codebase's established
 * per-page-editor pattern (see that file's own header comment for why
 * this isn't a shared module).
 *
 * Runs after admin-shell.js's `requireSession()` gate.
 */

const BRANDING_API_BASE = '/api/admin/branding';
const MEDIA_API_BASE = '/api/admin/media';

const SLOTS = ['primary', 'dark', 'favicon', 'og', 'email', 'appIcon'];

function initAdminBranding() {
  const root = document.querySelector('[data-branding-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const mediaPickerModal = document.querySelector('[data-media-picker-modal]');

  const els = {
    loadError: root.querySelector('[data-branding-load-error]'),
    success: root.querySelector('[data-branding-success]'),
    saveButton: root.querySelector('[data-branding-save]'),
    liveLogo: root.querySelector('[data-branding-live-logo]'),
    liveLogoDark: root.querySelector('[data-branding-live-logo-dark]'),
  };

  // slot -> currently assigned media asset id, or null. Populated from
  // the load response and mutated locally as the admin picks/removes —
  // Save sends this whole map, matching admin-settings.js's "send the
  // full current state" posture rather than diffing changed keys.
  const state = {};

  bindModalShells();
  bindPickers();
  els.saveButton.addEventListener('click', save);

  load();

  async function load() {
    els.loadError.hidden = true;
    try {
      const branding = await window.AdminAuth.adminFetch(BRANDING_API_BASE);
      SLOTS.forEach((slot) => {
        state[slot] = branding[slot].mediaAssetId;
        renderSlot(slot, branding[slot]);
      });
      updateLivePreview();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load branding.';
      els.loadError.hidden = false;
    }
  }

  function renderSlot(slot, assignment) {
    const preview = root.querySelector(`[data-branding-preview="${slot}"]`);
    const removeButton = root.querySelector(`[data-branding-remove="${slot}"]`);
    const meta = root.querySelector(`[data-branding-meta="${slot}"]`);

    preview.innerHTML = '';
    if (assignment.asset) {
      const img = document.createElement('img');
      img.src = assignment.asset.thumbnailPublicUrl || assignment.asset.publicUrl;
      img.alt = '';
      preview.appendChild(img);
      removeButton.hidden = false;

      const dims = assignment.asset.width && assignment.asset.height ? `${assignment.asset.width}×${assignment.asset.height} · ` : '';
      const altText = assignment.asset.altText ? `alt: "${assignment.asset.altText}"` : 'no alt text set';
      meta.textContent = `${dims}${altText} — edit in Media Library`;
    } else {
      removeButton.hidden = true;
      if (assignment.stale) {
        meta.textContent = 'The assigned image was removed from the Media Library. Choose a replacement.';
      } else {
        meta.textContent = slot === 'primary' || slot === 'dark' ? 'Using the static default currently in the site header.' : 'Not set.';
      }
    }
  }

  function bindPickers() {
    root.querySelectorAll('[data-branding-choose]').forEach((button) => {
      const slot = button.getAttribute('data-branding-choose');
      button.addEventListener('click', () => {
        openMediaPicker('image', (item) => {
          state[slot] = item.id;
          renderSlot(slot, { asset: item, mediaAssetId: item.id, stale: false });
          updateLivePreview();
        });
      });
    });
    root.querySelectorAll('[data-branding-remove]').forEach((button) => {
      const slot = button.getAttribute('data-branding-remove');
      button.addEventListener('click', () => {
        state[slot] = null;
        renderSlot(slot, { asset: null, mediaAssetId: null, stale: false });
        updateLivePreview();
      });
    });
  }

  function updateLivePreview() {
    // Uses whatever's already cached in the DOM from the last render
    // (choose/remove already updated the img src via renderSlot's own
    // preview element) rather than a second fetch — cheap and always in
    // sync with what Save is about to send.
    const primaryImg = root.querySelector('[data-branding-preview="primary"] img');
    const darkImg = root.querySelector('[data-branding-preview="dark"] img');
    els.liveLogo.src = primaryImg ? primaryImg.src : '/assets/branding/logo/logo-mark.png';
    els.liveLogoDark.src = darkImg ? darkImg.src : primaryImg ? primaryImg.src : '/assets/branding/logo/logo-mark.png';
  }

  async function save() {
    els.loadError.hidden = true;
    els.success.hidden = true;
    els.saveButton.disabled = true;

    const patch = {};
    SLOTS.forEach((slot) => {
      patch[slot] = state[slot];
    });

    try {
      const branding = await window.AdminAuth.adminFetch(BRANDING_API_BASE, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      SLOTS.forEach((slot) => renderSlot(slot, branding[slot]));
      updateLivePreview();
      els.success.textContent = 'Branding saved. The live site will pick this up on next page load.';
      els.success.hidden = false;
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not save branding.';
      els.loadError.hidden = false;
    } finally {
      els.saveButton.disabled = false;
    }
  }

  // ============================================================
  // Media picker (same pattern as admin-resource-editor.js)
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

        const thumb = document.createElement('img');
        thumb.className = 'media-picker-item__thumb';
        thumb.src = item.thumbnailPublicUrl || item.publicUrl;
        thumb.alt = '';
        button.appendChild(thumb);

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
        empty.textContent = 'No images found. Upload one in the Media Library first.';
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

  function bindModalShells() {
    mediaPickerModal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(mediaPickerModal)));
    mediaPickerModal.addEventListener('click', (event) => {
      if (event.target === mediaPickerModal) closeModal(mediaPickerModal);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !mediaPickerModal.hidden) closeModal(mediaPickerModal);
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

document.addEventListener('partials:loaded', initAdminBranding);

/**
 * Robayer WealthLab — Learning Studio admin page, Digital Library 2.0
 * Phase I. Same adminFetch()/product-loading/form-panel conventions as
 * admin-coupons.js (this project's established simple-CRUD template).
 *
 * Product/asset selection reuses the existing GET /api/admin/products
 * (list) and GET /api/admin/products/:id (detail, for its real
 * published `files`) endpoints - no new catalog endpoint was needed;
 * the asset's own real fileType (never admin-typed) decides whether
 * the page-number or chapter-href anchor field applies, mirroring
 * exactly what libraryLearningAdminService.ts's own server-side
 * validation already enforces.
 */

const LEARNING_API_BASE = '/api/admin/library-learning-items';
const PRODUCTS_API_BASE = '/api/admin/products';
const MIN_CHOICES = 2;
const MAX_CHOICES = 6;

function initAdminLibraryLearning() {
  const root = document.querySelector('[data-learning-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    products: [], // { id, slug, title }
    currentProductSlug: null,
    currentProductAssets: [], // { assetId, fileType, displayName, status }
    items: [],
    editingId: null,
  };

  const els = {
    loadError: root.querySelector('[data-learning-load-error]'),
    actionSuccess: root.querySelector('[data-learning-action-success]'),
    filterProduct: root.querySelector('[data-learning-filter-product]'),
    productPanel: root.querySelector('[data-learning-product-panel]'),
    resultCount: root.querySelector('[data-learning-result-count]'),
    newToggle: root.querySelector('[data-learning-new-toggle]'),
    newCancel: root.querySelector('[data-learning-new-cancel]'),
    formPanel: root.querySelector('[data-learning-form-panel]'),
    form: root.querySelector('[data-learning-form]'),
    formError: root.querySelector('[data-learning-form-error]'),
    formId: root.querySelector('[data-learning-form-id]'),
    formSubmit: root.querySelector('[data-learning-form-submit]'),
    assetSelect: root.querySelector('[data-learning-form-asset]'),
    typeRadios: root.querySelectorAll('[data-learning-form-type]'),
    anchorPageField: root.querySelector('[data-learning-anchor-page-field]'),
    anchorCfiField: root.querySelector('[data-learning-anchor-cfi-field]'),
    anchorPageInput: root.querySelector('[data-learning-form-anchor-page]'),
    anchorCfiInput: root.querySelector('[data-learning-form-anchor-cfi]'),
    sortOrderInput: root.querySelector('[data-learning-form-sort-order]'),
    promptInput: root.querySelector('[data-learning-form-prompt]'),
    quickCheckFields: root.querySelector('[data-learning-quick-check-fields]'),
    actionFields: root.querySelector('[data-learning-action-fields]'),
    choicesWrap: root.querySelector('[data-learning-form-choices]'),
    addChoiceBtn: root.querySelector('[data-learning-add-choice]'),
    explanationInput: root.querySelector('[data-learning-form-explanation]'),
    actionLabelInput: root.querySelector('[data-learning-form-action-label]'),
    statusSelect: root.querySelector('[data-learning-form-status]'),
    empty: root.querySelector('[data-learning-empty]'),
    tableWrap: root.querySelector('[data-learning-table-wrap]'),
    tableBody: root.querySelector('[data-learning-table-body]'),
    previewQuickCheck: root.querySelector('[data-learning-preview-quick-check]'),
    previewAction: root.querySelector('[data-learning-preview-action]'),
    previewPrompt: root.querySelector('[data-learning-preview-prompt]'),
    previewChoices: root.querySelector('[data-learning-preview-choices]'),
    previewActionPrompt: root.querySelector('[data-learning-preview-action-prompt]'),
    previewActionLabel: root.querySelector('[data-learning-preview-action-label]'),
  };

  loadProducts();
  bindProductFilter();
  bindTypeToggle();
  bindChoicesEditor();
  bindLivePreview();
  resetChoicesEditor();
  updatePreview();

  async function loadProducts() {
    try {
      const result = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}?pageSize=200`);
      state.products = result.items;
      result.items.forEach((product) => {
        els.filterProduct.appendChild(new Option(product.title, product.slug));
      });
    } catch (error) {
      showLoadError(error.message || 'Could not load products.');
    }
  }

  function bindProductFilter() {
    els.filterProduct.addEventListener('change', async () => {
      const slug = els.filterProduct.value;
      state.currentProductSlug = slug || null;
      closeForm();
      if (!slug) {
        els.productPanel.hidden = true;
        return;
      }
      els.productPanel.hidden = false;
      await loadProductAssets(slug);
      await refreshItems();
    });
  }

  async function loadProductAssets(slug) {
    els.assetSelect.innerHTML = '';
    const product = state.products.find((p) => p.slug === slug);
    if (!product) return;
    try {
      const detail = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${product.id}`);
      state.currentProductAssets = (detail.files || []).filter((f) => f.status === 'published' && (f.fileType === 'PDF' || f.fileType === 'EPUB'));
      state.currentProductAssets.forEach((asset) => {
        els.assetSelect.appendChild(new Option(`${asset.fileType} — ${asset.displayName}`, asset.assetId));
      });
      onAssetChanged();
    } catch (error) {
      showLoadError(error.message || 'Could not load this product’s assets.');
    }
  }

  els.assetSelect.addEventListener('change', onAssetChanged);

  function onAssetChanged() {
    const asset = state.currentProductAssets.find((a) => a.assetId === els.assetSelect.value);
    const isEpub = asset && asset.fileType === 'EPUB';
    els.anchorPageField.hidden = Boolean(isEpub);
    els.anchorCfiField.hidden = !isEpub;
  }

  function bindTypeToggle() {
    els.typeRadios.forEach((radio) => radio.addEventListener('change', onTypeChanged));
    onTypeChanged();
  }

  function currentItemType() {
    return Array.from(els.typeRadios).find((r) => r.checked).value;
  }

  function onTypeChanged() {
    const isAction = currentItemType() === 'action';
    els.quickCheckFields.hidden = isAction;
    els.actionFields.hidden = !isAction;
    updatePreview();
  }

  // ---- Choices editor ----

  /** Two blank choices, first one marked correct - the honest starting point for a brand-new Quick Check (editing an existing one populates rows directly in openForm() instead, since it also needs the real correct index per row). */
  function resetChoicesEditor() {
    els.choicesWrap.innerHTML = '';
    addChoiceRow('', true);
    addChoiceRow('', false);
    refreshChoicesRemoveButtons();
  }

  function addChoiceRow(value, checked) {
    if (els.choicesWrap.children.length >= MAX_CHOICES) return;
    const row = document.createElement('div');
    row.className = 'drawer__field-row';
    row.style.alignItems = 'center';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'learningCorrectChoice';
    radio.checked = Boolean(checked);
    radio.setAttribute('aria-label', 'Correct answer');
    radio.addEventListener('change', updatePreview);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field__input';
    input.maxLength = 300;
    input.placeholder = 'Choice text';
    input.value = value || '';
    input.addEventListener('input', updatePreview);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn--secondary';
    removeBtn.style.cssText = 'padding:6px 12px;font-size:var(--text-small);';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      row.remove();
      refreshChoicesRemoveButtons();
      updatePreview();
    });

    row.append(radio, input, removeBtn);
    els.choicesWrap.appendChild(row);
  }

  function refreshChoicesRemoveButtons() {
    const rows = Array.from(els.choicesWrap.children);
    rows.forEach((row) => {
      const removeBtn = row.querySelector('button');
      removeBtn.disabled = rows.length <= MIN_CHOICES;
    });
    els.addChoiceBtn.disabled = rows.length >= MAX_CHOICES;
    // Exactly one correct answer, always - if the checked row was just removed, fall back to the first.
    const radios = Array.from(els.choicesWrap.querySelectorAll('input[type="radio"]'));
    if (radios.length > 0 && !radios.some((r) => r.checked)) radios[0].checked = true;
  }

  function bindChoicesEditor() {
    els.addChoiceBtn.addEventListener('click', () => {
      addChoiceRow('', false);
      refreshChoicesRemoveButtons();
      updatePreview();
    });
  }

  function readChoices() {
    return Array.from(els.choicesWrap.children).map((row) => ({
      text: row.querySelector('input[type="text"]').value.trim(),
      correct: row.querySelector('input[type="radio"]').checked,
    }));
  }

  // ---- Live preview ----

  function bindLivePreview() {
    els.promptInput.addEventListener('input', updatePreview);
    els.actionLabelInput.addEventListener('input', updatePreview);
  }

  function updatePreview() {
    const isAction = currentItemType() === 'action';
    els.previewQuickCheck.hidden = isAction;
    els.previewAction.hidden = !isAction;
    if (isAction) {
      els.previewActionPrompt.textContent = els.promptInput.value || 'Your prompt appears here.';
      els.previewActionLabel.textContent = els.actionLabelInput.value || 'Your action label appears here.';
    } else {
      els.previewPrompt.textContent = els.promptInput.value || 'Your prompt appears here.';
      els.previewChoices.innerHTML = '';
      readChoices().forEach((choice) => {
        const label = document.createElement('label');
        label.className = 'learning-overlay__choice';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.disabled = true;
        radio.checked = choice.correct;
        const text = document.createElement('span');
        text.className = 'learning-overlay__choice-text';
        text.textContent = choice.text || '(empty choice)';
        label.append(radio, text);
        els.previewChoices.appendChild(label);
      });
    }
  }

  // ---- Create / edit form ----

  els.newToggle.addEventListener('click', () => openForm(null));
  els.newCancel.addEventListener('click', closeForm);

  function openForm(item) {
    els.form.reset();
    els.formError.hidden = true;
    state.editingId = item ? item.id : null;
    els.formId.value = item ? String(item.id) : '';
    els.formSubmit.textContent = item ? 'Save changes' : 'Create item';

    if (item) {
      els.assetSelect.value = item.assetId;
      onAssetChanged();
      Array.from(els.typeRadios).find((r) => r.value === item.itemType).checked = true;
      els.anchorPageInput.value = item.anchorPageNumber ?? '';
      els.anchorCfiInput.value = item.anchorCfi ?? '';
      els.sortOrderInput.value = item.sortOrder;
      els.promptInput.value = item.prompt;
      els.statusSelect.value = item.status;
      if (item.itemType === 'quick_check') {
        els.choicesWrap.innerHTML = '';
        item.choices.forEach((text, index) => addChoiceRow(text, index === item.correctChoiceIndex));
        refreshChoicesRemoveButtons();
        els.explanationInput.value = item.explanation || '';
      } else {
        resetChoicesEditor();
        els.actionLabelInput.value = item.actionLabel || '';
      }
    } else {
      if (state.currentProductAssets.length > 0) els.assetSelect.value = state.currentProductAssets[0].assetId;
      onAssetChanged();
      resetChoicesEditor();
      els.sortOrderInput.value = '0';
    }

    onTypeChanged();
    updatePreview();
    els.formPanel.hidden = false;
    els.newToggle.hidden = true;
  }

  function closeForm() {
    els.formPanel.hidden = true;
    els.newToggle.hidden = false;
    state.editingId = null;
  }

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.formError.hidden = true;

    const assetId = els.assetSelect.value;
    if (!assetId) {
      showFormError('Choose a target asset.');
      return;
    }
    const itemType = currentItemType();
    const prompt = els.promptInput.value.trim();
    if (!prompt) {
      showFormError('A prompt is required.');
      return;
    }

    const asset = state.currentProductAssets.find((a) => a.assetId === assetId);
    const body = {
      itemType,
      productSlug: state.currentProductSlug,
      assetId,
      anchorPageNumber: asset && asset.fileType === 'PDF' && els.anchorPageInput.value ? Number(els.anchorPageInput.value) : null,
      anchorCfi: asset && asset.fileType === 'EPUB' && els.anchorCfiInput.value ? els.anchorCfiInput.value.trim() : null,
      prompt,
      status: els.statusSelect.value,
      sortOrder: Number(els.sortOrderInput.value) || 0,
    };

    if (itemType === 'quick_check') {
      const choices = readChoices();
      if (choices.some((c) => !c.text)) {
        showFormError('Every choice needs text.');
        return;
      }
      if (choices.length < MIN_CHOICES) {
        showFormError(`At least ${MIN_CHOICES} choices are required.`);
        return;
      }
      const correctIndex = choices.findIndex((c) => c.correct);
      const explanation = els.explanationInput.value.trim();
      if (!explanation) {
        showFormError('An explanation is required — shown to the customer after they answer.');
        return;
      }
      body.choices = choices.map((c) => c.text);
      body.correctChoiceIndex = correctIndex;
      body.explanation = explanation;
    } else {
      const actionLabel = els.actionLabelInput.value.trim();
      if (!actionLabel) {
        showFormError('An action label is required.');
        return;
      }
      body.actionLabel = actionLabel;
    }

    els.formSubmit.disabled = true;
    try {
      if (state.editingId) {
        await window.AdminAuth.adminFetch(`${LEARNING_API_BASE}/${state.editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showActionSuccess('Learning item updated.');
      } else {
        await window.AdminAuth.adminFetch(LEARNING_API_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        showActionSuccess('Learning item created.');
      }
      closeForm();
      await refreshItems();
    } catch (error) {
      showFormError(error.message || 'Could not save this learning item.');
    } finally {
      els.formSubmit.disabled = false;
    }
  });

  // ---- List ----

  async function refreshItems() {
    els.loadError.hidden = true;
    try {
      const result = await window.AdminAuth.adminFetch(`${LEARNING_API_BASE}?productSlug=${encodeURIComponent(state.currentProductSlug)}`);
      state.items = result.items;
      renderTable();
    } catch (error) {
      showLoadError(error.message || 'Could not load learning items.');
    }
  }

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.empty.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.resultCount.textContent = state.items.length === 1 ? '1 learning item' : `${state.items.length} learning items`;
    if (!hasItems) return;
    state.items.forEach((item) => els.tableBody.appendChild(buildRow(item)));
  }

  function buildRow(item) {
    const row = document.createElement('tr');

    const typeCell = document.createElement('td');
    typeCell.textContent = item.itemType === 'quick_check' ? 'Quick Check' : 'Action';

    const assetCell = document.createElement('td');
    assetCell.textContent = item.format;

    const anchorCell = document.createElement('td');
    anchorCell.style.fontFamily = 'var(--font-mono)';
    anchorCell.textContent = item.anchorPageNumber != null ? `Page ${item.anchorPageNumber}` : item.anchorCfi || '—';

    const promptCell = document.createElement('td');
    promptCell.textContent = item.prompt.length > 70 ? `${item.prompt.slice(0, 70)}…` : item.prompt;

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item));

    const actionsCell = document.createElement('td');
    actionsCell.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

    const editBtn = smallButton('Edit', () => openForm(item));
    actionsCell.appendChild(editBtn);

    if (item.archivedAt) {
      actionsCell.appendChild(smallButton('Restore', () => restoreItem(item.id)));
    } else {
      actionsCell.appendChild(smallButton('Archive', () => archiveItem(item.id)));
      actionsCell.appendChild(smallButton('Delete', () => deleteItem(item.id)));
    }

    row.append(typeCell, assetCell, anchorCell, promptCell, statusCell, actionsCell);
    return row;
  }

  function smallButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--secondary';
    btn.style.cssText = 'padding:6px 12px;font-size:var(--text-small);';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function statusBadge(item) {
    const badge = document.createElement('span');
    if (item.archivedAt) {
      badge.className = 'badge badge--warning';
      badge.textContent = 'Archived';
    } else {
      const variants = { published: 'badge--success', draft: 'badge--info' };
      badge.className = `badge ${variants[item.status] || 'badge--info'}`;
      badge.textContent = item.status.charAt(0).toUpperCase() + item.status.slice(1);
    }
    return badge;
  }

  async function archiveItem(id) {
    els.loadError.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${LEARNING_API_BASE}/${id}/archive`, { method: 'POST' });
      showActionSuccess('Learning item archived — it will no longer appear to customers, but its history is preserved.');
      await refreshItems();
    } catch (error) {
      showLoadError(error.message || 'Could not archive this item.');
    }
  }

  async function restoreItem(id) {
    els.loadError.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${LEARNING_API_BASE}/${id}/restore`, { method: 'POST' });
      showActionSuccess('Learning item restored.');
      await refreshItems();
    } catch (error) {
      showLoadError(error.message || 'Could not restore this item.');
    }
  }

  async function deleteItem(id) {
    els.loadError.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${LEARNING_API_BASE}/${id}`, { method: 'DELETE' });
      showActionSuccess('Learning item permanently deleted.');
      await refreshItems();
    } catch (error) {
      // The service refuses to hard-delete an item with real customer
      // responses (see libraryLearningAdminService.ts) - surfaced here
      // as a normal, expected error, not a bug.
      showLoadError(error.message || 'Could not delete this item.');
    }
  }

  function showLoadError(message) {
    els.loadError.textContent = message;
    els.loadError.hidden = false;
  }
  function showFormError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
  }
  function showActionSuccess(message) {
    els.actionSuccess.textContent = message;
    els.actionSuccess.hidden = false;
  }
}

document.addEventListener('partials:loaded', initAdminLibraryLearning);

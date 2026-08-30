/**
 * Robayer WealthLab: Interactive Learning overlay — Digital Library 2.0
 * Phase H. Drives dashboard/read/index.html's `.learning-overlay`, a
 * separate, independent component from library-reader.js (this
 * project's established one-script-per-concern convention, matching
 * library-ai-panel.js), coordinated purely by DOM events
 * library-reader.js already dispatches: `library-reader:ready` (once,
 * to learn which resource is open and fetch its real published
 * learning items), `library-reader:page-changed` (PDF - fires on every
 * page render) and `library-reader:section-changed` (EPUB - fires only
 * when the spine item itself changes, added this phase).
 *
 * Every question/answer/explanation shown here comes verbatim from
 * GET /api/customer/purchases/:reference/learning-items — real,
 * admin-authored, book-grounded content (see
 * services/libraryLearningAdminService.ts's own header comment on why
 * grounding is the author's responsibility, never generated at serve
 * time). Grading is never computed client-side; "Check Answer" submits
 * to the server and renders whatever it returns.
 *
 * At most one item shown at a time, at most once per item per reading
 * session (already-answered items are excluded by the server's own
 * response join before this file ever sees them; a shown-but-dismissed
 * item is tracked locally so scrolling back past its anchor doesn't
 * re-interrupt reading).
 */

function initLibraryLearning() {
  const backdrop = document.querySelector('[data-learning-backdrop]');
  const overlay = document.querySelector('[data-learning-overlay]');
  if (!overlay || !backdrop || overlay.hasAttribute('data-bound')) return;
  overlay.setAttribute('data-bound', 'true');

  const closeBtn = document.querySelector('[data-learning-close]');
  const quickCheckEl = document.querySelector('[data-learning-quick-check]');
  const promptEl = document.querySelector('[data-learning-prompt]');
  const choicesEl = document.querySelector('[data-learning-choices]');
  const checkAnswerBtn = document.querySelector('[data-learning-check-answer]');
  const feedbackEl = document.querySelector('[data-learning-feedback]');
  const feedbackVerdictEl = document.querySelector('[data-learning-feedback-verdict]');
  const feedbackExplanationEl = document.querySelector('[data-learning-feedback-explanation]');
  const continueBtn = document.querySelector('[data-learning-continue]');
  const actionEl = document.querySelector('[data-learning-action]');
  const actionPromptEl = document.querySelector('[data-learning-action-prompt]');
  const actionLabelEl = document.querySelector('[data-learning-action-label]');
  const actionDoneBtn = document.querySelector('[data-learning-action-done]');
  const actionSkipBtn = document.querySelector('[data-learning-action-skip]');

  let purchaseReference = null;
  let assetId = null;
  let productSlug = null;
  let items = [];
  const shownItemIds = new Set();
  let currentItem = null;
  let selectedChoiceIndex = null;
  let submitting = false;

  document.addEventListener('library-reader:ready', (event) => {
    purchaseReference = event.detail.purchaseReference;
    assetId = event.detail.assetId;
    productSlug = event.detail.productSlug;
    load();
  });
  document.addEventListener('library-reader:page-changed', (event) => {
    maybeShowForPage(event.detail.currentPage);
  });
  document.addEventListener('library-reader:section-changed', (event) => {
    maybeShowForSection(event.detail.href);
  });

  async function load() {
    try {
      const result = await window.CustomerDashboard.customerFetch(
        `/api/customer/purchases/${encodeURIComponent(purchaseReference)}/learning-items?assetId=${encodeURIComponent(assetId)}`
      );
      // A response already present means this customer already
      // answered/completed it on another device or an earlier session
      // - never re-interrupt reading for something already done.
      items = (result.items || []).filter((item) => !item.response);
    } catch {
      // A missed learning overlay is never worth disrupting reading over - fail silently.
      items = [];
    }
  }

  function maybeShowForPage(currentPage) {
    if (currentItem || typeof currentPage !== 'number') return;
    const next = items.find((item) => !shownItemIds.has(item.id) && item.anchorPageNumber != null && currentPage >= item.anchorPageNumber);
    if (next) show(next);
  }

  function maybeShowForSection(href) {
    if (currentItem || !href) return;
    const next = items.find((item) => !shownItemIds.has(item.id) && item.anchorCfi != null && item.anchorCfi === href);
    if (next) show(next);
  }

  function show(item) {
    currentItem = item;
    shownItemIds.add(item.id);
    selectedChoiceIndex = null;

    quickCheckEl.hidden = item.itemType !== 'quick_check';
    actionEl.hidden = item.itemType !== 'action';

    if (item.itemType === 'quick_check') {
      promptEl.textContent = item.prompt;
      choicesEl.innerHTML = '';
      feedbackEl.hidden = true;
      checkAnswerBtn.hidden = false;
      checkAnswerBtn.disabled = true;
      item.choices.forEach((choiceText, index) => {
        choicesEl.appendChild(renderChoice(choiceText, index));
      });
    } else {
      actionPromptEl.textContent = item.prompt;
      actionLabelEl.textContent = item.actionLabel;
      actionDoneBtn.disabled = false;
      actionDoneBtn.textContent = '✓ Done';
    }

    open();
  }

  function renderChoice(choiceText, index) {
    const label = document.createElement('label');
    label.className = 'learning-overlay__choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'learning-choice';
    input.value = String(index);
    input.addEventListener('change', () => {
      selectedChoiceIndex = index;
      checkAnswerBtn.disabled = false;
    });
    const text = document.createElement('span');
    text.className = 'learning-overlay__choice-text';
    text.textContent = choiceText;
    label.appendChild(input);
    label.appendChild(text);
    return label;
  }

  checkAnswerBtn.addEventListener('click', async () => {
    if (submitting || selectedChoiceIndex === null || !currentItem) return;
    submitting = true;
    checkAnswerBtn.disabled = true;
    const item = currentItem;
    try {
      const result = await window.CustomerDashboard.customerFetch(
        `/api/customer/purchases/${encodeURIComponent(purchaseReference)}/learning-items/${item.id}/response?assetId=${encodeURIComponent(assetId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex }) }
      );
      renderQuickCheckFeedback(result, selectedChoiceIndex);
      if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent(result.isCorrect ? 'library-quick-check-correct' : 'library-quick-check-incorrect', productSlug);
    } catch {
      // A grading failure should never trap the reader - let them continue.
      feedbackEl.hidden = false;
      feedbackVerdictEl.textContent = "Couldn't check your answer right now.";
      feedbackVerdictEl.className = 'learning-overlay__feedback-verdict';
      feedbackExplanationEl.textContent = 'Please try again later — this never affects your reading progress.';
    } finally {
      submitting = false;
    }
  });

  function renderQuickCheckFeedback(result, chosenIndex) {
    Array.from(choicesEl.children).forEach((label, index) => {
      const input = label.querySelector('input');
      input.disabled = true;
      if (index === result.correctChoiceIndex) label.classList.add('learning-overlay__choice--correct');
      else if (index === chosenIndex) label.classList.add('learning-overlay__choice--incorrect');
    });
    checkAnswerBtn.hidden = true;
    feedbackEl.hidden = false;
    feedbackVerdictEl.textContent = result.isCorrect ? '✅ Correct.' : '❌ Not quite.';
    feedbackVerdictEl.className = `learning-overlay__feedback-verdict learning-overlay__feedback-verdict--${result.isCorrect ? 'correct' : 'incorrect'}`;
    feedbackExplanationEl.textContent = result.explanation;
  }

  actionDoneBtn.addEventListener('click', async () => {
    if (submitting || !currentItem) return;
    submitting = true;
    const item = currentItem;
    try {
      await window.CustomerDashboard.customerFetch(
        `/api/customer/purchases/${encodeURIComponent(purchaseReference)}/learning-items/${item.id}/response?assetId=${encodeURIComponent(assetId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemType: 'action', actionDone: true }) }
      );
      if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-action-done', productSlug);
    } catch {
      // Non-fatal - the local "shown" state still prevents re-nagging this session either way.
    } finally {
      submitting = false;
      actionDoneBtn.textContent = '✓ Saved';
      setTimeout(close, 700);
    }
  });

  actionSkipBtn.addEventListener('click', close);
  continueBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) close();
  });

  function open() {
    overlay.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      overlay.classList.add('learning-overlay--open');
      backdrop.classList.add('reader-drawer-backdrop--visible');
    });
    closeBtn.focus();
  }

  function close() {
    overlay.classList.remove('learning-overlay--open');
    backdrop.classList.remove('reader-drawer-backdrop--visible');
    setTimeout(() => {
      overlay.hidden = true;
      backdrop.hidden = true;
      currentItem = null;
    }, 220);
  }
}

document.addEventListener('partials:loaded', initLibraryLearning);
document.addEventListener('DOMContentLoaded', initLibraryLearning);

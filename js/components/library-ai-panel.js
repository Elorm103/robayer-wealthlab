/**
 * Robayer WealthLab: AI Reading Assistant panel — Digital Library
 * Phase 7C. Drives dashboard/read/index.html's `.ai-panel`, a separate,
 * independent component from library-reader.js (this project's
 * established one-script-per-concern convention), coordinated purely
 * by two DOM events library-reader.js dispatches:
 * `library-reader:ready` (once, when the resource/book is known) and
 * `library-reader:page-changed` (on every page render, for context).
 *
 * Never rendered as a floating site-wide widget — this panel does not
 * exist outside an active reading session, and every question it sends
 * is scoped to the exact resource currently open. The server
 * (POST /api/customer/library/ai/ask) re-verifies ownership on every
 * single request regardless of what this file already knows; nothing
 * here is a security boundary, only a UI for one that lives entirely
 * server-side — see backend/services/libraryKnowledge/answerService.ts.
 */

const MODE_LABELS = {
  explain: 'Explain',
  summarize: 'Summarize',
  teach: 'Teach Me',
  example: 'Example',
  quiz: 'Quiz Me',
  key_takeaways: 'Key Takeaways',
  ask: 'Ask',
};

/**
 * Phase J.2.1 fix — was `citations.filter((c) => c.pageNumber != null)`,
 * which silently dropped every EPUB citation: EPUB chunks carry `cfi`
 * (the chapter file's own href — see searchService.ts's own comment)
 * and `pageNumber` is always null for them, exactly the inverse of PDF.
 * A citation is "real" if it has either real location a book can
 * actually use to navigate — never both, per the format-specific
 * position convention this codebase already uses everywhere else
 * (library_bookmarks, library_learning_items). Extracted as a top-level,
 * DOM-free function so it can be exercised directly by
 * tests/frontend/library-ai-panel.citations.test.js, not only inferred
 * from reading the code.
 */
function isRealCitation(c) {
  return c.pageNumber != null || c.cfi != null;
}

/**
 * PDF: unchanged. EPUB: a real chapter title when the extraction found
 * one; otherwise an honest, non-fabricated location label — never a
 * made-up chapter name or page number (cfi here is a chapter href, not
 * a numbered position, so "This section" is the truthful description,
 * matching this codebase's existing "Saved position" fallback for an
 * EPUB bookmark with no title). Extracted for the same testability
 * reason as isRealCitation() above.
 */
function formatCitationLabel(c) {
  if (c.pageNumber != null) return c.chapterTitle ? `${c.chapterTitle} · Page ${c.pageNumber}` : `Page ${c.pageNumber}`;
  return c.chapterTitle || 'This section';
}

function initLibraryAiPanel() {
  const panel = document.querySelector('[data-ai-panel]');
  const trigger = document.querySelector('[data-ai-panel-trigger]');
  if (!panel || !trigger || panel.hasAttribute('data-bound')) return;
  panel.setAttribute('data-bound', 'true');

  const backdrop = document.querySelector('[data-ai-panel-backdrop]');
  const closeBtn = document.querySelector('[data-ai-panel-close]');
  const subtitleEl = document.querySelector('[data-ai-panel-subtitle]');
  const modesEl = document.querySelector('[data-ai-panel-modes]');
  const threadEl = document.querySelector('[data-ai-panel-thread]');
  const emptyStateEl = document.querySelector('[data-ai-panel-empty]');
  const errorEl = document.querySelector('[data-ai-panel-error]');
  const form = document.querySelector('[data-ai-panel-form]');
  const input = document.querySelector('[data-ai-panel-input]');
  const sendBtn = document.querySelector('[data-ai-panel-send]');

  let purchaseReference = null;
  let assetId = null;
  let productSlug = null;
  let currentPage = null;
  let requestInFlight = false;

  document.addEventListener('library-reader:ready', (event) => {
    purchaseReference = event.detail.purchaseReference;
    assetId = event.detail.assetId;
    productSlug = event.detail.productSlug;
    if (event.detail.supportsAi) {
      trigger.hidden = false;
      subtitleEl.textContent = `Ask about "${event.detail.bookTitle}" — grounded in this book only.`;
      // Digital Library Phase F — the Library home's "Ask Robayer AI"
      // entry point deep-links here with `?ai=1` so the real, existing
      // panel opens immediately with the book already in context,
      // rather than a second, parallel AI interface living on the
      // Library page itself. Absent for every normal reading link, so
      // opening a book to just read never opens this uninvited.
      if (new URLSearchParams(window.location.search).get('ai') === '1') openPanel();
    }
  });

  document.addEventListener('library-reader:page-changed', (event) => {
    currentPage = event.detail.currentPage;
  });

  trigger.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  backdrop.addEventListener('click', closePanel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
  });

  modesEl.querySelectorAll('[data-ai-mode]').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (requestInFlight) return;
      askQuestion(chip.getAttribute('data-ai-mode'), '');
    });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || requestInFlight) return;
    askQuestion('ask', question);
    input.value = '';
  });

  function openPanel() {
    panel.hidden = false;
    backdrop.hidden = false;
    // Reflow before adding the class so the CSS transition actually plays, not a same-frame snap.
    requestAnimationFrame(() => {
      panel.classList.add('ai-panel--open');
      backdrop.classList.add('ai-panel-backdrop--visible');
    });
    input.focus();
  }

  function closePanel() {
    panel.classList.remove('ai-panel--open');
    backdrop.classList.remove('ai-panel-backdrop--visible');
    setTimeout(() => {
      panel.hidden = true;
      backdrop.hidden = true;
    }, 220); // matches the CSS transition duration - avoids a visible snap before the slide-out finishes
    trigger.focus();
  }

  function showError(message) {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function setBusy(busy) {
    requestInFlight = busy;
    sendBtn.disabled = busy;
    input.disabled = busy;
    modesEl.querySelectorAll('[data-ai-mode]').forEach((chip) => (chip.disabled = busy));
  }

  async function askQuestion(mode, question) {
    if (!purchaseReference || !assetId) return;
    clearError();
    emptyStateEl.hidden = true;

    const questionBubble = appendBubble('question', question || MODE_LABELS[mode]);
    const thinkingBubble = appendBubble('answer', 'Thinking…', { pending: true });
    setBusy(true);

    try {
      const result = await window.CustomerDashboard.customerFetch('/api/customer/library/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseReference, assetId, mode, question, currentPage }),
      });

      thinkingBubble.remove();

      if (result.status === 'declined') {
        appendBubble('answer', "I couldn't find enough information about that in this book. Try rephrasing, or ask about a different part of what you're reading.");
      } else {
        appendAnswerBubble(result.answer, result.citations || []);
      }
    } catch (error) {
      thinkingBubble.remove();
      questionBubble.remove();
      showError(error.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      threadEl.scrollTop = threadEl.scrollHeight;
    }
  }

  function appendBubble(kind, text, opts) {
    const bubble = document.createElement('div');
    bubble.className = `ai-panel__bubble ai-panel__bubble--${kind}${opts && opts.pending ? ' ai-panel__bubble--pending' : ''}`;
    bubble.textContent = text;
    threadEl.appendChild(bubble);
    threadEl.scrollTop = threadEl.scrollHeight;
    return bubble;
  }

  function appendAnswerBubble(text, citations) {
    const bubble = document.createElement('div');
    bubble.className = 'ai-panel__bubble ai-panel__bubble--answer';

    const textEl = document.createElement('p');
    textEl.className = 'ai-panel__bubble-text';
    textEl.textContent = text;
    bubble.appendChild(textEl);

    const realCitations = citations.filter(isRealCitation);
    if (realCitations.length > 0) {
      const citeWrap = document.createElement('div');
      citeWrap.className = 'ai-panel__citations';
      realCitations.forEach((c) => {
        const citeBtn = document.createElement('button');
        citeBtn.type = 'button';
        citeBtn.className = 'ai-panel__citation';
        citeBtn.textContent = formatCitationLabel(c);
        citeBtn.addEventListener('click', () => {
          // Phase 8 (Digital Library Observability) — a real citation
          // click, distinct from the citations the AI merely returns
          // (already recorded server-side in
          // library_ai_message_citations); this is the customer
          // actually using one.
          if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-ai-citation-click', productSlug);
          // Phase J.2.1 — carries both; library-reader.js's PDF listener
          // (wireControls()) reads pageNumber, its EPUB listener
          // (wireEpubControls()) reads cfi, exactly like every other
          // format-specific position pair in this codebase. Only one of
          // the two branches is ever wired for a given reader session, so
          // there is no ambiguity about which one actually navigates.
          document.dispatchEvent(new CustomEvent('library-ai-panel:go-to-page', { detail: { pageNumber: c.pageNumber, cfi: c.cfi } }));
        });
        citeWrap.appendChild(citeBtn);
      });
      bubble.appendChild(citeWrap);
    }

    threadEl.appendChild(bubble);
    threadEl.scrollTop = threadEl.scrollHeight;
    return bubble;
  }
}

document.addEventListener('partials:loaded', initLibraryAiPanel);
document.addEventListener('DOMContentLoaded', initLibraryAiPanel);

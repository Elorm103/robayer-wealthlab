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
 *
 * Phase 4 (Robayer AI chapter-context architecture) addition: also
 * listens for `library-reader:section-changed` (EPUB — dispatched by
 * both the legacy epub.js reader and the controlled chapter-scoped
 * reader's own chapter renders) to track the reader's current chapter
 * href, sent as `currentHref` alongside the existing `currentPage`
 * (PDF) so the server can resolve LEVEL 1 (current chapter) context —
 * see answerService.ts's own header comment on the 5-level hierarchy.
 * Sending a stale/wrong href is not a security concern: the server only
 * ever matches it against this SAME already-authorized book's own
 * chapters (searchService.ts's resolveCurrentChapter()).
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
  let bookTitle = null;
  let currentPage = null;
  let currentHref = null;
  let requestInFlight = false;
  /**
   * Phase 5 (Priority I: AI context bar) — the real, server-resolved
   * chapter title, learned only from an actual answered response's own
   * citations (answerService.ts's resolveCurrentChapter() result) —
   * never guessed or fabricated client-side from currentPage/currentHref
   * alone, which the client cannot itself resolve to a title. Cleared
   * on every position change so a stale chapter name is never shown
   * once the reader has moved on to a fresh position the AI hasn't
   * confirmed yet.
   */
  let knownChapterTitle = null;

  document.addEventListener('library-reader:ready', (event) => {
    purchaseReference = event.detail.purchaseReference;
    assetId = event.detail.assetId;
    productSlug = event.detail.productSlug;
    bookTitle = event.detail.bookTitle;
    currentPage = null;
    currentHref = null;
    if (event.detail.supportsAi) {
      trigger.hidden = false;
      updateSubtitle();
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
    knownChapterTitle = null; // a new page may be a new chapter - the old title is no longer confirmed
    updateSubtitle();
  });

  // Phase 4 (Robayer AI chapter-context architecture) — EPUB only; see
  // this file's own header comment. PDF's position signal is already
  // covered by 'library-reader:page-changed' above.
  document.addEventListener('library-reader:section-changed', (event) => {
    currentHref = event.detail.href;
    knownChapterTitle = null;
    updateSubtitle();
  });

  /**
   * Reader-aware context display (Section F, refined Phase 5 Priority
   * I). Eliminates the ambiguity Priority I calls out — "what is the AI
   * currently reading?" — with the most honest answer available at each
   * moment: before any question has been asked this position, a plain
   * page number (PDF) or nothing (EPUB, which has no client-known
   * chapter TITLE, only an internal href); once a real answer has come
   * back and confirmed a chapter (see askQuestion()'s own citations
   * handling below), the actual chapter title, since that is now a real
   * server-confirmed fact, not a guess. Updates live as the reader turns
   * pages/chapters — knownChapterTitle is reset on every position change
   * above, so a stale chapter name is never shown for a position the AI
   * hasn't actually confirmed yet.
   */
  function updateSubtitle() {
    let context;
    if (knownChapterTitle) {
      context = ` — AI context: ${knownChapterTitle}`;
    } else if (currentPage != null) {
      context = ` — page ${currentPage}`;
    } else {
      context = '';
    }
    subtitleEl.textContent = `Ask about "${bookTitle}" — grounded in this book only${context}.`;
  }

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
        body: JSON.stringify({ purchaseReference, assetId, mode, question, currentPage, currentHref }),
      });

      thinkingBubble.remove();

      if (result.status === 'declined') {
        appendBubble('answer', "I couldn't find enough information about that in this book. Try rephrasing, or ask about a different part of what you're reading.");
      } else {
        appendAnswerBubble(result.answer, result.citations || []);
        // Phase 5 (Priority I) — a 'high' confidence answer with a
        // citation carrying a chapterTitle means answerService.ts's
        // resolveCurrentChapter() genuinely resolved LEVEL 1 for this
        // exact request; that real title now confirms what the context
        // line shows, in place of the plain page number.
        const resolvedTitle = result.confidenceTier === 'high' ? (result.citations || []).find((c) => c.chapterTitle)?.chapterTitle : null;
        if (resolvedTitle && resolvedTitle !== knownChapterTitle) {
          knownChapterTitle = resolvedTitle;
          updateSubtitle();
        }
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

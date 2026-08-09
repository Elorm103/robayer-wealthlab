/**
 * Robayer WealthLab: Customer AI Assistant — Version 5.0 Milestone 3.
 *
 * Progressive enhancement for [data-ai-chat]. Talks to
 * POST /api/customer/ai-assistant/ask and
 * POST /api/customer/ai-assistant/feedback (backend:
 * routes/customer/aiAssistant.ts). Stateless per the founder's
 * decision: nothing about a visitor's identity is ever stored — a
 * sessionId (sessionStorage-scoped, cleared when the tab closes) only
 * groups this browser session's turns for the backend's own
 * observability, and the FULL conversation context lives here, in
 * memory, resent with each new question so the assistant can handle
 * natural follow-ups without the server persisting anything.
 *
 * "Streaming responses" is simulated client-side (see revealAnswer()):
 * the backend's AI Gateway call is synchronous and ungoverned-response
 * streaming was deliberately not built into it (founder decision — see
 * docs/v5.0-milestone-3-engineering-report.md) — the complete, already-
 * governed answer is revealed progressively here purely for a
 * natural chat feel, not fetched incrementally.
 */

const AI_ASK_URL = '/api/customer/ai-assistant/ask';
const AI_FEEDBACK_URL = '/api/customer/ai-assistant/feedback';
const SESSION_STORAGE_KEY = 'robayer_ai_session_id';
const HISTORY_STORAGE_KEY = 'robayer_ai_history'; // sessionStorage only — cleared on tab close, never sent anywhere but this browser's own future requests in the same tab

const CONFIDENCE_LABEL = {
  high: 'High confidence',
  medium: 'Somewhat confident',
  low: 'Limited confidence',
};

const CONFIDENCE_BADGE_CLASS = {
  high: 'badge--success',
  medium: 'badge--info',
  low: 'badge--warning',
};

function initAiAssistant() {
  const root = document.querySelector('[data-ai-chat]:not([data-bound])');
  if (!root) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    messages: root.querySelector('[data-ai-messages]'),
    suggestions: root.querySelector('[data-ai-suggestions]'),
    errorBanner: root.querySelector('[data-ai-error]'),
    errorText: root.querySelector('[data-ai-error-text]'),
    retryButton: root.querySelector('[data-ai-retry]'),
    composer: root.querySelector('[data-ai-composer]'),
    input: root.querySelector('[data-ai-input]'),
    sendButton: root.querySelector('[data-ai-send]'),
    resetButton: root.querySelector('[data-ai-reset]'),
  };

  let sessionId = getOrCreateSessionId();
  let history = loadHistory(); // [{question, answer}], resent with each request — see header comment
  let pendingRequest = null; // { question } — the last question that failed, for Retry
  let isSending = false;

  renderHistory();

  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submitQuestion();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitQuestion();
    }
  });

  els.resetButton.addEventListener('click', () => {
    history = [];
    saveHistory();
    sessionId = createSessionId();
    els.messages.innerHTML = '';
    els.suggestions.hidden = true;
    els.suggestions.innerHTML = '';
    hideError();
    els.input.value = '';
    els.input.focus();
  });

  els.retryButton.addEventListener('click', () => {
    if (!pendingRequest) return;
    hideError();
    void sendQuestion(pendingRequest.question);
  });

  function getOrCreateSessionId() {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    return createSessionId();
  }

  function createSessionId() {
    const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    return id;
  }

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(HISTORY_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {
      // sessionStorage unavailable (private browsing, quota) — the
      // conversation simply won't survive a reload; still fully
      // functional for the current page view via the in-memory array.
    }
  }

  function renderHistory() {
    history.forEach((turn) => {
      appendMessage('user', turn.question);
      appendAssistantMessageStatic(turn.answer);
    });
    scrollToBottom();
  }

  function submitQuestion() {
    const question = els.input.value.trim();
    if (!question || isSending) return;
    els.input.value = '';
    void sendQuestion(question);
  }

  async function sendQuestion(question) {
    hideError();
    isSending = true;
    setComposerDisabled(true);
    pendingRequest = { question };

    appendMessage('user', question);
    scrollToBottom();
    const typingEl = appendTypingIndicator();

    try {
      const response = await fetch(AI_ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: history.slice(-4), sessionId }),
      });

      const body = await response.json().catch(() => null);
      typingEl.remove();

      if (!response.ok || !body || body.success === false) {
        const message = (body && body.error && body.error.message) || 'Something went wrong. Please try again.';
        showError(message);
        return;
      }

      const result = body.data;
      pendingRequest = null;

      if (result.status === 'declined') {
        appendDeclinedMessage(result);
      } else if (result.status === 'error') {
        appendErrorMessage();
      } else {
        await appendAssistantMessage(result);
        history.push({ question, answer: result.answer });
        saveHistory();

        // Version 5.0 (Customer Acquisition Phase 6) — a genuinely
        // answered turn only (not 'declined'/'error', which aren't a
        // real, useful AI interaction). Never includes the visitor's
        // question text itself — Meta receives only the confidence
        // tier, matching this feature's own "nothing about a visitor's
        // identity or content is ever stored/sent" stance (see this
        // file's header comment).
        if (window.RobayerTracking) {
          window.RobayerTracking.track('AskAI', { content_category: result.confidenceTier });
        }
      }

      renderSuggestions(result.suggestedFollowUps || []);
    } catch (err) {
      typingEl.remove();
      showError('Could not reach the assistant — please check your connection and try again.');
    } finally {
      isSending = false;
      setComposerDisabled(false);
      scrollToBottom();
    }
  }

  function setComposerDisabled(disabled) {
    els.input.disabled = disabled;
    els.sendButton.disabled = disabled;
  }

  function showError(message) {
    els.errorText.textContent = message;
    els.errorBanner.hidden = false;
  }

  function hideError() {
    els.errorBanner.hidden = true;
  }

  function appendMessage(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-chat__message ai-chat__message--${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat__bubble';
    bubble.textContent = text; // user's own text — never rendered as HTML
    wrapper.appendChild(bubble);
    els.messages.appendChild(wrapper);
    return wrapper;
  }

  function appendTypingIndicator() {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-chat__message ai-chat__message--assistant';
    wrapper.innerHTML = '<div class="ai-chat__typing" aria-label="Assistant is typing"><span></span><span></span><span></span></div>';
    els.messages.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
  }

  function appendDeclinedMessage(result) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-chat__message ai-chat__message--assistant ai-chat__message--declined';
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat__bubble';
    bubble.textContent = "I don't have enough reliable information in Robayer WealthLab's own content to answer that well. Rather than guess, I'd rather point you toward browsing our site directly — try the Investment Centre, Blog, or Resources for related topics.";
    wrapper.appendChild(bubble);
    els.messages.appendChild(wrapper);
  }

  function appendErrorMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-chat__message ai-chat__message--assistant ai-chat__message--error';
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat__bubble';
    bubble.textContent = "I ran into a problem generating an answer. Please try asking again.";
    wrapper.appendChild(bubble);
    els.messages.appendChild(wrapper);
  }

  /** Renders a past, already-complete turn (from history) — no streaming reveal, since it already happened in a prior render. */
  function appendAssistantMessageStatic(answerText) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-chat__message ai-chat__message--assistant';
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat__bubble';
    bubble.innerHTML = renderMarkdown(answerText);
    wrapper.appendChild(bubble);
    els.messages.appendChild(wrapper);
  }

  /** Renders a fresh answer with a simulated typing reveal, then the full markdown render, citations, confidence badge, and action buttons (copy/regenerate/feedback). */
  async function appendAssistantMessage(result) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-chat__message ai-chat__message--assistant';
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat__bubble';
    wrapper.appendChild(bubble);
    els.messages.appendChild(wrapper);

    await revealAnswer(bubble, result.answer);
    bubble.innerHTML = renderMarkdown(result.answer);

    const meta = document.createElement('div');
    meta.className = 'ai-chat__meta';
    const badgeClass = CONFIDENCE_BADGE_CLASS[result.confidenceTier] || 'badge--info';
    const label = CONFIDENCE_LABEL[result.confidenceTier] || 'Confidence';
    meta.innerHTML = `<span class="badge ${badgeClass} ai-chat__confidence">${escapeHtml(label)}</span>`;
    wrapper.appendChild(meta);

    if (result.citations && result.citations.length > 0) {
      wrapper.appendChild(renderCitations(result.citations));
    }

    wrapper.appendChild(renderActions(result));

    scrollToBottom();
  }

  /** Simulated streaming — reveals the already-complete, already-governed answer as plain text in small growing chunks, purely for a natural typing feel. Never partially-rendered HTML mid-reveal (avoids malformed markup from a half-formed markdown tag) — the full markdown render only happens once, after this completes. */
  function revealAnswer(bubbleEl, fullText) {
    return new Promise((resolve) => {
      const words = fullText.split(/(\s+)/);
      let i = 0;
      const chunkSize = Math.max(1, Math.ceil(words.length / 40)); // ~40 reveal steps regardless of answer length
      const tick = () => {
        i = Math.min(words.length, i + chunkSize);
        bubbleEl.textContent = words.slice(0, i).join('');
        scrollToBottom();
        if (i < words.length) {
          setTimeout(tick, 16);
        } else {
          resolve();
        }
      };
      tick();
    });
  }

  function renderCitations(citations) {
    const container = document.createElement('div');
    container.className = 'ai-chat__citations';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ai-chat__citations-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `Show ${citations.length} source${citations.length === 1 ? '' : 's'}`;

    const list = document.createElement('div');
    list.className = 'ai-chat__citations';
    list.hidden = true;
    citations.forEach((c) => {
      const link = document.createElement(c.url ? 'a' : 'div');
      link.className = 'ai-chat__citation';
      if (c.url) {
        link.href = c.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      const titleEl = document.createElement('span');
      titleEl.className = 'ai-chat__citation-title';
      titleEl.textContent = c.title;
      link.appendChild(titleEl);
      list.appendChild(link);
    });

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      list.hidden = expanded;
      toggle.textContent = expanded ? `Show ${citations.length} source${citations.length === 1 ? '' : 's'}` : 'Hide sources';
    });

    container.appendChild(toggle);
    container.appendChild(list);
    return container;
  }

  function renderActions(result) {
    const actions = document.createElement('div');
    actions.className = 'ai-chat__actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ai-chat__action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(result.answer).then(() => {
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });
    actions.appendChild(copyBtn);

    const regenBtn = document.createElement('button');
    regenBtn.type = 'button';
    regenBtn.className = 'ai-chat__action-btn';
    regenBtn.textContent = 'Regenerate';
    regenBtn.addEventListener('click', () => {
      const lastQuestion = history.length > 0 ? history[history.length - 1].question : null;
      if (lastQuestion) void sendQuestion(lastQuestion);
    });
    actions.appendChild(regenBtn);

    const helpfulBtn = document.createElement('button');
    helpfulBtn.type = 'button';
    helpfulBtn.className = 'ai-chat__action-btn';
    helpfulBtn.textContent = '👍 Helpful';
    helpfulBtn.setAttribute('aria-pressed', 'false');

    const notHelpfulBtn = document.createElement('button');
    notHelpfulBtn.type = 'button';
    notHelpfulBtn.className = 'ai-chat__action-btn';
    notHelpfulBtn.textContent = '👎 Not helpful';
    notHelpfulBtn.setAttribute('aria-pressed', 'false');

    function sendFeedback(feedback) {
      if (!result.messageId) return;
      fetch(AI_FEEDBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: result.messageId, feedback }),
      }).catch(() => {});
      helpfulBtn.setAttribute('aria-pressed', String(feedback === 'helpful'));
      notHelpfulBtn.setAttribute('aria-pressed', String(feedback === 'not_helpful'));
    }

    helpfulBtn.addEventListener('click', () => sendFeedback('helpful'));
    notHelpfulBtn.addEventListener('click', () => sendFeedback('not_helpful'));
    actions.appendChild(helpfulBtn);
    actions.appendChild(notHelpfulBtn);

    return actions;
  }

  function renderSuggestions(titles) {
    els.suggestions.innerHTML = '';
    if (!titles || titles.length === 0) {
      els.suggestions.hidden = true;
      return;
    }
    titles.forEach((title) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-chat__suggestion';
      chip.textContent = title;
      chip.addEventListener('click', () => {
        els.input.value = `Tell me about ${title}`;
        submitQuestion();
      });
      els.suggestions.appendChild(chip);
    });
    els.suggestions.hidden = false;
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

/** Escapes HTML entities first, then applies a small, safe markdown subset (bold, italic, bullet/numbered lists, simple pipe tables, paragraphs) — never trusts raw LLM output as HTML. No link syntax support: citations are rendered separately as real, D1-sourced citation cards, so the model's own prose never needs to produce a clickable link. */
function renderMarkdown(rawText) {
  const escaped = escapeHtml(rawText);
  const lines = escaped.split('\n');
  const htmlParts = [];
  let listBuffer = [];
  let listType = null; // 'ul' | 'ol'
  let tableBuffer = [];

  function flushList() {
    if (listBuffer.length === 0) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    htmlParts.push(`<${tag}>${listBuffer.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${tag}>`);
    listBuffer = [];
    listType = null;
  }

  function flushTable() {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer.filter((row) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row));
    const cellsOf = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (rows.length > 0) {
      const [headerRow, ...bodyRows] = rows;
      const headerCells = cellsOf(headerRow).map((c) => `<th>${inlineMarkdown(c)}</th>`).join('');
      const bodyHtml = bodyRows.map((row) => `<tr>${cellsOf(row).map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`).join('');
      htmlParts.push(`<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
    }
    tableBuffer = [];
  }

  lines.forEach((line) => {
    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
    const numberedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    const tableMatch = /^\s*\|.*\|\s*$/.test(line);

    if (tableMatch) {
      flushList();
      tableBuffer.push(line);
      return;
    }
    flushTable();

    if (bulletMatch) {
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listBuffer.push(bulletMatch[1]);
      return;
    }
    if (numberedMatch) {
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listBuffer.push(numberedMatch[1]);
      return;
    }
    flushList();

    if (line.trim().length === 0) return;
    htmlParts.push(`<p>${inlineMarkdown(line)}</p>`);
  });
  flushList();
  flushTable();

  return htmlParts.join('');
}

function inlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.addEventListener('partials:loaded', initAiAssistant);
document.addEventListener('DOMContentLoaded', initAiAssistant);

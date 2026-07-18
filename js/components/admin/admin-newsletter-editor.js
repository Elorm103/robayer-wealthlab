/**
 * Robayer WealthLab — Newsletter Campaign editor, Version 2.1 Phase 6.
 * Shared between admin/newsletter/new/ (no `?id=`) and
 * admin/newsletter/edit/?id= — mirrors admin-blog-editor.js's own
 * create/edit mode-detection pattern exactly, including redirecting
 * the URL (via history.replaceState, no reload) to the real edit page
 * the moment a brand-new draft is first saved.
 *
 * A campaign that is no longer `draft` renders read-only (content
 * fields disabled) plus the observability/delivery-summary sections
 * and, while `sending`, a Resume action — matching the approved
 * Draft → Sending → Sent lifecycle exactly, with no additional states.
 */

const CAMPAIGNS_API_BASE = '/api/admin/newsletter/campaigns';

const STATUS_LABELS = { draft: 'Draft', sending: 'Sending', sent: 'Sent', failed: 'Failed' };
const STATUS_BADGE_CLASS = { draft: '', sending: 'badge--warning', sent: 'badge--success', failed: 'badge--error' };

const RICHTEXT_ALLOWED_TAGS = new Set(['P', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'A', 'IMG', 'BR', 'DIV']);

function initCampaignEditor() {
  const root = document.querySelector('[data-campaign-editor-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    loadError: root.querySelector('[data-ce-load-error]'),
    success: root.querySelector('[data-ce-success]'),
    statusBadge: root.querySelector('[data-ce-status-badge]'),
    observability: root.querySelector('[data-ce-observability]'),
    createdBy: root.querySelector('[data-ce-created-by]'),
    createdAt: root.querySelector('[data-ce-created-at]'),
    sentBy: root.querySelector('[data-ce-sent-by]'),
    sentAt: root.querySelector('[data-ce-sent-at]'),
    recipientCount: root.querySelector('[data-ce-recipient-count]'),
    deliverySummary: root.querySelector('[data-ce-delivery-summary]'),
    deliverySent: root.querySelector('[data-ce-delivery-sent]'),
    deliveryFailed: root.querySelector('[data-ce-delivery-failed]'),
    deliverySkipped: root.querySelector('[data-ce-delivery-skipped]'),
    deliveryPending: root.querySelector('[data-ce-delivery-pending]'),
    resume: root.querySelector('[data-ce-resume]'),
    subject: root.querySelector('[data-ce-subject]'),
    rtToolbar: root.querySelector('[data-rt-toolbar]'),
    rtEditor: root.querySelector('[data-rt-editor]'),
    save: root.querySelector('[data-ce-save]'),
    delete: root.querySelector('[data-ce-delete]'),
    testSection: root.querySelector('[data-ce-test-section]'),
    testEmails: root.querySelector('[data-ce-test-emails]'),
    sendTest: root.querySelector('[data-ce-send-test]'),
    testStatus: root.querySelector('[data-ce-test-status]'),
    sendSection: root.querySelector('[data-ce-send-section]'),
    sendHint: root.querySelector('[data-ce-send-hint]'),
    openSendModal: root.querySelector('[data-ce-open-send-modal]'),
    // Outside `root` in the HTML (a sibling at the body level, same as
    // every other admin editor's confirmation modal) — must be queried
    // from `document`, not `root`. Found via a real click-through-out
    // failure: root.querySelector() here silently returned null,
    // throwing inside bindModal() and aborting init before the save
    // button's listener was ever attached.
    sendModal: document.querySelector('[data-ce-send-modal]'),
    // Same reason as sendModal above — these are children of that
    // out-of-root modal, not of `root` itself.
    modalRecipientCount: document.querySelector('[data-ce-modal-recipient-count]'),
    modalError: document.querySelector('[data-ce-modal-error]'),
    confirmSend: document.querySelector('[data-ce-confirm-send]'),
  };

  let campaignId = new URLSearchParams(window.location.search).get('id');
  let campaign = null;

  bindRichText();
  bindModal();
  els.save.addEventListener('click', handleSave);
  els.delete.addEventListener('click', handleDelete);
  els.sendTest.addEventListener('click', handleSendTest);
  els.openSendModal.addEventListener('click', openSendModal);
  els.confirmSend.addEventListener('click', handleConfirmSend);
  els.resume.addEventListener('click', handleResume);

  if (campaignId) {
    load();
  } else {
    renderDraftMode(null);
  }

  async function load() {
    els.loadError.hidden = true;
    try {
      campaign = await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/${campaignId}`);
      renderCampaign();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load this campaign.';
      els.loadError.hidden = false;
    }
  }

  function formatDate(isoString) {
    if (!isoString) return 'Never';
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderCampaign() {
    els.statusBadge.textContent = STATUS_LABELS[campaign.status] || campaign.status;
    els.statusBadge.className = `badge ${STATUS_BADGE_CLASS[campaign.status] || ''}`;
    els.statusBadge.hidden = false;

    els.observability.hidden = false;
    els.createdBy.textContent = campaign.createdByName || '—';
    els.createdAt.textContent = formatDate(campaign.createdAt);
    els.sentBy.textContent = campaign.sentByName || '—';
    els.sentAt.textContent = formatDate(campaign.sentAt);
    els.recipientCount.textContent = campaign.intendedRecipientCount ?? '—';

    els.subject.value = campaign.subject;
    els.rtEditor.innerHTML = campaign.body || '';

    if (campaign.status === 'draft') {
      renderDraftMode(campaign);
    } else {
      renderReadOnlyMode();
    }
  }

  function renderDraftMode(existing) {
    els.subject.disabled = false;
    els.rtEditor.setAttribute('contenteditable', 'true');
    els.save.hidden = false;
    els.delete.hidden = !existing;
    els.testSection.hidden = false;
    els.deliverySummary.hidden = true;
    els.sendSection.hidden = !existing;
    if (existing) {
      els.sendHint.textContent = existing.testSentAt
        ? 'A test has been sent for this content. You may now send to subscribers.'
        : 'Send a test email below before Send becomes available.';
      els.openSendModal.disabled = !existing.testSentAt;
    }
  }

  function renderReadOnlyMode() {
    els.subject.disabled = true;
    els.rtEditor.removeAttribute('contenteditable');
    els.save.hidden = true;
    els.delete.hidden = true;
    els.testSection.hidden = true;
    els.sendSection.hidden = true;

    els.deliverySummary.hidden = false;
    els.deliverySent.textContent = campaign.delivery.sent;
    els.deliveryFailed.textContent = campaign.delivery.failed;
    els.deliverySkipped.textContent = campaign.delivery.skipped;
    const pending = campaign.delivery.pending + campaign.delivery.sending;
    els.deliveryPending.textContent = pending;
    els.resume.hidden = !(campaign.status === 'sending' && pending > 0);
  }

  // ============================================================
  // Rich text editor — same contenteditable + execCommand pattern as
  // admin-blog-editor.js/admin-product-editor.js/admin-resource-editor.js.
  // ============================================================

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
        } else {
          const value = button.getAttribute('data-rt-value');
          document.execCommand(cmd, false, value || undefined);
        }
      });
    });
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
      const attributeNames = [...child.attributes].map((a) => a.name);
      attributeNames.forEach((name) => {
        if (child.tagName === 'A' && name === 'href') return;
        if (child.tagName === 'IMG' && (name === 'src' || name === 'alt')) return;
        child.removeAttribute(name);
      });
      sanitizeNode(child);
    });
  }

  // ============================================================
  // Save / Delete
  // ============================================================

  function clearFieldErrors() {
    root.querySelectorAll('[data-ce-error-field]').forEach((el) => {
      el.hidden = true;
      el.textContent = '';
    });
  }

  function showFieldErrors(fields) {
    (fields || []).forEach((f) => {
      const el = root.querySelector(`[data-ce-error-field="${f.field}"]`);
      if (el) {
        el.textContent = f.message;
        el.hidden = false;
      }
    });
  }

  async function ensureSaved() {
    if (campaignId) return true;
    return handleSave();
  }

  async function handleSave() {
    clearFieldErrors();
    els.loadError.hidden = true;
    els.success.hidden = true;

    const input = { subject: els.subject.value.trim(), body: sanitizeRichText(els.rtEditor.innerHTML) };

    try {
      if (campaignId) {
        campaign = await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/${campaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      } else {
        campaign = await window.AdminAuth.adminFetch(CAMPAIGNS_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        campaignId = String(campaign.id);
        window.history.replaceState({}, '', `/admin/newsletter/edit/?id=${campaignId}`);
      }
      renderCampaign();
      els.success.textContent = 'Draft saved.';
      els.success.hidden = false;
      return true;
    } catch (error) {
      if (error.fields) showFieldErrors(error.fields);
      els.loadError.textContent = error.message || 'Could not save this campaign.';
      els.loadError.hidden = false;
      return false;
    }
  }

  async function handleDelete() {
    if (!campaignId) return;
    if (!window.confirm('Delete this draft? This cannot be undone.')) return; // eslint-disable-line no-alert -- matches this admin's existing confirm() usage for low-risk, reversible-scope deletes
    try {
      await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/${campaignId}`, { method: 'DELETE' });
      window.location.href = '/admin/newsletter/';
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not delete this draft.';
      els.loadError.hidden = false;
    }
  }

  // ============================================================
  // Test send
  // ============================================================

  async function handleSendTest() {
    const saved = await ensureSaved();
    if (!saved) return;

    const testEmails = els.testEmails.value.split(',').map((e) => e.trim()).filter(Boolean);
    if (testEmails.length === 0) {
      els.testStatus.textContent = 'Enter at least one test email address.';
      return;
    }

    els.sendTest.disabled = true;
    els.testStatus.textContent = 'Sending test…';
    try {
      const result = await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/${campaignId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testEmails }),
      });
      const sentCount = result.results.filter((r) => r.sent).length;
      els.testStatus.textContent = `Test sent to ${sentCount} of ${result.results.length} address(es).`;
      campaign = await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/${campaignId}`);
      renderDraftMode(campaign);
    } catch (error) {
      els.testStatus.textContent = error.message || 'Could not send test email.';
    } finally {
      els.sendTest.disabled = false;
    }
  }

  // ============================================================
  // Send / Resume
  // ============================================================

  async function openSendModal() {
    els.modalError.hidden = true;
    try {
      const { subscribedCount } = await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/subscribed-count`);
      els.modalRecipientCount.textContent = subscribedCount;
      els.sendModal.hidden = false;
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load the subscriber count.';
      els.loadError.hidden = false;
    }
  }

  function bindModal() {
    els.sendModal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => (els.sendModal.hidden = true)));
  }

  async function handleConfirmSend() {
    els.modalError.hidden = true;
    els.confirmSend.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/${campaignId}/send`, { method: 'POST' });
      els.sendModal.hidden = true;
      await load();
      els.success.textContent = 'Campaign send started.';
      els.success.hidden = false;
    } catch (error) {
      els.modalError.textContent = error.message || 'Could not start this send.';
      els.modalError.hidden = false;
    } finally {
      els.confirmSend.disabled = false;
    }
  }

  async function handleResume() {
    els.resume.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/${campaignId}/resume`, { method: 'POST' });
      await load();
      els.success.textContent = 'Resume started.';
      els.success.hidden = false;
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not resume this campaign.';
      els.loadError.hidden = false;
    } finally {
      els.resume.disabled = false;
    }
  }
}

document.addEventListener('partials:loaded', initCampaignEditor);

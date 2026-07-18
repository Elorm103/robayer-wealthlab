/**
 * Robayer WealthLab — Settings page, Version 2.1 Phase 5. Drives
 * admin/settings/index.html: Platform (maintenance mode, download
 * defaults), Email (sender/reply-to, per-template toggles,
 * diagnostics), Payments (read-only), System Information (read-only).
 *
 * Runs after admin-shell.js's `requireSession()` gate. Every call
 * below hits a `super_admin`-only endpoint — a non-super_admin never
 * reaches this page's data at all (the initial load itself would fail
 * with `FORBIDDEN`), but the server enforces this regardless of what
 * this script does.
 */

const SETTINGS_API_BASE = '/api/admin/settings';

const TEMPLATE_LABELS = {
  'newsletter-welcome': 'Newsletter welcome',
  'free-guide-delivery': 'Free guide delivery',
  'consultation-acknowledgement': 'Consultation acknowledgement',
  'contact-acknowledgement': 'Contact acknowledgement',
  'purchase-receipt': 'Purchase receipt',
  'secure-download': 'Secure download',
  'password-reset': 'Password reset',
  'admin-invite': 'Admin invite',
};

function initAdminSettings() {
  const root = document.querySelector('[data-settings-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    loadError: root.querySelector('[data-settings-load-error]'),
    success: root.querySelector('[data-settings-success]'),
    versionMismatch: root.querySelector('[data-settings-version-mismatch]'),
    templateToggles: root.querySelector('[data-template-toggles]'),
    emailDiagnosticsBody: root.querySelector('[data-email-diagnostics-body]'),
    paymentDiagnostics: root.querySelector('[data-payment-diagnostics]'),
    systemDiagnostics: root.querySelector('[data-system-diagnostics]'),
    saveButton: root.querySelector('[data-settings-save]'),
  };

  els.saveButton.addEventListener('click', save);

  load();

  async function load() {
    els.loadError.hidden = true;
    try {
      const [settings, status] = await Promise.all([
        window.AdminAuth.adminFetch(SETTINGS_API_BASE),
        window.AdminAuth.adminFetch(`${SETTINGS_API_BASE}/status`),
      ]);
      renderEditable(settings);
      renderDiagnostics(status);
      els.versionMismatch.hidden = settings.settingsSchemaVersion.value.matches;
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load settings.';
      els.loadError.hidden = false;
    }
  }

  // ============================================================
  // Editable settings
  // ============================================================

  function renderEditable(settings) {
    root.querySelector('#setting-maintenance-enabled').checked = settings.maintenanceMode.value.enabled;
    root.querySelector('#setting-maintenance-message').value = settings.maintenanceMode.value.message;
    root.querySelector('#setting-default-max-downloads').value = settings.defaultMaxDownloads.value ?? '';
    root.querySelector('#setting-default-expires-days').value = settings.defaultDownloadExpiresDays.value ?? '';
    root.querySelector('#setting-sender-name').value = settings.emailSenderName.value;
    root.querySelector('#setting-reply-to').value = settings.emailReplyTo.value ?? '';

    els.templateToggles.innerHTML = '';
    Object.entries(settings.emailTemplateEnabled.value).forEach(([template, enabled]) => {
      const field = document.createElement('div');
      field.className = 'field field--checkbox';
      const id = `template-toggle-${template}`;
      field.innerHTML = `
        <input type="checkbox" id="${id}" data-template-enabled="${template}" ${enabled ? 'checked' : ''}>
        <label class="field__label" for="${id}">${TEMPLATE_LABELS[template] || template}</label>
      `;
      els.templateToggles.appendChild(field);
    });
  }

  async function save() {
    els.loadError.hidden = true;
    els.success.hidden = true;
    els.saveButton.disabled = true;

    const templateEnabled = {};
    els.templateToggles.querySelectorAll('[data-template-enabled]').forEach((input) => {
      templateEnabled[input.getAttribute('data-template-enabled')] = input.checked;
    });

    const maxDownloadsRaw = root.querySelector('#setting-default-max-downloads').value.trim();
    const expiresDaysRaw = root.querySelector('#setting-default-expires-days').value.trim();
    const replyToRaw = root.querySelector('#setting-reply-to').value.trim();

    const patch = {
      maintenanceMode: {
        enabled: root.querySelector('#setting-maintenance-enabled').checked,
        message: root.querySelector('#setting-maintenance-message').value,
      },
      defaultMaxDownloads: maxDownloadsRaw === '' ? null : Number(maxDownloadsRaw),
      defaultDownloadExpiresDays: expiresDaysRaw === '' ? null : Number(expiresDaysRaw),
      emailSenderName: root.querySelector('#setting-sender-name').value.trim(),
      emailReplyTo: replyToRaw === '' ? null : replyToRaw,
      emailTemplateEnabled: templateEnabled,
    };

    try {
      await window.AdminAuth.adminFetch(SETTINGS_API_BASE, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      els.success.textContent = 'Settings saved.';
      els.success.hidden = false;
      await load();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not save settings.';
      els.loadError.hidden = false;
    } finally {
      els.saveButton.disabled = false;
    }
  }

  // ============================================================
  // Read-only diagnostics
  // ============================================================

  function sourceTag(source) {
    return `<span class="settings-source-tag" data-source="${source}">${source.replace('_', ' ')}</span>`;
  }

  function diagnosticRow(label, valueHtml, source) {
    return `<div class="settings-diagnostic-row"><dt>${label}</dt><dd>${valueHtml} ${sourceTag(source)}</dd></div>`;
  }

  function formatDate(isoString) {
    if (!isoString) return 'Never';
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderDiagnostics(status) {
    const p = status.payment;
    const environmentLabel = { test: 'Test mode', live: 'Live mode', unknown: 'Unrecognized key format', not_configured: 'Not configured' }[p.environment.value];
    els.paymentDiagnostics.innerHTML = [
      diagnosticRow('Provider', escapeHtml(p.provider.value), p.provider.source),
      diagnosticRow('Connection status', p.secretConfigured.value ? 'Secret configured' : 'Not configured', p.secretConfigured.source),
      diagnosticRow('Environment', environmentLabel, p.environment.source),
      diagnosticRow('Last successful payment', formatDate(p.lastSuccessfulPaymentAt.value), p.lastSuccessfulPaymentAt.source),
      diagnosticRow('Last successful webhook', formatDate(p.lastWebhookReceivedAt.value), p.lastWebhookReceivedAt.source),
      diagnosticRow('Failed payments (7 days)', String(p.recentFailureCount7d.value), p.recentFailureCount7d.source),
    ].join('');

    const s = status.system;
    const schemaVersionText = `v${s.settingsSchemaVersion.value.stored} (expects v${s.settingsSchemaVersion.value.expected})${s.settingsSchemaVersion.value.matches ? '' : ' — MISMATCH'}`;
    els.systemDiagnostics.innerHTML = [
      diagnosticRow('Environment', s.environment.value === 'production' ? 'Production' : 'Development', s.environment.source),
      diagnosticRow('Application version', escapeHtml(s.appVersion.value), s.appVersion.source),
      diagnosticRow('Deployed commit', s.deployedCommit.value ? escapeHtml(s.deployedCommit.value) : 'Not available', s.deployedCommit.source),
      diagnosticRow('Deployed at', formatDate(s.deployedAt.value) === 'Never' ? 'Not available' : formatDate(s.deployedAt.value), s.deployedAt.source),
      diagnosticRow('Current migration', s.currentMigration.value ? escapeHtml(s.currentMigration.value) : 'Not available', s.currentMigration.source),
      diagnosticRow('Settings schema version', schemaVersionText, s.settingsSchemaVersion.source),
    ].join('');

    els.emailDiagnosticsBody.innerHTML = '';
    if (!status.email.resendConfigured.value) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="5">Resend API key is not configured — no email can be sent.</td>';
      els.emailDiagnosticsBody.appendChild(row);
    }
    status.email.perTemplate.forEach((entry) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${TEMPLATE_LABELS[entry.template] || entry.template}</td>
        <td>${formatDate(entry.lastSentAt)}</td>
        <td>${entry.sentCount30d}</td>
        <td>${entry.failedCount30d}</td>
        <td>${entry.skippedCount30d}</td>
      `;
      els.emailDiagnosticsBody.appendChild(row);
    });
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }
}

document.addEventListener('partials:loaded', initAdminSettings);

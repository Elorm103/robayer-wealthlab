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
  'customer-purchase-followup': 'Purchase follow-up',
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
    aiGatewayDiagnostics: root.querySelector('[data-ai-gateway-diagnostics]'),
    aiGatewayTestError: root.querySelector('[data-ai-gateway-test-error]'),
    aiGatewayTestSuccess: root.querySelector('[data-ai-gateway-test-success]'),
    aiGatewayTestButton: root.querySelector('[data-ai-gateway-test]'),
    saveButton: root.querySelector('[data-settings-save]'),
    baselineLoadError: root.querySelector('[data-baseline-load-error]'),
    baselineSuccess: root.querySelector('[data-baseline-success]'),
    baselineLatestEmpty: root.querySelector('[data-baseline-latest-empty]'),
    baselineLatest: root.querySelector('[data-baseline-latest]'),
    baselineCaptureForm: root.querySelector('[data-baseline-capture-form]'),
    baselineVersionInput: root.querySelector('[data-baseline-version-input]'),
    baselineNotesInput: root.querySelector('[data-baseline-notes-input]'),
    baselineCaptureButton: root.querySelector('[data-baseline-capture]'),
  };

  els.saveButton.addEventListener('click', save);
  els.baselineCaptureButton.addEventListener('click', captureBaseline);
  els.aiGatewayTestButton.addEventListener('click', testAiGateway);

  load();
  loadBaseline();

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
    root.querySelector('#setting-hero-eyebrow').value = settings.heroContent.value.eyebrow;
    root.querySelector('#setting-hero-headline').value = settings.heroContent.value.headline;
    root.querySelector('#setting-hero-subheading').value = settings.heroContent.value.subheading;
    root.querySelector('#setting-hero-primary-cta-text').value = settings.heroContent.value.primaryCtaText;
    root.querySelector('#setting-hero-primary-cta-href').value = settings.heroContent.value.primaryCtaHref;
    root.querySelector('#setting-hero-secondary-cta-text').value = settings.heroContent.value.secondaryCtaText;
    root.querySelector('#setting-hero-secondary-cta-href').value = settings.heroContent.value.secondaryCtaHref;

    root.querySelector('#setting-maintenance-enabled').checked = settings.maintenanceMode.value.enabled;
    root.querySelector('#setting-maintenance-message').value = settings.maintenanceMode.value.message;
    root.querySelector('#setting-default-max-downloads').value = settings.defaultMaxDownloads.value ?? '';
    root.querySelector('#setting-default-expires-days').value = settings.defaultDownloadExpiresDays.value ?? '';
    root.querySelector('#setting-sender-name').value = settings.emailSenderName.value;
    root.querySelector('#setting-reply-to').value = settings.emailReplyTo.value ?? '';
    root.querySelector('#setting-campaign-cap').value = settings.campaignRecipientCap.value;

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
      heroContent: {
        eyebrow: root.querySelector('#setting-hero-eyebrow').value.trim(),
        headline: root.querySelector('#setting-hero-headline').value.trim(),
        subheading: root.querySelector('#setting-hero-subheading').value.trim(),
        primaryCtaText: root.querySelector('#setting-hero-primary-cta-text').value.trim(),
        primaryCtaHref: root.querySelector('#setting-hero-primary-cta-href').value.trim(),
        secondaryCtaText: root.querySelector('#setting-hero-secondary-cta-text').value.trim(),
        secondaryCtaHref: root.querySelector('#setting-hero-secondary-cta-href').value.trim(),
      },
      maintenanceMode: {
        enabled: root.querySelector('#setting-maintenance-enabled').checked,
        message: root.querySelector('#setting-maintenance-message').value,
      },
      defaultMaxDownloads: maxDownloadsRaw === '' ? null : Number(maxDownloadsRaw),
      defaultDownloadExpiresDays: expiresDaysRaw === '' ? null : Number(expiresDaysRaw),
      emailSenderName: root.querySelector('#setting-sender-name').value.trim(),
      emailReplyTo: replyToRaw === '' ? null : replyToRaw,
      emailTemplateEnabled: templateEnabled,
      campaignRecipientCap: Number(root.querySelector('#setting-campaign-cap').value),
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

  function baselineRow(label, valueHtml) {
    return `<div class="settings-diagnostic-row"><dt>${label}</dt><dd>${valueHtml}</dd></div>`;
  }

  // ============================================================
  // Production Launch Baseline — Version 4.9 Phase 9. Read access is
  // open to every authenticated admin; capturing a new baseline is
  // super_admin-only, enforced server-side regardless of what this
  // script shows/hides.
  // ============================================================

  function formatCurrency(pesewas) {
    return 'GH₵' + (pesewas / 100).toFixed(2);
  }

  async function loadBaseline() {
    els.baselineLoadError.hidden = true;
    try {
      const [payload, session] = await Promise.all([
        window.AdminAuth.adminFetch('/api/admin/production-baseline'),
        window.AdminAuth.adminFetch('/api/admin/auth/session'),
      ]);
      renderLatestBaseline(payload.latest);
      els.baselineCaptureForm.hidden = session.role !== 'super_admin';
    } catch (error) {
      els.baselineLoadError.textContent = error.message || 'Could not load the production launch baseline.';
      els.baselineLoadError.hidden = false;
    }
  }

  function renderLatestBaseline(baseline) {
    if (!baseline) {
      els.baselineLatestEmpty.hidden = false;
      els.baselineLatest.hidden = true;
      return;
    }
    els.baselineLatestEmpty.hidden = true;
    els.baselineLatest.hidden = false;
    els.baselineLatest.innerHTML = [
      baselineRow('Platform version', escapeHtml(baseline.platformVersion)),
      baselineRow('Launch date', escapeHtml(baseline.launchDate)),
      baselineRow('Captured', formatDate(baseline.createdAt)),
      baselineRow('Lifetime revenue (total processed)', formatCurrency(baseline.lifetimeRevenuePesewas)),
      baselineRow('Customer (production) revenue', formatCurrency(baseline.customerRevenuePesewas)),
      baselineRow('Internal revenue', formatCurrency(baseline.internalRevenuePesewas)),
      baselineRow('Development revenue', formatCurrency(baseline.developmentRevenuePesewas)),
      baselineRow('Customers', String(baseline.customersCount)),
      baselineRow('Orders', String(baseline.ordersCount)),
      baselineRow('Products', String(baseline.productsCount)),
      baselineRow('Bundles', String(baseline.bundlesCount)),
      baselineRow('Resources', String(baseline.resourcesCount)),
      baselineRow('Downloads', String(baseline.downloadsCount)),
      baselineRow('Subscribers', String(baseline.subscribersCount)),
      baselineRow('Reviews', String(baseline.reviewsCount)),
      baselineRow('Conversion rate', baseline.conversionRatePercent === null ? 'No data yet' : baseline.conversionRatePercent + '%'),
      baselineRow('Average order value', baseline.averageOrderValuePesewas === null ? 'No data yet' : formatCurrency(baseline.averageOrderValuePesewas)),
      baselineRow('Traffic (page views, lifetime)', baseline.trafficPageViews === null ? 'No data' : String(baseline.trafficPageViews)),
    ].join('');
  }

  async function captureBaseline() {
    const platformVersion = els.baselineVersionInput.value.trim();
    els.baselineLoadError.hidden = true;
    els.baselineSuccess.hidden = true;

    if (!platformVersion) {
      els.baselineLoadError.textContent = 'Platform version is required to capture a baseline.';
      els.baselineLoadError.hidden = false;
      return;
    }

    els.baselineCaptureButton.disabled = true;
    try {
      await window.AdminAuth.adminFetch('/api/admin/production-baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platformVersion, notes: els.baselineNotesInput.value.trim() || undefined }),
      });
      els.baselineSuccess.textContent = 'Baseline captured — this snapshot is now permanent and cannot be edited or deleted.';
      els.baselineSuccess.hidden = false;
      els.baselineVersionInput.value = '';
      els.baselineNotesInput.value = '';
      await loadBaseline();
    } catch (error) {
      els.baselineLoadError.textContent = error.message || 'Could not capture a new baseline.';
      els.baselineLoadError.hidden = false;
    } finally {
      els.baselineCaptureButton.disabled = false;
    }
  }

  function formatDate(isoString) {
    if (!isoString) return 'Never';
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // 1 micro = $0.000001 — see backend/services/ai/types.ts.
  function formatUsdMicros(micros) {
    return '$' + (micros / 1_000_000).toFixed(4);
  }

  async function testAiGateway() {
    els.aiGatewayTestError.hidden = true;
    els.aiGatewayTestSuccess.hidden = true;
    els.aiGatewayTestButton.disabled = true;
    try {
      const result = await window.AdminAuth.adminFetch(`${SETTINGS_API_BASE}/ai-gateway/test`, { method: 'POST' });
      els.aiGatewayTestSuccess.textContent = `Success — ${result.provider}/${result.model} responded "${result.content}" in ${result.latencyMs}ms (${formatUsdMicros(result.costUsdMicros)}${result.fallbackUsed ? ', fallback used' : ''}).`;
      els.aiGatewayTestSuccess.hidden = false;
      await load();
    } catch (error) {
      els.aiGatewayTestError.textContent = error.message || 'AI Gateway test request failed.';
      els.aiGatewayTestError.hidden = false;
    } finally {
      els.aiGatewayTestButton.disabled = false;
    }
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

    const ai = status.aiGateway;
    els.aiGatewayDiagnostics.innerHTML = [
      diagnosticRow('OpenAI API key', ai.openAiConfigured.value ? 'Configured' : 'Not configured', ai.openAiConfigured.source),
      diagnosticRow('Last successful call', formatDate(ai.lastSuccessfulCallAt.value), ai.lastSuccessfulCallAt.source),
      diagnosticRow('Last failed call', formatDate(ai.lastFailedCallAt.value), ai.lastFailedCallAt.source),
      diagnosticRow('Calls (30 days)', String(ai.callCount30d.value), ai.callCount30d.source),
      diagnosticRow('Cost (30 days)', formatUsdMicros(ai.costUsdMicros30d.value), ai.costUsdMicros30d.source),
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

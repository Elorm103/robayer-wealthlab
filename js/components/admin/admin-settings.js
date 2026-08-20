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
    aiGatewayStatusBadge: root.querySelector('[data-ai-gateway-status-badge]'),
    aiGatewayStatusReason: root.querySelector('[data-ai-gateway-status-reason]'),
    aiGatewayWarnings: root.querySelector('[data-ai-gateway-warnings]'),
    aiGatewayDiagnosticsStatus: root.querySelector('[data-ai-gateway-diagnostics-status]'),
    aiGatewayDiagnosticsVolume: root.querySelector('[data-ai-gateway-diagnostics-volume]'),
    aiGatewayDiagnosticsCost: root.querySelector('[data-ai-gateway-diagnostics-cost]'),
    aiGatewayDiagnosticsLatency: root.querySelector('[data-ai-gateway-diagnostics-latency]'),
    aiGatewayBudgetStatusBadge: root.querySelector('[data-ai-gateway-budget-status-badge]'),
    aiGatewayPolicyStatus: root.querySelector('[data-ai-gateway-policy-status]'),
    aiGatewayRetentionStatus: root.querySelector('[data-ai-gateway-retention-status]'),
    aiGatewayGovernanceSummary: root.querySelector('[data-ai-gateway-governance-summary]'),
    aiGatewayClassificationDistribution: root.querySelector('[data-ai-gateway-classification-distribution]'),
    aiGatewayProviderDistribution: root.querySelector('[data-ai-gateway-provider-distribution]'),
    aiGatewayProviderBudgets: root.querySelector('[data-ai-gateway-provider-budgets]'),
    aiGatewayEncryptionHint: root.querySelector('[data-ai-gateway-encryption-hint]'),
    aiGatewayRoutingBody: root.querySelector('[data-ai-gateway-routing-body]'),
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
      renderEditable(settings, status);
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

  function renderEditable(settings, status) {
    root.querySelector('#setting-hero-eyebrow').value = settings.heroContent.value.eyebrow;
    root.querySelector('#setting-hero-headline').value = settings.heroContent.value.headline;
    root.querySelector('#setting-hero-subheading').value = settings.heroContent.value.subheading;
    root.querySelector('#setting-hero-primary-cta-text').value = settings.heroContent.value.primaryCtaText;
    root.querySelector('#setting-hero-primary-cta-href').value = settings.heroContent.value.primaryCtaHref;
    root.querySelector('#setting-hero-secondary-cta-text').value = settings.heroContent.value.secondaryCtaText;
    root.querySelector('#setting-hero-secondary-cta-href').value = settings.heroContent.value.secondaryCtaHref;

    root.querySelector('#setting-announcement-enabled').checked = settings.announcement.value.enabled;
    root.querySelector('#setting-announcement-type').value = settings.announcement.value.type;
    root.querySelector('#setting-announcement-dismissible').checked = settings.announcement.value.dismissible;
    root.querySelector('#setting-announcement-title').value = settings.announcement.value.title;
    root.querySelector('#setting-announcement-message').value = settings.announcement.value.message;
    root.querySelector('#setting-announcement-button-text').value = settings.announcement.value.buttonText;
    root.querySelector('#setting-announcement-button-url').value = settings.announcement.value.buttonUrl;

    root.querySelector('#setting-maintenance-enabled').checked = settings.maintenanceMode.value.enabled;
    root.querySelector('#setting-maintenance-message').value = settings.maintenanceMode.value.message;
    root.querySelector('#setting-default-max-downloads').value = settings.defaultMaxDownloads.value ?? '';
    root.querySelector('#setting-default-expires-days').value = settings.defaultDownloadExpiresDays.value ?? '';
    root.querySelector('#setting-sender-name').value = settings.emailSenderName.value;
    root.querySelector('#setting-reply-to').value = settings.emailReplyTo.value ?? '';
    root.querySelector('#setting-campaign-cap').value = settings.campaignRecipientCap.value;
    root.querySelector('#setting-ai-cost-cap').value = microsToUsd(settings.aiGatewayCostCapUsdMicros.value);
    root.querySelector('#setting-ai-daily-budget').value = settings.aiGatewayDailyBudgetUsdMicros.value === null ? '' : microsToUsd(settings.aiGatewayDailyBudgetUsdMicros.value);
    root.querySelector('#setting-ai-monthly-budget').value = settings.aiGatewayMonthlyBudgetUsdMicros.value === null ? '' : microsToUsd(settings.aiGatewayMonthlyBudgetUsdMicros.value);
    root.querySelector('#setting-ai-platform-budget').value = settings.aiGatewayPlatformBudgetUsdMicros.value === null ? '' : microsToUsd(settings.aiGatewayPlatformBudgetUsdMicros.value);
    root.querySelector('#setting-ai-retention-mode').value = settings.aiGatewayRetentionStorageMode.value;
    root.querySelector('#setting-ai-retention-days').value = settings.aiGatewayRetentionDays.value === null ? 'null' : String(settings.aiGatewayRetentionDays.value);
    els.aiGatewayEncryptionHint.textContent = status.aiGateway.retentionStatus.value.encryptionAvailable
      ? 'AI_PROMPT_ENCRYPTION_KEY is configured — encrypted modes are available.'
      : 'AI_PROMPT_ENCRYPTION_KEY is NOT configured — an encrypted mode will silently store as metadata_only until it is set.';

    renderProviderBudgets(settings, status);

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

  /**
   * One numeric USD input per provider this Gateway currently knows
   * about (from the routing snapshot — today just "openai"), rather
   * than a raw JSON textarea, since a founder editing a dollar figure
   * shouldn't have to hand-write JSON. Builds/reads
   * aiGatewayProviderBudgetsUsdMicros as {provider: microsOrNull} on
   * save() via each input's `data-provider-budget-input` attribute.
   */
  function renderProviderBudgets(settings, status) {
    const known = new Set(Object.keys(settings.aiGatewayProviderBudgetsUsdMicros.value));
    status.aiGateway.routing.value.forEach((r) => {
      known.add(r.primaryProvider);
      if (r.fallbackProvider) known.add(r.fallbackProvider);
    });

    els.aiGatewayProviderBudgets.innerHTML = '';
    if (known.size === 0) {
      els.aiGatewayProviderBudgets.innerHTML = '<p class="text-small text-secondary">No providers registered yet.</p>';
      return;
    }

    const defaultUsd = microsToUsd(status.aiGateway.defaultProviderBudgetUsdMicros.value ?? 0);
    const row = document.createElement('div');
    row.className = 'editor-field-row';
    known.forEach((provider) => {
      const configured = settings.aiGatewayProviderBudgetsUsdMicros.value[provider];
      const field = document.createElement('div');
      field.className = 'field mb-2';
      const inputId = `provider-budget-${provider}`;
      field.innerHTML = `
        <label class="field__label" for="${inputId}">${escapeHtml(provider)} lifetime budget (USD)</label>
        <input class="field__input" type="number" step="0.01" min="0" id="${inputId}" data-provider-budget-input="${escapeHtml(provider)}" placeholder="Default: $${defaultUsd}">
      `;
      field.querySelector('input').value = configured === null || configured === undefined ? '' : microsToUsd(configured);
      row.appendChild(field);
    });
    els.aiGatewayProviderBudgets.appendChild(row);
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
    const dailyBudgetRaw = root.querySelector('#setting-ai-daily-budget').value.trim();
    const monthlyBudgetRaw = root.querySelector('#setting-ai-monthly-budget').value.trim();
    const platformBudgetRaw = root.querySelector('#setting-ai-platform-budget').value.trim();
    const retentionDaysRaw = root.querySelector('#setting-ai-retention-days').value;

    const providerBudgets = {};
    els.aiGatewayProviderBudgets.querySelectorAll('[data-provider-budget-input]').forEach((input) => {
      const provider = input.getAttribute('data-provider-budget-input');
      const raw = input.value.trim();
      providerBudgets[provider] = raw === '' ? null : usdToMicros(raw);
    });

    const patch = {
      announcement: {
        enabled: root.querySelector('#setting-announcement-enabled').checked,
        type: root.querySelector('#setting-announcement-type').value,
        title: root.querySelector('#setting-announcement-title').value.trim(),
        message: root.querySelector('#setting-announcement-message').value.trim(),
        buttonText: root.querySelector('#setting-announcement-button-text').value.trim(),
        buttonUrl: root.querySelector('#setting-announcement-button-url').value.trim(),
        dismissible: root.querySelector('#setting-announcement-dismissible').checked,
      },
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
      aiGatewayCostCapUsdMicros: usdToMicros(root.querySelector('#setting-ai-cost-cap').value),
      aiGatewayDailyBudgetUsdMicros: dailyBudgetRaw === '' ? null : usdToMicros(dailyBudgetRaw),
      aiGatewayMonthlyBudgetUsdMicros: monthlyBudgetRaw === '' ? null : usdToMicros(monthlyBudgetRaw),
      aiGatewayPlatformBudgetUsdMicros: platformBudgetRaw === '' ? null : usdToMicros(platformBudgetRaw),
      aiGatewayProviderBudgetsUsdMicros: providerBudgets,
      aiGatewayRetentionStorageMode: root.querySelector('#setting-ai-retention-mode').value,
      aiGatewayRetentionDays: retentionDaysRaw === 'null' ? null : Number(retentionDaysRaw),
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

  // Plain-number (no '$') variants for populating/reading <input type="number"> fields.
  function microsToUsd(micros) {
    return micros / 1_000_000;
  }
  function usdToMicros(usdString) {
    return Math.round(Number(usdString) * 1_000_000);
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

    renderAiGatewayDashboard(status.aiGateway);

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

  const STATUS_BADGE = {
    healthy: { label: 'Healthy', variant: 'badge--success' },
    warning: { label: 'Warning', variant: 'badge--warning' },
    offline: { label: 'Offline', variant: 'badge--error' },
  };

  function renderAiGatewayDashboard(ai) {
    const statusInfo = STATUS_BADGE[ai.healthStatus.value] || STATUS_BADGE.warning;
    els.aiGatewayStatusBadge.className = `badge ${statusInfo.variant}`;
    els.aiGatewayStatusBadge.textContent = statusInfo.label;
    els.aiGatewayStatusReason.textContent = ai.healthReason.value;

    if (ai.warnings.value.length > 0) {
      els.aiGatewayWarnings.hidden = false;
      els.aiGatewayWarnings.innerHTML = `<div class="alert alert--warning" role="alert"><strong>Warnings</strong><ul style="margin: 4px 0 0; padding-left: 1.2em;">${ai.warnings.value
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join('')}</ul></div>`;
    } else {
      els.aiGatewayWarnings.hidden = true;
      els.aiGatewayWarnings.innerHTML = '';
    }

    els.aiGatewayDiagnosticsStatus.innerHTML = [
      diagnosticRow('OpenAI API key', ai.openAiConfigured.value ? 'Configured' : 'Not configured', ai.openAiConfigured.source),
      diagnosticRow('Last successful call', formatDate(ai.lastSuccessfulCallAt.value), ai.lastSuccessfulCallAt.source),
      diagnosticRow('Last failed call', formatDate(ai.lastFailedCallAt.value), ai.lastFailedCallAt.source),
      diagnosticRow('Consecutive failures', String(ai.consecutiveFailures.value), ai.consecutiveFailures.source),
      diagnosticRow('Last error', ai.lastErrorMessage.value ? escapeHtml(ai.lastErrorMessage.value) : 'None', ai.lastErrorMessage.source),
    ].join('');

    els.aiGatewayDiagnosticsVolume.innerHTML = [
      diagnosticRow('Calls today', String(ai.callsToday.value), ai.callsToday.source),
      diagnosticRow('Calls (7 days)', String(ai.callsLast7d.value), ai.callsLast7d.source),
      diagnosticRow('Calls (30 days)', String(ai.callsLast30d.value), ai.callsLast30d.source),
      diagnosticRow('Calls (all-time)', String(ai.callsTotal.value), ai.callsTotal.source),
      diagnosticRow('Success rate (30 days)', ai.successRatePercent30d.value === null ? 'No data yet' : `${ai.successRatePercent30d.value}%`, ai.successRatePercent30d.source),
      diagnosticRow('Failure rate (30 days)', ai.failureRatePercent30d.value === null ? 'No data yet' : `${ai.failureRatePercent30d.value}%`, ai.failureRatePercent30d.source),
    ].join('');

    els.aiGatewayDiagnosticsCost.innerHTML = [
      diagnosticRow("Today's cost", formatUsdMicros(ai.costTodayUsdMicros.value), ai.costTodayUsdMicros.source),
      diagnosticRow('Cost (30 days)', formatUsdMicros(ai.costLast30dUsdMicros.value), ai.costLast30dUsdMicros.source),
      diagnosticRow('Lifetime cost', formatUsdMicros(ai.costLifetimeUsdMicros.value), ai.costLifetimeUsdMicros.source),
      diagnosticRow('Current cost cap', formatUsdMicros(ai.costCapUsdMicros.value) + ' / call', ai.costCapUsdMicros.source),
      diagnosticRow('Daily budget', ai.dailyBudgetUsdMicros.value === null ? 'Unconfigured' : formatUsdMicros(ai.dailyBudgetUsdMicros.value), ai.dailyBudgetUsdMicros.source),
      diagnosticRow('Monthly budget', ai.monthlyBudgetUsdMicros.value === null ? 'Unconfigured' : formatUsdMicros(ai.monthlyBudgetUsdMicros.value), ai.monthlyBudgetUsdMicros.source),
      diagnosticRow('Platform lifetime budget', ai.platformBudgetUsdMicros.value === null ? 'Unconfigured' : formatUsdMicros(ai.platformBudgetUsdMicros.value), ai.platformBudgetUsdMicros.source),
      diagnosticRow(
        'Provider budgets (lifetime)',
        Object.keys(ai.providerBudgetsUsdMicros.value).length === 0
          ? `All using default (${formatUsdMicros(ai.defaultProviderBudgetUsdMicros.value ?? 0)})`
          : Object.entries(ai.providerBudgetsUsdMicros.value)
              .map(([p, v]) => `${escapeHtml(p)}: ${v === null ? 'unconfigured' : formatUsdMicros(v)}`)
              .join(', '),
        ai.providerBudgetsUsdMicros.source
      ),
    ].join('');

    const budgetBadge = STATUS_BADGE[ai.budgetStatus.value === 'blocking' ? 'offline' : ai.budgetStatus.value === 'near_limit' ? 'warning' : 'healthy'];
    els.aiGatewayBudgetStatusBadge.className = `badge ${budgetBadge.variant}`;
    els.aiGatewayBudgetStatusBadge.textContent = { healthy: 'Healthy', near_limit: 'Near limit', blocking: 'Blocking' }[ai.budgetStatus.value];

    els.aiGatewayDiagnosticsLatency.innerHTML = [
      diagnosticRow('Average', ai.avgLatencyMs.value === null ? 'No data yet' : `${ai.avgLatencyMs.value}ms`, ai.avgLatencyMs.source),
      diagnosticRow('Fastest', ai.fastestLatencyMs.value === null ? 'No data yet' : `${ai.fastestLatencyMs.value}ms`, ai.fastestLatencyMs.source),
      diagnosticRow('Slowest', ai.slowestLatencyMs.value === null ? 'No data yet' : `${ai.slowestLatencyMs.value}ms`, ai.slowestLatencyMs.source),
    ].join('');

    els.aiGatewayPolicyStatus.innerHTML = [
      diagnosticRow('Policy version', escapeHtml(ai.policyStatus.value.version), ai.policyStatus.source),
      diagnosticRow('Recognized classifications', ai.policyStatus.value.classifications.join(', '), ai.policyStatus.source),
    ].join('');

    els.aiGatewayRetentionStatus.innerHTML = [
      diagnosticRow('Storage mode', escapeHtml(ai.retentionStatus.value.storageMode), ai.retentionStatus.source),
      diagnosticRow('Retention period', ai.retentionStatus.value.retentionDays === null ? 'Forever' : `${ai.retentionStatus.value.retentionDays} days`, ai.retentionStatus.source),
      diagnosticRow('Encryption available', ai.retentionStatus.value.encryptionAvailable ? 'Yes (AI_PROMPT_ENCRYPTION_KEY set)' : 'No — encrypted modes fall back to metadata_only', ai.retentionStatus.source),
    ].join('');

    els.aiGatewayGovernanceSummary.innerHTML = [
      diagnosticRow('Sensitive prompts detected', String(ai.sensitivePromptCount30d.value), ai.sensitivePromptCount30d.source),
      diagnosticRow('Masked prompts stored', String(ai.maskedPromptCount30d.value), ai.maskedPromptCount30d.source),
      diagnosticRow('Budget blocks', String(ai.budgetBlocks30d.value), ai.budgetBlocks30d.source),
      diagnosticRow('Policy violations', String(ai.policyViolations30d.value), ai.policyViolations30d.source),
      diagnosticRow('Retention cleanup last ran', formatDate(ai.retentionCleanupLastRunAt.value), ai.retentionCleanupLastRunAt.source),
      diagnosticRow('Total purged (lifetime)', String(ai.retentionCleanupTotalPurged.value), ai.retentionCleanupTotalPurged.source),
      diagnosticRow('Oldest stored prompt', formatDate(ai.oldestStoredPromptAt.value), ai.oldestStoredPromptAt.source),
      diagnosticRow('Newest stored prompt', formatDate(ai.newestStoredPromptAt.value), ai.newestStoredPromptAt.source),
    ].join('');

    window.AdminCharts.renderBarChart(els.aiGatewayClassificationDistribution, ai.classificationDistribution30d.value, { color: 'var(--color-accent)' });
    window.AdminCharts.renderBarChart(els.aiGatewayProviderDistribution, ai.providerDistribution30d.value, { color: 'var(--color-sika-gold)' });

    els.aiGatewayRoutingBody.innerHTML = '';
    if (ai.routing.value.length === 0) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="3">No AI features are registered yet.</td>';
      els.aiGatewayRoutingBody.appendChild(row);
    }
    ai.routing.value.forEach((r) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${escapeHtml(r.feature)}</td>
        <td>${escapeHtml(r.primaryProvider)} / ${escapeHtml(r.primaryModel)}</td>
        <td>${r.fallbackProvider ? `${escapeHtml(r.fallbackProvider)} / ${escapeHtml(r.fallbackModel)}` : 'None configured'}</td>
      `;
      els.aiGatewayRoutingBody.appendChild(row);
    });
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }
}

document.addEventListener('partials:loaded', initAdminSettings);

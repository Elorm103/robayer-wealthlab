/**
 * Robayer WealthLab — Executive Dashboard (Version 3.5: Executive
 * Dashboard & Business Intelligence).
 *
 * Drives admin/index.html. Every number rendered here comes directly
 * from one of the six new GET /api/admin/dashboard/* endpoints (health,
 * executive-summary, charts, customer-insights, operational, alerts) —
 * see backend/services/admin/systemHealthService.ts and
 * backend/services/admin/executiveDashboardService.ts for how each is
 * computed. Per the milestone brief's explicit "no placeholder
 * metrics" rule, nothing here is invented: a section whose data is
 * empty renders its existing empty-state, never a fake number.
 *
 * Runs after admin-shell.js's requireSession() gate, same convention
 * as every other admin page script.
 */

const ANALYTICS_MODE_LABELS = {
  production: 'Production Only',
  production_internal: 'Production + Internal',
  all: 'All Records',
};

async function initAdminDashboard() {
  const root = document.querySelector('[data-dashboard-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  let chartsRangeDays = 30;
  let analyticsMode = 'production';

  await initAnalyticsMode();

  loadHealth();
  loadAlerts();
  loadExecutiveSummary();
  loadCharts(chartsRangeDays);
  loadCustomerInsights(chartsRangeDays);
  loadOperational();
  loadEmailLifecycle();
  bindChartPresets();
  bindAnalyticsModeToggle();

  // ============================================================
  // Version 4.9 Phase 6 — Analytics Mode (per-admin, persisted).
  // Controls which data_classification values count toward the
  // customer-facing KPI cards above (Revenue & orders / Content &
  // growth), reporting only — it never touches data_classification or
  // any underlying record. The Revenue breakdown card always shows
  // every classification regardless of this setting. Each admin's
  // choice is their own (admin_users.analytics_mode) and persists
  // across sessions/devices; read once at load from the same session
  // check admin-shell.js already performs, so this page never needs
  // its own separate settings screen to know the current value.
  // ============================================================
  async function initAnalyticsMode() {
    try {
      const session = await window.AdminAuth.adminFetch('/api/admin/auth/session');
      if (session.analyticsMode) analyticsMode = session.analyticsMode;
    } catch (error) {
      // Non-fatal here - admin-shell.js's own requireSession() gate is
      // the real auth boundary; this page just falls back to the safe
      // 'production' default if its own session read fails.
    }
    syncAnalyticsModeUi();
  }

  function syncAnalyticsModeUi() {
    root.querySelectorAll('[data-analytics-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-analytics-mode') === analyticsMode));
    });
    const label = root.querySelector('[data-analytics-mode-label]');
    if (label) label.textContent = 'Viewing: ' + (ANALYTICS_MODE_LABELS[analyticsMode] || analyticsMode);
  }

  function bindAnalyticsModeToggle() {
    root.querySelectorAll('[data-analytics-mode]').forEach((button) => {
      button.addEventListener('click', async () => {
        const mode = button.getAttribute('data-analytics-mode');
        if (mode === analyticsMode) return;
        analyticsMode = mode;
        syncAnalyticsModeUi();
        loadExecutiveSummary();
        loadCharts(chartsRangeDays);
        loadCustomerInsights(chartsRangeDays);
        loadOperational();
        loadAlerts();

        try {
          await window.AdminAuth.adminFetch('/api/admin/auth/analytics-mode', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ analyticsMode: mode }),
          });
        } catch (error) {
          // Persisting the preference is best-effort - the mode still
          // applies for the rest of this session either way, it just
          // won't be remembered as this admin's default next time.
        }
      });
    });
  }

  // ============================================================
  // Phase 1 — Health
  // ============================================================
  async function loadHealth() {
    let health;
    try {
      health = await window.AdminAuth.adminFetch('/api/admin/dashboard/health');
    } catch (error) {
      showLoadError('Could not load system health: ' + error.message);
      return;
    }
    renderHealth(health);
  }

  function renderHealth(health) {
    const grid = root.querySelector('[data-health-grid]');
    const overallBadge = root.querySelector('[data-health-overall-badge]');
    grid.innerHTML = '';

    const overallLabel = { healthy: 'All systems healthy', warning: 'Attention needed', error: 'Service disruption' }[health.overallStatus] || 'Unknown';
    overallBadge.textContent = overallLabel;
    overallBadge.className = 'badge ' + { healthy: 'badge--success', warning: 'badge--warning', error: 'badge--error' }[health.overallStatus];

    health.checks.forEach((check) => {
      const li = document.createElement('li');
      li.className = 'health-item';
      const dot = document.createElement('span');
      dot.className = 'health-item__dot health-item__dot--' + check.status;
      dot.setAttribute('aria-hidden', 'true');
      const body = document.createElement('div');
      body.className = 'health-item__body';
      const label = document.createElement('p');
      label.className = 'health-item__label';
      label.textContent = statusWord(check.status) + ' — ' + check.label;
      const detail = document.createElement('p');
      detail.className = 'health-item__detail';
      detail.textContent = check.detail;
      body.append(label, detail);
      li.append(dot, body);
      grid.appendChild(li);
    });

    root.querySelector('[data-health-version]').textContent = 'Version ' + health.appVersion;
    root.querySelector('[data-health-environment]').textContent = health.environment === 'production' ? 'Production' : 'Development';
    root.querySelector('[data-health-schema]').textContent = health.schemaVersion || 'Unknown';
  }

  function statusWord(status) {
    return { healthy: 'Healthy', warning: 'Warning', error: 'Error' }[status] || status;
  }

  // ============================================================
  // Phase 6 — Alerts
  // ============================================================
  async function loadAlerts() {
    let payload;
    try {
      payload = await window.AdminAuth.adminFetch('/api/admin/dashboard/alerts?analyticsMode=' + analyticsMode);
    } catch (error) {
      return; // A failed alerts fetch degrades silently - health/KPIs are the load-bearing sections.
    }
    renderAlerts(payload.alerts);
  }

  function renderAlerts(alerts) {
    const list = root.querySelector('[data-alerts-list]');
    const empty = root.querySelector('[data-alerts-empty]');
    if (!alerts || alerts.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.hidden = false;
    list.innerHTML = '';
    alerts.forEach((alert) => {
      const li = document.createElement('li');
      li.className = 'alert-list__item alert-list__item--' + alert.severity;
      li.textContent = alert.message;
      list.appendChild(li);
    });
  }

  // ============================================================
  // Phase 2 + 7 + 9 + 10 — Executive Summary
  // ============================================================
  async function loadExecutiveSummary() {
    let summary;
    try {
      summary = await window.AdminAuth.adminFetch('/api/admin/dashboard/executive-summary?analyticsMode=' + analyticsMode);
    } catch (error) {
      showLoadError('Could not load the executive summary: ' + error.message);
      return;
    }
    renderKpis(summary.kpis);
    renderRevenueIntelligence(summary.revenueIntelligence);
    renderPublishing(summary.publishing);
    renderFinancial(summary.financial);
    renderMonthlyRevenueChart(summary.revenueIntelligence.revenueByMonth);
  }

  function renderKpis(kpis) {
    setValue('[data-kpi-revenue-today]', formatCurrency(kpis.revenue.todayPesewas / 100));
    setText('[data-kpi-revenue-today-meta]', formatDelta(kpis.revenue.todayVsYesterdayPercent) + ' vs yesterday');
    setValue('[data-kpi-revenue-yesterday]', formatCurrency(kpis.revenue.yesterdayPesewas / 100));
    setValue('[data-kpi-revenue-month]', formatCurrency(kpis.revenue.monthPesewas / 100));
    setText('[data-kpi-revenue-month-meta]', formatDelta(kpis.revenue.monthVsLastMonthPercent) + ' vs last month');
    setValue('[data-kpi-revenue-lifetime]', formatCurrency(kpis.revenue.lifetimePesewas / 100));

    setValue('[data-kpi-orders-today]', kpis.orders.today);
    setValue('[data-kpi-orders-month]', kpis.orders.thisMonth);
    setValue('[data-kpi-orders-completed]', kpis.orders.completed);
    setValue('[data-kpi-orders-pending]', kpis.orders.pending);
    setValue('[data-kpi-refunds]', kpis.orders.refunds);

    setValue('[data-kpi-conversion]', kpis.conversionRate.value === null ? 'No data yet' : kpis.conversionRate.value + '%');
    setText('[data-kpi-conversion-meta]', 'Last ' + kpis.conversionRate.windowDays + ' days');
    setValue('[data-kpi-total-customers]', kpis.totalCustomers);
    setValue('[data-kpi-returning]', kpis.returningCustomers);
    setValue('[data-kpi-aov]', kpis.averageOrderValuePesewas === null ? 'No data yet' : formatCurrency(kpis.averageOrderValuePesewas / 100));

    const breakdown = kpis.revenue.breakdown;
    setValue('[data-kpi-revenue-production]', formatCurrency(breakdown.productionPesewas / 100));
    setValue('[data-kpi-revenue-internal]', formatCurrency(breakdown.internalPesewas / 100));
    setValue('[data-kpi-revenue-development]', formatCurrency(breakdown.developmentPesewas / 100));
    setValue('[data-kpi-revenue-total-processed]', formatCurrency(breakdown.totalProcessedPesewas / 100));

    setValue('[data-kpi-subscribers]', kpis.newsletter.totalSubscribers);
    setValue('[data-kpi-subscribers-today]', kpis.newsletter.newToday);
    setValue('[data-kpi-books]', kpis.content.publishedBooks);
    setValue('[data-kpi-resources]', kpis.content.publishedResources);
    setValue('[data-kpi-blog]', kpis.content.publishedBlogPosts);
    setValue('[data-kpi-reviews]', kpis.content.publishedReviews);
    setValue('[data-kpi-rating]', kpis.content.averageRating === null ? 'No reviews yet' : kpis.content.averageRating.toFixed(1) + ' / 5');
    setValue('[data-kpi-coupons-active]', kpis.coupons.active);
    setValue('[data-kpi-coupons-expired]', kpis.coupons.expired);
    setValue('[data-kpi-draft]', kpis.content.draftProducts + kpis.content.draftResources + kpis.content.draftBlogPosts);
  }

  function renderRevenueIntelligence(ri) {
    setText(
      '[data-ri-best-seller]',
      ri.bestSellingProduct ? ri.bestSellingProduct.title + ' — ' + formatCurrency(ri.bestSellingProduct.revenuePesewas / 100) + ' (' + ri.bestSellingProduct.orderCount + ' orders)' : 'No verified orders yet.'
    );
    setText('[data-ri-best-day]', ri.highestRevenueDay ? ri.highestRevenueDay.date + ' — ' + formatCurrency(ri.highestRevenueDay.revenuePesewas / 100) : 'No verified orders yet.');
    setText(
      '[data-ri-fastest-growing]',
      ri.fastestGrowingProduct ? ri.fastestGrowingProduct.title + ' — up ' + ri.fastestGrowingProduct.growthPercent + '% vs the prior 30 days' : 'Not enough data yet (needs orders in two consecutive 30-day windows).'
    );
    setText('[data-ri-coupon-loss]', formatCurrency(ri.revenueLostToCouponsPesewas / 100));
    setText('[data-ri-avg-discount]', ri.averageDiscountPesewas === null ? 'No coupon orders yet.' : formatCurrency(ri.averageDiscountPesewas / 100));
    setText(
      '[data-ri-forecast]',
      ri.salesForecast ? formatCurrency(ri.salesForecast.nextMonthPesewas / 100) + ' projected next month. ' + ri.salesForecast.basis : 'Not enough monthly history yet for an honest trendline (needs at least 3 months of real revenue).'
    );
  }

  function renderFinancial(fin) {
    setText('[data-fin-gross]', formatCurrency(fin.grossRevenuePesewas / 100));
    setText('[data-fin-net]', formatCurrency(fin.netRevenuePesewas / 100));
    setText(
      '[data-fin-most-discounted]',
      fin.mostDiscountedProduct ? fin.mostDiscountedProduct.title + ' — ' + formatCurrency(fin.mostDiscountedProduct.totalDiscountPesewas / 100) + ' given in discounts' : 'No coupon orders yet.'
    );
  }

  function renderPublishing(pub) {
    setValue('[data-pub-books]', pub.books.published);
    setText('[data-pub-books-meta]', pub.books.draft + ' draft, ' + pub.books.comingSoon + ' coming soon, ' + pub.books.archived + ' archived');
    setValue('[data-pub-resources]', pub.resources.published);
    setText('[data-pub-resources-meta]', pub.resources.draft + ' draft');
    setValue('[data-pub-blog]', pub.blog.published);
    setText('[data-pub-blog-meta]', pub.blog.draft + ' draft');
    setValue('[data-pub-media]', pub.mediaAssetsCount);
    setValue('[data-pub-broken-media]', pub.brokenMediaReferences);
    setValue('[data-pub-missing-covers]', pub.productsMissingCovers);
    setValue('[data-pub-missing-metadata]', pub.productsMissingMetadata);
    setValue('[data-pub-missing-seo]', pub.productsMissingSeo);
  }

  function renderMonthlyRevenueChart(revenueByMonth) {
    const container = root.querySelector('[data-chart-monthly-revenue]');
    if (!container) return;
    const points = revenueByMonth.map((m) => ({ date: m.month, count: Math.round(m.revenuePesewas / 100) }));
    window.AdminCharts.renderTimeseries(container, points, { color: 'var(--color-accent)' });
  }

  // ============================================================
  // Phase 3 — Sales Analytics charts (range-based)
  // ============================================================
  function bindChartPresets() {
    root.querySelectorAll('[data-charts-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        root.querySelectorAll('[data-charts-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        button.setAttribute('aria-pressed', 'true');
        chartsRangeDays = Number(button.getAttribute('data-charts-preset'));
        loadCharts(chartsRangeDays);
        loadCustomerInsights(chartsRangeDays);
      });
    });
  }

  function rangeParams(days) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return 'from=' + fmt(from) + '&to=' + fmt(to);
  }

  async function loadCharts(days) {
    let data;
    try {
      data = await window.AdminAuth.adminFetch('/api/admin/dashboard/charts?' + rangeParams(days) + '&analyticsMode=' + analyticsMode);
    } catch (error) {
      showLoadError('Could not load sales analytics: ' + error.message);
      return;
    }

    const revenuePoints = data.dailyRevenue.map((d) => ({ date: d.date, count: Math.round(d.revenuePesewas / 100) }));
    window.AdminCharts.renderTimeseries(root.querySelector('[data-chart-revenue]'), revenuePoints, { color: 'var(--color-accent)' });

    const channelBars = data.salesByChannel.map((c) => ({ label: labelizeChannel(c.channel), value: c.orderCount }));
    window.AdminCharts.renderBarChart(root.querySelector('[data-chart-channel]'), channelBars, {
      color: 'var(--color-info, var(--color-accent))',
      formatValue: (n) => n + ' order' + (n === 1 ? '' : 's'),
    });

    renderTopProductsTable(data.topProducts);
    renderCouponUsageTable(data.couponUsage);
  }

  function labelizeChannel(channel) {
    if (channel === 'unknown') return 'Unknown';
    return channel.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function renderTopProductsTable(items) {
    const body = root.querySelector('[data-top-products-body]');
    const wrap = root.querySelector('[data-top-products-wrap]');
    const empty = root.querySelector('[data-top-products-empty]');
    if (!items || items.length === 0) {
      wrap.hidden = true;
      empty.hidden = false;
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;
    body.innerHTML = '';
    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(item.title) + '</td><td>' + item.orderCount + '</td><td>' + formatCurrency(item.revenuePesewas / 100) + '</td>';
      body.appendChild(tr);
    });
  }

  function renderCouponUsageTable(items) {
    const body = root.querySelector('[data-coupon-usage-body]');
    const wrap = root.querySelector('[data-coupon-usage-wrap]');
    const empty = root.querySelector('[data-coupon-usage-empty]');
    if (!items || items.length === 0) {
      wrap.hidden = true;
      empty.hidden = false;
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;
    body.innerHTML = '';
    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + escapeHtml(item.code) + '</td><td>' + item.redemptions + '</td><td>' + formatCurrency(item.totalDiscountPesewas / 100) + '</td>';
      body.appendChild(tr);
    });
  }

  // ============================================================
  // Phase 4 + 8 — Customer Analytics & Experience Metrics
  // ============================================================
  async function loadCustomerInsights(days) {
    let data;
    try {
      data = await window.AdminAuth.adminFetch('/api/admin/dashboard/customer-insights?' + rangeParams(days) + '&analyticsMode=' + analyticsMode);
    } catch (error) {
      showLoadError('Could not load customer analytics: ' + error.message);
      return;
    }

    root.querySelector('[data-customer-range-label]').textContent = '(last ' + days + ' days)';
    setValue('[data-cust-new]', data.newCustomers);
    setValue('[data-cust-returning]', data.returningCustomersInRange);
    setValue('[data-cust-recoveries]', data.passwordRecoveries);
    setValue('[data-cust-review-rate]', data.reviewSubmissionRate === null ? 'No data yet' : data.reviewSubmissionRate + '%');
    setValue('[data-cust-clv]', data.customerLifetimeValuePesewas === null ? 'No data yet' : formatCurrency(data.customerLifetimeValuePesewas / 100));
    setValue('[data-cust-repeat-rate]', data.repeatPurchaseRatePercent === null ? 'No data yet' : data.repeatPurchaseRatePercent + '%');
    setValue('[data-cust-time-to-purchase]', data.averageTimeToPurchaseDays === null ? 'No data yet' : data.averageTimeToPurchaseDays + ' days');
    setValue('[data-cust-time-to-review]', data.averageTimeToFirstReviewDays === null ? 'No data yet' : data.averageTimeToFirstReviewDays + ' days');

    renderMostDownloaded(data.mostDownloadedProducts);
  }

  function renderMostDownloaded(items) {
    const body = root.querySelector('[data-most-downloaded-body]');
    const wrap = root.querySelector('[data-most-downloaded-wrap]');
    const empty = root.querySelector('[data-most-downloaded-empty]');
    if (!items || items.length === 0) {
      wrap.hidden = true;
      empty.hidden = false;
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;
    body.innerHTML = '';
    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + escapeHtml(item.slug) + '</td><td>' + item.downloads + '</td>';
      body.appendChild(tr);
    });
  }

  // ============================================================
  // Phase 5 — Operational Monitoring feeds
  // ============================================================
  async function loadOperational() {
    let data;
    try {
      data = await window.AdminAuth.adminFetch('/api/admin/dashboard/operational?analyticsMode=' + analyticsMode);
    } catch (error) {
      showLoadError('Could not load operational activity: ' + error.message);
      return;
    }

    renderFeed('[data-feed-orders]', data.recentOrders, (o) => o.productTitle + ' — ' + formatCurrency(o.amountPesewas / 100), (o) => o.verifiedAt);
    renderFeed('[data-feed-reviews]', data.recentReviews, (r) => r.productTitle + ' — ' + r.rating + '/5 (' + r.status + ')', (r) => r.createdAt);
    renderFeed('[data-feed-contacts]', data.recentContactMessages, (c) => c.name + ': ' + c.messagePreview, (c) => c.createdAt);
    renderFeed('[data-feed-consultations]', data.recentConsultations, (c) => c.name + ' (' + c.status + ')', (c) => c.createdAt);
    renderFeed('[data-feed-newsletter]', data.recentNewsletterSignups, (s) => s.email, (s) => s.subscribedAt);
    renderFeed('[data-feed-logins]', data.recentLogins, (l) => l.email, (l) => l.createdAt);
    renderFeed('[data-feed-failed-logins]', data.recentFailedLogins, (l) => l.email + ' (' + humanizeAction(l.outcome) + ')', (l) => l.createdAt);
    renderFeed('[data-feed-password-resets]', data.recentPasswordResets, (p) => p.recipient + ' — ' + humanizeAction(p.template), (p) => p.createdAt);
    renderFeed('[data-feed-admin-activity]', data.recentAdminActivity, (a) => humanizeAction(a.action), (a) => a.createdAt);
    renderFeed('[data-feed-product-changes]', data.recentProductChanges, (p) => humanizeAction(p.action) + (p.entityId ? ' (#' + p.entityId + ')' : ''), (p) => p.createdAt);
  }

  // ============================================================
  // Version 4.0 Milestone C1 (Core Email Lifecycle) — Email Lifecycle summary
  // ============================================================
  const EMAIL_LIFECYCLE_LABELS = {
    'newsletter-welcome': 'Newsletter welcome',
    'free-guide-delivery': 'Lead magnet delivery',
    'customer-welcome': 'Welcome (first purchase)',
    'purchase-receipt': 'Purchase receipt',
    'secure-download': 'Secure download',
    'customer-purchase-followup': 'Purchase follow-up',
    'customer-review-reminder': 'Review reminder',
    'newsletter-campaign': 'Product/campaign announcement',
  };

  async function loadEmailLifecycle() {
    let data;
    try {
      data = await window.AdminAuth.adminFetch('/api/admin/dashboard/email-lifecycle');
    } catch (error) {
      showLoadError('Could not load the email lifecycle summary: ' + error.message);
      return;
    }

    const emptyEl = root.querySelector('[data-email-lifecycle-empty]');
    const wrapEl = root.querySelector('[data-email-lifecycle-wrap]');
    const bodyEl = root.querySelector('[data-email-lifecycle-body]');
    const windowLabelEl = root.querySelector('[data-email-lifecycle-window]');
    if (!emptyEl || !wrapEl || !bodyEl) return;

    if (windowLabelEl) windowLabelEl.textContent = 'Last ' + data.windowDays + ' days';

    const hasAnyActivity = data.stages.some((stage) => stage.sent > 0 || stage.failed > 0);
    emptyEl.hidden = hasAnyActivity;
    wrapEl.hidden = !hasAnyActivity;
    if (!hasAnyActivity) return;

    bodyEl.innerHTML = '';
    data.stages.forEach((stage) => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.textContent = EMAIL_LIFECYCLE_LABELS[stage.template] || stage.template;
      const sentTd = document.createElement('td');
      sentTd.textContent = String(stage.sent);
      const failedTd = document.createElement('td');
      failedTd.textContent = String(stage.failed);
      if (stage.failed > 0) failedTd.style.color = 'var(--color-error, #B3261E)';
      const lastSentTd = document.createElement('td');
      lastSentTd.textContent = stage.lastSentAt ? formatRelativeTime(stage.lastSentAt) : '—';
      tr.append(nameTd, sentTd, failedTd, lastSentTd);
      bodyEl.appendChild(tr);
    });
  }

  function renderFeed(selector, items, labelFn, timeFn) {
    const list = root.querySelector(selector);
    if (!list) return;
    list.innerHTML = '';
    if (!items || items.length === 0) {
      const li = document.createElement('li');
      li.className = 'admin-activity-item';
      const span = document.createElement('span');
      span.className = 'text-secondary text-small';
      span.textContent = 'Nothing yet.';
      li.appendChild(span);
      list.appendChild(li);
      return;
    }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'admin-activity-item';
      const label = document.createElement('span');
      label.textContent = labelFn(item);
      const time = document.createElement('span');
      time.className = 'text-secondary text-small';
      time.textContent = formatRelativeTime(timeFn(item));
      li.append(label, time);
      list.appendChild(li);
    });
  }

  // ============================================================
  // Shared helpers
  // ============================================================
  function setValue(selector, value) {
    const el = root.querySelector(selector);
    if (el) el.textContent = String(value);
  }
  function setText(selector, value) {
    const el = root.querySelector(selector);
    if (el) el.textContent = value;
  }

  function formatDelta(percent) {
    if (percent === null) return 'New';
    const sign = percent > 0 ? '+' : '';
    return sign + percent + '%';
  }

  function showLoadError(message) {
    const errorEl = root.querySelector('[data-dashboard-error]');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
}

/** Same GH₵ formatting convention as every other admin page's own local copy (see admin-analytics.js). */
function formatCurrency(amount) {
  if (!isFinite(amount)) return 'GH₵0.00';
  const rounded = Math.round(amount * 100) / 100;
  const parts = Math.abs(rounded).toFixed(2).split('.');
  const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
}

/** Generic fallback humanizer for the many audit_logs action strings this dashboard surfaces (far more than the small hand-mapped set admin-dashboard.js's Phase 0.2 version needed) — "product.updated" -> "product updated", "cron.heartbeat" -> "cron heartbeat". */
function humanizeAction(action) {
  return String(action).replace(/[._]/g, ' ');
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const then = new Date(isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z').getTime();
  const diffSeconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return diffMinutes + 'm ago';
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return diffHours + 'h ago';
  const diffDays = Math.round(diffHours / 24);
  return diffDays + 'd ago';
}

document.addEventListener('partials:loaded', initAdminDashboard);

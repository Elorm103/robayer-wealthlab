/**
 * Robayer WealthLab: "Your Learning" — Digital Library 2.0 Phase I
 * (Learning Studio + Personal Mastery). Drives the
 * [data-library-learning-stats-root] section on dashboard/index.html,
 * a separate, independent component matching this project's
 * established one-script-per-section convention (library-continue-reading.js,
 * library-ai-entry.js, library-recommendations.js).
 *
 * Calls GET /api/customer/library/learning-stats — see
 * services/customer/libraryLearningService.ts's own header comment:
 * every number is a real COUNT/SUM over this customer's own
 * library_learning_responses rows, never an invented "mastery score."
 * The endpoint itself only returns books this customer has actually
 * engaged with (an inner join to their responses) - so this component
 * never has to decide whether to hide an all-zero card; there simply
 * isn't one. Renders nothing at all, section stays hidden, if the
 * customer has never answered a Quick Check or completed an Action
 * anywhere - never a placeholder, never an empty "Your Learning"
 * heading with nothing under it.
 *
 * Joins against GET /api/customer/purchases (same independent-fetch,
 * join-client-side pattern library-continue-reading.js already
 * established) purely to resolve a real, owned assetId to link "Continue
 * Learning" to - the stats endpoint aggregates across every asset of a
 * product, so when a book has both PDF and EPUB this deliberately
 * links to whichever owned, non-revoked asset sorts first, the same
 * simplification a "jump back in" shortcut can afford even though the
 * main Library card (Phase 9C.6) shows every format explicitly.
 */

function initLibraryLearningStats() {
  const section = document.querySelector('[data-library-learning-stats-root]');
  if (!section || section.hasAttribute('data-bound')) return;
  section.setAttribute('data-bound', 'true');

  const listEl = section.querySelector('[data-library-learning-stats-list]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let statsResult;
    let purchasesResult;
    try {
      [statsResult, purchasesResult] = await Promise.all([
        window.CustomerDashboard.customerFetch('/api/customer/library/learning-stats'),
        window.CustomerDashboard.customerFetch('/api/customer/purchases?limit=50'),
      ]);
    } catch {
      // A missed "Your Learning" section is never worth disrupting the rest of the Library over - fail silently.
      return;
    }

    const stats = statsResult.stats || [];
    if (stats.length === 0) return;

    const purchaseBySlug = new Map((purchasesResult.purchases || []).map((p) => [p.productSlug, p]));

    const items = stats
      .map((stat) => {
        const purchase = purchaseBySlug.get(stat.productSlug);
        if (!purchase) return null; // stale/edge case - no longer visible to this customer
        const asset = (purchase.assets || []).find((a) => !a.revoked);
        if (!asset) return null;
        return { stat, purchase, asset };
      })
      .filter(Boolean);
    if (items.length === 0) return;

    listEl.innerHTML = '';
    items.forEach((item) => listEl.appendChild(renderCard(item)));
    section.hidden = false;
  }

  function renderCard({ stat, purchase, asset }) {
    const card = document.createElement('a');
    card.className = 'library-learning-stats-card';
    card.href = `/dashboard/read/?ref=${encodeURIComponent(purchase.purchaseReference)}&assetId=${encodeURIComponent(asset.assetId)}`;

    const title = document.createElement('p');
    title.className = 'library-learning-stats-card__title';
    title.textContent = purchase.productTitle;
    card.appendChild(title);

    const metrics = document.createElement('div');
    metrics.className = 'library-learning-stats-card__metrics';

    if (stat.quickChecksAttempted > 0) {
      const metric = document.createElement('span');
      metric.className = 'library-learning-stats-card__metric';
      metric.textContent = `🧠 ${stat.quickChecksCorrect}/${stat.quickChecksAttempted} correct`;
      metrics.appendChild(metric);
    }
    if (stat.actionsCompleted > 0) {
      const metric = document.createElement('span');
      metric.className = 'library-learning-stats-card__metric';
      metric.textContent = `💡 ${stat.actionsCompleted} action${stat.actionsCompleted === 1 ? '' : 's'} completed`;
      metrics.appendChild(metric);
    }
    card.appendChild(metrics);

    if (stat.totalPublishedItems > 0) {
      const track = document.createElement('div');
      track.className = 'library-learning-stats-card__track';
      const fill = document.createElement('div');
      fill.className = 'library-learning-stats-card__track-fill';
      const percent = Math.round((stat.itemsCompleted / stat.totalPublishedItems) * 100);
      fill.style.width = `${percent}%`;
      track.appendChild(fill);
      card.appendChild(track);

      const meta = document.createElement('p');
      meta.className = 'library-learning-stats-card__meta';
      meta.textContent = `${stat.itemsCompleted} of ${stat.totalPublishedItems} learning moments`;
      card.appendChild(meta);
    }

    const cta = document.createElement('span');
    cta.className = 'library-learning-stats-card__cta';
    cta.textContent = 'Continue learning';
    card.appendChild(cta);

    return card;
  }
}

document.addEventListener('partials:loaded', initLibraryLearningStats);
document.addEventListener('DOMContentLoaded', initLibraryLearningStats);

/**
 * Robayer WealthLab: "Recommended for You" — Digital Library
 * Modernization (Phase 5), extended in Digital Library 2.0 Phase G
 * (Book Discovery + Recommendations). Drives the
 * [data-library-recommendations-root] section on dashboard/index.html,
 * a separate, independent component from library-list.js, matching
 * this project's established one-script-per-section convention
 * (js/components/admin/admin-live-activity.js, admin-system-health.js,
 * etc.) rather than growing the library component further.
 *
 * Calls GET /api/customer/library/recommendations — see
 * backend/services/customer/libraryRecommendationsService.ts for the
 * full reasoning: admin-curated product_relations first, a deterministic
 * topic-match fallback second, scoped to what this authenticated
 * customer actually owns. `rec.reason` is a real, server-built sentence
 * (never an internal score, never fabricated social proof) — rendered
 * here verbatim, not reconstructed client-side. Renders nothing at all
 * if the response is empty (a customer who owns nothing, or whose
 * owned products have no relation AND no topic peer) — never a
 * placeholder, never an empty heading with nothing under it.
 *
 * Deliberately quiet: at most three cards, phrased as a next step, never
 * a storefront tone. See the Phase 1-4 report's UX strategy section for
 * why relevance is prioritized over revenue here.
 */

function initLibraryRecommendations() {
  const section = document.querySelector('[data-library-recommendations-root]');
  if (!section || section.hasAttribute('data-bound')) return;
  section.setAttribute('data-bound', 'true');

  const listEl = section.querySelector('[data-library-recommendations-list]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let result;
    try {
      result = await window.CustomerDashboard.customerFetch('/api/customer/library/recommendations');
    } catch {
      // A missed recommendation is never worth disrupting the rest of
      // the Library over - fail silently, section stays hidden.
      return;
    }

    const recommendations = result.recommendations || [];
    if (recommendations.length === 0) return;

    listEl.innerHTML = '';
    recommendations.forEach((rec) => listEl.appendChild(renderCard(rec)));
    section.hidden = false;
  }

  function renderCard(rec) {
    const card = document.createElement('a');
    card.className = 'library-recommendation';
    card.href = `/books/${encodeURIComponent(rec.slug)}/`;
    card.setAttribute('data-library-recommendation-cta', '');

    const cover = document.createElement('div');
    cover.className = 'library-recommendation__cover book-card__cover book-card__cover--compact';
    if (rec.coverImageUrl) {
      cover.style.backgroundImage = `url('${rec.coverImageUrl}')`;
      cover.style.backgroundSize = 'cover';
      cover.style.backgroundPosition = 'center';
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'book-card__cover-placeholder-text';
      placeholder.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'book-card__cover-placeholder-title';
      title.textContent = rec.title;
      placeholder.appendChild(title);
      cover.appendChild(placeholder);
    }
    card.appendChild(cover);

    const body = document.createElement('div');
    body.className = 'library-recommendation__body';

    const because = document.createElement('p');
    because.className = 'library-recommendation__because';
    // rec.reason is a complete, real, server-built sentence (see
    // libraryRecommendationsService.ts's own buildReason()) - rendered
    // exactly as returned, never reconstructed or guessed client-side.
    because.textContent = rec.reason || 'You may find this useful next';
    body.appendChild(because);

    const title = document.createElement('p');
    title.className = 'library-recommendation__title';
    title.textContent = rec.title;
    body.appendChild(title);

    if (rec.shortDescription) {
      const description = document.createElement('p');
      description.className = 'library-recommendation__description';
      description.textContent = rec.shortDescription;
      body.appendChild(description);
    }

    const cta = document.createElement('span');
    cta.className = 'library-recommendation__cta';
    cta.textContent = 'Explore';
    body.appendChild(cta);

    card.appendChild(body);
    return card;
  }
}

document.addEventListener('partials:loaded', initLibraryRecommendations);
document.addEventListener('DOMContentLoaded', initLibraryRecommendations);

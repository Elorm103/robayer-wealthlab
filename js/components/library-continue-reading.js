/**
 * Robayer WealthLab: "Continue Reading" — Digital Library Phase 7B
 * (Personal Reading Experience). Drives the
 * [data-library-continue-reading-root] section on dashboard/index.html,
 * a separate, independent component from library-list.js, matching
 * this project's established one-script-per-section convention
 * (js/components/library-recommendations.js et al.) rather than
 * growing the library component further.
 *
 * Fetches its own two things — GET /api/customer/library/progress (the
 * server-persisted reading position, see
 * backend/services/customer/libraryProgressService.ts) and
 * GET /api/customer/purchases (for the title/cover the progress
 * endpoint deliberately doesn't duplicate) — and joins them client-
 * side by (purchaseReference, assetId). Mirrors
 * library-recommendations.js's own "independent fetch, not shared
 * state" pattern exactly, at the cost of one extra request most
 * customers' browsers will already have this data cached from.
 *
 * Shows only genuinely `in_progress` resources — never `not_started`
 * (nothing to continue) and never `completed` (that belongs to the
 * card's own "Completed" badge, not this shelf). Renders nothing at
 * all, section stays hidden, for a customer with no in-progress
 * reading - never a placeholder, never an empty heading.
 */

function initLibraryContinueReading() {
  const section = document.querySelector('[data-library-continue-reading-root]');
  if (!section || section.hasAttribute('data-bound')) return;
  section.setAttribute('data-bound', 'true');

  const listEl = section.querySelector('[data-library-continue-reading-list]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let progressResult;
    let purchasesResult;
    try {
      // Phase J.2.3 — reuses the one shared, page-wide fetch of each
      // endpoint (see library-data.js) instead of issuing its own.
      [progressResult, purchasesResult] = await Promise.all([window.LibraryData.getProgress(), window.LibraryData.getPurchases()]);
    } catch {
      // A missed "Continue Reading" shelf is never worth disrupting the
      // rest of the Library over - fail silently, section stays hidden.
      return;
    }

    const inProgress = (progressResult.progress || []).filter((p) => p.status === 'in_progress');
    if (inProgress.length === 0) return;

    const purchaseByReference = new Map((purchasesResult.purchases || []).map((p) => [p.purchaseReference, p]));

    const items = inProgress
      .map((p) => {
        const purchase = purchaseByReference.get(p.purchaseReference);
        if (!purchase) return null; // stale/edge case - the purchase itself is no longer visible to this customer
        return { progress: p, purchase };
      })
      .filter(Boolean);
    if (items.length === 0) return;

    listEl.innerHTML = '';
    items.forEach((item) => listEl.appendChild(renderCard(item)));
    section.hidden = false;
  }

  function renderCard({ progress, purchase }) {
    const card = document.createElement('a');
    card.className = 'library-continue-card';
    card.href = `/dashboard/read/?ref=${encodeURIComponent(purchase.purchaseReference)}&assetId=${encodeURIComponent(progress.assetId)}`;
    card.setAttribute('data-library-continue-reading-cta', '');

    const cover = document.createElement('div');
    cover.className = 'library-continue-card__cover book-card__cover book-card__cover--compact';
    if (purchase.coverImageUrl) {
      cover.style.backgroundImage = `url('${purchase.coverImageUrl}')`;
      cover.style.backgroundSize = 'cover';
      cover.style.backgroundPosition = 'center';
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'book-card__cover-placeholder-text';
      placeholder.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'book-card__cover-placeholder-title';
      title.textContent = purchase.productTitle;
      placeholder.appendChild(title);
      cover.appendChild(placeholder);
    }
    card.appendChild(cover);

    const body = document.createElement('div');
    body.className = 'library-continue-card__body';

    const title = document.createElement('p');
    title.className = 'library-continue-card__title';
    title.textContent = purchase.productTitle;
    body.appendChild(title);

    const track = document.createElement('div');
    track.className = 'library-continue-card__track';
    const fill = document.createElement('div');
    fill.className = 'library-continue-card__track-fill';
    fill.style.width = `${progress.percentComplete}%`;
    track.appendChild(fill);
    body.appendChild(track);

    const meta = document.createElement('p');
    meta.className = 'library-continue-card__meta';
    // PDF reports a real page/of/total; EPUB has no fixed page count
    // (progress.currentPage/totalPages are genuinely null - see
    // libraryProgressService.ts's own ProgressInput comment), so it
    // shows only the real percentage rather than a fabricated "Page
    // null of null."
    meta.textContent = progress.currentPage != null && progress.totalPages != null
      ? `Page ${progress.currentPage} of ${progress.totalPages} — ${progress.percentComplete}% complete`
      : `${progress.percentComplete}% complete`;
    body.appendChild(meta);

    const cta = document.createElement('span');
    cta.className = 'library-continue-card__cta';
    cta.textContent = 'Continue reading';
    body.appendChild(cta);

    card.appendChild(body);
    return card;
  }
}

document.addEventListener('partials:loaded', initLibraryContinueReading);
document.addEventListener('DOMContentLoaded', initLibraryContinueReading);

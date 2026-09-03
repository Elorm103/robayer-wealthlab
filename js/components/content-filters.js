/**
 * Robayer WealthLab — Content Filters Component
 *
 * Generic category-pill + live-search filtering for a grid of cards.
 * Introduced in Sprint 5 (Blog) to replace the page-specific
 * book-filters.js (Sprint 2) and resource-filters.js (Sprint 4) — same
 * underlying logic, generalized behind data attributes so any future
 * page opts in with markup only, no new JS.
 *
 * Markup contract (all optional except the grid):
 *   [data-filter-grid]     the card container — each direct child is one card
 *   [data-filter-controls] wraps .filter-pill buttons (aria-pressed, data-filter)
 *   [data-filter-search]   a text/search <input>
 *   [data-filter-empty]    toggled via .hidden when nothing matches
 * Cards read [data-category] (for pills) and [data-title] (for search).
 *
 * Pill clicks are handled via delegation on [data-filter-controls]
 * itself, not per-button listeners bound at init time, so a page whose
 * pills are generated dynamically after an async fetch (e.g.
 * affiliate-resources.js's per-product pills, built once the resource
 * list is known) still works with zero extra wiring, exactly like a
 * page whose pills are static HTML from the start.
 */

function initContentFilters() {
  const grid = document.querySelector('[data-filter-grid]');
  if (!grid) return;

  const bar = document.querySelector('[data-filter-controls]');
  const searchInput = document.querySelector('[data-filter-search]');
  const emptyState = document.querySelector('[data-filter-empty]');

  let activeCategory = 'all';

  function applyFilters() {
    // Re-queried on every call rather than cached at init — a grid
    // populated asynchronously by js/components/product-loader.js
    // (Sprint 2.2) has no real children yet at DOMContentLoaded, so a
    // one-time snapshot here would silently filter zero/stale cards
    // forever. Re-querying costs nothing at this project's grid sizes.
    const cards = Array.from(grid.children);
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    let visibleCount = 0;

    cards.forEach((card) => {
      const matchesCategory = activeCategory === 'all' || card.getAttribute('data-category') === activeCategory;
      const title = (card.getAttribute('data-title') || '').toLowerCase();
      const matchesQuery = query === '' || title.includes(query);
      const visible = matchesCategory && matchesQuery;
      card.classList.toggle('hidden', !visible);
      if (visible) visibleCount += 1;
    });

    if (emptyState) emptyState.classList.toggle('hidden', visibleCount !== 0);
  }

  if (bar) {
    bar.addEventListener('click', (event) => {
      const pill = event.target.closest('.filter-pill');
      if (!pill || !bar.contains(pill)) return;
      Array.from(bar.querySelectorAll('.filter-pill')).forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
      activeCategory = pill.getAttribute('data-filter');
      applyFilters();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }
}

document.addEventListener('DOMContentLoaded', initContentFilters);

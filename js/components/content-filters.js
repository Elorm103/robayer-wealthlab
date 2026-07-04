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
 */

function initContentFilters() {
  const grid = document.querySelector('[data-filter-grid]');
  if (!grid) return;

  const bar = document.querySelector('[data-filter-controls]');
  const searchInput = document.querySelector('[data-filter-search]');
  const emptyState = document.querySelector('[data-filter-empty]');
  const cards = Array.from(grid.children);

  let activeCategory = 'all';

  function applyFilters() {
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
    const pills = Array.from(bar.querySelectorAll('.filter-pill'));
    pills.forEach((pill) => {
      pill.addEventListener('click', () => {
        pills.forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
        activeCategory = pill.getAttribute('data-filter');
        applyFilters();
      });
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }
}

document.addEventListener('DOMContentLoaded', initContentFilters);

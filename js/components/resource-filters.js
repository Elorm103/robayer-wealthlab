/**
 * Robayer WealthLab — Resource Filters Component
 *
 * Combines category-pill filtering (same pattern as book-filters.js)
 * with client-side text search over the resources grid, since both
 * act on the same set of cards and must not fight each other. Cards
 * carry [data-category]/[data-title], so adding more resources later
 * needs no changes here.
 */

function initResourceFilters() {
  const grid = document.querySelector('[data-resource-grid]');
  if (!grid) return;

  const bar = document.querySelector('[data-resource-filters]');
  const searchInput = document.querySelector('[data-resource-search]');
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

document.addEventListener('DOMContentLoaded', initResourceFilters);

/**
 * Robayer WealthLab — Book Filters Component
 *
 * Category-pill filtering for the Books page grid. Purely a show/hide
 * layer over markup that already exists in the page — book-cards carry
 * a [data-category], so adding more books later needs no changes here.
 */

function initBookFilters() {
  const bar = document.querySelector('[data-book-filters]');
  const grid = document.querySelector('[data-book-grid]');
  const emptyState = document.querySelector('[data-filter-empty]');

  if (!bar || !grid) return;

  const pills = Array.from(bar.querySelectorAll('.filter-pill'));
  const cards = Array.from(grid.children);

  function applyFilter(category) {
    let visibleCount = 0;

    cards.forEach((card) => {
      const matches = category === 'all' || card.getAttribute('data-category') === category;
      card.classList.toggle('hidden', !matches);
      if (matches) visibleCount += 1;
    });

    if (emptyState) emptyState.classList.toggle('hidden', visibleCount !== 0);
  }

  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
      applyFilter(pill.getAttribute('data-filter'));
    });
  });
}

document.addEventListener('DOMContentLoaded', initBookFilters);

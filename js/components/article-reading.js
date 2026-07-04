/**
 * Robayer WealthLab — Article Reading Component
 *
 * Two related long-form-reading affordances for Blog Article pages: a
 * fixed reading-progress bar, and active-section highlighting in the
 * sticky table of contents. Both derive from the same scroll
 * position, so they're one scroll listener rather than two competing
 * ones. Each feature checks its own elements exist before doing
 * anything, so a future article can opt out of either (or both) by
 * simply not including that markup.
 */

function initArticleReading() {
  const article = document.querySelector('[data-article-body]');
  if (!article) return;

  const progressBar = document.querySelector('[data-reading-progress]');
  const tocLinks = Array.from(document.querySelectorAll('[data-toc] a'));
  const headings = tocLinks
    .map((link) => document.getElementById(link.getAttribute('href').slice(1)))
    .filter(Boolean);

  function updateProgress() {
    if (!progressBar) return;
    const rect = article.getBoundingClientRect();
    const articleTop = window.scrollY + rect.top;
    const viewportBottom = window.scrollY + window.innerHeight;
    const percent = Math.min(100, Math.max(0, ((viewportBottom - articleTop) / rect.height) * 100));
    progressBar.style.setProperty('--reading-progress', percent);
  }

  function setActiveHeading() {
    if (!headings.length) return;
    let current = headings[0];
    headings.forEach((heading) => {
      if (heading.getBoundingClientRect().top - 120 <= 0) current = heading;
    });
    tocLinks.forEach((link) => {
      const isActive = link.getAttribute('href') === '#' + current.id;
      if (isActive) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  function onScroll() {
    updateProgress();
    setActiveHeading();
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

document.addEventListener('DOMContentLoaded', initArticleReading);

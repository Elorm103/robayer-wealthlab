/**
 * Robayer WealthLab — dependency-free inline SVG time-series chart
 * (Version 2.0 Phase 3 Stage 4, Analytics). Hand-rolled rather than a
 * charting library, per docs/v2-analytics-spec.md's "Charts" section:
 * this platform's real data volume (tens of points, not thousands)
 * doesn't justify the dependency, following the same "no icon library,
 * hand-authored SVG" precedent already used for every icon on the
 * public site.
 *
 * Exposed as `window.AdminCharts.renderTimeseries` — a plain global
 * function, not a component that self-registers on `partials:loaded`,
 * since it has no page of its own and is called directly by whichever
 * page needs a chart (today: admin-analytics.js).
 */

window.AdminCharts = (function () {
  const WIDTH = 600;
  const HEIGHT = 180;
  const PADDING = { top: 16, right: 12, bottom: 24, left: 12 };

  /**
   * @param {HTMLElement} container
   * @param {{date: string, count: number}[]} points
   * @param {{color?: string}} [options]
   */
  function renderTimeseries(container, points, options) {
    container.innerHTML = '';

    if (!points || points.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-secondary text-small';
      empty.textContent = 'No data in this range.';
      container.appendChild(empty);
      return;
    }

    const color = (options && options.color) || 'var(--color-accent)';
    const maxCount = Math.max(1, ...points.map((p) => p.count));
    const plotWidth = WIDTH - PADDING.left - PADDING.right;
    const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

    const xFor = (index) => PADDING.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const yFor = (count) => PADDING.top + plotHeight - (count / maxCount) * plotHeight;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', describeForScreenReader(points));
    svg.style.width = '100%';
    svg.style.height = 'auto';

    const gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    gridLine.setAttribute('x1', String(PADDING.left));
    gridLine.setAttribute('x2', String(WIDTH - PADDING.right));
    gridLine.setAttribute('y1', String(PADDING.top + plotHeight));
    gridLine.setAttribute('y2', String(PADDING.top + plotHeight));
    gridLine.setAttribute('stroke', 'var(--color-border)');
    gridLine.setAttribute('stroke-width', '1');
    svg.appendChild(gridLine);

    const pathData = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(2)} ${yFor(p.count).toFixed(2)}`).join(' ');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);

    points.forEach((p, i) => {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', xFor(i).toFixed(2));
      dot.setAttribute('cy', yFor(p.count).toFixed(2));
      dot.setAttribute('r', '2.5');
      dot.setAttribute('fill', color);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${p.date}: ${p.count}`;
      dot.appendChild(title);
      svg.appendChild(dot);
    });

    const maxLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    maxLabel.setAttribute('x', String(PADDING.left));
    maxLabel.setAttribute('y', String(PADDING.top - 4));
    maxLabel.setAttribute('font-size', '10');
    maxLabel.setAttribute('fill', 'var(--color-text-secondary)');
    maxLabel.textContent = String(maxCount);
    svg.appendChild(maxLabel);

    const firstLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    firstLabel.setAttribute('x', String(PADDING.left));
    firstLabel.setAttribute('y', String(HEIGHT - 6));
    firstLabel.setAttribute('font-size', '10');
    firstLabel.setAttribute('fill', 'var(--color-text-secondary)');
    firstLabel.textContent = points[0].date;
    svg.appendChild(firstLabel);

    const lastLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lastLabel.setAttribute('x', String(WIDTH - PADDING.right));
    lastLabel.setAttribute('y', String(HEIGHT - 6));
    lastLabel.setAttribute('font-size', '10');
    lastLabel.setAttribute('fill', 'var(--color-text-secondary)');
    lastLabel.setAttribute('text-anchor', 'end');
    lastLabel.textContent = points[points.length - 1].date;
    svg.appendChild(lastLabel);

    container.appendChild(svg);
  }

  function describeForScreenReader(points) {
    const total = points.reduce((sum, p) => sum + p.count, 0);
    return `Time series chart, ${points[0].date} to ${points[points.length - 1].date}, ${total} total`;
  }

  return { renderTimeseries };
})();

/**
 * Robayer WealthLab — Scroll Reveal Component
 *
 * Fades/slides [data-reveal] elements into place the first time they
 * enter the viewport. No-ops (shows content immediately) when the user
 * prefers reduced motion, matching the site's existing reduced-motion
 * posture (see base.css's global @media (prefers-reduced-motion) rule).
 */

function initScrollReveal() {
  const targets = document.querySelectorAll('[data-reveal]:not(.is-visible)');
  if (!targets.length) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  targets.forEach((el) => observer.observe(el));
}

document.addEventListener('DOMContentLoaded', initScrollReveal);

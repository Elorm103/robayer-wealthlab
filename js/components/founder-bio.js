/**
 * Robayer WealthLab — Founder Bio Component
 *
 * Renders the founder's biography from content/founder/bio.json into
 * any [data-founder-bio="short"] (a single paragraph) or
 * [data-founder-bio="long"] (a container that gets one <p> per bio
 * paragraph) element.
 *
 * The existing hand-written text already in these elements is the
 * fallback: if the fetch fails for any reason, nothing changes and the
 * page keeps showing its current, correct copy. Founder *name*/*title*
 * are deliberately left alone here — those stay owned by
 * assets/config/site.json via js/content-inject.js, so each fact has
 * exactly one source rather than two competing ones.
 */

(function () {
  async function initFounderBio() {
    const shortEls = document.querySelectorAll('[data-founder-bio="short"]');
    const longEls = document.querySelectorAll('[data-founder-bio="long"]');
    if (!shortEls.length && !longEls.length) return;

    try {
      const response = await fetch('/content/founder/bio.json');
      if (!response.ok) return;
      const bio = await response.json();

      if (bio.shortBio) {
        shortEls.forEach((el) => { el.textContent = bio.shortBio; });
      }

      if (Array.isArray(bio.longBio) && bio.longBio.length) {
        longEls.forEach((el) => {
          el.innerHTML = bio.longBio.map((paragraph) => `<p>${paragraph}</p>`).join('');
        });
      }
    } catch (error) {
      console.error(error);
    }
  }

  document.addEventListener('partials:loaded', initFounderBio);
})();

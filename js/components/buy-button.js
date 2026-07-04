/**
 * Robayer WealthLab — Buy Button Component
 *
 * Checkout (SkillsPad) isn't wired up yet. Rather than leave
 * [data-buy-button] behaving like a dead "#" link, clicking it reveals
 * an honest note in place of a silent no-op — same progressive-
 * enhancement pattern as newsletter-form.js.
 */

function initBuyButtons() {
  document.querySelectorAll('[data-buy-button]:not([data-bound])').forEach((btn) => {
    btn.setAttribute('data-bound', 'true');
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      if (btn.nextElementSibling && btn.nextElementSibling.hasAttribute('data-buy-note')) return;

      const note = document.createElement('p');
      note.setAttribute('data-buy-note', 'true');
      note.setAttribute('role', 'status');
      note.className = 'alert alert--info mt-3';
      note.innerHTML = 'Checkout is launching soon — <a href="/newsletter/">subscribe</a> to know the moment it opens.';
      btn.insertAdjacentElement('afterend', note);
    });
  });
}

document.addEventListener('DOMContentLoaded', initBuyButtons);

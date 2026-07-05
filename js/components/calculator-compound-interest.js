/**
 * Robayer WealthLab — Compound Interest Calculator
 *
 * Progressive enhancement for the form on /calculators/compound-interest/.
 * Uses the shared math in js/components/calculator-utils.js
 * (window.RobayerCalc) — client-side only, no backend, no external
 * libraries. Follows the same explicit-submit + validation pattern as
 * js/components/contact-form.js, rather than recalculating on every
 * keystroke, so the aria-live result region announces once per
 * deliberate calculation instead of on every character typed.
 */

function initCompoundInterestCalculator() {
  const forms = document.querySelectorAll('[data-calculator="compound-interest"]:not([data-bound])');
  if (!window.RobayerCalc) return;

  forms.forEach((form) => {
    form.setAttribute('data-bound', 'true');

    const fields = {
      principal: form.querySelector('[name="principal"]'),
      contribution: form.querySelector('[name="contribution"]'),
      rate: form.querySelector('[name="rate"]'),
      frequency: form.querySelector('[name="frequency"]'),
      years: form.querySelector('[name="years"]'),
    };
    const resultRegion = form.querySelector('[data-calculator-result]');
    const tableBody = form.querySelector('[data-calculator-table-body]');

    function validateField(input, test) {
      const field = input.closest('.field');
      const errorEl = field ? field.querySelector('.field__error') : null;
      const valid = test(input.value.trim());
      if (field) field.classList.toggle('field--error', !valid);
      if (errorEl) errorEl.hidden = valid;
      return valid;
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();

      const principal = window.RobayerCalc.parseNumberInput(fields.principal.value);
      const contribution = window.RobayerCalc.parseNumberInput(fields.contribution.value);
      const rate = window.RobayerCalc.parseNumberInput(fields.rate.value);
      const years = window.RobayerCalc.parseNumberInput(fields.years.value);
      const periodsPerYear = fields.frequency.value === 'annually' ? 1 : 12;

      const checks = [
        { input: fields.principal, test: () => !isNaN(principal) && principal >= 0 },
        { input: fields.contribution, test: () => !isNaN(contribution) && contribution >= 0 },
        { input: fields.rate, test: () => !isNaN(rate) && rate >= 0 },
        { input: fields.years, test: () => !isNaN(years) && years > 0 && years <= 100 },
      ];

      let firstInvalid = null;
      checks.forEach(({ input, test }) => {
        const valid = validateField(input, test);
        if (!valid && !firstInvalid) firstInvalid = input;
      });

      if (firstInvalid) {
        firstInvalid.focus();
        resultRegion.hidden = true;
        return;
      }

      const result = window.RobayerCalc.futureValueWithContributions(principal, contribution, rate, years, periodsPerYear);
      renderResult(result, principal, contribution, rate, years, periodsPerYear);
    });

    function renderResult(result, principal, contribution, rate, years, periodsPerYear) {
      resultRegion.hidden = false;
      resultRegion.querySelector('[data-result="future-value"]').textContent = window.RobayerCalc.formatCurrency(result.futureValue);
      resultRegion.querySelector('[data-result="total-contributed"]').textContent = window.RobayerCalc.formatCurrency(result.totalContributed);
      resultRegion.querySelector('[data-result="total-interest"]').textContent = window.RobayerCalc.formatCurrency(result.totalInterest);

      const breakdown = window.RobayerCalc.yearlyBreakdown(principal, contribution, rate, years, periodsPerYear);
      tableBody.innerHTML = breakdown.map((row) => (
        '<tr>' +
        '<td>' + row.year + '</td>' +
        '<td>' + window.RobayerCalc.formatCurrency(row.contributed) + '</td>' +
        '<td>' + window.RobayerCalc.formatCurrency(row.interest) + '</td>' +
        '<td>' + window.RobayerCalc.formatCurrency(row.balance) + '</td>' +
        '</tr>'
      )).join('');

      resultRegion.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

document.addEventListener('partials:loaded', initCompoundInterestCalculator);
document.addEventListener('DOMContentLoaded', initCompoundInterestCalculator);

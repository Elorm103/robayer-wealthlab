/**
 * Robayer WealthLab — Savings Goal Calculator
 *
 * Progressive enhancement for the form on /calculators/savings-goal/.
 * Solves the same future-value formula as the Compound Interest
 * calculator (via window.RobayerCalc.requiredContribution) for the
 * monthly contribution instead of the future value. Client-side only.
 */

function initSavingsGoalCalculator() {
  const forms = document.querySelectorAll('[data-calculator="savings-goal"]:not([data-bound])');
  if (!window.RobayerCalc) return;

  forms.forEach((form) => {
    form.setAttribute('data-bound', 'true');

    const fields = {
      goal: form.querySelector('[name="goal"]'),
      current: form.querySelector('[name="current"]'),
      rate: form.querySelector('[name="rate"]'),
      years: form.querySelector('[name="years"]'),
    };
    const resultRegion = form.querySelector('[data-calculator-result]');
    const onTrackMessage = form.querySelector('[data-on-track-message]');
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

      const goal = window.RobayerCalc.parseNumberInput(fields.goal.value);
      const current = window.RobayerCalc.parseNumberInput(fields.current.value);
      const rate = window.RobayerCalc.parseNumberInput(fields.rate.value);
      const years = window.RobayerCalc.parseNumberInput(fields.years.value);
      const periodsPerYear = 12;

      const checks = [
        { input: fields.goal, test: () => !isNaN(goal) && goal > 0 },
        { input: fields.current, test: () => !isNaN(current) && current >= 0 },
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

      const requiredMonthly = window.RobayerCalc.requiredContribution(goal, current, rate, years, periodsPerYear);
      renderResult(requiredMonthly, goal, current, rate, years, periodsPerYear);
    });

    function renderResult(requiredMonthly, goal, current, rate, years, periodsPerYear) {
      resultRegion.hidden = false;

      const figureEl = resultRegion.querySelector('[data-result="required-contribution"]');
      const labelEl = resultRegion.querySelector('[data-result-label]');
      const breakdownWrapper = resultRegion.querySelector('[data-breakdown-wrapper]');

      if (requiredMonthly <= 0) {
        // Already on track: current savings alone, growing at the given
        // rate, are projected to reach the goal without further
        // contributions — an honest message instead of a negative number.
        labelEl.textContent = "You're already on track";
        figureEl.textContent = window.RobayerCalc.formatCurrency(0);
        onTrackMessage.hidden = false;
        breakdownWrapper.hidden = true;
        return;
      }

      onTrackMessage.hidden = true;
      breakdownWrapper.hidden = false;
      labelEl.textContent = 'Required monthly contribution';
      figureEl.textContent = window.RobayerCalc.formatCurrency(requiredMonthly);

      const breakdown = window.RobayerCalc.yearlyBreakdown(current, requiredMonthly, rate, years, periodsPerYear);
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

document.addEventListener('partials:loaded', initSavingsGoalCalculator);
document.addEventListener('DOMContentLoaded', initSavingsGoalCalculator);

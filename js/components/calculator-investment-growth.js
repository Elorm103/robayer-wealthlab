/**
 * Robayer WealthLab — Investment Growth Calculator
 *
 * Progressive enhancement for the form on /calculators/investment-growth/.
 * Shares the same future-value-with-contributions core as the Compound
 * Interest calculator (window.RobayerCalc), plus an optional inflation
 * adjustment (window.RobayerCalc.realValue). Client-side only.
 */

function initInvestmentGrowthCalculator() {
  const forms = document.querySelectorAll('[data-calculator="investment-growth"]:not([data-bound])');
  if (!window.RobayerCalc) return;

  forms.forEach((form) => {
    form.setAttribute('data-bound', 'true');

    const fields = {
      principal: form.querySelector('[name="principal"]'),
      contribution: form.querySelector('[name="contribution"]'),
      rate: form.querySelector('[name="rate"]'),
      years: form.querySelector('[name="years"]'),
      inflationToggle: form.querySelector('[name="inflation-toggle"]'),
      inflationRate: form.querySelector('[name="inflation-rate"]'),
    };
    const inflationField = form.querySelector('[data-inflation-field]');
    const resultRegion = form.querySelector('[data-calculator-result]');
    const realValueRow = form.querySelector('[data-real-value-row]');
    const tableBody = form.querySelector('[data-calculator-table-body]');

    function validateField(input, test) {
      const field = input.closest('.field');
      const errorEl = field ? field.querySelector('.field__error') : null;
      const valid = test(input.value.trim());
      if (field) field.classList.toggle('field--error', !valid);
      if (errorEl) errorEl.hidden = valid;
      return valid;
    }

    if (fields.inflationToggle) {
      fields.inflationToggle.addEventListener('change', () => {
        inflationField.hidden = !fields.inflationToggle.checked;
      });
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();

      const principal = window.RobayerCalc.parseNumberInput(fields.principal.value);
      const contribution = window.RobayerCalc.parseNumberInput(fields.contribution.value);
      const rate = window.RobayerCalc.parseNumberInput(fields.rate.value);
      const years = window.RobayerCalc.parseNumberInput(fields.years.value);
      const applyInflation = fields.inflationToggle && fields.inflationToggle.checked;
      const inflationRate = applyInflation ? window.RobayerCalc.parseNumberInput(fields.inflationRate.value) : 0;
      const periodsPerYear = 12;

      const checks = [
        { input: fields.principal, test: () => !isNaN(principal) && principal >= 0 },
        { input: fields.contribution, test: () => !isNaN(contribution) && contribution >= 0 },
        { input: fields.rate, test: () => !isNaN(rate) && rate >= 0 },
        { input: fields.years, test: () => !isNaN(years) && years > 0 && years <= 100 },
      ];
      if (applyInflation) {
        checks.push({ input: fields.inflationRate, test: () => !isNaN(inflationRate) && inflationRate >= 0 });
      }

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
      renderResult(result, principal, contribution, rate, years, periodsPerYear, applyInflation, inflationRate);
    });

    function renderResult(result, principal, contribution, rate, years, periodsPerYear, applyInflation, inflationRate) {
      resultRegion.hidden = false;
      resultRegion.querySelector('[data-result="future-value"]').textContent = window.RobayerCalc.formatCurrency(result.futureValue);
      resultRegion.querySelector('[data-result="total-contributed"]').textContent = window.RobayerCalc.formatCurrency(result.totalContributed);
      resultRegion.querySelector('[data-result="total-interest"]').textContent = window.RobayerCalc.formatCurrency(result.totalInterest);

      if (applyInflation) {
        const real = window.RobayerCalc.realValue(result.futureValue, inflationRate, years);
        resultRegion.querySelector('[data-result="real-value"]').textContent = window.RobayerCalc.formatCurrency(real);
        realValueRow.hidden = false;
      } else {
        realValueRow.hidden = true;
      }

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

document.addEventListener('partials:loaded', initInvestmentGrowthCalculator);
document.addEventListener('DOMContentLoaded', initInvestmentGrowthCalculator);

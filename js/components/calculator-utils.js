/**
 * Robayer WealthLab — Calculator Math Utilities
 *
 * Shared, pure functions for the Financial Calculators (Compound
 * Interest, Savings Goal, Investment Growth) — no DOM access, no side
 * effects, safe to unit-reason-about in isolation.
 *
 * Extracted here — rather than copy-pasted into each calculator's own
 * script — because all three genuinely share the same time-value-of-
 * money formula family (future value of a lump sum plus an ordinary
 * annuity of periodic contributions; Savings Goal solves the same
 * formula for the contribution instead of the future value). That is
 * a real, present duplication risk across 3 simultaneous consumers,
 * not a speculative one — the same test this project already applied
 * to `js/content-loader.js` in an earlier sprint (removed for having
 * zero real consumers) and to `js/components/calculator-utils.js`'s
 * own sibling components here (which pass that test).
 *
 * Exposed as `window.RobayerCalc` — no module system/build step exists
 * on this site, so a single global namespace object is the simplest
 * compatible approach (matches every other script here being a plain,
 * directly `<script src>`-loaded file).
 */

(function (global) {
  /**
   * Future value of a lump sum plus periodic contributions
   * (ordinary annuity — contribution posted at the end of each period).
   */
  function futureValueWithContributions(principal, contribution, annualRatePercent, years, periodsPerYear) {
    const i = (annualRatePercent / 100) / periodsPerYear;
    const n = periodsPerYear * years;
    const fvPrincipal = principal * Math.pow(1 + i, n);
    const fvContributions = i === 0
      ? contribution * n
      : contribution * ((Math.pow(1 + i, n) - 1) / i);
    const futureValue = fvPrincipal + fvContributions;
    const totalContributed = principal + contribution * n;
    return {
      futureValue,
      totalContributed,
      totalInterest: futureValue - totalContributed,
    };
  }

  /**
   * Solves the same future-value formula for the required periodic
   * contribution instead of the future value. Returns `null` if the
   * timeframe is zero or negative (caller must validate years > 0
   * before calling this) rather than dividing by zero.
   */
  function requiredContribution(targetFutureValue, presentValue, annualRatePercent, years, periodsPerYear) {
    const i = (annualRatePercent / 100) / periodsPerYear;
    const n = periodsPerYear * years;
    if (n <= 0) return null;
    const fvOfPresent = presentValue * Math.pow(1 + i, n);
    const remaining = targetFutureValue - fvOfPresent;
    return i === 0 ? remaining / n : (remaining * i) / (Math.pow(1 + i, n) - 1);
  }

  /**
   * Deflates a nominal future amount by a flat annual inflation rate,
   * compounded once per year (inflation figures are conventionally
   * quoted annually, so this intentionally doesn't compound monthly
   * the way the interest/return calculations above do).
   */
  function realValue(nominalValue, inflationRatePercent, years) {
    return nominalValue / Math.pow(1 + inflationRatePercent / 100, years);
  }

  /** Year-by-year balance/contributed/interest snapshot for a breakdown table. */
  function yearlyBreakdown(principal, contribution, annualRatePercent, years, periodsPerYear) {
    const rows = [];
    for (let y = 1; y <= years; y++) {
      const result = futureValueWithContributions(principal, contribution, annualRatePercent, y, periodsPerYear);
      rows.push({ year: y, balance: result.futureValue, contributed: result.totalContributed, interest: result.totalInterest });
    }
    return rows;
  }

  /** GH₵ currency formatting — thousand separators, 2 decimal places. */
  function formatCurrency(amount) {
    if (!isFinite(amount)) return 'GH₵0.00';
    const rounded = Math.round(amount * 100) / 100;
    const parts = Math.abs(rounded).toFixed(2).split('.');
    const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
  }

  /** Parses a form input into a finite number, or NaN if invalid/empty. */
  function parseNumberInput(value) {
    const n = parseFloat(value);
    return isFinite(n) ? n : NaN;
  }

  global.RobayerCalc = {
    futureValueWithContributions,
    requiredContribution,
    realValue,
    yearlyBreakdown,
    formatCurrency,
    parseNumberInput,
  };
})(window);

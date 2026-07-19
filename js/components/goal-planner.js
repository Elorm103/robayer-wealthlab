/**
 * Robayer WealthLab — Financial Goal Planner
 *
 * An educational recommendation engine, not artificial intelligence and
 * not financial advice. A visitor picks one of 8 goals, answers a
 * structured question set fetched from `content/goal-planner/{slug}.json`,
 * and receives a recommendation built entirely from structured mappings:
 * a suggested monthly savings figure (via window.RobayerCalc —
 * the exact same function the Savings Goal calculator uses, never a
 * duplicated formula) plus the relevant calculator(s), service(s),
 * article, resources, and a consultation recommendation named in that
 * goal's own JSON. No backend, no AI, no APIs — every goal's JSON is a
 * static file fetched the same way `assets/config/site.json` already is.
 */

// Slug -> {title, href} lookups. Deliberately hardcoded here rather than
// a second fetch of content/services/*.json or content/calculators/*.json —
// the same "small, fixed, already-known set" reasoning already used by
// consultation-form.js's category <select> options.
var GOAL_PLANNER_SERVICES = {
  'financial-education': { title: 'Financial Education', href: '/services/financial-education/' },
  'investment-education': { title: 'Investment Education', href: '/services/investment-education/' },
  'personal-financial-coaching': { title: 'Personal Financial Coaching', href: '/services/personal-financial-coaching/' },
  'business-financial-advisory': { title: 'Business Financial Advisory', href: '/services/business-financial-advisory/' },
  'retirement-planning-guidance': { title: 'Retirement Planning Guidance', href: '/services/retirement-planning-guidance/' },
  'financial-literacy-workshops': { title: 'Financial Literacy Workshops', href: '/services/financial-literacy-workshops/' },
};

var GOAL_PLANNER_CALCULATORS = {
  'compound-interest': { title: 'Compound Interest Calculator', href: '/calculators/compound-interest/' },
  'savings-goal': { title: 'Savings Goal Calculator', href: '/calculators/savings-goal/' },
  'investment-growth': { title: 'Investment Growth Calculator', href: '/calculators/investment-growth/' },
};

var GOAL_PLANNER_TREASURY_ARTICLE = {
  title: 'What Are Treasury Bills in Ghana?',
  href: '/blog/what-are-treasury-bills-in-ghana/',
};

function initGoalPlanner() {
  var root = document.querySelector('[data-goal-planner]:not([data-bound])');
  if (!root || !window.RobayerCalc) return;
  root.setAttribute('data-bound', 'true');

  var selectStep = root.querySelector('[data-step="select"]');
  var questionsStep = root.querySelector('[data-step="questions"]');
  var resultStep = root.querySelector('[data-step="result"]');

  var goalButtons = selectStep.querySelectorAll('[data-goal-slug]');
  var questionsHeading = questionsStep.querySelector('[data-questions-heading]');
  var questionsDescription = questionsStep.querySelector('[data-questions-description]');
  var questionsContainer = questionsStep.querySelector('[data-goal-questions]');
  var questionsForm = questionsStep.querySelector('[data-goal-questions-form]');
  var questionsError = questionsStep.querySelector('[data-goal-form-error]');
  var backToSelectButtons = root.querySelectorAll('[data-goal-back-to-select]');

  var resultHeading = resultStep.querySelector('[data-result-heading]');
  var resultIntro = resultStep.querySelector('[data-result-intro]');
  var resultFigureWrapper = resultStep.querySelector('[data-result-figure-wrapper]');
  var resultFigure = resultStep.querySelector('[data-result-figure]');
  var resultOnTrack = resultStep.querySelector('[data-result-on-track]');
  var resultStats = resultStep.querySelector('[data-result-stats]');
  var resultCalculators = resultStep.querySelector('[data-result-calculators]');
  var resultServices = resultStep.querySelector('[data-result-services]');
  var resultArticle = resultStep.querySelector('[data-result-article]');
  var resultConsultationLink = resultStep.querySelector('[data-result-consultation-link]');
  var startOverButtons = root.querySelectorAll('[data-goal-start-over]');

  var currentConfig = null;

  goalButtons.forEach(function (button) {
    button.addEventListener('click', function () { selectGoal(button); });
  });

  backToSelectButtons.forEach(function (button) {
    button.addEventListener('click', function () { goToStep('select'); });
  });

  startOverButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      goalButtons.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      goToStep('select');
    });
  });

  function selectGoal(button) {
    goalButtons.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    button.setAttribute('aria-pressed', 'true');
    loadGoal(button.getAttribute('data-goal-slug'));
  }

  // Arriving with ?goal=<slug> (e.g. from the Learning Hub's per-path
  // recommendations) jumps straight to that goal's questions — the same
  // contextual-link convenience consultation-form.js's ?category= already
  // provides, so a recommendation link is genuinely useful, not generic.
  var requestedGoal = new URLSearchParams(window.location.search).get('goal');
  if (requestedGoal) {
    var matchingButton = root.querySelector('[data-goal-slug="' + CSS.escape(requestedGoal) + '"]');
    if (matchingButton) selectGoal(matchingButton);
  }

  function goToStep(name) {
    selectStep.hidden = name !== 'select';
    questionsStep.hidden = name !== 'questions';
    resultStep.hidden = name !== 'result';

    var focusTarget = name === 'select'
      ? goalButtons[0]
      : name === 'questions' ? questionsHeading : resultHeading;

    if (focusTarget) {
      if (!focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus();
    }
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function loadGoal(slug) {
    questionsError.hidden = true;
    questionsContainer.innerHTML = '<p class="text-secondary text-small">Loading questions…</p>';
    goToStep('questions');

    fetch('/content/goal-planner/' + slug + '.json')
      .then(function (response) {
        if (!response.ok) throw new Error('Failed to load goal configuration.');
        return response.json();
      })
      .then(function (config) {
        currentConfig = config;
        renderQuestions(config);
      })
      .catch(function () {
        questionsContainer.innerHTML = '';
        questionsHeading.textContent = 'Something went wrong';
        questionsDescription.textContent = "This goal's questions couldn't be loaded right now. Please try again, or choose a different goal.";
      });
  }

  function renderQuestions(config) {
    questionsHeading.textContent = config.title;
    questionsDescription.textContent = config.goalDescription;
    questionsContainer.innerHTML = '';

    config.questions.forEach(function (question) {
      var field = document.createElement('div');
      field.className = 'field';

      var labelText = question.label + (question.unit ? ' (' + question.unit + ')' : '');
      var fieldId = 'gp-q-' + question.id;

      var labelEl = document.createElement('label');
      labelEl.setAttribute('for', fieldId);
      labelEl.className = 'field__label';
      labelEl.textContent = labelText;
      field.appendChild(labelEl);

      var inputEl;
      if (question.type === 'select') {
        inputEl = document.createElement('select');
        inputEl.className = 'field__select';
        question.options.forEach(function (option) {
          var optionEl = document.createElement('option');
          optionEl.value = option;
          optionEl.textContent = option;
          if (option === question.default) optionEl.selected = true;
          inputEl.appendChild(optionEl);
        });
      } else {
        inputEl = document.createElement('input');
        inputEl.type = 'number';
        inputEl.className = 'field__input';
        inputEl.inputMode = 'decimal';
        if (question.min !== undefined) inputEl.min = question.min;
        if (question.max !== undefined) inputEl.max = question.max;
        if (question.step !== undefined) inputEl.step = question.step;
        inputEl.value = question.default;
      }
      inputEl.id = fieldId;
      inputEl.name = question.id;
      field.appendChild(inputEl);

      if (question.help) {
        var helpEl = document.createElement('p');
        helpEl.className = 'text-secondary text-small mt-1';
        helpEl.textContent = question.help;
        field.appendChild(helpEl);
      }

      var errorEl = document.createElement('span');
      errorEl.className = 'field__error';
      errorEl.hidden = true;
      var min = question.min !== undefined ? question.min : 0;
      var max = question.max !== undefined ? question.max : null;
      errorEl.textContent = max
        ? 'Enter a value between ' + min + ' and ' + max + '.'
        : 'Enter a value of ' + min + ' or more.';
      field.appendChild(errorEl);

      questionsContainer.appendChild(field);
    });
  }

  questionsForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!currentConfig) return;

    questionsError.hidden = true;
    var answers = {};
    var firstInvalid = null;

    currentConfig.questions.forEach(function (question) {
      var input = questionsForm.querySelector('[name="' + question.id + '"]');
      var value = window.RobayerCalc.parseNumberInput(input.value);
      var min = question.min !== undefined ? question.min : -Infinity;
      var max = question.max !== undefined ? question.max : Infinity;
      var valid = !isNaN(value) && value >= min && value <= max;

      var field = input.closest('.field');
      var errorEl = field ? field.querySelector('.field__error') : null;
      if (field) field.classList.toggle('field--error', !valid);
      if (errorEl) errorEl.hidden = valid;
      if (!valid && !firstInvalid) firstInvalid = input;

      answers[question.id] = value;
    });

    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    var targetAmount = resolveSource(currentConfig.targetAmount, answers);
    var years = resolveSource(currentConfig.years, answers);

    if (!(years > 0)) {
      questionsError.textContent = currentConfig.yearsErrorMessage
        || 'Please check your numbers: the timeframe must be greater than zero.';
      questionsError.hidden = false;
      if (!questionsError.hasAttribute('tabindex')) questionsError.setAttribute('tabindex', '-1');
      questionsError.focus();
      return;
    }

    var currentSavings = answers[currentConfig.currentSavingsQuestionId];
    var rate = answers[currentConfig.rateQuestionId];

    var requiredMonthly = window.RobayerCalc.requiredContribution(targetAmount, currentSavings, rate, years, 12);
    renderResult(currentConfig, { targetAmount: targetAmount, years: years, currentSavings: currentSavings, rate: rate, requiredMonthly: requiredMonthly });
  });

  function resolveSource(source, answers) {
    if (source.source === 'direct') return answers[source.questionId];
    if (source.source === 'computed' && source.operation === 'multiply') {
      return source.questionIds.reduce(function (acc, id) { return acc * answers[id]; }, 1);
    }
    if (source.source === 'computed' && source.operation === 'subtract') {
      return answers[source.questionIds[0]] - answers[source.questionIds[1]];
    }
    return NaN;
  }

  function renderResult(config, figures) {
    resultHeading.textContent = config.title + ': your starting point';
    resultIntro.textContent = config.resultIntro;

    if (figures.requiredMonthly <= 0) {
      resultOnTrack.hidden = false;
      resultFigureWrapper.hidden = true;
    } else {
      resultOnTrack.hidden = true;
      resultFigureWrapper.hidden = false;
      resultFigure.textContent = window.RobayerCalc.formatCurrency(figures.requiredMonthly);
    }

    resultStats.innerHTML =
      resultStatRow('Target amount', window.RobayerCalc.formatCurrency(figures.targetAmount)) +
      resultStatRow('Timeframe', formatYears(figures.years)) +
      resultStatRow('Already saved', window.RobayerCalc.formatCurrency(figures.currentSavings)) +
      resultStatRow('Assumed annual return', figures.rate + '%');

    resultCalculators.innerHTML = config.relatedCalculators.map(function (slug, index) {
      var entry = GOAL_PLANNER_CALCULATORS[slug];
      return entry ? tocItem(index, entry) : '';
    }).join('');

    resultServices.innerHTML = config.relatedServices.map(function (slug, index) {
      var entry = GOAL_PLANNER_SERVICES[slug];
      return entry ? tocItem(index, entry) : '';
    }).join('');

    if (config.includeTreasuryBillArticle) {
      resultArticle.hidden = false;
      resultArticle.innerHTML = 'Read <a href="' + GOAL_PLANNER_TREASURY_ARTICLE.href + '">' + GOAL_PLANNER_TREASURY_ARTICLE.title + '</a> for a short-term, low-risk savings option available in Ghana.';
    } else {
      resultArticle.hidden = true;
    }

    resultConsultationLink.href = '/consultation/?category=' + encodeURIComponent(config.consultationCategory);

    goToStep('result');
  }

  function resultStatRow(label, value) {
    return '<div class="calculator-result__row"><span>' + label + '</span><span>' + value + '</span></div>';
  }

  function formatYears(years) {
    var rounded = years.toFixed(1).replace(/\.0$/, '');
    return rounded + (rounded === '1' ? ' year' : ' years');
  }

  function tocItem(index, entry) {
    var number = String(index + 1).padStart(2, '0');
    return '<li class="toc__item"><span class="toc__number numeric">' + number + '</span><span class="toc__title"><a href="' + entry.href + '">' + entry.title + '</a></span></li>';
  }
}

document.addEventListener('partials:loaded', initGoalPlanner);
document.addEventListener('DOMContentLoaded', initGoalPlanner);

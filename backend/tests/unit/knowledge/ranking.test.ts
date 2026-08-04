/**
 * Unit tests: lightweight reranking and confidence calibration —
 * Version 5.0 Milestone 2.2. Pure logic, no DB/network — tests
 * services/knowledge/ranking.ts directly rather than only through
 * searchService.ts's integration (searchService.test.ts covers the
 * integration; this file covers the scoring logic itself in isolation).
 */
import { describe, it, expect } from 'vitest';
import { tokenize, computeRankingSignals, scoreToConfidence, CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_MEDIUM_THRESHOLD } from '../../../services/knowledge/ranking';

describe('tokenize', () => {
  it('lowercases, strips punctuation, drops stopwords and single-character tokens', () => {
    expect(tokenize('What is the Ghana Stock Exchange?')).toEqual(['ghana', 'stock', 'exchange']);
  });

  it('normalizes simple plurals so "resources" matches "resource"', () => {
    expect(tokenize('resources')).toEqual(['resource']);
    expect(tokenize('books')).toEqual(['book']);
  });

  it('does not over-strip short words that merely end in s', () => {
    // "as"/"is" are stopwords anyway, but confirm a real short non-stopword ending in s is left alone (length < 4 rule).
    expect(tokenize('gas')).toEqual(['gas']);
  });

  it('returns an empty array for a query with no meaningful tokens', () => {
    expect(tokenize('what is the')).toEqual([]);
  });
});

describe('computeRankingSignals', () => {
  it('applies zero boost when there is no title/keyword/source overlap', () => {
    const signals = computeRankingSignals('zzyzx qorvath', 0.5, 'Unrelated Title', 'Completely unrelated chunk text.', 'static_page');
    expect(signals.titleBoost).toBe(0);
    expect(signals.keywordBoost).toBe(0);
    expect(signals.sourceBoost).toBe(0);
    expect(signals.finalScore).toBe(0.5);
  });

  it('applies the full title boost weight on an exact title match', () => {
    const signals = computeRankingSignals('Privacy Policy', 0.4, 'Privacy Policy | Robayer WealthLab', 'Some unrelated chunk body.', 'static_page');
    expect(signals.titleBoost).toBeCloseTo(0.25, 5); // 2/2 query tokens present in title * TITLE_BOOST_WEIGHT
  });

  it('applies a partial keyword boost proportional to overlap fraction', () => {
    const signals = computeRankingSignals('treasury bills ghana', 0.3, 'Some Title', 'This page discusses treasury bills at length.', 'static_page');
    // 2 of 3 query tokens ("treasury", "bill") appear in the chunk text; "ghana" does not.
    expect(signals.keywordBoost).toBeCloseTo((2 / 3) * 0.15, 5);
  });

  it('applies the source-type boost only when a trigger word is present AND the source type matches', () => {
    const withTrigger = computeRankingSignals('what resources are available', 0.3, 'Some Title', 'Some body.', 'resource');
    expect(withTrigger.sourceBoost).toBeGreaterThan(0);

    const wrongSourceType = computeRankingSignals('what resources are available', 0.3, 'Some Title', 'Some body.', 'blog_post');
    expect(wrongSourceType.sourceBoost).toBe(0);

    const noTriggerWord = computeRankingSignals('tell me about savings', 0.3, 'Some Title', 'Some body.', 'resource');
    expect(noTriggerWord.sourceBoost).toBe(0);
  });

  it('caps the final score at 1.0 even when cosine similarity plus every boost would exceed it', () => {
    const signals = computeRankingSignals('treasury bills', 0.95, 'Treasury Bills Guide', 'Treasury bills explained in full.', 'blog_post');
    expect(signals.finalScore).toBeLessThanOrEqual(1);
  });
});

describe('scoreToConfidence', () => {
  it('buckets at the documented Milestone 2.2 thresholds', () => {
    expect(scoreToConfidence(CONFIDENCE_HIGH_THRESHOLD)).toBe('high');
    expect(scoreToConfidence(CONFIDENCE_HIGH_THRESHOLD - 0.001)).toBe('medium');
    expect(scoreToConfidence(CONFIDENCE_MEDIUM_THRESHOLD)).toBe('medium');
    expect(scoreToConfidence(CONFIDENCE_MEDIUM_THRESHOLD - 0.001)).toBe('low');
    expect(scoreToConfidence(0)).toBe('low');
    expect(scoreToConfidence(1)).toBe('high');
  });
});

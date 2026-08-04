/**
 * Lightweight reranking and confidence calibration — Version 5.0
 * Milestone 2.2. No external rerank API and no new provider — combines
 * Vectorize's own cosine similarity with cheap lexical signals (title
 * overlap, keyword overlap, source-type relevance) computed entirely
 * from data searchService.ts already has in hand from the D1 join.
 * Kept in its own file (matching this project's one-function-per-file
 * convention for services/knowledge/*) so it's independently testable
 * and so searchService.ts's own orchestration doesn't get harder to
 * read.
 *
 * WHY hybrid (dense + lexical), not just raising the cosine bar: real
 * production evidence (7 representative queries, 35 scored results —
 * see docs/v5.0-milestone-2.2-retrieval-quality-report.md) showed raw
 * cosine similarity does not cleanly separate "exact match" from
 * "topically adjacent" in this corpus — text-embedding-3-small over a
 * single site's own short, topically-overlapping pages produces a
 * narrower, lower score range than generic cosine-similarity intuition
 * suggests (correct results ranged ~0.37-0.71, not the 0.8-0.95 people
 * often expect). A literal title/keyword match is a genuine, cheap,
 * separate positive signal this corpus's raw embeddings under-weight.
 */

export interface RankingSignals {
  vectorSimilarity: number;
  titleBoost: number;
  keywordBoost: number;
  sourceBoost: number;
  /** vectorSimilarity + titleBoost + keywordBoost + sourceBoost, capped at 1.0. What results are actually sorted and confidence-bucketed by. */
  finalScore: number;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'how', 'all', 'any', 'both', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'my', 'your', 'me', 'say',
  'do',
]);

/** Crude singular/plural normalization (strip one trailing 's' on words ≥4 chars) — no stemming library, deliberately simple, but enough to match "resource" against a query's "resources" without over-matching short words like "is"/"as". */
function normalize(word: string): string {
  if (word.length >= 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(normalize);
}

function overlapFraction(queryTokens: string[], targetTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0;
  const hits = queryTokens.filter((t) => targetTokens.has(t)).length;
  return hits / queryTokens.length;
}

/**
 * Query words that plausibly signal "the user wants THIS kind of
 * content" — directly implements the brief's own "boost source
 * relevance" suggestion. Deliberately generic (keyed by source_type,
 * not any one example query) rather than overfit to a single test
 * case.
 */
const SOURCE_TYPE_TRIGGER_WORDS: Partial<Record<string, string[]>> = {
  resource: ['resource', 'guide', 'download', 'template', 'freebie', 'checklist'],
  product: ['book', 'ebook'],
  blog_post: ['blog', 'article', 'post'],
};

export const TITLE_BOOST_WEIGHT = 0.25;
export const KEYWORD_BOOST_WEIGHT = 0.15;
export const SOURCE_BOOST_WEIGHT = 0.08;

export function computeRankingSignals(query: string, vectorSimilarity: number, title: string, chunkText: string, sourceType: string): RankingSignals {
  const queryTokens = tokenize(query);
  const titleTokens = new Set(tokenize(title));
  const chunkTokens = new Set(tokenize(chunkText));

  const titleBoost = overlapFraction(queryTokens, titleTokens) * TITLE_BOOST_WEIGHT;
  const keywordBoost = overlapFraction(queryTokens, chunkTokens) * KEYWORD_BOOST_WEIGHT;

  const triggerWords = SOURCE_TYPE_TRIGGER_WORDS[sourceType] ?? [];
  const sourceBoost = triggerWords.some((w) => queryTokens.includes(w)) ? SOURCE_BOOST_WEIGHT : 0;

  const finalScore = Math.min(1, vectorSimilarity + titleBoost + keywordBoost + sourceBoost);

  return { vectorSimilarity, titleBoost, keywordBoost, sourceBoost, finalScore };
}

export type RetrievalConfidence = 'high' | 'medium' | 'low';

/**
 * Version 5.0 Milestone 2.2 recalibration, against the FINAL (post-
 * boost) score, not raw cosine — see docs/v5.0-milestone-2.2-confidence-calibration-report.md
 * for the full worked derivation. Summary: Milestone 2's original
 * 0.75/0.5 thresholds were engineering-judgment placeholders (explicitly
 * documented as such) chosen before any real query traffic existed.
 * Real production evidence — Privacy Policy and Terms of Use exact
 * matches (title+keyword boosted) landing ~0.75-0.80, Treasury
 * Bills/Investment Centre strong matches ~0.74-1.0, versus the
 * "resources" query's best imperfect match blending to ~0.50 — put the
 * boundary between "exact/strong match" and "plausible but uncertain"
 * at roughly 0.6, and between "plausible" and "weak" at roughly 0.45.
 * These remain a first, evidence-grounded pass, not a final answer —
 * Task 8's re-verification against real (not hand-estimated) blended
 * production scores is the actual confirmation, and Task 4's ongoing
 * analytics are what let these be revisited as more real query history
 * accumulates.
 */
export const CONFIDENCE_HIGH_THRESHOLD = 0.6;
export const CONFIDENCE_MEDIUM_THRESHOLD = 0.45;

export function scoreToConfidence(finalScore: number): RetrievalConfidence {
  if (finalScore >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (finalScore >= CONFIDENCE_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

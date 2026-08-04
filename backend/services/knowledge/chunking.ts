/**
 * Semantic chunking — Version 5.0 Milestone 2 (Knowledge Base). Splits
 * a document's extracted plain text into paragraph-boundary-aware
 * chunks targeting ~300-500 tokens each, per
 * docs/v5.0-knowledge-base.md §5 — never a fixed-character-count cut
 * that could sever a sentence mid-thought.
 *
 * Token counting reuses services/ai/aiGateway.ts's own
 * `estimateInputTokens()` heuristic (~4 characters/token) rather than
 * a second, independently-defined one — the same number must mean the
 * same thing everywhere in this codebase that estimates tokens
 * without a real tokenizer.
 */

import { estimateInputTokens } from '../ai/aiGateway';

const TARGET_MIN_TOKENS = 300;
const TARGET_MAX_TOKENS = 500;
/** A paragraph alone exceeding this is split by sentence — see splitLongParagraph(). */
const HARD_MAX_TOKENS = 600;

export interface TextChunk {
  index: number;
  text: string;
  tokens: number;
}

function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** A single paragraph too long to be its own chunk — split on sentence boundaries, greedily re-grouped to the same target range as the main algorithm. */
function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s+|$)/g) ?? [paragraph];
  const groups: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence.trim()}` : sentence.trim();
    if (current && estimateInputTokens(candidate) > TARGET_MAX_TOKENS) {
      groups.push(current);
      current = sentence.trim();
    } else {
      current = candidate;
    }
  }
  if (current) groups.push(current);
  return groups;
}

/**
 * Greedily accumulates paragraphs into chunks until the next paragraph
 * would push the chunk past `TARGET_MAX_TOKENS`, starting a new chunk
 * at that point — the standard "paragraph-aware" chunking approach.
 * A paragraph that alone exceeds `HARD_MAX_TOKENS` is pre-split by
 * sentence (splitLongParagraph()) before accumulation, so one
 * unusually long paragraph never becomes one oversized chunk.
 */
export function chunkText(text: string): TextChunk[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const paragraphs = splitIntoParagraphs(trimmed).flatMap((p) => (estimateInputTokens(p) > HARD_MAX_TOKENS ? splitLongParagraph(p) : [p]));

  const chunks: TextChunk[] = [];
  let current = '';
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateInputTokens(paragraph);

    if (current && currentTokens + paragraphTokens > TARGET_MAX_TOKENS && currentTokens >= TARGET_MIN_TOKENS) {
      chunks.push({ index: chunks.length, text: current, tokens: currentTokens });
      current = paragraph;
      currentTokens = paragraphTokens;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      currentTokens += paragraphTokens;
    }
  }
  if (current) chunks.push({ index: chunks.length, text: current, tokens: currentTokens });

  return chunks;
}

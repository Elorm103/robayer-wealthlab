/**
 * Unit tests: semantic chunking — Version 5.0 Milestone 2 (Knowledge
 * Base). Pure logic, no DB.
 */
import { describe, it, expect } from 'vitest';
import { chunkText } from '../../../services/knowledge/chunking';

describe('chunkText', () => {
  it('returns an empty array for empty/whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const chunks = chunkText('A short paragraph about treasury bills in Ghana.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toContain('treasury bills');
  });

  it('keeps multiple short paragraphs together in one chunk when combined they stay under the target', () => {
    const text = 'First paragraph about saving.\n\nSecond paragraph about investing.\n\nThird paragraph about budgeting.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('First paragraph');
    expect(chunks[0].text).toContain('Third paragraph');
  });

  it('splits into multiple chunks once accumulated paragraphs exceed the target range', () => {
    // Each paragraph ~120 tokens (480 chars) — five of them comfortably exceeds the ~500 token target per chunk.
    const paragraph = 'Treasury bills are a common first investment in Ghana. '.repeat(20);
    const text = Array.from({ length: 5 }, () => paragraph).join('\n\n');

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk index is sequential starting at 0.
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('splits a single paragraph that alone exceeds the hard maximum by sentence', () => {
    const longSentence = 'Treasury bills are short-term government securities issued by the Bank of Ghana. ';
    const oneHugeParagraph = longSentence.repeat(40); // no blank-line breaks at all — one "paragraph"

    const chunks = chunkText(oneHugeParagraph);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should individually balloon far past the target — each should be a fraction of the whole.
    chunks.forEach((c) => expect(c.tokens).toBeLessThan(700));
  });

  it('never drops any sentence-ending content — the full input text is recoverable from the concatenated chunks', () => {
    const text = 'Paragraph one covers saving.\n\nParagraph two covers investing.\n\nParagraph three covers budgeting for beginners in Ghana.';
    const chunks = chunkText(text);
    const recombined = chunks.map((c) => c.text).join(' ');
    expect(recombined).toContain('Paragraph one covers saving.');
    expect(recombined).toContain('Paragraph two covers investing.');
    expect(recombined).toContain('Paragraph three covers budgeting');
  });
});

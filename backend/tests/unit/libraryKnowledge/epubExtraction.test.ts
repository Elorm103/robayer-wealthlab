import { describe, it, expect } from 'vitest';
import { extractEpubText } from '../../../services/libraryKnowledge/epubExtraction';

const EPUB_BASE64 =
  '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';

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

describe('extractEpubText', () => {
  it('extracts real per-section text and headings from a genuine EPUB, in the real Workers runtime', async () => {
    const result = await extractEpubText(base64ToArrayBuffer(EPUB_BASE64));

    // nav.xhtml + ch1.xhtml + ch2.xhtml — footnotes.xhtml is linear="no" and must be excluded
    expect(result.totalSections).toBe(3);
    expect(result.sections).toHaveLength(3);

    expect(result.sections[0].href).toBe('nav.xhtml');
    expect(result.sections[0].chapterTitle).toBeNull();

    expect(result.sections[1].href).toBe('ch1.xhtml');
    expect(result.sections[1].chapterTitle).toBe('Chapter 1: Treasury Bills Explained');
    expect(result.sections[1].text).toContain('Treasury bills are short-term government securities');
    expect(result.sections[1].text).toContain('sold at a discount and redeemed at face value');

    expect(result.sections[2].href).toBe('ch2.xhtml');
    expect(result.sections[2].chapterTitle).toBe('Chapter 2: Mobile Money Savings');
    expect(result.sections[2].text).toContain('Mobile money accounts let Ghanaians save');

    const allText = result.sections.map((s) => s.text).join(' ');
    expect(allText).not.toContain('non-linear footnotes page');
  });
});

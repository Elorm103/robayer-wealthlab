/**
 * Unit tests: receipt PDF rendering - Version 3.2 Milestone M4
 * (Reviews & Coupons), added at M4E closeout.
 *
 * Closes the gap M4D's independent Testing Assessment identified: the
 * conditional "Discount: -X" line renderReceiptPdf() draws when a
 * coupon was applied was verified correct by code inspection during
 * M4D but had zero automated coverage. renderReceiptPdf() is a pure
 * function (no D1/R2 access - see its own header comment), so it is
 * exercised directly here with no database setup at all.
 */
import { describe, it, expect } from 'vitest';
import { renderReceiptPdf, type ReceiptPdfInput } from '../../services/orders/receiptPdfService';

function baseInput(overrides: Partial<ReceiptPdfInput> = {}): ReceiptPdfInput {
  return {
    receiptNumber: 'RWL-RCT-2026-000001',
    issuedAt: '2026-07-26 10:00:00',
    purchaseReference: 'RWL-2026-100001',
    customerEmail: 'buyer@example.com',
    lineItems: [{ title: 'Test Guide', quantity: 1, unitPricePesewas: 3900, lineTotalPesewas: 3900 }],
    subtotalPesewas: 3900,
    discountPesewas: 0,
    taxBreakdown: [],
    taxPesewas: 0,
    totalPesewas: 3900,
    currency: 'GHS',
    ...overrides,
  };
}

/**
 * pdf-lib's `.save()` FlateDecode-compresses content streams by
 * default, so the literal drawn text is not directly searchable in the
 * raw bytes - confirmed empirically while writing this test (an
 * earlier version of this file asserted directly on the raw bytes and
 * failed for exactly this reason). This helper extracts every
 * `stream...endstream` block and inflates it via the standard
 * `DecompressionStream('deflate')` Web API (available natively in
 * workerd, no Node zlib/compat flag needed - PDF's FlateDecode is the
 * same zlib-wrapped deflate format that API's 'deflate' mode expects),
 * then concatenates every successfully-decompressed block's text. Any
 * block that isn't actually Flate-compressed (or is a binary object
 * stream unrelated to page content) simply fails to decompress and is
 * skipped - this helper only needs to find the one content stream that
 * contains the drawn text, not correctly parse the whole PDF.
 */
async function extractDecompressedText(bytes: Uint8Array): Promise<string> {
  const raw = new TextDecoder('latin1').decode(bytes);
  const streamMarker = 'stream';
  const endMarker = 'endstream';
  let searchFrom = 0;
  const chunks: string[] = [];

  while (true) {
    const streamIdx = raw.indexOf(streamMarker, searchFrom);
    if (streamIdx === -1) break;
    const endIdx = raw.indexOf(endMarker, streamIdx);
    if (endIdx === -1) break;

    // Skip the "stream" keyword itself and its trailing EOL (CRLF or LF) per the PDF spec.
    let dataStart = streamIdx + streamMarker.length;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    // The EOL immediately before "endstream" is also not part of the
    // compressed payload itself - trimming it avoids a spurious
    // "trailing bytes after end of compressed data" decompression error.
    let dataEnd = endIdx;
    if (raw[dataEnd - 1] === '\n') dataEnd--;
    if (raw[dataEnd - 1] === '\r') dataEnd--;

    const chunkBytes = bytes.slice(dataStart, dataEnd);
    try {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(chunkBytes);
      writer.close();
      const decompressed = new Response(ds.readable);
      const buf = new Uint8Array(await decompressed.arrayBuffer());
      chunks.push(new TextDecoder('latin1').decode(buf));
    } catch {
      // Not a Flate-compressed stream (or not one this helper can read) - skip it.
    }

    searchFrom = endIdx + endMarker.length;
  }

  const decompressedText = chunks.join('\n');

  // pdf-lib draws text operands as PDF hex strings (`<48656C6C6F>` rather
  // than the literal `(Hello)`), confirmed empirically from this test's
  // own decompressed output. Decode every hex-string token found and
  // append its ASCII content to the searchable corpus too - false
  // positives from non-text hex tokens elsewhere in the stream are
  // harmless here, since this helper only needs to support a substring
  // search, not a correct PDF content-stream parse.
  const hexDecoded: string[] = [];
  for (const match of decompressedText.matchAll(/<([0-9A-Fa-f]{2,})>/g)) {
    const hex = match[1];
    if (hex.length % 2 !== 0) continue;
    let ascii = '';
    for (let i = 0; i < hex.length; i += 2) {
      ascii += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    hexDecoded.push(ascii);
  }

  return decompressedText + '\n' + hexDecoded.join('\n');
}

describe('renderReceiptPdf', () => {
  it('produces a well-formed PDF', async () => {
    const bytes = await renderReceiptPdf(baseInput());
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('always renders the receipt number and subtotal (sanity check confirming the decompression helper below actually recovers drawn text)', async () => {
    const bytes = await renderReceiptPdf(baseInput());
    const text = await extractDecompressedText(bytes);
    expect(text).toContain('RWL-RCT-2026-000001');
    expect(text).toContain('Subtotal: GHS 39.00');
  });

  it('renders a "Discount:" line with the correct amount when a coupon was applied', async () => {
    const bytes = await renderReceiptPdf(
      baseInput({
        subtotalPesewas: 3900,
        discountPesewas: 390,
        totalPesewas: 3510,
      })
    );
    const text = await extractDecompressedText(bytes);
    expect(text).toContain('Discount: -GHS 3.90');
    expect(text).toContain('Total: GHS 35.10');
  });

  it('never renders a "Discount:" line for an ordinary, non-coupon receipt (discountPesewas = 0)', async () => {
    const bytes = await renderReceiptPdf(baseInput({ discountPesewas: 0 }));
    const text = await extractDecompressedText(bytes);
    expect(text).not.toContain('Discount:');
    expect(text).toContain('Subtotal: GHS 39.00'); // confirms the stream was actually recovered, not just empty
  });
});

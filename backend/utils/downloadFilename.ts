/**
 * Builds the filename a browser saves a digital-asset download as — see
 * routes/downloads.ts's Content-Disposition header. Deliberately never
 * derived from `media_assets.original_filename`: that column is the
 * literal filename captured once, at upload time, and has no mechanism
 * to stay in sync with a product's `title` if the product is ever
 * renamed later (exactly what happened to the flagship eBook — the
 * file kept downloading as "starting-to-invest-with-gh100.pdf" long
 * after the product was renamed to "Small Cedis, Big Wealth" in D1,
 * since nothing had ever re-derived the download filename from the
 * live title). Building it fresh from `product.title` at download time
 * means a future rename can never leave this stale again.
 */

/** Strips accents, drops anything that isn't a letter/digit/space/hyphen, collapses whitespace into single hyphens. "Small Cedis, Big Wealth" -> "Small-Cedis-Big-Wealth". */
function slugifyTitle(title: string): string {
  const cleaned = title
    .normalize('NFKD') // decomposes accented letters (e.g. "é" -> "e" + a combining mark)
    .replace(/[^a-zA-Z0-9\s-]/g, '') // drop everything that isn't a plain letter/digit/space/hyphen — this also removes the combining marks NFKD just split out, and punctuation like commas/apostrophes/currency symbols
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
  return cleaned.length > 0 ? cleaned : 'download';
}

/** `fileType` is the DigitalAsset's own type field (e.g. "PDF", "ZIP") — already a small, known enum (see routes/downloads.ts's CONTENT_TYPES), so lowercasing it is always a safe, correct extension. */
export function buildDownloadFilename(productTitle: string, fileType: string): string {
  const slug = slugifyTitle(productTitle);
  const extension = fileType.replace(/^\./, '').toLowerCase() || 'bin';
  return `${slug}.${extension}`;
}

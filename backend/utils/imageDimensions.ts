/**
 * Image width/height extraction — Version 2.0 Phase 1 (Media Library).
 * Parses the real file bytes' own headers; never trusts a
 * client-supplied width/height (those would be cosmetic-only metadata
 * an attacker could set to anything, and this project's stated
 * discipline is not to trust client input it doesn't have to). Pure
 * computation, no dependency, matching backend/utils/README.md's
 * "utilities vs. services" distinction.
 *
 * Best-effort by design: a dimension this can't confidently parse
 * (an unusual JPEG variant, a lossy-VP8 WebP frame, or a viewBox-less
 * SVG) returns `null` rather than guessing — `media_assets.width`/
 * `height` are nullable for exactly this reason. This never blocks an
 * upload; it only affects whether the admin UI can show real
 * dimensions before the browser itself renders the image.
 */

export interface Dimensions {
  width: number;
  height: number;
}

export function extractDimensions(bytes: Uint8Array, mimeType: string): Dimensions | null {
  switch (mimeType) {
    case 'image/png':
      return extractPng(bytes);
    case 'image/jpeg':
      return extractJpeg(bytes);
    case 'image/webp':
      return extractWebp(bytes);
    case 'image/svg+xml':
      return extractSvg(bytes);
    default:
      return null;
  }
}

/** PNG: 8-byte signature, then the IHDR chunk is always first — width/height are 4-byte big-endian integers at fixed offsets 16 and 20. */
function extractPng(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG: walk the marker stream until a Start-of-Frame marker (0xC0-0xCF, excluding 0xC4/0xC8/0xCC which aren't SOF) is found; its payload holds height then width as big-endian 16-bit integers. */
function extractJpeg(bytes: Uint8Array): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; // skip the initial FFD8
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null; // not a marker where one was expected — malformed or unsupported structure
    const marker = bytes[offset + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const segmentLength = view.getUint16(offset + 2, false);
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/** WebP: handles the two formats with directly-encoded dimensions (VP8X extended header, VP8L lossless signature) — a lossy VP8-only frame's dimensions require decoding the frame header's variable-length prefix and is deliberately not implemented (returns null; see this file's header comment on "best-effort by design"). */
function extractWebp(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 30) return null;
  const chunkId = String.fromCharCode(...bytes.slice(12, 16));

  if (chunkId === 'VP8X') {
    // Canvas width/height are 24-bit little-endian, each stored as (value - 1), at byte offsets 24 and 27.
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (chunkId === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    // 14-bit width-1 and height-1 packed across 4 bytes starting at offset 21, little-endian bit order.
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = (b0 | ((b1 & 0x3f) << 8)) + 1;
    const height = (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  return null;
}

/** SVG: reads explicit width/height attributes on the root <svg> element; falls back to the viewBox's 3rd/4th values (its own width/height in user units) if those attributes are absent — the common case for hand-authored icons. */
function extractSvg(bytes: Uint8Array): Dimensions | null {
  const text = new TextDecoder().decode(bytes.slice(0, 4096));
  const svgTagMatch = text.match(/<svg\b[^>]*>/i);
  if (!svgTagMatch) return null;
  const tag = svgTagMatch[0];

  const widthMatch = tag.match(/\bwidth="([\d.]+)/i);
  const heightMatch = tag.match(/\bheight="([\d.]+)/i);
  if (widthMatch && heightMatch) {
    const width = Math.round(parseFloat(widthMatch[1]));
    const height = Math.round(parseFloat(heightMatch[1]));
    if (width > 0 && height > 0) return { width, height };
  }

  const viewBoxMatch = tag.match(/\bviewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/i);
  if (viewBoxMatch) {
    const width = Math.round(parseFloat(viewBoxMatch[1]));
    const height = Math.round(parseFloat(viewBoxMatch[2]));
    if (width > 0 && height > 0) return { width, height };
  }

  return null;
}

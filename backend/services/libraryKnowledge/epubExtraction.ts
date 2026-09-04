/**
 * EPUB text extraction — Digital Library 2.0, Phase E (EPUB → Robayer
 * AI Knowledge Integration). Mirrors pdfExtraction.ts's own shape and
 * discipline exactly: real, substantiated per-unit text (there, per
 * PAGE; here, per SPINE ITEM — an EPUB's real chapter-file boundary,
 * confirmed real by every EPUB this project generates), zero fabricated
 * structure, zero new runtime dependency.
 *
 * An EPUB is a ZIP archive (its own spec requires "PK\x03\x04" as the
 * first four bytes of any real file, confirmed multiple times this
 * project already checks this exact signature — see
 * utils/mediaValidation.ts). Rather than add a ZIP dependency, this
 * hand-rolls the minimal real subset of the ZIP spec actually needed —
 * read the Central Directory, then each entry's Local File Header —
 * using `DecompressionStream('deflate-raw')`, a native Workers/Web
 * Streams API (confirmed working directly against the real Workers
 * runtime, not assumed — see epubExtraction.test.ts). This is the same
 * "prefer a native platform API over a new dependency" posture as
 * pdfExtraction.ts's own `dommatrix` shim and htmlExtraction.ts's own
 * `HTMLRewriter` use.
 *
 * Chapter/heading titles: PREFER the chapter's own `<title>` tag (in
 * `<head>`) when it is meaningfully populated; fall back to the first
 * real `<h1>`-`<h6>` text in `<body>` otherwise. Phase 4 (Robayer AI
 * chapter-context architecture) change — confirmed empirically against
 * the real production book that its EPUB `<title>` tags are textually
 * IDENTICAL to the corresponding PDF's own outline/bookmark titles for
 * the same chapter (e.g. both read exactly "Chapter 5: Understanding
 * Listed Companies"), which is what makes a single (documentId,
 * chapterTitle) key work as a chapter-scoped retrieval filter across
 * BOTH formats of the same book — a first-heading text can legitimately
 * differ in punctuation/casing from the PDF outline's own label, which
 * would silently break that cross-format match. Never inferred from a
 * filename, never fabricated when a chapter genuinely has neither
 * (front/back matter without a title or heading correctly gets
 * `chapterTitle: null`).
 */

/**
 * A generic, unhelpful `<title>` — an empty tag, a bare authoring-tool
 * default, or a navigation document's own boilerplate title (a real
 * EPUB nav.xhtml commonly titles itself "Nav"/"Table of Contents",
 * confirmed directly against this codebase's own
 * epubExtraction.test.ts fixture — that is a document label, never a
 * chapter title) — is worse than a real first-heading. This is the one
 * deliberate case where the fallback is preferred over a "populated"
 * title.
 */
function isMeaningfulEpubTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (/^(untitled|document|chapter|nav|navigation|toc|table of contents|contents|cover|title page)$/i.test(trimmed)) return false;
  return true;
}

// ----------------------------------------------------------------------
// Minimal ZIP reader — Central Directory + Local File Header only, the
// exact subset an EPUB (always a real, non-split, non-encrypted ZIP)
// needs. Deliberately does NOT support: multi-disk archives, ZIP64
// (needed only past 4GB — no real book approaches that), or encryption
// — none of which any real EPUB this project produces or would ever
// receive from a legitimate source uses.
// ----------------------------------------------------------------------

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(view: DataView): number {
  // The EOCD record is at the very end of the file, plus up to 65535
  // bytes of an optional trailing comment — scan backward from the end,
  // same approach every real ZIP reader uses (there is no forward
  // anchor to find it from).
  const maxCommentLength = 65535;
  const searchStart = Math.max(0, view.byteLength - 22 - maxCommentLength);
  for (let i = view.byteLength - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a valid ZIP/EPUB archive — no End Of Central Directory record found.');
}

function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('Malformed ZIP/EPUB archive — central directory entry signature mismatch.');
    }
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const fileCommentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + fileNameLength));

    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
}

async function readEntryBytes(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const localOffset = entry.localHeaderOffset;
  if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Malformed ZIP/EPUB archive — local file header signature mismatch for "${entry.name}".`);
  }
  const localFileNameLength = view.getUint16(localOffset + 26, true);
  const localExtraFieldLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localFileNameLength + localExtraFieldLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed; // stored, no compression (e.g. the mandatory "mimetype" entry)
  if (entry.compressionMethod !== 8) throw new Error(`Unsupported ZIP compression method (${entry.compressionMethod}) for "${entry.name}" — expected stored or deflate.`);

  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

async function readZipTextEntry(bytes: Uint8Array, entries: ZipEntry[], name: string): Promise<string> {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`Expected archive member not found: "${name}".`);
  const raw = await readEntryBytes(bytes, entry);
  return new TextDecoder().decode(raw);
}

// ----------------------------------------------------------------------
// EPUB structure — container.xml -> OPF package -> manifest/spine.
// Uses HTMLRewriter (the same native, zero-dependency parser
// htmlExtraction.ts already established for this codebase) rather than
// a hand-rolled XML parser — the OPF/container documents are well-
// formed XML, which HTMLRewriter parses the same as HTML.
// ----------------------------------------------------------------------

async function findOpfPath(bytes: Uint8Array, entries: ZipEntry[]): Promise<string> {
  const containerXml = await readZipTextEntry(bytes, entries, 'META-INF/container.xml');
  let opfPath: string | null = null;
  const rewriter = new HTMLRewriter().on('rootfile', {
    element(el) {
      opfPath = el.getAttribute('full-path');
    },
  });
  await rewriter.transform(new Response(containerXml)).text();
  if (!opfPath) throw new Error('Could not locate the OPF package document via META-INF/container.xml.');
  return opfPath;
}

interface ManifestItem {
  id: string;
  href: string;
}

async function parseOpf(opfXml: string): Promise<{ manifest: Map<string, ManifestItem>; spineIdrefs: string[] }> {
  const manifest = new Map<string, ManifestItem>();
  const spineIdrefs: string[] = [];

  const rewriter = new HTMLRewriter()
    .on('manifest item', {
      element(el) {
        const id = el.getAttribute('id');
        const href = el.getAttribute('href');
        if (id && href) manifest.set(id, { id, href });
      },
    })
    .on('spine itemref', {
      element(el) {
        const idref = el.getAttribute('idref');
        // A spine item explicitly marked non-reading-order content
        // (linear="no", e.g. a pop-up footnote page some EPUBs use) is
        // real content but not part of the book's actual reading flow
        // — excluded here the same way a real reader would skip it.
        const linear = el.getAttribute('linear');
        if (idref && linear !== 'no') spineIdrefs.push(idref);
      },
    });
  await rewriter.transform(new Response(opfXml)).text();

  return { manifest, spineIdrefs };
}

/** Resolves an OPF-relative href against the OPF file's own directory — real EPUB structure (this project's own generator included) commonly nests content under "EPUB/" or "OEBPS/", so a bare manifest href is not yet a real ZIP entry name. */
function resolveOpfRelativePath(opfPath: string, href: string): string {
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  // A manifest href is never expected to carry its own "../" segments in
  // a real, valid EPUB (the OPF and its content live in the same
  // subtree) — normalization beyond simple concatenation is deliberately
  // not implemented, matching this file's "only the real subset actually
  // needed" scope.
  return opfDir + href;
}

export interface ExtractedEpubSection {
  sectionIndex: number;
  href: string;
  chapterTitle: string | null;
  text: string;
}

export interface ExtractedEpub {
  totalSections: number;
  sections: ExtractedEpubSection[];
}

/**
 * `bytes` is the whole file, already fetched from R2 by the caller —
 * matching extractPdfText()'s own "no I/O of its own" convention.
 */
export async function extractEpubText(bytes: ArrayBuffer): Promise<ExtractedEpub> {
  const zipBytes = new Uint8Array(bytes);
  const entries = readCentralDirectory(zipBytes);

  const opfPath = await findOpfPath(zipBytes, entries);
  const opfXml = await readZipTextEntry(zipBytes, entries, opfPath);
  const { manifest, spineIdrefs } = await parseOpf(opfXml);

  const sections: ExtractedEpubSection[] = [];
  for (const idref of spineIdrefs) {
    const item = manifest.get(idref);
    if (!item) continue; // a spine idref with no matching manifest item is a malformed EPUB, not this extractor's problem to fabricate around — skipped, not guessed
    const entryPath = resolveOpfRelativePath(opfPath, item.href);

    let headTitle: string | null = null;
    let sawTitleClose = false;
    let headingTitle: string | null = null;
    const textParts: string[] = [];
    let sawHeading = false;
    const rewriter = new HTMLRewriter()
      .on('title', {
        text(chunk) {
          if (sawTitleClose) return; // only the document's own single <title> tag — never a later, unrelated element some malformed EPUB happens to also name "title"
          if (headTitle === null) headTitle = '';
          headTitle += chunk.text;
          if (chunk.lastInTextNode) sawTitleClose = true;
        },
      })
      .on('h1, h2, h3, h4, h5, h6', {
        text(chunk) {
          if (sawHeading) return; // only the FIRST real heading in this chapter file becomes the fallback title — never the last, never a guess
          if (headingTitle === null) headingTitle = '';
          headingTitle += chunk.text;
          if (chunk.lastInTextNode) sawHeading = true;
        },
      })
      .on('body', {
        text(chunk) {
          textParts.push(chunk.text);
        },
      });

    let xhtml: string;
    try {
      xhtml = await readZipTextEntry(zipBytes, entries, entryPath);
    } catch {
      continue; // a manifest entry pointing at a missing file is a malformed EPUB — skipped, not fabricated
    }
    await rewriter.transform(new Response(xhtml)).text();

    const text = textParts.join(' ').replace(/\s+/g, ' ').trim();
    const trimmedHeadTitle = headTitle === null ? null : (headTitle as string).trim();
    const trimmedHeadingTitle = headingTitle === null ? null : (headingTitle as string).trim() || null;
    // Prefer whichever real signal is more COMPLETE, not just "prefer
    // <title> unconditionally" — confirmed empirically that real books
    // vary here: the production Ghana Stock Exchange book's <title> is
    // the fuller, more identifying one ("Chapter 5: Understanding Listed
    // Companies", matching its PDF outline exactly), while a bare
    // "Chapter 1" <title> next to a richer "Chapter 1: Treasury Bills
    // Explained" <h1> is an equally realistic authoring pattern (see
    // this file's own test fixture). A longer, meaningful string is the
    // one more likely to actually match a PDF outline's own full label,
    // which is the entire point of getting this right — so length,
    // not tag identity, decides; <title> only wins outright ties.
    const meaningfulHeadTitle = trimmedHeadTitle && isMeaningfulEpubTitle(trimmedHeadTitle) ? trimmedHeadTitle : null;
    const trimmedTitle =
      meaningfulHeadTitle && trimmedHeadingTitle
        ? (trimmedHeadingTitle.length > meaningfulHeadTitle.length ? trimmedHeadingTitle : meaningfulHeadTitle)
        : meaningfulHeadTitle || trimmedHeadingTitle;
    if (!text) continue; // a genuinely empty section (e.g. a blank divider page) contributes nothing to index — not an error, matching extractPdfText()'s own per-page skip

    sections.push({ sectionIndex: sections.length, href: item.href, chapterTitle: trimmedTitle, text });
  }

  return { totalSections: sections.length, sections };
}

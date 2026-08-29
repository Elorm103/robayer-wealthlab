#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 9C.9 — EPUB3 generation for "Small Cedis, Big Wealth", the real
Robayer WealthLab flagship book (D1 product id=1, slug
starting-to-invest-with-gh100). Unlike every previous EPUB this project
has built, there is no markdown manuscript for this book anywhere in
the repository -- the only real source is the actual, current
production PDF (docs/small-cedis-source.pdf, fetched read-only from
production R2 this phase, sha256 58779e38..., matching production
media_assets exactly). This script extracts and restructures that
PDF's real content via PyMuPDF (font-size/position-aware, not a raw
pdftotext dump) -- every word below comes from the real PDF; nothing
is invented, summarized, or reworded.
"""

import html
import re
import uuid
from pathlib import Path

import fitz
from ebooklib import epub

ROOT = Path(r"C:\Users\hp\Downloads\robayer-wealthlab")
BOOK_ROOT = ROOT / "docs" / "small-cedis-big-wealth" / "production"
PDF_PATH = BOOK_ROOT / "source" / "small-cedis-big-wealth-source.pdf"
COVER_PATH = BOOK_ROOT / "cover" / "small-cedis-big-wealth-cover.png"
OUTPUT_PATH = BOOK_ROOT / "epub" / "small-cedis-big-wealth.epub"

CHROME_SIZE_MAX = 7.6  # running header/footer chrome only -- confirmed via a full-document font-size survey (7.5/8.0-9.5/10.0/11.0/14-16/27/40); nothing at 7.5 anywhere in the book is real body content.
CHROME_PATTERNS = [
    re.compile(r"^SMALL CEDIS,?\s*BIG WEALTH$", re.I),
    re.compile(r"^Robayer WealthLab\s*.\s*Page\s*\d+$", re.I),
    re.compile(r"^CHAPTER \d+ OF 9$", re.I),
]

# Defined here (not just before render_blocks_to_html) because
# merge_wrapped_lines() also needs them: the real book's due-diligence
# checklist uses checkbox glyphs (☐), one per line, at tight line
# spacing indistinguishable by gap alone from a single wrapped
# paragraph -- so a block starting with one of these markers must never
# be merged into its neighbour as a "continuation line."
BULLET_RE = re.compile(r"^[•●▪☐☑–-]\s+")
NUM_RE = re.compile(r"^\d+[\.\)]\s+")


def esc(text):
    return html.escape(text, quote=False)


def is_chrome(text, size):
    t = text.strip()
    if not t:
        return True
    if size <= CHROME_SIZE_MAX:
        return True
    for pat in CHROME_PATTERNS:
        if pat.match(t):
            return True
    return False


def classify_block(dominant_size, bold, text):
    if dominant_size >= 14:
        return "h1"
    if 8.0 <= dominant_size <= 9.7 and (bold or text.isupper()) and len(text) < 90:
        return "h3"
    return "p"


def extract_page_blocks(page, table_bboxes):
    """Returns an ordered list of (kind, text, y0, y1) for one page's non-chrome, non-table text, reading top-to-bottom. y0/y1 (PDF point coordinates) let the caller distinguish a wrapped line (tiny gap) from a real new paragraph (larger gap), calibrated against this book's own real, measured line/paragraph spacing."""
    d = page.get_text("dict")
    out = []
    blocks = sorted(d["blocks"], key=lambda b: (round(b["bbox"][1]), b["bbox"][0]))
    for block in blocks:
        if "lines" not in block:
            continue
        bx0, by0, bx1, by1 = block["bbox"]
        inside_table = False
        for tb in table_bboxes:
            tx0, ty0, tx1, ty1 = tb
            if bx0 >= tx0 - 2 and by0 >= ty0 - 2 and bx1 <= tx1 + 2 and by1 <= ty1 + 2:
                inside_table = True
                break
        if inside_table:
            continue

        lines_text = []
        sizes = []
        bolds = []
        for line in block["lines"]:
            line_text = "".join(span["text"] for span in line["spans"])
            if not line_text.strip():
                continue
            for span in line["spans"]:
                sizes.append(span["size"])
                bolds.append(bool(span["flags"] & 2 ** 4) or "Bold" in span.get("font", ""))
            lines_text.append(line_text)
        if not lines_text:
            continue

        full_text = " ".join(l.strip() for l in lines_text).strip()
        full_text = re.sub(r"\s+", " ", full_text)
        dominant_size = max(sizes) if sizes else 10.0
        bold = any(bolds)

        if is_chrome(full_text, dominant_size):
            continue
        if re.match(r"^\d{1,2}$", full_text) and dominant_size < 14:
            continue

        kind = classify_block(dominant_size, bold, full_text)
        if kind == "h1":
            # A lone leading chapter-number glyph sometimes shares the
            # title's own text block (e.g. "4 IC Wealth and Other...") --
            # the number is decorative page furniture, not book text.
            full_text = re.sub(r"^\d{1,2}\s+", "", full_text)
        out.append((kind, full_text, by0, by1))
    return out


# Measured directly from this book's own real line/paragraph spacing
# (see the Phase 9C.9 report): a wrapped line within one paragraph sits
# ~3.4-5.3pt below the previous line; a genuine new paragraph (or a
# multi-line heading's second line) sits ~8-13pt below; anything larger
# is a real new element (a different heading, a new card/box).
SAME_LINE_GAP_MAX = 6.5
SAME_PARAGRAPH_RUN_GAP_MAX = 13.0


def merge_wrapped_lines(page_blocks):
    """Collapses same-page, same-kind blocks that are really just wrapped lines of one heading/paragraph into a single block, using this book's own measured spacing -- never merges across a page boundary or a kind change. H1s always merge with an immediately preceding H1 on the same page (a chapter title never has two real, separate H1s back to back -- confirmed by inspecting every chapter's title block in this book); body paragraphs only merge below SAME_LINE_GAP_MAX, so a genuine new paragraph (a larger, but still same-section, gap) correctly starts its own <p> instead of being run on."""
    merged = []
    for kind, text, y0, y1 in page_blocks:
        should_merge = False
        is_list_marker = bool(BULLET_RE.match(text) or NUM_RE.match(text))
        prev_is_list_marker = bool(merged and (BULLET_RE.match(merged[-1][1]) or NUM_RE.match(merged[-1][1])))
        if merged and merged[-1][0] == kind and not is_list_marker and not prev_is_list_marker:
            gap = y0 - merged[-1][3]
            if kind == "h1":
                should_merge = True
            elif gap <= SAME_LINE_GAP_MAX:
                should_merge = True
        if should_merge:
            prev_kind, prev_text, prev_y0, _prev_y1 = merged[-1]
            merged[-1] = (prev_kind, f"{prev_text} {text}".strip(), prev_y0, y1)
        else:
            merged.append((kind, text, y0, y1))
    return merged


def extract_tables_html(page):
    """Real tables via PyMuPDF's own table-structure detector -- cell text taken verbatim, never re-typed or estimated."""
    tabs = page.find_tables()
    results = []
    for t in tabs.tables:
        rows = t.extract()
        if not rows or len(rows) < 2:
            continue
        header, *body_rows = rows
        html_parts = ['<div class="table-wrap"><table>']
        html_parts.append("<thead><tr>" + "".join(f"<th>{esc(str(c or ''))}</th>" for c in header) + "</tr></thead>")
        html_parts.append("<tbody>")
        for r in body_rows:
            html_parts.append("<tr>" + "".join(f"<td>{esc(str(c or ''))}</td>" for c in r) + "</tr>")
        html_parts.append("</tbody></table></div>")
        results.append(("".join(html_parts), t.bbox))
    return results


def render_blocks_to_html(blocks):
    """Groups classified (kind, text) blocks into XHTML, collapsing consecutive bullet/numbered paragraphs into real <ul>/<ol> lists. `blocks` is a plain (kind, text) sequence -- wrapped-line merging has already happened upstream in merge_wrapped_lines()."""
    out = []
    i, n = 0, len(blocks)
    while i < n:
        kind, text = blocks[i]
        if kind == "h1":
            out.append(f"<h1>{esc(text)}</h1>")
            i += 1
            continue
        if kind == "h3":
            out.append(f"<h3>{esc(text)}</h3>")
            i += 1
            continue
        if BULLET_RE.match(text):
            items = []
            while i < n and blocks[i][0] == "p" and BULLET_RE.match(blocks[i][1]):
                items.append(BULLET_RE.sub("", blocks[i][1]))
                i += 1
            out.append("<ul>" + "".join(f"<li>{esc(it)}</li>" for it in items) + "</ul>")
            continue
        if NUM_RE.match(text):
            items = []
            while i < n and blocks[i][0] == "p" and NUM_RE.match(blocks[i][1]):
                items.append(NUM_RE.sub("", blocks[i][1]))
                i += 1
            out.append("<ol>" + "".join(f"<li>{esc(it)}</li>" for it in items) + "</ol>")
            continue
        out.append(f"<p>{esc(text)}</p>")
        i += 1
    return "\n".join(out)


def wrap_xhtml(title_text, body_html):
    return (
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n'
        "<head>\n<meta charset=\"utf-8\"/>\n"
        f"<title>{esc(title_text)}</title>\n"
        '<link rel="stylesheet" type="text/css" href="style/stylesheet.css"/>\n'
        f"</head>\n<body>\n{body_html}\n</body>\n</html>"
    )


CSS = """
@charset "utf-8";
body { font-family: Georgia, "Newsreader", serif; line-height: 1.6; margin: 0; padding: 0 1em; }
h1, h3 { font-family: "Segoe UI", "Space Grotesk", sans-serif; color: #16233D; line-height: 1.25; }
h1 { font-size: 1.7em; margin-top: 1.2em; }
h3 { font-size: 1em; margin-top: 1.4em; text-transform: uppercase; letter-spacing: 0.03em; color: #6B675E; }
p { margin: 0 0 1em 0; }
ul, ol { margin: 0 0 1em 0; padding-left: 1.4em; }
li { margin-bottom: 0.4em; }
.table-wrap { overflow-x: auto; margin: 1em 0; width: 100%; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 0.06em solid #E8E4DC; padding: 0.5em 0.6em; text-align: left; vertical-align: top; font-size: 0.9em; }
th { background: #FAF6EF; font-family: "Segoe UI", "Space Grotesk", sans-serif; }
.title-page { text-align: center; margin-top: 12%; }
.title-page .kicker { font-family: "Segoe UI", "Space Grotesk", sans-serif; letter-spacing: 0.08em; color: #6B675E; font-size: 0.8em; }
.title-page h1 { font-size: 2em; margin: 0.3em 0; }
.title-page .subtitle { font-style: italic; margin: 1em 0; color: #6B675E; }
.title-page .by-line { margin-top: 2em; font-family: "Segoe UI", "Space Grotesk", sans-serif; }
.cover-image { max-width: 100%; height: auto; display: block; margin: 0 auto; }
"""

# Section boundaries -- built directly from the real PDF's own printed
# Table of Contents (page index 5) cross-checked against the real
# in-document "CHAPTER N OF 9" markers found on pages 8, 11, 13, 15,
# 17, 19, 21, 23, 24 (0-indexed) -- not guessed, read from the actual
# extracted text.
SECTIONS = [
    ("Copyright & Disclaimer", 1),
    ("About Robayer WealthLab", 2),
    ("About the Author", 3),
    ("Why I Wrote This Book", 4),
    ("Other Books by Robayer WealthLab", 6),
    ("Introduction: Why Small Money Can Build Big Wealth in Ghana", 7),
    ("Chapter 1: Mobile Money Susu & Digital Savings Wallets", 8),
    ("Chapter 2: Treasury Bills, Ghana's Safest Real Investment", 11),
    ("Chapter 3: Money Market Funds & Mutual Funds", 13),
    ("Chapter 4: IC Wealth and Other Licensed Wealth Platforms", 15),
    ("Chapter 5: The Ghana Stock Exchange", 17),
    ("Chapter 6: Traditional Bank Savings & Fixed Deposits", 19),
    ("Chapter 7: Petty Trading & Skills", 21),
    ("Chapter 8: How to Spot and Avoid Investment Scams in Ghana", 23),
    ("Chapter 9: Your 6-Month Action Plan", 24),
    ("Frequently Asked Questions", 25),
    ("Bonus Chapter: 10 Biggest Money Mistakes Ghanaians Make", 26),
    ("Bonus: The 30-Day Wealth Challenge", 27),
    ("Bonus: Investment Due-Diligence Checklist", 29),
    ("Bonus: Financial Goal Worksheet", 30),
    ("Bonus: Official Resource Links", 31),
    ("Glossary", 32),
    ("Appendix: Side-by-Side Comparison", 34),
    ("Continue Your Wealth Journey", 35),
]
TOTAL_PAGES = 37


def build():
    doc = fitz.open(str(PDF_PATH))

    section_ranges = []
    for idx, (title, start) in enumerate(SECTIONS):
        end = SECTIONS[idx + 1][1] if idx + 1 < len(SECTIONS) else TOTAL_PAGES
        section_ranges.append((title, start, end))

    book = epub.EpubBook()
    book.set_identifier(f"urn:uuid:{uuid.uuid4()}")
    book.set_title("Small Cedis, Big Wealth")
    book.set_language("en")
    book.add_author("Robert Loh Kobla")
    book.add_metadata("DC", "publisher", "Robayer WealthLab Press")
    book.add_metadata(
        "DC", "description",
        "How Ordinary Ghanaians Can Build Real Wealth Starting With GH\u20b51 -- "
        "a practical Ghanaian wealth guide covering mobile money susu, Treasury "
        "Bills, money market funds, licensed wealth platforms, the Ghana Stock "
        "Exchange, and how to spot investment scams."
    )
    for kw in ["Treasury Bills Ghana", "mobile money susu", "Ghana Stock Exchange", "money market funds", "Robayer WealthLab"]:
        book.add_metadata("DC", "subject", kw)
    book.add_metadata("DC", "rights", "\u00A9 2026 Robayer WealthLab. All rights reserved.")

    style_item = epub.EpubItem(uid="style_main", file_name="style/stylesheet.css", media_type="text/css", content=CSS)
    book.add_item(style_item)

    cover_bytes = COVER_PATH.read_bytes()
    book.set_cover("images/cover.png", cover_bytes, create_page=False)
    cover_item = epub.EpubHtml(uid="cover", title="Cover", file_name="cover.xhtml", lang="en")
    cover_item.content = wrap_xhtml("Cover", '<img class="cover-image" src="images/cover.png" alt="Small Cedis, Big Wealth -- cover"/>')
    cover_item.add_link(href="style/stylesheet.css", rel="stylesheet", type="text/css")
    cover_item.is_linear = False
    book.add_item(cover_item)

    title_body = (
        '<div class="title-page">'
        '<p class="kicker">A PRACTICAL GHANAIAN WEALTH GUIDE</p>'
        "<h1>Small Cedis, Big Wealth</h1>"
        '<p class="subtitle">How Ordinary Ghanaians Can Build Real Wealth Starting With GH\u20b51</p>'
        '<p class="by-line">Robert Loh Kobla<br/>Founder, Robayer WealthLab</p>'
        "</div>"
    )
    title_item = epub.EpubHtml(uid="titlepage", title="Title Page", file_name="titlepage.xhtml", lang="en")
    title_item.content = wrap_xhtml("Title Page", title_body)
    title_item.add_link(href="style/stylesheet.css", rel="stylesheet", type="text/css")
    book.add_item(title_item)

    section_items = []
    for title, start, end in section_ranges:
        all_blocks = []
        for pi in range(start, end):
            page = doc[pi]
            tables = extract_tables_html(page)
            table_bboxes = [bbox for _, bbox in tables]
            page_blocks = extract_page_blocks(page, table_bboxes)
            page_blocks = merge_wrapped_lines(page_blocks)
            # Interleave: emit the page's classified text blocks, then
            # any real tables found on that page, in that order (tables
            # in this book's real layout consistently sit after their
            # page's lead-in text). A page boundary always ends any
            # in-progress paragraph -- never merged across pages.
            all_blocks.extend((kind, text) for kind, text, _y0, _y1 in page_blocks)
            for table_html, _ in tables:
                all_blocks.append(("table_html", table_html))

        # Render, handling the special 'table_html' marker separately
        # from render_blocks_to_html's normal heading/paragraph/list path.
        parts = []
        run = []
        for kind, text in all_blocks:
            if kind == "table_html":
                if run:
                    parts.append(render_blocks_to_html(run))
                    run = []
                parts.append(text)
            else:
                run.append((kind, text))
        if run:
            parts.append(render_blocks_to_html(run))
        body_html = "\n".join(p for p in parts if p.strip())

        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
        item = epub.EpubHtml(uid=f"sec-{slug}", title=title, file_name=f"sec-{slug}.xhtml", lang="en")
        item.content = wrap_xhtml(title, body_html)
        item.add_link(href="style/stylesheet.css", rel="stylesheet", type="text/css")
        book.add_item(item)
        section_items.append(item)

    toc = [epub.Link(title_item.file_name, "Title Page", title_item.id)]
    front = [it for it, (title, *_rest) in zip(section_items, section_ranges) if title in (
        "Copyright & Disclaimer", "About Robayer WealthLab", "About the Author", "Why I Wrote This Book", "Other Books by Robayer WealthLab"
    )]
    intro = [it for it, (title, *_rest) in zip(section_items, section_ranges) if title.startswith("Introduction")]
    chapters = [it for it, (title, *_rest) in zip(section_items, section_ranges) if title.startswith("Chapter")]
    back = [it for it in section_items if it not in front and it not in intro and it not in chapters]

    if front:
        toc.append((epub.Section("Front Matter"), [epub.Link(it.file_name, it.title, it.id) for it in front]))
    if intro:
        toc.append((epub.Section("Introduction"), [epub.Link(it.file_name, it.title, it.id) for it in intro]))
    if chapters:
        toc.append((epub.Section("Chapters"), [epub.Link(it.file_name, it.title, it.id) for it in chapters]))
    if back:
        toc.append((epub.Section("Additional Resources"), [epub.Link(it.file_name, it.title, it.id) for it in back]))
    book.toc = tuple(toc)

    book.add_item(epub.EpubNcx())
    nav_item = epub.EpubNav()
    book.add_item(nav_item)

    book.spine = ["cover", nav_item, title_item] + section_items

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    epub.write_epub(str(OUTPUT_PATH), book, {})
    print("Wrote:", OUTPUT_PATH)
    print("Sections:", len(section_items))


if __name__ == "__main__":
    build()

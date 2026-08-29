#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 9C.6 EPUB generation for "TREASURY BILLS MADE SIMPLE".

Reads the locked manuscript markdown files (docs/book-treasury-bills-made-simple/
manuscript/*.md) and produces a reflowable EPUB3 file. Reuses the same
general markdown -> XHTML conversion approach already proven in
docs/ghana-remote-work-guide/production/epub/generate_epub.py (ebooklib,
a hand-written block parser for headings/paragraphs/lists/tables/
blockquotes, EPUB3 nav/TOC) rather than inventing a new pipeline -- this
manuscript's markdown is simpler (no checkbox lists, no fenced code
blocks, no card-mode tables), so no chapter-specific transformations are
needed.

No manuscript wording is altered, added to, or removed anywhere. This
script only converts markdown structure to XHTML markup.
"""

import html
import re
import uuid
from pathlib import Path

from ebooklib import epub

ROOT = Path(r"C:\Users\hp\Downloads\robayer-wealthlab")
MANUSCRIPT_DIR = ROOT / "docs" / "book-treasury-bills-made-simple" / "manuscript"
OUTPUT_PATH = ROOT / "docs" / "book-treasury-bills-made-simple" / "production" / "epub" / "treasury-bills-made-simple.epub"

# No cover image file exists anywhere in the repo for this book (only a
# design spec doc, docs/book-treasury-bills-made-simple/publication/
# cover-design-spec.md) -- per the "do not fabricate content" instruction,
# this build ships without an embedded cover image rather than inventing
# one. epub.js and every EPUB3 reader render a coverless book without
# error; a real cover can be added by re-running this script once one
# exists, without touching the manuscript-to-XHTML logic below.
COVER_PATH = None


def esc(text):
    return html.escape(text, quote=False)


def inline_format(text):
    text = esc(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    return text


def parse_table_lines(table_lines):
    def parse_row(line):
        cells = line.strip().strip("|").split("|")
        return [c.strip() for c in cells]

    header = parse_row(table_lines[0])
    rows = [parse_row(l) for l in table_lines[2:]]
    return header, rows


def render_table_html(header, rows):
    out = ['<div class="table-wrap"><table>']
    out.append("<thead><tr>" + "".join("<th>{}</th>".format(inline_format(h)) for h in header) + "</tr></thead>")
    out.append("<tbody>")
    for r in rows:
        out.append("<tr>" + "".join("<td>{}</td>".format(inline_format(c)) for c in r) + "</tr>")
    out.append("</tbody></table></div>")
    return "\n".join(out)


def render_blockquote(bq_lines):
    paras, cur = [], []
    for l in bq_lines:
        if l.strip() == "":
            if cur:
                paras.append(" ".join(cur))
                cur = []
        else:
            cur.append(l.strip())
    if cur:
        paras.append(" ".join(cur))
    inner = "".join("<p>{}</p>".format(inline_format(p)) for p in paras)
    return "<blockquote>{}</blockquote>".format(inner)


def render_bullet_list(items):
    out = ["<ul>"]
    for it in items:
        out.append("<li>{}</li>".format(inline_format(it)))
    out.append("</ul>")
    return "\n".join(out)


def render_numbered_list(items):
    out = ["<ol>"]
    for it in items:
        out.append("<li>{}</li>".format(inline_format(it)))
    out.append("</ol>")
    return "\n".join(out)


def render_body(lines):
    """Converts a page's raw markdown body lines (everything below the
    page's own H1) into XHTML. Handles: H2/H3 headings, horizontal
    rules, pipe tables, blockquotes, bullet lists, numbered lists, and
    plain paragraphs -- the complete set of block constructs actually
    present in this manuscript (confirmed via a full read of every
    chapter file; no fenced code blocks or checkbox lists exist here)."""
    html_parts = []
    i, n = 0, len(lines)

    def is_blank(l):
        return l.strip() == ""

    while i < n:
        line = lines[i]
        if is_blank(line):
            i += 1
            continue

        if line.startswith("### "):
            html_parts.append("<h3>{}</h3>".format(inline_format(line[4:].strip())))
            i += 1
            continue

        if line.startswith("## "):
            html_parts.append("<h2>{}</h2>".format(inline_format(line[3:].strip())))
            i += 1
            continue

        if line.strip() == "---":
            html_parts.append("<hr/>")
            i += 1
            continue

        if line.startswith("|"):
            table_lines = []
            while i < n and lines[i].startswith("|"):
                table_lines.append(lines[i])
                i += 1
            header, rows = parse_table_lines(table_lines)
            html_parts.append(render_table_html(header, rows))
            continue

        if line.startswith(">"):
            bq_lines = []
            while i < n and (lines[i].startswith(">") or is_blank(lines[i])):
                if lines[i].startswith(">"):
                    bq_lines.append(lines[i][1:].strip())
                else:
                    bq_lines.append("")
                i += 1
                if is_blank(lines[i - 1]) and (i >= n or not lines[i].startswith(">")):
                    break
            html_parts.append(render_blockquote(bq_lines))
            continue

        if line.startswith("- "):
            li_lines = []
            while i < n and (lines[i].startswith("- ") or (li_lines and lines[i].startswith("  ") and not is_blank(lines[i]))):
                if lines[i].startswith("- "):
                    li_lines.append(lines[i][2:])
                else:
                    li_lines[-1] += " " + lines[i].strip()
                i += 1
            html_parts.append(render_bullet_list(li_lines))
            continue

        if re.match(r"^\d+\.\s", line):
            ol_lines = []
            while i < n and (re.match(r"^\d+\.\s", lines[i]) or (ol_lines and lines[i].startswith("  ") and not is_blank(lines[i]))):
                if re.match(r"^\d+\.\s", lines[i]):
                    ol_lines.append(re.sub(r"^\d+\.\s", "", lines[i]))
                else:
                    ol_lines[-1] += " " + lines[i].strip()
                i += 1
            html_parts.append(render_numbered_list(ol_lines))
            continue

        # paragraph (a single italic-only line, e.g. "*Reading Time: 8 minutes*",
        # is rendered as its own <p class="meta"> for a lighter visual weight)
        para_lines = []
        while (
            i < n
            and not is_blank(lines[i])
            and not lines[i].startswith("#")
            and not lines[i].startswith("|")
            and not lines[i].startswith(">")
            and not lines[i].startswith("- ")
            and not re.match(r"^\d+\.\s", lines[i])
            and lines[i].strip() != "---"
        ):
            para_lines.append(lines[i])
            i += 1
        para_text = " ".join(l.strip() for l in para_lines)
        is_meta = bool(re.match(r"^\*[^*]+\*$", para_text.strip()))
        cls = ' class="meta"' if is_meta else ""
        html_parts.append("<p{}>{}</p>".format(cls, inline_format(para_text)))

    return "\n".join(html_parts)


def wrap_xhtml(title_text, body_html):
    return (
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8"/>\n'
        "<title>{title}</title>\n"
        '<link rel="stylesheet" type="text/css" href="style/stylesheet.css"/>\n'
        "</head>\n"
        "<body>\n"
        "{body}\n"
        "</body>\n"
        "</html>"
    ).format(title=esc(title_text), body=body_html)


CSS = """
@charset "utf-8";

body {
  font-family: Georgia, "Newsreader", serif;
  line-height: 1.6;
  margin: 0;
  padding: 0 1em;
}

h1, h2, h3 {
  font-family: "Segoe UI", "Space Grotesk", sans-serif;
  color: #16233D;
  line-height: 1.25;
}

h1 { font-size: 1.7em; margin-top: 1.2em; }
h2 { font-size: 1.3em; margin-top: 1.6em; border-bottom: 0.06em solid #E8E4DC; padding-bottom: 0.3em; }
h3 { font-size: 1.05em; margin-top: 1.3em; }

p { margin: 0 0 1em 0; }
p.meta { font-style: italic; color: #6B675E; margin-bottom: 1.4em; }
a { color: #16233D; }

em { font-style: italic; }
strong { font-weight: 600; }

blockquote {
  margin: 1em 0;
  padding: 0.6em 1em;
  border-left: 0.25em solid #E6AF19;
  background: #FBF1E0;
}
blockquote p { margin: 0 0 0.6em 0; }
blockquote p:last-child { margin-bottom: 0; }

ul, ol { margin: 0 0 1em 0; padding-left: 1.4em; }
li { margin-bottom: 0.4em; }

.table-wrap { overflow-x: auto; margin: 1em 0; width: 100%; }
table { border-collapse: collapse; width: 100%; }
th, td {
  border: 0.06em solid #E8E4DC;
  padding: 0.5em 0.6em;
  text-align: left;
  vertical-align: top;
  font-size: 0.92em;
}
th {
  background: #FAF6EF;
  font-family: "Segoe UI", "Space Grotesk", sans-serif;
}

hr { border: none; border-top: 0.06em solid #E8E4DC; margin: 1.6em 0; }

.title-page { text-align: center; margin-top: 15%; }
.title-page .kicker { font-family: "Segoe UI", "Space Grotesk", sans-serif; letter-spacing: 0.04em; color: #6B675E; }
.title-page h1 { font-size: 1.9em; margin-bottom: 0.2em; }
.title-page .subtitle { font-style: italic; margin: 1.2em 0; color: #6B675E; }
.title-page .by-line { margin-top: 2em; font-family: "Segoe UI", "Space Grotesk", sans-serif; }
"""

# ----------------------------------------------------------------------
# Front matter: 00-front-matter.md's own preamble (title block, before
# its first "##") becomes the title page; everything from "## Copyright
# Page" onward becomes one combined Front Matter page, EXCEPT
# "## Table of Contents" (redundant with the EPUB's own real
# navigation/TOC -- epub.js's TOC drawer already provides this,
# reproducing a page-number-based TOC as static text would be
# misleading in a reflowable, page-number-less format).
# ----------------------------------------------------------------------

CHAPTER_FILES = [
    "01-chapter-1-what-are-treasury-bills.md",
    "02-chapter-2-why-governments-borrow-money.md",
    "03-chapter-3-how-treasury-bills-work-in-ghana.md",
    "04-chapter-4-understanding-different-tenors.md",
    "05-chapter-5-returns-explained.md",
    "06-chapter-6-risks-and-misconceptions.md",
    "07-chapter-7-how-to-invest-step-by-step.md",
    "08-chapter-8-frequently-asked-questions.md",
    "09-chapter-9-beginner-checklist.md",
    "10-chapter-10-final-summary.md",
]

END_MATTER_FILES = [
    ("11-glossary.md", "Glossary"),
    ("12-references.md", "References"),
    ("13-about-robayer-wealthlab.md", "About Robayer WealthLab"),
    ("14-about-the-author.md", "About the Author"),
]


def parse_front_matter(text):
    lines = text.split("\n")
    first_h2 = next(i for i, l in enumerate(lines) if l.startswith("## "))
    preamble_lines = lines[:first_h2]
    rest_lines = lines[first_h2:]

    # Preamble: "TITLE", "*subtitle*", "By ...", "Book N in the ... Series", "---"
    preamble_text = [l for l in preamble_lines if l.strip() and l.strip() != "---"]
    title = preamble_text[0].strip() if preamble_text else "Treasury Bills Made Simple"
    subtitle = preamble_text[1].strip().strip("*") if len(preamble_text) > 1 else ""
    byline = preamble_text[2].strip() if len(preamble_text) > 2 else "By Robayer WealthLab"
    series_line = preamble_text[3].strip() if len(preamble_text) > 3 else ""

    # Rest: split into H2 sections, skip "Table of Contents"
    sections = []
    cur = None
    for l in rest_lines:
        if l.startswith("## "):
            if cur is not None:
                sections.append(cur)
            cur = {"title": l[3:].strip(), "body": []}
            continue
        if cur is not None:
            cur["body"].append(l)
    if cur is not None:
        sections.append(cur)
    sections = [s for s in sections if s["title"] != "Table of Contents"]

    return {"title": title, "subtitle": subtitle, "byline": byline, "series_line": series_line}, sections


CHAPTER_H1_RE = re.compile(r"^# (Chapter \d+:.*)$")


def parse_chapter_file(text):
    lines = text.split("\n")
    m = CHAPTER_H1_RE.match(lines[0].strip())
    title = m.group(1).strip() if m else lines[0].lstrip("# ").strip()
    body_lines = lines[1:]
    return title, body_lines


def parse_end_matter_file(text, fallback_title):
    lines = text.split("\n")
    if lines[0].startswith("# "):
        title = lines[0][2:].strip()
        body_lines = lines[1:]
    else:
        title = fallback_title
        body_lines = lines
    return title, body_lines


def build():
    book = epub.EpubBook()
    book.set_identifier("urn:uuid:{}".format(uuid.uuid4()))
    book.set_title("Treasury Bills Made Simple")
    book.set_language("en")
    book.add_author("Robayer WealthLab")
    book.add_metadata("DC", "publisher", "Robayer WealthLab")
    book.add_metadata(
        "DC",
        "description",
        "A beginner's guide to Ghana's Treasury Bills: what they are, how the "
        "auction system works, how to calculate your own return, real risks, "
        "and the exact steps to buy your first one.",
    )
    for kw in ["Treasury Bills Ghana", "T-bills", "Bank of Ghana", "Ghana investing", "Robayer WealthLab"]:
        book.add_metadata("DC", "subject", kw)
    book.add_metadata("DC", "rights", "\u00A9 2026 Robayer WealthLab. All rights reserved.")

    style_item = epub.EpubItem(uid="style_main", file_name="style/stylesheet.css", media_type="text/css", content=CSS)
    book.add_item(style_item)

    front_matter_text = (MANUSCRIPT_DIR / "00-front-matter.md").read_text(encoding="utf-8")
    meta, fm_sections = parse_front_matter(front_matter_text)

    # ---------------- Title page ----------------
    title_body = (
        '<div class="title-page">'
        "<h1>{title}</h1>"
        '<p class="subtitle">{subtitle}</p>'
        '<p class="by-line">{byline}</p>'
        "<p>{series}</p>"
        "</div>"
    ).format(
        title=esc(meta["title"]),
        subtitle=inline_format(meta["subtitle"]),
        byline=esc(meta["byline"]),
        series=esc(meta["series_line"]),
    )
    title_item = epub.EpubHtml(uid="titlepage", title="Title Page", file_name="titlepage.xhtml", lang="en")
    title_item.content = wrap_xhtml("Title Page", title_body)
    title_item.add_link(href="style/stylesheet.css", rel="stylesheet", type="text/css")
    book.add_item(title_item)

    # ---------------- Front matter (one combined page) ----------------
    fm_body_parts = []
    for sec in fm_sections:
        fm_body_parts.append("<h2>{}</h2>".format(esc(sec["title"])))
        fm_body_parts.append(render_body(sec["body"]))
    front_matter_item = epub.EpubHtml(uid="frontmatter", title="Front Matter", file_name="front-matter.xhtml", lang="en")
    front_matter_item.content = wrap_xhtml("Front Matter", "\n".join(fm_body_parts))
    front_matter_item.add_link(href="style/stylesheet.css", rel="stylesheet", type="text/css")
    book.add_item(front_matter_item)

    # ---------------- Chapters ----------------
    chapter_items = []
    for idx, filename in enumerate(CHAPTER_FILES, start=1):
        text = (MANUSCRIPT_DIR / filename).read_text(encoding="utf-8")
        title, body_lines = parse_chapter_file(text)
        body_html = render_body(body_lines)
        file_name = "ch{:02d}.xhtml".format(idx)
        item = epub.EpubHtml(uid="ch{:02d}".format(idx), title=title, file_name=file_name, lang="en")
        item.content = wrap_xhtml(title, "<h1>{}</h1>\n{}".format(esc(title), body_html))
        item.add_link(href="style/stylesheet.css", rel="stylesheet", type="text/css")
        book.add_item(item)
        chapter_items.append(item)

    # ---------------- End matter ----------------
    end_matter_items = []
    for filename, fallback_title in END_MATTER_FILES:
        text = (MANUSCRIPT_DIR / filename).read_text(encoding="utf-8")
        title, body_lines = parse_end_matter_file(text, fallback_title)
        body_html = render_body(body_lines)
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
        item = epub.EpubHtml(uid="end-{}".format(slug), title=title, file_name="end-{}.xhtml".format(slug), lang="en")
        item.content = wrap_xhtml(title, "<h1>{}</h1>\n{}".format(esc(title), body_html))
        item.add_link(href="style/stylesheet.css", rel="stylesheet", type="text/css")
        book.add_item(item)
        end_matter_items.append(item)

    # ---------------- Nav / TOC ----------------
    toc = [
        epub.Link(title_item.file_name, "Title Page", title_item.id),
        epub.Link(front_matter_item.file_name, "Front Matter", front_matter_item.id),
        (epub.Section("Chapters"), [epub.Link(it.file_name, it.title, it.id) for it in chapter_items]),
        (epub.Section("End Matter"), [epub.Link(it.file_name, it.title, it.id) for it in end_matter_items]),
    ]
    book.toc = tuple(toc)

    book.add_item(epub.EpubNcx())
    nav_item = epub.EpubNav()
    book.add_item(nav_item)

    # ---------------- Spine ----------------
    book.spine = [nav_item, title_item, front_matter_item] + chapter_items + end_matter_items

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    epub.write_epub(str(OUTPUT_PATH), book, {})

    print("Wrote:", OUTPUT_PATH)
    print("Chapters:", len(chapter_items))
    print("End matter pages:", len(end_matter_items))


if __name__ == "__main__":
    build()

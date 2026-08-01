#!/usr/bin/env node
/**
 * Robayer WealthLab: automatic asset cache-busting (Version 3.6:
 * Platform Hardening, Phase 1).
 *
 * Replaces the old, manually-incremented `?v=m68` / `?v=m69` scheme —
 * the direct cause of at least three separate live cache-poisoning
 * incidents across Version 3.5.1 and 3.5.3 (see
 * docs/v4.0-technical-debt-register.md, item #1) — with a version
 * string that is a pure function of the asset's own content: a short
 * SHA-256 hash of the file's current bytes.
 *
 * Why this eliminates the failure mode entirely, not just reduces it:
 * the old scheme failed when a human picked a version number that
 * happened to already have been requested by some client (a monitor,
 * a premature curl check, an unrelated concurrent fetch) before the
 * real new content was live at origin — Cloudflare then cached that
 * URL's old response for its full TTL. A content hash cannot suffer
 * this failure by construction: the hash of the OLD content and the
 * hash of the NEW content are different strings whenever the content
 * actually differs, so the new URL was never served before this exact
 * content existed, by anyone, ever. If two deploys produce the exact
 * same hash, it is because the content is byte-identical — in which
 * case serving a cached copy is correct, not a bug. There is no
 * "already used this number" mistake left to make, because there is
 * no number to pick.
 *
 * Scope: every local `/css/*.css` and `/js/**\/*.js` reference found
 * inside every static `*.html` file under the repo root, and inside
 * the four Worker route files that render their own `<head>`/`<script>`
 * tags server-side (backend/routes/{books,blog,free-guide,resources}.ts).
 * Deliberately covers assets that never carried a `?v=` at all before
 * this script existed (e.g. tokens.css, base.css, nav.js) — those were
 * exactly as exposed to the same GitHub Pages/Cloudflare static-asset
 * caching as components.css always was, just without anyone noticing
 * yet, since they change far less often.
 *
 * No new dependency: uses only Node's built-in `fs`, `path`, `crypto`.
 * Run via `node scripts/bump-asset-versions.mjs` before every push
 * that changes a static asset (see docs/v3.6-cache-architecture-report.md
 * for the full policy, including the optional pre-commit hook that
 * runs this automatically).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASH_LENGTH = 10;

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.wrangler', 'backend']);

/** Every static *.html file under the repo root, excluding backend/ (a separate deploy target with its own route files, handled below) and the usual noise directories. */
function findHtmlFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      findHtmlFiles(full, out);
    } else if (entry === 'index.html' || entry.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

const ROUTE_FILES = ['backend/routes/books.ts', 'backend/routes/blog.ts', 'backend/routes/free-guide.ts', 'backend/routes/resources.ts'].map((p) => join(REPO_ROOT, p));

/** Matches a quoted local /css/... or /js/... path, with an optional existing ?v=... suffix, inside the SAME quote character (so it works identically for HTML attribute values and JS string literals). */
const ASSET_REF_PATTERN = /(["'])(\/(?:css|js)\/[^"'?]+\.(?:css|js))(\?v=[a-zA-Z0-9]+)?\1/g;

const hashCache = new Map();

function hashFor(assetPath) {
  if (hashCache.has(assetPath)) return hashCache.get(assetPath);
  const onDisk = join(REPO_ROOT, assetPath.replace(/^\//, ''));
  if (!existsSync(onDisk)) {
    console.warn(`  (skipped — file not found on disk: ${assetPath})`);
    hashCache.set(assetPath, null);
    return null;
  }
  const content = readFileSync(onDisk);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, HASH_LENGTH);
  hashCache.set(assetPath, hash);
  return hash;
}

function processFile(filePath, { dryRun }) {
  const original = readFileSync(filePath, 'utf8');
  let changed = 0;

  const updated = original.replace(ASSET_REF_PATTERN, (match, quote, assetPath) => {
    const hash = hashFor(assetPath);
    if (hash === null) return match; // Referenced asset doesn't exist on disk — leave untouched rather than guess.
    const replacement = `${quote}${assetPath}?v=${hash}${quote}`;
    if (replacement !== match) changed++;
    return replacement;
  });

  if (changed > 0) {
    console.log(`${dryRun ? '[dry-run] would update' : 'updated'} ${changed} reference(s) in ${filePath.replace(REPO_ROOT, '.')}`);
    if (!dryRun) writeFileSync(filePath, updated, 'utf8');
  }
  return changed;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const htmlFiles = findHtmlFiles(REPO_ROOT);
  const allFiles = [...htmlFiles, ...ROUTE_FILES.filter((f) => existsSync(f))];

  let totalChanged = 0;
  for (const file of allFiles) {
    totalChanged += processFile(file, { dryRun });
  }

  console.log(`\n${dryRun ? 'Dry run complete' : 'Done'} — ${totalChanged} reference(s) across ${allFiles.length} file(s) checked, ${hashCache.size} unique asset(s) hashed.`);
  if (dryRun && totalChanged > 0) {
    console.log('Run again without --dry-run to apply.');
  }
}

main();

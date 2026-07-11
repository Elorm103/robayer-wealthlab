/**
 * Ambient module declaration for the `.html` text-module imports in
 * services/emailService.ts. Wrangler's `[[rules]] type = "Text"`
 * (../wrangler.toml) bundles each imported `*.html` file as a plain
 * string at build time — this declaration only tells TypeScript what
 * type to expect, since `tsc`/editors don't know about Wrangler's
 * bundler-level rule on their own.
 */
declare module '*.html' {
  const content: string;
  export default content;
}

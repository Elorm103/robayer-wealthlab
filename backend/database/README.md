# database/

## Purpose

The Cloudflare D1 (SQLite-compatible) schema for this backend — the
single source of truth for every table's structure, once a real D1
database is created and this schema is applied to it.

## Contents

- [`schema.sql`](schema.sql) — the complete, concrete `CREATE TABLE`
  design for all 12 tables (Products, Orders, Customers, Downloads,
  Newsletter Subscribers, Consultation Requests, Admin Users, Payment
  Transactions, Download Tokens, Audit Logs, Email Log, and Contact
  Messages — the last added in Version 1.2 Sprint 3). Applied for the
  first time in Sprint 3, Phase 3 — see "Today" below.
- [`migrations/0001_initial.sql`](migrations/0001_initial.sql) — a
  historical copy of `schema.sql` as of the moment it was first applied
  to a real D1 database, per the "Migrations" section below.
- See `docs/database-design.md` for the full field-by-field rationale
  behind every table: why each primary key was chosen, what each
  foreign key relationship means, which indexes exist and why, which
  constraints are enforced at the database level versus the
  application level, and the soft-delete strategy per table.

## Migrations

*(Updated in Version 1.2 Sprint 3, Phase 3 — this section previously
said "future.")* `schema.sql` has now been applied to a real production
D1 database (`robayer-wealthlab-db`) for the first time, so this
project's own stated rule now applies: **from here on, changes are
additive migration files** (`0002_add_x.sql`, `0003_add_y.sql`, …)
under [`migrations/`](migrations/), never hand-edits to `schema.sql`
in place — the same "never rewrite history, only extend it" discipline
already applied to `CHANGELOG.md`.

`wrangler.jsonc`'s D1 binding sets `"migrations_dir": "database/migrations"`
so `wrangler d1 migrations create/list/apply` know where to look.
`0001_initial.sql` is recorded as already-applied in the `d1_migrations`
bookkeeping table (in both the local and production databases) —
**it should never be run via `wrangler d1 migrations apply`**, since
its `CREATE TABLE` statements would fail against tables that already
exist. It exists purely as the historical record of what
`schema.sql` looked like at the moment of first application.

## Today

*(Updated in Version 1.2 Sprint 3, Phase 3.)* `schema.sql` is live: a
real D1 database (`robayer-wealthlab-db`, see
`docs/cloudflare-resources.md`) has it fully applied — 12 tables, 19
indexes, and `CHECK` constraints all verified directly against
production (not just reviewed as text). The Worker itself has not been
deployed, so nothing outside `wrangler d1 execute`/`wrangler dev` has
touched this database yet.

*(Updated — Version 2.0 Phase 0.1, Authentication Foundation.)*
[`migrations/0006_admin_auth_foundation.sql`](migrations/0006_admin_auth_foundation.sql)
adds `admin_users.name`/`admin_users.totp_secret` (additive `ALTER
TABLE`) and a new `admin_sessions` table — see
`docs/v2-authentication-design.md` and `docs/v2-database-expansion.md`.
Verified against local D1 (`wrangler d1 execute --local`), not yet
applied to production. Scoped deliberately narrow: the other new
tables `docs/v2-database-expansion.md` describes (`blog_posts`,
`resources`, `media_assets`, etc.) belong to later phases that build
the modules which actually use them, not to this migration.

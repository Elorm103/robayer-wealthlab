# types/

## Purpose

Shared TypeScript type definitions — the one part of this backend that
is genuinely written in full now, not just documented, because a type
has no runtime behavior. Declaring `interface Order { … }` doesn't
create an order, call a database, or expose an endpoint; it's a
machine-checked form of documentation. Writing these now gives every
future route/service a single, agreed-upon shape to code against
instead of each one improvising its own.

## Contents

- [`api-contracts.ts`](api-contracts.ts) — the standardized success/failure
  response envelope every endpoint will use (Phase 7 — see
  `docs/worker-api-design.md` for how each endpoint's specific `data`
  shape fits inside this envelope).
- [`entities.ts`](entities.ts) — TypeScript interfaces mirroring
  `database/schema.sql` table-for-table, so a future route/service
  gets compile-time checking that it's reading/writing the fields that
  actually exist in D1.

## Today

Both files are written and complete for this sprint's known scope.
Neither is imported by any running code — no Worker exists yet to
import them into.

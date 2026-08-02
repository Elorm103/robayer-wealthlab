# Version 5 Readiness Report

**Planning only. No code. No implementation.** Prepared as instructed, ahead of any Version 5 work beginning, based on what this session directly observed about the platform's current state — not speculation about what might be true.

---

## Current platform strengths

- **A real, working commerce pipeline**, proven end-to-end: checkout → Paystack verification → order artifacts → entitlement-gated download, with coupons and race-condition-safe redemption already handled correctly (`couponRaceConditions.test.ts` passes).
- **A genuinely classification-honest data model.** Every customer-facing table now carries an evidence-based PRODUCTION/INTERNAL/DEVELOPMENT/UNKNOWN tag, and the Executive Dashboard, Archive Centre, and Launch Baseline all read from the same classification rather than three different ad-hoc definitions of "real data."
- **An audit trail that's actually wired up**, not just a table that exists unused — every classification change and analytics-mode change writes through one shared function, which means new mutations added in Version 5 have an existing, proven pattern to reuse rather than a decision to make from scratch.
- **A CMS and email lifecycle that already work**, covering the full customer journey (welcome → delivery → receipt → follow-up → review reminder) without gaps.
- **Discipline against premature infrastructure**: no caching layer, no pre-aggregation table, no speculative abstraction has been added anywhere in the codebase without a current row-count reason. This is a real asset — it means Version 5 inherits a codebase that hasn't accumulated complexity nobody needed yet.

---

## Current platform limitations

- **Zero production customers and zero production revenue.** Every technical system works; the platform has not yet made its first arms-length sale. This is the single most important fact for planning Version 5 priorities.
- **A single active product** (`starting-to-invest-with-gh100`) and one resource, with a second product (`momo-savings-playbook`) still `coming-soon`. The platform is built for a catalog, but the catalog itself is thin.
- **No production newsletter subscribers, no production reviews.** The growth/engagement loop (subscribe → nurture → convert → review → repeat) has never been exercised by a real customer.
- **21 pre-existing, unrelated test failures** in the checkout/webhook/coupon suite need a root-cause fix before they can be trusted as a safety net for Version 5 changes to that area.
- **Local development D1 is stale** relative to the production schema — anyone doing local `wrangler dev` work hits missing-column errors until this is refreshed.
- **The Archive Centre's relation map is narrow by design** — fine for today's actual UNKNOWN records, but will need deliberate expansion if Version 5 introduces new entity types with their own ambiguous-data problems.

---

## Technical debt remaining

- The 21 failing tests (root cause not yet diagnosed — flagged as a separate task, still open).
- Local dev environment schema drift (no fix attempted this session; noted, not resolved).
- `getEmailLifecycleSummary`, `getSalesCharts`'s coupon-usage/channel breakdowns, and a few other narrower dashboard slices were retrofitted for classification-awareness on a "as far as it meaningfully applies" basis — worth a dedicated audit before Version 5 adds new dashboard surfaces, to confirm the pattern was applied consistently everywhere it should be.
- No formal `production_launch_baselines` snapshot has been captured yet — the table and workflow exist and are proven immutable, but the first real entry is still pending a founder action.

---

## Recommended priorities for Version 5

In rough order, based on what would most reduce risk or unlock the most value given the platform's actual current state (zero production revenue, working infrastructure):

1. **Get the first real, arms-length sale.** Every other recommendation here is secondary to this. The platform's technical readiness is not the bottleneck; go-to-market is.
2. **Fix the 21 pre-existing test failures** before building anything new on top of checkout/webhook/coupon logic — right now that whole area's regression safety net is compromised.
3. **Refresh local dev D1** so future work (Version 5 or otherwise) isn't slowed down by schema-drift debugging that has nothing to do with the actual feature being built.
4. **Capture the first official Launch Baseline** once real customer activity exists, so Version 5's growth reporting has a true "before" to compare against.
5. Only after the above: catalog expansion (bringing `momo-savings-playbook` to `active`), engagement-loop activation (newsletter, reviews), and any new dashboard/reporting surfaces.

---

## Recommended engineering principles for Version 5

Carried forward from what has clearly worked well across Version 4, worth stating explicitly so they survive a change in who's doing the work:

- **No placeholder metrics.** If a number can't be honestly computed from real data, it doesn't ship — it's omitted, with a comment explaining why, not faked.
- **No speculative infrastructure.** Don't add caching, pre-aggregation, or abstraction layers ahead of a current, real need for them.
- **One audit mechanism, reused, never duplicated.** Any new mutation that needs an audit trail uses the existing `auditService.record()` — never a parallel logging path.
- **Evidence-based classification, never guessed.** If Version 5 introduces new customer-facing tables, they should get `data_classification` from day one, defaulting to `UNKNOWN`, resolved only with real evidence.
- **Additive migrations over restructuring**, matching this codebase's consistent pattern (bundles, classification, analytics mode were all added as new columns/tables, never a rewrite of an existing one).
- **Verify against the live schema, not just the migration files.** This session's own verification pass caught a real bug precisely because it checked `sqlite_master` directly rather than trusting what the migration history implied — that discipline is worth keeping.

---

## Risks to avoid

- **Building more catalog/dashboard features before the first real sale.** The technical platform is not the constraint right now; adding more of it doesn't address the actual gap.
- **Treating the 21 failing tests as acceptable background noise indefinitely.** Every additional milestone that ships without fixing them makes the eventual root-cause diagnosis harder (more surface area to rule out).
- **Letting local dev schema drift get worse.** Each new migration that isn't reflected locally makes the next person's first hour of work a debugging exercise unrelated to their actual task.
- **Expanding the classification model's scope without the same evidence discipline this session used.** The four-tier model's value depends entirely on nothing ever being guessed into PRODUCTION/INTERNAL/DEVELOPMENT — that discipline has to be maintained by whoever extends it next, not just by the process that built it.

---

## Opportunities for growth

- The Archive Centre and Launch Baseline infrastructure built this release are reusable, general-purpose tools — not one-off reports. Any future data-quality question ("which records are ambiguous, and why") now has a real interface, not a one-time SQL script.
- The per-admin Analytics Mode architecture scales cleanly as more administrators join, per the founder's own stated reasoning for choosing it over a global setting — Version 5 can add more admins without redesigning this.
- The email lifecycle infrastructure already exists end-to-end; once real subscribers/customers exist, the growth loop (welcome → nurture → convert → review → repeat) is ready to activate without new engineering, only new content and traffic.

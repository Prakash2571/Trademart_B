# Storefront automation — price sync and visibility

Trademart decides two things about your Shopify storefront:

- **Price** — repriced to hit a target margin over your real supplier cost.
- **Visibility** — hidden when out of stock or (optionally) when it would sell below your margin floor.

Both are **off until you opt in**, both have a **preview that writes nothing**, and every change is **recorded with the reason that caused it**.

> ⚠️ This is the only part of Trademart that writes to your store. Read [Safety](#safety) before setting `AUTOMATION_ENABLED=true`.

---

## Where the cost comes from

The whole feature hangs on one Shopify field: **`inventoryItem.unitCost`** — the "Cost per item" box on a variant.

That choice is deliberate. Tradelle publishes no production API (see `src/suppliers/tradelle/tradelle.provider.ts`), so there is no cost endpoint to call. But Tradelle — and DSers, Zendrop, CJ Dropshipping, AutoDS, and manual CSV imports — all write cost into that same Shopify field when they import a product.

So Trademart reads **one place** and works with **any** of them:

```
Dropshipping app  ──writes──▶  Shopify "Cost per item"  ──reads──▶  Trademart
   (any vendor)                (inventoryItem.unitCost)             pricing engine
```

No per-supplier integration, no supplier API keys, nothing to maintain per vendor. If a product's cost is blank, Trademart **skips it** rather than guessing.

Requires the **`read_inventory`** scope. Without it Shopify withholds `unitCost` entirely, and automation refuses to run rather than concluding "no product has a cost" — see [Preconditions](#preconditions).

---

## Quick start

```bash
# 1. What is configured?
curl http://localhost:4000/api/automation/status

# 2. What WOULD change? Writes nothing, works even with the kill switch off.
curl -X POST http://localhost:4000/api/automation/preview \
  -H 'Content-Type: application/json' \
  -d '{"rules":{"price":{"enabled":true,"targetMarginPercentage":35}}}'

# 3. Read the output. Then, only if it looks right:
#    set AUTOMATION_ENABLED=true, restart, and:
curl -X POST http://localhost:4000/api/automation/apply \
  -H 'Content-Type: application/json' \
  -d '{"rules":{"price":{"enabled":true,"targetMarginPercentage":35}}}'

# 4. What did it do?
curl http://localhost:4000/api/automation/runs
```

Scope a run to part of the catalogue with Shopify search syntax:

```json
{ "query": "vendor:Tradelle", "maxProducts": 25 }
```

---

## Routes

| Route | Writes? | Purpose |
| --- | --- | --- |
| `GET /api/automation/status` | no | Kill switch, default rules, cost source, readiness |
| `POST /api/automation/preview` | **never** | Full plan with reasons. `dryRun` is hardcoded true. |
| `POST /api/automation/apply` | yes | Executes the plan. Requires `AUTOMATION_ENABLED=true`. |
| `GET /api/automation/runs` | no | Audit history, newest first (`?limit=1..50`) |

`preview` and `apply` run **identical decision code** — the only difference is whether the resulting plan is executed. A preview you can't trust would be worse than no preview.

---

## The rules

Send overrides in the request body; anything omitted keeps its default.

### Price rules

| Rule | Default | What it does |
| --- | --- | --- |
| `enabled` | **`false`** | Price writing is opt-in |
| `targetMarginPercentage` | `30` | Margin to aim for |
| `minMarginPercentage` | `10` | **Hard floor.** Never breached, even by rounding or clamping |
| `paymentFeePercentage` | `2.9` | Processor fee, as % of price |
| `shopifyFeePercentage` | `0` | Platform fee, as % of price |
| `advertisingCost` / `otherCosts` | `0` | Flat per-order costs |
| `rounding` | `charm99` | `none` \| `charm99` \| `integer` |
| `maxIncreasePercentage` | `20` | Max rise in one run |
| `maxDecreasePercentage` | `20` | Max fall in one run |
| `minChangeAmount` | `0.05` | Ignore drift smaller than this |
| `requireKnownCost` | `true` | Never price from an unknown cost |

### Visibility rules

| Rule | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Visibility automation is on (low risk, reversible) |
| `hideOutOfStock` | `true` | Tracked quantity ≤ 0 → set to `DRAFT` |
| `restoreWhenBackInStock` | `true` | Back in stock → `ACTIVE`, but only if automation hid it |
| `hideBelowMinMargin` | `false` | Hide listings selling under the floor |
| `hideUnknownCost` | **`false`** | Off deliberately — on a store with no cost data this would hide your entire catalogue on run one |

### Global

| Rule | Default | What it does |
| --- | --- | --- |
| `exemptTags` | `trademart:manual`, `trademart:no-automation` | Tagged products are never touched |
| `maxItemsPerRun` | `50` | Hard cap; the plan reports `truncated: true` if hit |

---

## How a price is decided

Guardrails apply in this order:

1. **Unknown cost → skip.** Nothing is priced from a guess.
2. Compute the price that achieves `targetMarginPercentage`, using the *same* `calculateSuggestedPrice()` as `/api/pricing/suggest-price`, so automation and the manual endpoint can never disagree.
3. **Round** per `rounding`. `charm99` rounds *down* (12.40 → 11.99) — rounding up would silently push every price above target.
4. **Margin floor.** If rounding dropped it under `minMarginPercentage`, step back up until it clears.
5. **Clamp** to `maxIncreasePercentage` / `maxDecreasePercentage`.
6. If the clamp pushed it under the floor → **skip entirely** rather than sell at a loss. The output tells you to raise the cap or lower the target.
7. Ignore changes smaller than `minChangeAmount`.

A zero `unitCost` is treated as **unknown, not free** — Shopify returns `0` both for "genuinely free" and "never filled in", and pricing something as free is exactly the invented-data failure this codebase forbids.

Cost in a different currency from the price is **skipped**: no exchange rate is available and guessing one would be wrong.

## How visibility is decided

Automation drives product **`status`** (`ACTIVE` / `DRAFT`) only.

It does *not* touch sales-channel publications. Publications need publication IDs and can silently strip a product from channels a merchant curated by hand; `status` is one field, store-wide, and trivially reversible. That's a deliberate limit, not an oversight.

Three rules it will not break:

- **`ARCHIVED` is never touched.** Archiving is a deliberate "retired" signal.
- **A product a human drafted is never un-hidden.** Automation tags what it hides with `trademart:auto-hidden` and only restores products carrying that tag. Your unfinished listings stay unfinished.
- **Unknown stock is not "out of stock".** If `read_inventory` is missing or nothing is tracked, quantity resolves to `null` and the product is left alone. Untracked variants count as always available, matching Shopify.

Repricing is skipped for any product being hidden in the same run — wasted work and a confusing audit trail.

---

## Safety

**The kill switch.** `AUTOMATION_ENABLED` defaults to `false`. Deploying this cannot change a price. `preview` ignores the switch, so you can always inspect safely.

**Preview first.** Always. The plan lists every action with `from`, `to`, projected margin, and the reasons.

**The escape hatch.** Tag a product `trademart:manual` and automation ignores it permanently. This is the first thing to reach for if a run misbehaves.

**Bounded blast radius.** `maxIncreasePercentage`/`maxDecreasePercentage` bound per-run movement, and `maxItemsPerRun` (default 50) caps how many things one run can touch — so a bad cost feed can't rewrite a catalogue.

**Reversible.** Every applied action stores its previous value in `automation_runs`, so `GET /api/automation/runs` tells you exactly what to put back.

**Failure isolation.** One failing product never aborts the run. Each action gets `applied` / `failed` with its own error.

### Preconditions

`apply` refuses, with a specific code, when:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `AUTOMATION_DISABLED` | 403 | `AUTOMATION_ENABLED` is not `true`. Nothing is broken — writes are off on purpose. |
| `AUTOMATION_RULES_INVALID` | 400 | Bad rule set (e.g. floor above target). `details.problems` lists all of them. |
| `AUTOMATION_PRECONDITION_FAILED` | 409 | Shopify withheld `unitCost` (no `read_inventory`), so every product would look cost-less. Refuses rather than silently doing nothing. |
| `SHOPIFY_SCOPE_MISSING` | 403 | No `write_products`. |

That third one matters: without it, a missing scope would look like "your catalogue has no costs" and automation would skip everything while reporting success.

---

## Audit trail

Every run — including previews — is written to `automation_runs` with the rule set snapshotted, so a past decision stays explainable after you change your rules.

```bash
curl "http://localhost:4000/api/automation/runs?limit=5"
```

Each action records `type`, `fromValue`, `toValue`, `reasons[]`, `status`, `error`.

Requires MongoDB. If Mongo is unavailable, automation still runs but logs a warning that the write was unaudited — an unaudited storefront change is a real problem, so it is never silent.

---

## Scopes

| Scope | Needed for |
| --- | --- |
| `read_products` | Reading the catalogue |
| `read_inventory` | **Cost per item** and stock levels — without it there is no cost and no automation |
| `write_products` | Applying price and status changes |

Add them, `shopify app deploy`, then update the install on the store.

---

## Tests

45 tests cover the decision engines, with no network:

```bash
npm test
```

`src/automation/automation.rules.test.ts` guards specifically: unknown cost is never priced, the margin floor survives rounding *and* clamping, charm rounding goes down, exempt tags win, `ARCHIVED` and human-drafted products are untouched, unknown stock is not zero, and `maxItemsPerRun` truncates.

The decision logic is pure (`rules.types.ts`, `price.rules.ts`, `visibility.rules.ts`, `plan.ts`) — no Shopify, no database, no clock. `automation.service.ts` holds all the side effects.

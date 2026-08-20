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

### Cost-source hierarchy

Shopify's cost per item is not the *only* possible source, and which one was
used is recorded on every priced action. Costs resolve in this order (most to
least authoritative):

| # | Source | Where it comes from |
| --- | --- | --- |
| 1 | `SUPPLIER_API` | a documented supplier API (none today — Tradelle has none) |
| 2 | `SHOPIFY_UNIT_COST` | Shopify's "cost per item", written by the dropshipping app |
| 3 | `MANUAL` | a cost you entered in Trademart |
| 4 | `UNKNOWN` | nothing available — the product is **not** priced |

A non-positive amount at any level is treated as **UNKNOWN, never as free**. The
source appears in every price action's `costSource` and in its reasons, so a run
is auditable down to "where did this number come from".

### Manual costs

When a product has no Shopify cost per item (and no supplier API), attach one
yourself so it can still be priced:

```bash
# Set a manual cost for a whole product (all variants) or one variant
curl -X PUT https://your-host/api/costs \
  -H 'Content-Type: application/json' \
  -d '{"shopifyProductId":"123","supplierProductCost":9.50,"supplierShippingCost":2,"currencyCode":"GBP","provider":"TRADELLE","note":"from supplier invoice"}'

curl "https://your-host/api/costs?productId=123"        # list
curl -X DELETE "https://your-host/api/costs?productId=123&variantId=456"
```

- A **variant-level** manual cost wins over a **product-level** one for that variant.
- By default a manual cost is a *fallback* below Shopify's cost per item. Send
  `"override": true` to make it win over a wrong Shopify value (it still never
  beats a live supplier API).
- Manual costs are stored in MongoDB, so this needs `MONGODB_URI`. With automation
  in `read_inventory`-less mode, stored manual costs are what let a run proceed
  instead of failing the precondition check.
- `PUT`/`DELETE` require an authenticated operator; `GET` follows
  `OPERATOR_PROTECT_READS`.

---

## The workflow this replaces

Trademart cannot pull a catalogue *from* Tradelle — Tradelle publishes no API, and its own Shopify app does the importing. Everything after the import is what gets automated:

```
Tradelle / DSers / Zendrop app          Trademart
        │                                  │
        ├── imports product + cost ──▶ Shopify
        │                                  │
        │                        ┌─────────┴──────────┐
        │                        │ 1. hold for review │  nothing appears unreviewed
        │                        │ 2. apply markup    │  cost x 2.5, or + £10, or a margin
        │                        │ 3. you approve     │  POST /automation/approve
        │                        │ 4. keep in sync    │  cost moves → price follows
        │                        └────────────────────┘
```

Steps 1, 2 and 4 need no manual action once configured.

## Quick start

```bash
# 1. Save your rules ONCE. Webhook-triggered runs use these.
curl -X PUT http://localhost:4000/api/automation/rules \
  -H 'Content-Type: application/json' \
  -d '{"rules":{
        "price":{"enabled":true,"pricingMode":"multiplier","multiplier":2.5},
        "selection":{"mode":"vendor","includeVendors":["Tradelle"]}
      }}'

# 2. What WOULD change? Writes nothing, works even with the kill switch off.
curl -X POST http://localhost:4000/api/automation/preview

# 3. Read the output. Then, only if it looks right:
#    set AUTOMATION_ENABLED=true, restart, and:
curl -X POST http://localhost:4000/api/automation/apply

# 4. What did it do?
curl http://localhost:4000/api/automation/runs
```

For fully hands-off syncing, also set `AUTOMATION_ON_WEBHOOK=true` and register subscriptions (`POST /api/webhooks/register`).

---

## Saved rules vs per-request rules

| Source | Precedence | Used by |
| --- | --- | --- |
| `DEFAULT_AUTOMATION_RULES` | lowest | everything |
| Saved (`PUT /api/automation/rules`) | middle | **webhook-triggered runs**, and as the base for manual runs |
| Request body `rules` | highest | that one request only |

**Saving matters.** A webhook has no request body, so an automatic run reads the saved rules. If you never save any, automatic runs fall back to defaults where `price.enabled` is `false` — they would tidy visibility but never reprice. `GET /api/automation/rules` shows both what is stored and the effective set.

Saving requires MongoDB. Without it, pass rules per request instead.

---

## Pricing modes

Three ways to express "additional price". All three then pass through the *same* guardrails — rounding, the margin floor, and the per-run clamps.

| Mode | Formula | Use when |
| --- | --- | --- |
| `margin` | solves for `targetMarginPercentage`, fees included | you think in margins |
| `multiplier` | `cost × multiplier` | the classic dropshipping "2.5x rule" |
| `fixed_uplift` | `cost + fixedUplift` | a flat amount on every item |

```json
{ "rules": { "price": { "enabled": true, "pricingMode": "multiplier", "multiplier": 2.5 } } }
{ "rules": { "price": { "enabled": true, "pricingMode": "fixed_uplift", "fixedUplift": 12 } } }
```

**A markup is not a margin.** "2.5x" sounds like a 60% margin but isn't once payment fees and ad costs are counted, so `minMarginPercentage` still does real work in markup modes — it will raise a price that a thin multiplier left under the floor. A `multiplier` below 1 is rejected at validation time rather than quietly pricing under cost.

---

## Choosing which products to automate

`selection` is the "only my desired products" control.

| Mode | Behaviour |
| --- | --- |
| `all` (default) | The whole catalogue |
| `vendor` | Only listed vendors, e.g. `["Tradelle"]` |
| `tagged` | Only products carrying a listed tag |

```json
{ "rules": { "selection": { "mode": "vendor", "includeVendors": ["Tradelle"] } } }
```

Products **outside** the selection are left completely untouched — not hidden, not repriced. Narrowing the selection can therefore never damage the rest of your catalogue, which is what makes it safe to start narrow and widen later. Your own-brand products stay entirely under your control while dropshipped ones are automated.

A filtering mode with an empty include list is rejected, because it would select nothing and every run would silently do nothing while looking healthy.

---

## The review gate for new imports

`selection.newProductPolicy` decides what happens to a product Trademart has never seen:

| Policy | Behaviour |
| --- | --- |
| `draft` (default) | Force `DRAFT` + tag `trademart:needs-review`. Nothing reaches the storefront unreviewed. |
| `leave` | Whatever status the importing app set stands |
| `activate` | Publish immediately |

A dropshipping app can import hundreds of products at once. The default stops them appearing in your shop at whatever price the importer chose.

Held products are **still priced**, so they arrive in your review queue already correct. Then:

```bash
curl -X POST http://localhost:4000/api/automation/approve \
  -H 'Content-Type: application/json' -d '{"productId":"123456789"}'
```

That clears the review tag and publishes. If you activate a held product yourself in the Shopify admin, automation treats the leftover tag as stale and does not fight you.

---

## Hands-off syncing (webhook triggers)

With `AUTOMATION_ON_WEBHOOK=true`, these topics trigger a run for just the affected product:

| Topic | Why |
| --- | --- |
| `products/create` | New import → review gate + initial price |
| `products/update` | Cost per item may have moved |
| `inventory_levels/update` | Stock changed → hide or restore |

`inventory_levels/update` names an inventory *item*, not a product, so Trademart resolves it to its product first.

Automation runs **after** the webhook is acknowledged. Shopify wants a 2xx within seconds, and a lookup plus a write can exceed that — a timeout would make Shopify retry an event already processed. A failed run is logged and never turns into a retry.

### Why this doesn't loop forever

Automation writes a price → Shopify emits `products/update` → that triggers automation → which writes a price → …

Shopify doesn't tell a webhook which app caused a change, so the loop can't be broken by inspecting the delivery. Two things break it:

1. **The fixed point (the real defence).** Automation only writes when the current price differs from the target by at least `minChangeAmount`. After its own write the product *is* at the target, so the echoed run computes the same number, finds nothing to do, and stops. The loop terminates after exactly one extra no-op run. This is asserted directly in `automation.triggers.test.ts`, including under charm rounding, where oscillation would otherwise hide.
2. **A 60-second per-product cooldown.** Even a terminating loop wastes API calls, and a pathological rule set could thrash. The cooldown bounds the damage regardless. It is in-memory on purpose: it is an optimisation, not the correctness mechanism, so it must not make automation depend on Mongo.

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
| `GET /api/automation/rules` | no | Saved rules + the effective set a run would use |
| `PUT /api/automation/rules` | no* | Save rules. *Required* for webhook-triggered runs. |
| `POST /api/automation/approve` | yes | Publish a held product: `{ "productId": "…" }` |
| `GET /api/automation/runs` | no | Audit history, newest first (`?limit=1..50`) |

\* writes to MongoDB, not to Shopify.

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
| `pricingMode` | `margin` | `margin` \| `multiplier` \| `fixed_uplift` |
| `multiplier` | `2.5` | Used by `multiplier` mode |
| `fixedUplift` | `10` | Used by `fixed_uplift` mode |
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

### Selection

| Rule | Default | What it does |
| --- | --- | --- |
| `selection.mode` | `all` | `all` \| `tagged` \| `vendor` |
| `selection.includeTags` | `[]` | Used by `tagged` mode |
| `selection.includeVendors` | `[]` | Used by `vendor` mode |
| `selection.newProductPolicy` | `draft` | `leave` \| `draft` \| `activate` |

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
| `DATABASE_UNAVAILABLE` | 503 | Saving rules or reading history needs MongoDB. |

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

82 tests cover the decision engines, with no network:

```bash
npm test
```

`automation.rules.test.ts` guards: unknown cost is never priced, the margin floor survives rounding *and* clamping (in markup modes too), charm rounding goes down, exempt tags win, `ARCHIVED` and human-drafted products are untouched, unknown stock is not zero, unselected products are left alone entirely, held products are priced but not published, and `maxItemsPerRun` truncates.

`automation.triggers.test.ts` guards the trigger mapping and, most importantly, the **fixed point** — feeding automation's own output back in must produce no further change.

The decision logic is pure (`rules.types.ts`, `price.rules.ts`, `visibility.rules.ts`, `plan.ts`) — no Shopify, no database, no clock. `automation.service.ts` holds all the side effects.

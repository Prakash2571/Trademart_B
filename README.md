# Trademart Backend

Node.js + TypeScript API that connects Trademart to a Shopify store through the
**GraphQL Admin API**, plus a standalone pricing/margin engine.

This is a development MVP. It proves Trademart can read and analyse Shopify data
safely. It is not a production multi-tenant SaaS.

---

## Requirements

| Requirement | Version / notes |
| --- | --- |
| Node.js | **20 or newer** (22 LTS recommended). Uses the built-in `fetch` and `node:test`. |
| npm | Ships with Node. The repo uses npm — don't switch package managers. |
| MongoDB | Any reachable instance (local or Atlas). **Optional** for this test version. |
| Shopify | A store plus the released **Trademart** app and an Admin API access token. |

### Stack

- **Express 4** + TypeScript (`tsx` for development)
- **Mongoose 8** / MongoDB
- **Shopify GraphQL Admin API** (`2026-07`) — the REST Admin API is legacy and is not used
- `helmet`, `cors`, `express-rate-limit` for baseline hardening
- Tests use Node's built-in test runner — **no test framework dependency**

---

## Install

```bash
npm install
cp .env.example .env
```

Then fill in `.env` (see below).

---

## Environment variables

All secrets live here and **never** leave the server. Never commit `.env`.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `4000` | |
| `FRONTEND_URL` | no | `http://localhost:3000` | The **only** allowed CORS origin. Next.js dev runs on 3000. |
| `APP_URL` | no | — | This backend's own **public** origin, as Shopify sees it. Enables the OAuth redirect flow and webhook registration. Must be `https` in production. |
| `MONGODB_URI` | no in dev | — | Blank = run without persistence. Required when `NODE_ENV=production`. |
| `SHOPIFY_STORE_DOMAIN` | **yes** | — | Must be the `.myshopify.com` domain. |
| `SHOPIFY_API_VERSION` | no | `2026-07` | Format `YYYY-MM`. |
| `SHOPIFY_CLIENT_ID` | no in dev, **yes in prod** | — | From the Dev Dashboard. Half a pair is a startup error. |
| `SHOPIFY_CLIENT_SECRET` | no in dev, **yes in prod** | — | Paired with the client id. Also signs/verifies the OAuth HMAC. |
| `SHOPIFY_ACCESS_TOKEN` | no | — | **Optional override.** Disables automatic refresh — see below. |
| `SHOPIFY_WEBHOOK_SECRET` | no | falls back to `SHOPIFY_CLIENT_SECRET` | Leave blank normally — Shopify signs app webhooks with the client secret. Set it only for webhooks created by hand in the Shopify admin. |
| `SHOPIFY_SCOPES` | no | `read_products,read_orders,read_customers,read_inventory` | Scopes requested by the OAuth flow. Ignored under managed installation. |
| `SHOPIFY_AUTH_MODE` | no | `auto` | `auto` = client credentials grant. `oauth` = use the stored per-merchant offline token. |
| `TOKEN_ENCRYPTION_KEY` | only for `oauth` | — | 32 bytes (hex or base64) encrypting offline tokens at rest. `openssl rand -base64 32`. |
| `AUTOMATION_ENABLED` | no | `false` | **Kill switch for storefront writes.** `true` lets Trademart change live prices and product visibility. Must be exactly `true`/`false`. |
| `AUTOMATION_ON_WEBHOOK` | no | `false` | Let Shopify webhooks trigger automation runs, so cost/stock changes sync with no manual step. Needs `AUTOMATION_ENABLED=true` too. |
| `OPERATOR_USERNAME` | no | `operator` | Console login username. No colon. |
| `OPERATOR_PASSWORD_HASH` | for the console | — | scrypt hash from `npm run operator:hash`. Never the plaintext. |
| `SESSION_SECRET` | with password | — | HMAC key signing session cookies. ≥ 32 chars. Rotating it logs everyone out. |
| `OPERATOR_API_KEY` | for scripts | — | Bearer key for non-browser clients. ≥ 24 chars. CSRF-exempt. |
| `SESSION_TTL_HOURS` | no | `12` | Session lifetime (1–720). |
| `OPERATOR_PROTECT_READS` | no | `false` | `true` requires login for reads too, not just writes. |

`APP_URL` is **not** `FRONTEND_URL`: the first is this API as Shopify reaches it,
the second is the browser app allowed through CORS. Shopify cannot reach
`localhost`, so a tunnel URL is required for local OAuth/webhook testing — the
server logs a warning if `APP_URL` points at localhost.

Config is validated at boot. Structural mistakes (bad port, an
`admin.shopify.com` URL, a malformed API version) **abort startup** with a
readable list. Missing optional credentials only log warnings so the server still
starts and can report its own degraded state.

### The store domain must be the `.myshopify.com` one

```env
# correct
SHOPIFY_STORE_DOMAIN=teststoremart-uk8mmby.myshopify.com

# rejected at startup
SHOPIFY_STORE_DOMAIN=admin.shopify.com/store/teststoremart-uk8mmby
```

---

## Run the development server

```bash
npm run dev          # tsx watch, reloads on change
```

Other scripts:

```bash
npm run build        # compile to dist/
npm start            # run the compiled build
npm run typecheck    # tsc --noEmit
npm test             # compile + run unit tests
npm run shopify:ping # manual integration test against the real store
```

### Minimum config to be useful

Only three values, and nothing to paste by hand beyond the app credentials:

```env
SHOPIFY_STORE_DOMAIN=teststoremart-uk8mmby.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
```

`SHOPIFY_STORE_DOMAIN` is the only variable that will stop the server booting if
absent, and it is pre-filled in `.env.example`. Everything else defaults or
degrades with a warning.

Verify it is alive:

```bash
curl http://localhost:4000/api/health
```

```json
{ "status": "ok" }
```

(The real response includes extra `checks` diagnostics; `status` stays at the top
level.)

---

## Database

This test version uses **MongoDB via Mongoose**, so there is **no migration
step** — collections and indexes are created on first write. `npx prisma migrate
dev` does not apply here.

```env
# local
MONGODB_URI=mongodb://127.0.0.1:27017/trademart

# Atlas
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/trademart?retryWrites=true&w=majority
```

Connecting is deliberately **non-fatal**. If `MONGODB_URI` is blank or the server
is unreachable, the API still boots; Shopify reads and the pricing engine work
normally and `/api/health` reports the degraded state. Only persistence is
disabled.

Collections (`src/database/models/`):

| Model | Purpose |
| --- | --- |
| `Store` | Connected store metadata. **No token field** — tokens must be encrypted when OAuth lands. |
| `ProductSnapshot` | Only the product fields Trademart needs — not a full mirror. |
| `OrderSnapshot` | Order financials copied verbatim. Customer **GID only, no PII**. |
| `CustomerReference` | Non-identifying aggregates only. No email/phone/name/address. |
| `SupplierProduct` | Shopify product ↔ supplier link, with how the cost was obtained. |
| `CostRecord` | Manually entered cost inputs for the pricing engine. |
| `AnalyticsSnapshot` | Aggregates, always stamped with the window they cover. |
| `WebhookEvent` | Verified webhook deliveries, deduplicated by Shopify's delivery id. |

Shopify ids are stored as **strings** because they are GIDs
(`gid://shopify/Product/123`), never numbers.

---

## Shopify configuration

The **Trademart** app already exists in the Shopify Dev Dashboard — this project
does not create or modify it.

1. Open your app in the Shopify Dev Dashboard → **Settings**.
2. Copy the **Client ID** and **Client secret** into `.env`.
3. Confirm the Admin API scopes you need are enabled (see below).
4. **Install / update the app on the development store** — the client
   credentials grant only works on stores where the app is installed.
5. Restart the backend.

There is no access token to copy. See the next section for why.

### Authentication: client credentials grant

The backend authenticates itself using the app's own credentials, with no human
interaction:

```
POST https://{shop}.myshopify.com/admin/oauth/access_token
{ "client_id": "…", "client_secret": "…", "grant_type": "client_credentials" }

→ { "access_token": "shpat_…", "scope": "read_products,read_orders", "expires_in": 86399 }
```

These tokens are **short-lived** — `expires_in` is typically 86399 (~24h) but
3599 (~1h) also occurs — so the lifetime is always read from the response and
never assumed. The backend:

- caches the token in memory and reuses it across requests
- refreshes it automatically ~5 minutes before expiry (capped at half the
  lifetime, so very short-lived tokens can't cause a refresh loop)
- **coalesces concurrent requests** into a single token request, so a burst of
  traffic never triggers a stampede of token calls
- **suppresses repeat requests for 30s after a terminal auth failure** (bad
  secret, app not installed), so a misconfigured setup makes one token request
  per 30s instead of one per operation. Transient failures (network, 5xx,
  throttling) are never suppressed, and the window self-heals — no restart
  needed once the configuration is fixed
- on a `401` from the Admin API, discards the token and re-authenticates **once**
  before surfacing the error — covering revoked or early-rotated tokens
- never logs or returns the token value

Reference:
[client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)
·
[Dev Dashboard tokens](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens)

Inspect the live state any time — no secrets are returned:

```bash
curl http://localhost:4000/api/shopify/status | jq .data.token
```

```json
{
  "strategy": "CLIENT_CREDENTIALS",
  "cached": true,
  "expiresAt": "2026-08-13T08:12:44.000Z",
  "expiresInSeconds": 86031,
  "scopes": ["read_products", "read_orders", "read_inventory"],
  "fetchCount": 1,
  "lastFetchedAt": "2026-08-12T08:12:45.000Z",
  "lastError": null
}
```

`scopes` is a genuine bonus of this flow: Shopify reports what it actually
granted, so a missing scope is visible before any query is attempted.

### Installing the app so the grant works

The client credentials grant only issues tokens for stores where the app is
**installed**, and per Shopify's docs it is *"only available for apps developed
by your own organization and installed in stores that you own"* — so **the app
and the store must belong to the same Shopify organization**.

Trademart has no OAuth callback (by design), so a redirect-based install cannot
complete: Shopify would redirect to the app's `application_url` and get
`ERR_CONNECTION_REFUSED` if nothing is running there.

Use **Shopify-managed installation** instead — Shopify installs the app and
registers its scopes *without making any calls to your app*
([docs](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation)).
In `shopify.app.toml`:

```toml
client_id = "your-client-id"
name = "Trademart"

# Trademart is a standalone dashboard, not embedded in the Shopify admin.
# Shopify documents this placeholder for non-embedded apps.
application_url = "https://shopify.dev/apps/default-app-home"
embedded = false

# REQUIRED for managed installation - Shopify cannot install the app without
# knowing which scopes to grant. Do NOT set use_legacy_install_flow = true,
# which forces the old redirect-based flow.
[access_scopes]
scopes = "read_products,read_orders,read_customers,read_inventory"

[webhooks]
api_version = "2026-07"
```

Then push the config and install:

```bash
shopify app deploy      # registers the scopes with Shopify
```

and install the app on the store from the Dev Dashboard. No backend restart is
needed afterwards — a terminal auth failure is only suppressed for 30 seconds,
so the dashboard recovers on its own within half a minute.

Scope notes: `read_locations` may additionally be required for inventory
*location* details, and `read_reports` is only useful if you intend to try
ShopifyQL analytics (plan-dependent). Add scopes only as you need them.

### Troubleshooting authentication

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `SHOPIFY_NOT_CONFIGURED` | No credentials loaded | Set `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`, restart |
| `SHOPIFY_AUTH_FAILED` · *"Missing or invalid client secret"* | Client ID was accepted, secret rejected | Re-copy or regenerate the secret **from the same app**, restart |
| `SHOPIFY_AUTH_FAILED` · *"invalid client id"* | Client ID wrong | Re-copy the client ID |
| `SHOPIFY_APP_NOT_INSTALLED` | Credentials are correct; app not installed on the store | Managed installation above; check app and store share one organization |
| `ERR_CONNECTION_REFUSED` on `localhost:<port>` during install | Shopify tried a redirect-based install against `application_url` | Switch to managed installation (declare scopes + deploy) |
| `SHOPIFY_SCOPE_MISSING` | Authentication works; a scope is absent | Add the scope, `shopify app deploy`, update the install |

`npm run shopify:ping` prints credential **lengths** (never values), which
catches a blank, truncated or duplicated credential.

### `SHOPIFY_ACCESS_TOKEN` — optional override

Setting it makes the backend use that token verbatim and **disables automatic
refresh** (`authStrategy` becomes `STATIC_TOKEN`, and a startup warning is
logged). Leave it blank unless you specifically need it — for an admin-created
custom app that issued a long-lived `shpat_` token, or to debug against a known
token. If both it and the client credentials are set, the static token wins.

### Merchant OAuth (redirect flow)

Implemented and **opt-in**. Full guide: [docs/OAUTH_AND_WEBHOOKS.md](docs/OAUTH_AND_WEBHOOKS.md).

Everything obtains tokens through `ShopifyTokenProvider`
(`src/shopify/token/token.types.ts`), keyed by **shop domain**, which is what let
OAuth slot in without touching the client, services or controllers:

```ts
interface ShopifyTokenProvider {
  readonly strategy: 'CLIENT_CREDENTIALS' | 'STATIC_TOKEN' | 'OAUTH_OFFLINE';
  readonly canRefresh: boolean;
  getAccessToken(shopDomain: string): Promise<CachedToken>;
  invalidate(shopDomain: string): void;
  describe(shopDomain: string): TokenDiagnostics;
}
```

The redirect URL to add under **App access → Allowed redirection URL(s)** is:

```
https://<APP_URL>/api/auth/callback
```

`GET /api/auth/status` prints the exact string to paste, because Shopify compares
it character for character.

Two things are worth knowing before enabling it:

- **Completing an install does not change how requests authenticate.** That
  requires `SHOPIFY_AUTH_MODE=oauth`. The default (`auto`) keeps using the client
  credentials grant, so adding OAuth cannot silently change a working deployment.
- **Offline tokens are encrypted at rest** with AES-256-GCM
  (`TOKEN_ENCRYPTION_KEY`), and a completed install therefore needs MongoDB.
  Changing the key invalidates every stored token.

### Webhooks

Receipt was already implemented; registration now exists too.

```bash
curl -X POST "http://localhost:4000/api/webhooks/register?dryRun=1"  # preview
curl -X POST  http://localhost:4000/api/webhooks/register            # apply
curl http://localhost:4000/api/webhooks/subscriptions                # live state
```

Needs `APP_URL` (Shopify cannot reach localhost — use a tunnel),
a signing secret (defaults to `SHOPIFY_CLIENT_SECRET`), and the read scope for
each topic. Registration is
idempotent: it reconciles against Shopify rather than blindly creating, so running
it twice will not double your deliveries. Deliveries are de-duplicated by
`X-Shopify-Webhook-Id`.

See [docs/OAUTH_AND_WEBHOOKS.md](docs/OAUTH_AND_WEBHOOKS.md) for the reconciliation
rules, the two different HMAC schemes, and a troubleshooting table.

### Scopes and what breaks without them

| Scope | Enables | Without it |
| --- | --- | --- |
| `read_products` | `/shopify/products` | Products fail with `SHOPIFY_SCOPE_MISSING` |
| `read_orders` | `/shopify/orders`, analytics, revenue | Orders and all revenue figures unavailable |
| `read_inventory` | `/shopify/inventory`, `totalInventory`, `inventoryQuantity`, cost per item | Products still load; inventory/cost fields return `null` and `meta.degraded` lists them |
| `read_customers` | `/shopify/customers`, order customer, **the dashboard customer count** | `customersCount` fails with `SHOPIFY_SCOPE_MISSING`; the Customers stat shows as unavailable and the dashboard reports the issue under `shopify.counts.customers` |
| `read_reports` | ShopifyQL analytics | Traffic endpoint reports `available: false` |

There is **no** dedicated webhook scope. Each webhook *topic* needs the scope for
the data it carries — `PRODUCTS_*` needs `read_products`, `CUSTOMERS_*` needs
`read_customers`, `INVENTORY_LEVELS_UPDATE` needs `read_inventory`, and
`APP_UNINSTALLED` needs none. So registering subscriptions requires no extra
scopes beyond the reads above
([docs](https://shopify.dev/docs/apps/build/webhooks/subscribe)).
| `write_products` | `POST /api/automation/apply` | Price and visibility changes fail with `SHOPIFY_SCOPE_MISSING`; preview still works |

List reads that hit a missing scope automatically retry a **reduced query** and
report what was dropped in `meta.degraded`, rather than failing the whole page.
Missing fields come back as `null` — never as `0`.

**Counts are different.** `getCounts()` has no reduced form to fall back on — a
count either works or it doesn't — so each count is fetched in its own request
and a failure is reported as a per-section issue (`shopify.counts.customers`)
while the rest of the dashboard still renders. This is why a missing
`read_customers` shows up as a warning banner rather than a blank page.

Customer PII is additionally gated by Shopify's
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)
approval, which is separate from the scope. A custom app installed on a store
inside your own organisation has that access by default, and it is auto-granted on
development stores — so on a test store the scope alone is normally enough.

---

## How to test the Shopify connection

### Automated matrix (recommended)

```bash
npm run shopify:ping
```

This is the documented manual integration test. It runs against the real store in
`SHOPIFY_STORE_DOMAIN` and prints a pass/fail line per capability, so a missing
scope is immediately obvious:

```
Trademart -> Shopify connection test
  store        : teststoremart-uk8mmby.myshopify.com
  api version  : 2026-07
  auth strategy: CLIENT_CREDENTIALS

Results
  [PASS] access token (client credentials grant)
         CLIENT_CREDENTIALS | expires in 86399s | granted scopes: read_products, read_orders
  [PASS] shop (connection test)
         Test Store Mart | teststoremart-uk8mmby.myshopify.com | plan=… | currency=…
  [PASS] products (read_products)
         3 product(s)
  [FAIL] customers (read_customers + protected data)
         SHOPIFY_SCOPE_MISSING: The Trademart Shopify app is missing …
```

It exits non-zero only if the basic shop query fails.

### By hand

```bash
curl http://localhost:4000/api/shopify/status   # never returns the token
curl http://localhost:4000/api/shopify/shop
curl "http://localhost:4000/api/shopify/products?limit=5"
curl "http://localhost:4000/api/shopify/orders?limit=5"
```

---

## API

Envelopes are consistent:

```json
{ "success": true,  "data": {}, "meta": {} }
{ "success": false, "code": "SHOPIFY_SCOPE_MISSING", "message": "…" }
```

**Authentication:** everything that changes the store requires a signed-in
operator (session cookie or `Authorization: Bearer <OPERATOR_API_KEY>`). See
[docs/OPERATOR_AUTH.md](docs/OPERATOR_AUTH.md). Public exceptions: `/api/health`,
`/api/operator/*`, the Shopify OAuth callback, and the HMAC-verified webhook
receiver.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/health` | Liveness + database/Shopify diagnostics. Public. |
| POST | `/api/operator/login` | Start a session. Public, rate-limited. |
| POST | `/api/operator/logout` | Clear the session. |
| GET | `/api/operator/me` | Auth state. Always 200. |
| GET | `/api/operator/csrf` | Issue a CSRF token. |
| GET | `/api/shopify/status` | Config + connectivity. Always 200. Booleans only, no secrets. |
| GET | `/api/shopify/shop` | Connection test / shop info |
| GET | `/api/shopify/products` | `?limit=1..100&cursor=&query=` (Shopify search syntax) |
| GET | `/api/shopify/products/:id` | Numeric id or full GID |
| GET | `/api/shopify/themes` | List themes; marks the live (MAIN) one. Needs `read_themes`. |
| GET | `/api/shopify/themes/:id/files` | Read specific theme files (`?filenames=a,b`). Read-only. |
| GET | `/api/storefront/status` | Storefront capabilities + honest limitations |
| GET | `/api/shopify/orders` | `?limit=&cursor=&query=` |
| GET | `/api/shopify/orders/:id` | |
| GET | `/api/shopify/customers` | Only scope-permitted fields |
| GET | `/api/shopify/inventory` | Read-only |
| GET | `/api/analytics/overview` | Aggregates over real orders, window disclosed |
| GET | `/api/analytics/traffic` | Reports `available: false` — sessions are not inferred |
| GET | `/api/dashboard/summary` | One call for the dashboard; degrades per-section |
| GET | `/api/suppliers/providers` | Registered providers + real capabilities |
| POST | `/api/pricing/calculate` | Profit/margin from a selling price + costs |
| POST | `/api/pricing/suggest-price` | Selling price for a desired margin |
| POST | `/api/webhooks/shopify` | HMAC-verified receiver. De-duplicates retries by `X-Shopify-Webhook-Id`. |
| GET | `/api/webhooks/status` | Local configuration. Always answers, even if Shopify is down. |
| GET | `/api/webhooks/subscriptions` | What Shopify actually has registered |
| POST | `/api/webhooks/register` | Reconcile subscriptions. `?dryRun=1` to preview. |
| POST | `/api/webhooks/unregister` | Delete one subscription: `{ "id": "gid://shopify/WebhookSubscription/…" }` |
| GET | `/api/auth/install` | `?shop=<store>.myshopify.com` — starts the OAuth handshake (302) |
| GET | `/api/auth/callback` | The allow-listed redirect URL Shopify calls back |
| GET | `/api/auth/status` | OAuth diagnostics, including the exact `redirectUri` to allow-list |
| GET | `/api/automation/status` | Kill switch, default rules, cost source, readiness |
| POST | `/api/automation/preview` | What automation **would** change. Never writes. |
| POST | `/api/automation/apply` | Applies price/visibility changes. Needs `AUTOMATION_ENABLED=true`. |
| GET | `/api/automation/rules` | Saved rules + the effective set a run would use |
| PUT | `/api/automation/rules` | Save rules. Required for webhook-triggered runs. |
| POST | `/api/automation/approve` | Publish a held product: `{ "productId": "…" }` |
| GET | `/api/automation/runs` | Audit history of automation runs |

### Error codes

`SHOPIFY_NOT_CONFIGURED`, `SHOPIFY_AUTH_FAILED`, `SHOPIFY_APP_NOT_INSTALLED`,
`SHOPIFY_UNAUTHORIZED`, `SHOPIFY_SCOPE_MISSING`,
`SHOPIFY_THROTTLED`, `SHOPIFY_GRAPHQL_ERROR`, `SHOPIFY_USER_ERROR`,
`SHOPIFY_HTTP_ERROR`, `SHOPIFY_NETWORK_ERROR`, `SHOPIFY_NOT_FOUND`,
`VALIDATION_ERROR`, `NOT_FOUND`, `DATABASE_UNAVAILABLE`, `RATE_LIMITED`,
`INTERNAL_ERROR`, `WEBHOOK_NOT_CONFIGURED`, `WEBHOOK_INVALID_SIGNATURE`,
`WEBHOOK_REGISTRATION_FAILED`, `OAUTH_NOT_CONFIGURED`, `OAUTH_INVALID_REQUEST`,
`OAUTH_INVALID_HMAC`, `OAUTH_STATE_INVALID`, `ENCRYPTION_NOT_CONFIGURED`,
`AUTOMATION_DISABLED`, `AUTOMATION_RULES_INVALID`,
`AUTOMATION_PRECONDITION_FAILED`, `UNAUTHORIZED`, `CSRF_INVALID`,
`LOGIN_FAILED`, `OPERATOR_NOT_CONFIGURED`, `THEME_PROTECTED`.

### Rate limits

Every Shopify call goes through one client that handles HTTP failures, GraphQL
`errors`, `userErrors`, throttling and network faults. Retries use exponential
backoff with jitter and honour `Retry-After`, capped at 3 attempts.
**Permission errors are never retried.**

---

## Storefront automation (price sync + visibility)

The one part of Trademart that **writes** to your store. Full guide:
[docs/AUTOMATION.md](docs/AUTOMATION.md).

Supplier costs come from Shopify's own **"Cost per item"**
(`inventoryItem.unitCost`). That is what makes it supplier-agnostic: Tradelle,
DSers, Zendrop, CJ and AutoDS all write into that one field, so Trademart reads
one place and works with any of them — no supplier API required, which matters
because Tradelle does not publish one.

Tradelle's own app still does the importing (it has no API to pull from).
Trademart owns everything after that: which products show, your markup, and
keeping prices in sync when costs move.

```bash
# Save your rules once - webhook-triggered runs use these.
curl -X PUT http://localhost:4000/api/automation/rules \
  -H 'Content-Type: application/json' \
  -d '{"rules":{
        "price":{"enabled":true,"pricingMode":"multiplier","multiplier":2.5},
        "selection":{"mode":"vendor","includeVendors":["Tradelle"]}
      }}'

curl -X POST http://localhost:4000/api/automation/preview   # never writes
```

`preview` **never writes** and works even with the kill switch off. `apply` runs
the identical decision code and requires `AUTOMATION_ENABLED=true`.

**Three ways to set price:** a target margin, `cost × multiplier` (the 2.5x
rule), or `cost + fixed uplift`. All three pass through the same guardrails — a
markup is not a margin once fees are counted, so the floor still applies.

**Only your desired products.** `selection` limits automation to chosen vendors
or tags; anything outside is left completely untouched, so your own-brand
products stay under your control while dropshipped ones are automated.

**New imports are held for review** by default (`DRAFT` + a review tag), priced
but not published, until you `POST /api/automation/approve`. A bulk import can't
dump hundreds of unreviewed products into your shop.

**Hands-off syncing.** With `AUTOMATION_ON_WEBHOOK=true`, a cost or stock change
in Shopify triggers a run for that product automatically — no manual step. It
cannot loop: automation only writes when the price actually differs from target,
so its own echo is a no-op (asserted in tests), backed by a 60s per-product
cooldown.

Guardrails, because this changes what real customers see and pay:

- **Off by default.** `AUTOMATION_ENABLED=false`, and price rules are disabled
  even then. Deploying it cannot change a price.
- **Never prices from a guess.** No cost per item → the variant is skipped. A
  `0` cost counts as *unknown*, not free.
- **Hard margin floor**, upheld after rounding *and* after clamping. If a clamp
  would breach it, the change is skipped rather than sold at a loss.
- **Bounded movement** (±20% per run by default) and `maxItemsPerRun` (50), so a
  bad cost feed cannot rewrite a catalogue.
- **Escape hatch.** Tag a product `trademart:manual` and it is never touched.
- **Never un-hides what a human hid** — automation only restores products it
  tagged `trademart:auto-hidden` itself. `ARCHIVED` is never touched.
- **Reversible + audited.** Every applied action stores its previous value in
  `automation_runs` with the reasons that caused it.

Needs `read_inventory` (for cost) and `write_products` (to apply). If Shopify
withholds `unitCost`, automation **refuses to run** rather than reporting
"nothing to do" for a reason unrelated to your catalogue.

---

## Pricing engine

Standalone — no Shopify or database needed.

```bash
curl -X POST http://localhost:4000/api/pricing/calculate \
  -H 'Content-Type: application/json' \
  -d '{"sellingPrice":2999,"supplierProductCost":1000,"supplierShippingCost":300,"paymentFee":90,"advertisingCost":500}'
```

```
Selling price          2999
Supplier product       1000
Shipping                300
Payment fee              90
Advertising CPA         500
--------------------------------
Total cost             1890
Estimated profit       1109   (36.98% margin)
```

Any omitted cost is treated as `0` **and** listed in `missingInputs`, with
`isEstimate: true`. The engine never claims exact profit when supplier costs,
taxes, returns or ad spend are unknown.

---

## Suppliers

`SupplierProvider` (`src/suppliers/supplier.types.ts`) keeps Trademart decoupled
from any single supplier. Adding CJdropshipping, an AliExpress-compatible
provider or a direct manufacturer API means appending to the registry.

**Tradelle today:** Tradelle documents a *Shopify integration* (importing
products into Shopify, automatic Shopify-order fulfillment), not a public
production API. So `getSupplierCost` and `getShippingCost` return `null` — no
endpoints are invented and no fake costs are produced. The current bridge is:

```
Trademart -> Shopify API -> Shopify store -> Tradelle integration -> Tradelle fulfillment
```

`identifyProduct` matches only reliable Shopify signals (vendor, tags,
fulfillment service) — **never the product title**. Until Tradelle is installed
on the store, products classify as `OTHER` or `UNKNOWN`. Once it is, inspect a
real imported product and extend the markers in
`src/suppliers/tradelle/tradelle.provider.ts`.

---

## Webhooks

Receiving and registering are both implemented. Full guide:
[docs/OAUTH_AND_WEBHOOKS.md](docs/OAUTH_AND_WEBHOOKS.md).

Order of operations, never reordered: **verify HMAC over the raw body → verify
the shop domain → then parse**. The route is mounted before the JSON body parser
because the signature is computed over the exact bytes Shopify sent.

Retries are de-duplicated by `X-Shopify-Webhook-Id`, so a slow response followed
by a Shopify retry cannot count the same order twice.

`localhost` is not reachable by Shopify. For local testing, use a Shopify CLI
tunnel — **no purchased domain is needed**:

```bash
npm install -g @shopify/cli@latest
shopify app dev            # prints a public https URL
```

Set `APP_URL` to that https URL. The webhook signing secret needs no separate
value — Shopify signs app deliveries with `SHOPIFY_CLIENT_SECRET`, which the
backend uses automatically. Then register:

```bash
curl -X POST "http://localhost:4000/api/webhooks/register?dryRun=1"  # preview
curl -X POST  http://localhost:4000/api/webhooks/register            # apply
```

Registration reconciles against Shopify instead of blindly creating, so it is safe
to re-run; a topic already pointing at the right URL is left alone. No dedicated
webhook scope is needed — each topic uses the read scope for its own data, so a
topic you lack the scope for is the only one that fails.

Registered topics: app uninstalled, inventory levels update, order
create/update/cancel, fulfillment create/update, product create/update/delete,
customer create/update.

Handlers today: `app/uninstalled` clears the stored offline token, and
`products/create`, `products/update` and `inventory_levels/update` trigger
storefront automation when `AUTOMATION_ON_WEBHOOK=true`. Remaining topics are
verified and stored with `processed: false`.

---

## Tests

```bash
npm test
```

Compiles with `tsc` and runs Node's built-in runner — **no Shopify access and no
network required**. Shopify payloads are mocked.

**286 tests currently pass.** Coverage:

| Area | File |
| --- | --- |
| Pricing calculations | `src/pricing/pricing.test.ts` |
| Shopify error handling | `src/shopify/shopify.errors.test.ts` |
| Retry / backoff policy | `src/shopify/shopify.throttle.test.ts` |
| Environment / config validation | `src/config/env.validation.test.ts` |
| Token caching, refresh, single-flight | `src/shopify/token/token.test.ts` |
| Webhook HMAC verification | `src/webhooks/webhook.verify.test.ts` |
| Webhook registration / idempotency | `src/webhooks/webhook.registration.test.ts` |
| OAuth callback HMAC | `src/auth/oauth.hmac.test.ts` |
| OAuth state nonce (CSRF, expiry, forgery) | `src/auth/oauth.state.test.ts` |
| Token encryption at rest | `src/common/crypto.test.ts` |
| Automation rules (price guardrails, visibility, selection) | `src/automation/automation.rules.test.ts` |
| Webhook triggers + write-loop safety | `src/automation/automation.triggers.test.ts` |
| Supplier classification | `src/suppliers/supplier.registry.test.ts` |
| Shopify → DTO mapping | `src/shopify/shopify.mappers.test.ts` |
| Analytics aggregation | `src/analytics/analytics.test.ts` |

Domain logic is deliberately dependency-free so it is testable in isolation.

---

## Project structure

```
src/
├── server.ts              entry point
├── app.ts                 middleware + route wiring
├── config/                env validation (pure) + loader
├── common/                errors, logger (redacting), http, validation, crypto
├── auth/                  OAuth redirect flow (HMAC, state, code exchange)
├── automation/            price + visibility rules (pure) and execution
├── shopify/               client, service, mappers, error mapping, throttling
│   ├── graphql/           query documents (FULL + BASIC scope variants)
│   └── token/             token providers: client credentials, static, OAuth offline
├── products/  orders/  customers/  inventory/    controllers
├── analytics/             real-data aggregates + honest unavailability
├── pricing/               standalone margin engine
├── suppliers/             SupplierProvider + registry
│   └── tradelle/
├── webhooks/              HMAC verification, receiver, registration
├── database/              Mongo connection + models
├── integrations/          shopify (done), meta + google (placeholders only)
├── health/
└── scripts/               shopifyPing.ts manual integration test
```

---

## Security

- Secrets are backend-only; `.env` is gitignored and `.env.example` holds placeholders.
- The logger redacts `shpat_`/`shpss_`-style tokens and Mongo URIs; tokens are never logged.
- `/api/shopify/status` reports credential **presence as booleans** — never values.
- CORS is restricted to `FRONTEND_URL`; `helmet` sets security headers; `/api` is rate limited.
- All query/body input is validated; Shopify ids are treated as opaque strings.
- The OAuth `shop` parameter is validated against the `.myshopify.com` pattern before
  being interpolated into any URL — an unchecked value would be an open redirect.
- OAuth callbacks are verified by HMAC **then** by a signed, shop-bound `state`
  nonce, before any parameter is trusted or any token is stored.
- Offline access tokens are encrypted with AES-256-GCM before being persisted;
  nothing in the schema ever holds a readable credential.
- Every write endpoint requires an authenticated operator (session cookie or API
  key); the middleware fails closed. CORS is defence-in-depth, not auth. See
  [docs/OPERATOR_AUTH.md](docs/OPERATOR_AUTH.md).
- Storefront writes are off behind `AUTOMATION_ENABLED` (default `false`), bounded
  per run, reversible from the `automation_runs` audit trail, and always
  previewable without writing.
- No card data, no payment gateway secrets, no customer passwords — Shopify owns checkout.
- No Shopify Admin scraping, no browser automation, no private endpoints.

---

## Not implemented (intentionally)

Direct Tradelle API · Meta/Google Ads · automated campaigns ·
automatic supplier ordering · payment processing · multi-tenant architecture ·
subscription billing · microservices · Kafka · Redis · Kubernetes · queues ·
AI recommendations · production deployment.

Two things that used to be on this list now exist, both **opt-in**:

- **Merchant OAuth** — enabled with `SHOPIFY_AUTH_MODE=oauth`; the default
  remains the single-store client credentials grant.
- **Automatic price and visibility changes** — enabled with
  `AUTOMATION_ENABLED=true`; `POST /api/automation/preview` always works and
  never writes. See [docs/AUTOMATION.md](docs/AUTOMATION.md).

Multi-tenancy is still out of scope — the token seam is keyed by shop domain, but
the rest of the app assumes one configured store. Supplier *ordering* remains
unimplemented: automation reads costs and writes prices, it does not place orders.

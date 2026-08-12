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
| `MONGODB_URI` | no in dev | — | Blank = run without persistence. Required when `NODE_ENV=production`. |
| `SHOPIFY_STORE_DOMAIN` | **yes** | — | Must be the `.myshopify.com` domain. |
| `SHOPIFY_API_VERSION` | no | `2026-07` | Format `YYYY-MM`. |
| `SHOPIFY_CLIENT_ID` | no in dev, **yes in prod** | — | From the Dev Dashboard. Half a pair is a startup error. |
| `SHOPIFY_CLIENT_SECRET` | no in dev, **yes in prod** | — | Paired with the client id. |
| `SHOPIFY_ACCESS_TOKEN` | no | — | **Optional override.** Disables automatic refresh — see below. |
| `SHOPIFY_WEBHOOK_SECRET` | no | — | Required before webhook deliveries are accepted. |

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

### `SHOPIFY_ACCESS_TOKEN` — optional override

Setting it makes the backend use that token verbatim and **disables automatic
refresh** (`authStrategy` becomes `STATIC_TOKEN`, and a startup warning is
logged). Leave it blank unless you specifically need it — for an admin-created
custom app that issued a long-lived `shpat_` token, or to debug against a known
token. If both it and the client credentials are set, the static token wins.

### Adding merchant OAuth later

Multi-merchant OAuth is deliberately **not** implemented, but the seam for it
exists. Everything obtains tokens through `ShopifyTokenProvider`
(`src/shopify/token/token.types.ts`), and every method is already keyed by
**shop domain**:

```ts
interface ShopifyTokenProvider {
  readonly strategy: 'CLIENT_CREDENTIALS' | 'STATIC_TOKEN' | 'OAUTH_OFFLINE';
  readonly canRefresh: boolean;
  getAccessToken(shopDomain: string): Promise<CachedToken>;
  invalidate(shopDomain: string): void;
  describe(shopDomain: string): TokenDiagnostics;
}
```

To add per-merchant OAuth: implement an `OAUTH_OFFLINE` provider that resolves
tokens per shop from the database (encrypted at rest) and return it from
`src/shopify/token/index.ts`. The client, services and controllers need no
changes — they already pass a shop domain and never see a credential.

### Scopes and what breaks without them

| Scope | Enables | Without it |
| --- | --- | --- |
| `read_products` | `/shopify/products` | Products fail with `SHOPIFY_SCOPE_MISSING` |
| `read_orders` | `/shopify/orders`, analytics, revenue | Orders and all revenue figures unavailable |
| `read_inventory` | `/shopify/inventory`, `totalInventory`, `inventoryQuantity`, cost per item | Products still load; inventory/cost fields return `null` and `meta.degraded` lists them |
| `read_customers` | `/shopify/customers`, order customer | Customer PII withheld; aggregates still work |
| `read_reports` | ShopifyQL analytics | Traffic endpoint reports `available: false` |

Reads that hit a missing scope automatically retry a **reduced query** and report
what was dropped in `meta.degraded`, rather than failing the whole page. Missing
fields come back as `null` — never as `0`.

Customer PII is additionally gated by Shopify's
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)
approval, which is separate from the scope.

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

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/health` | Liveness + database/Shopify diagnostics |
| GET | `/api/shopify/status` | Config + connectivity. Always 200. Booleans only, no secrets. |
| GET | `/api/shopify/shop` | Connection test / shop info |
| GET | `/api/shopify/products` | `?limit=1..100&cursor=&query=` (Shopify search syntax) |
| GET | `/api/shopify/products/:id` | Numeric id or full GID |
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
| POST | `/api/webhooks/shopify` | HMAC-verified receiver (no subscriptions registered yet) |
| GET | `/api/webhooks/status` | What is configured / planned |

### Error codes

`SHOPIFY_NOT_CONFIGURED`, `SHOPIFY_AUTH_FAILED`, `SHOPIFY_APP_NOT_INSTALLED`,
`SHOPIFY_UNAUTHORIZED`, `SHOPIFY_SCOPE_MISSING`,
`SHOPIFY_THROTTLED`, `SHOPIFY_GRAPHQL_ERROR`, `SHOPIFY_USER_ERROR`,
`SHOPIFY_HTTP_ERROR`, `SHOPIFY_NETWORK_ERROR`, `SHOPIFY_NOT_FOUND`,
`VALIDATION_ERROR`, `NOT_FOUND`, `DATABASE_UNAVAILABLE`, `RATE_LIMITED`,
`INTERNAL_ERROR`, `WEBHOOK_NOT_CONFIGURED`, `WEBHOOK_INVALID_SIGNATURE`.

### Rate limits

Every Shopify call goes through one client that handles HTTP failures, GraphQL
`errors`, `userErrors`, throttling and network faults. Retries use exponential
backoff with jitter and honour `Retry-After`, capped at 3 attempts.
**Permission errors are never retried.**

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

Not required for the first milestone; the receiver exists and is ready.

Order of operations, never reordered: **verify HMAC over the raw body → verify
the shop domain → then parse**. The route is mounted before the JSON body parser
because the signature is computed over the exact bytes Shopify sent.

`localhost` is not reachable by Shopify. For local testing, use a Shopify CLI
tunnel — **no purchased domain is needed**:

```bash
npm install -g @shopify/cli@latest
shopify app dev            # prints a public https URL
```

Point the subscription at `<public-url>/api/webhooks/shopify` and set
`SHOPIFY_WEBHOOK_SECRET`. Without that secret every delivery is rejected with
`WEBHOOK_NOT_CONFIGURED`.

Planned topics: order create/update/cancel, fulfillment create/update, product
create/update/delete, customer create/update.

---

## Tests

```bash
npm test
```

Compiles with `tsc` and runs Node's built-in runner — **no Shopify access and no
network required**. Shopify payloads are mocked.

**99 tests currently pass.** Coverage:

| Area | File |
| --- | --- |
| Pricing calculations | `src/pricing/pricing.test.ts` |
| Shopify error handling | `src/shopify/shopify.errors.test.ts` |
| Retry / backoff policy | `src/shopify/shopify.throttle.test.ts` |
| Environment / config validation | `src/config/env.validation.test.ts` |
| Token caching, refresh, single-flight | `src/shopify/token/token.test.ts` |
| Webhook HMAC verification | `src/webhooks/webhook.verify.test.ts` |
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
├── common/                errors, logger (redacting), http, validation
├── shopify/               client, service, mappers, error mapping, throttling
│   └── graphql/           query documents (FULL + BASIC scope variants)
├── products/  orders/  customers/  inventory/    controllers
├── analytics/             real-data aggregates + honest unavailability
├── pricing/               standalone margin engine
├── suppliers/             SupplierProvider + registry
│   └── tradelle/
├── webhooks/              HMAC verification + receiver
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
- No card data, no payment gateway secrets, no customer passwords — Shopify owns checkout.
- No Shopify Admin scraping, no browser automation, no private endpoints.

---

## Not implemented (intentionally)

Direct Tradelle API · Meta/Google Ads · automated campaigns · automatic price
changes · automatic supplier ordering · payment processing · merchant OAuth ·
multi-tenant architecture · subscription billing · microservices · Kafka · Redis
· Kubernetes · queues · AI recommendations · production deployment.

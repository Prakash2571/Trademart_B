# Route security inventory

Every HTTP route this service exposes, with the control that protects it.

This file is **checked by a test**. `src/auth/operator/route.inventory.test.ts` parses
the routers out of `src/**` and fails the build when a route exists that is not listed
here, or when a listed route no longer exists. That is the point: an auth boundary
nobody can enumerate is an auth boundary nobody can review, and both of the
information leaks found in the second hardening pass (`GET /api/webhooks/status`,
`GET /api/auth/status`) were routes that had quietly ended up on a public router.

## How to read the columns

| Column | Meaning |
| --- | --- |
| **Access** | `PUBLIC` = no credential. `OPERATOR` = always requires one. `OPERATOR (writes)` = mutations require one; GETs are open unless `OPERATOR_PROTECT_READS=true`, which is forced on in production. `OPERATOR (reads)` = requires one whenever `OPERATOR_PROTECT_READS=true`. |
| **Auth** | What actually proves the caller. |
| **CSRF** | Whether a cookie-authenticated mutation must echo the CSRF token. Bearer API keys are exempt: a browser never attaches an `Authorization` header on its own, so a cross-site request cannot forge one. |
| **Rate limit** | Which limiter applies, on top of the global 300/min per IP. |
| **Idem.** | Whether `Idempotency-Key` is honoured, and whether the route fails closed when the idempotency/audit store is unavailable. |
| **DB** | Whether the route needs MongoDB to function. |
| **Audit** | Whether the action writes an audit-trail entry. |

`PRODUCTION` in the Access column is a reminder that `OPERATOR_PROTECT_READS` cannot be
disabled when `NODE_ENV=production`, so in a real deployment every `OPERATOR (reads)`
row is effectively `OPERATOR`.

## Public surface

These five groups are public **by necessity**, each for a specific reason. Nothing
else is.

| Method | Path | Access | Auth | CSRF | Rate limit | Idem. | DB | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | PUBLIC | none | n/a | global | no | no | no |
| GET | `/api/health/live` | PUBLIC | none | n/a | global | no | no | no |
| GET | `/api/health/ready` | PUBLIC | none | n/a | global | no | no | no |
| GET | `/api/version` | PUBLIC | none | n/a | global | no | no | no |
| POST | `/api/operator/login` | PUBLIC | password | no | **login: 10 / 15 min, successes not counted** | no | no | **yes** (LOGIN / LOGIN_FAILED) |
| POST | `/api/operator/logout` | PUBLIC | session (optional) | no | global | no | no | yes (LOGOUT) |
| GET | `/api/operator/me` | PUBLIC | session (optional) | n/a | global | no | no | no |
| GET | `/api/operator/csrf` | PUBLIC | none | n/a | global | no | no | no |
| GET | `/api/auth/install` | PUBLIC | none | n/a | global | no | no | no |
| GET | `/api/auth/callback` | PUBLIC | **Shopify HMAC + signed state** | n/a | global | no | writes token | no |
| POST | `/api/webhooks/shopify` | PUBLIC | **Shopify HMAC + shop domain** | n/a | **none by design** | dedupe by `webhookId` unique index | **yes — 503 when unavailable** | no |
| POST | `/api/webhooks/razorpay` | PUBLIC | **Razorpay HMAC** | n/a | **none by design** | dedupe by `eventId` unique index | yes | no |
| GET | `/api/storefront/catalog` | PUBLIC | none | n/a | catalog: 100/min | no | no | no |
| GET | `/api/storefront/collections` | PUBLIC | none | n/a | catalog: 100/min | no | no | no |
| GET | `/api/storefront/collections/:handle` | PUBLIC | none | n/a | catalog: 100/min | no | no | no |
| GET | `/api/storefront/products/:handle` | PUBLIC | none | n/a | catalog: 100/min | no | no | no |
| POST | `/api/storefront/checkout` | PUBLIC | none (guest) | no | checkout: 10/min | **required** (key + request hash) | yes | no |
| POST | `/api/storefront/payments/verify` | PUBLIC | **Razorpay signature + server-side fetch** | no | idempotent by construction | yes | no |
| GET | `/api/storefront/checkout/:id/status` | PUBLIC | **status token** | n/a | tracking: 15/min | no | yes | no |
| GET | `/api/storefront/orders/track/:token` | PUBLIC | **tracking token** | n/a | tracking: 15/min | no | yes | no |

Notes on the deliberate choices in that table:

- **Webhook receivers are not rate limited.** They are mounted before the global
  limiter. Shopify delivers in bursts (one bulk edit in the Shopify admin can produce
  dozens of `products/update` events in seconds), and a 429 to a webhook sender is a
  delivery failure that consumes its retry budget. The limit that fits a signed sender
  is the HMAC and the 2 MB body cap, not a request count.
- **Storefront tokens are the credential.** `statusToken` and `trackingToken` are
  43-character base64url HMAC values, stored only as hashes, compared in constant
  time, and rate limited hard to resist enumeration. The token is masked out of the
  access log (`common/logPath.ts`).
- **Guest checkout has no session, so no CSRF token.** There is nothing to forge: the
  request carries no ambient authority, and the server recomputes the price from
  Shopify regardless of what the browser sent.

## Operator surface

| Method | Path | Access | Auth | CSRF | Idem. | DB | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/audit` | **OPERATOR** | session / API key | n/a | no | yes | no |
| GET | `/api/audit/actions` | **OPERATOR** | session / API key | n/a | no | yes | no |
| GET | `/api/diagnostics/operations` | **OPERATOR** | session / API key | n/a | no | degrades | no |
| GET | `/api/auth/status` | **OPERATOR** | session / API key | n/a | no | no | no |
| GET | `/api/webhooks/status` | **OPERATOR** | session / API key | n/a | no | no | no |
| GET | `/api/webhooks/subscriptions` | **OPERATOR** | session / API key | n/a | no | no | no |
| GET | `/api/webhooks/events` | **OPERATOR** | session / API key | n/a | no | yes | no |
| POST | `/api/webhooks/register` | **OPERATOR** | session / API key | yes | no | no | yes |
| POST | `/api/webhooks/unregister` | **OPERATOR** | session / API key | yes | no | no | no |
| POST | `/api/webhooks/events/:id/retry` | **OPERATOR** | session / API key | yes | no | yes | yes |
| POST | `/api/automation/preview` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| POST | `/api/automation/apply` | OPERATOR (writes) | session / API key | yes | **yes — fails closed** | yes | yes |
| POST | `/api/automation/approve` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| GET | `/api/automation/rules` | OPERATOR (writes → open GET) | session / API key | n/a | no | yes | no |
| PUT | `/api/automation/rules` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| GET | `/api/automation/runs` | OPERATOR (writes → open GET) | session / API key | n/a | no | yes | no |
| GET | `/api/automation/status` | OPERATOR (writes → open GET) | session / API key | n/a | no | no | no |
| POST | `/api/shopify/products` | OPERATOR (writes) | session / API key | yes | **yes — fails closed** | yes | yes |
| PATCH | `/api/shopify/products/:id` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| POST | `/api/shopify/products/:id/publish` | OPERATOR (writes) | session / API key | yes | **yes — fails closed** | yes | yes |
| POST | `/api/shopify/products/:id/publish-headless` | OPERATOR (writes) | session / API key | yes | **yes — fails closed** | yes | yes |
| POST | `/api/shopify/products/:id/unpublish` | OPERATOR (writes) | session / API key | yes | **yes — fails closed** | yes | yes |
| POST | `/api/shopify/inventory/set` | OPERATOR (writes) | session / API key | yes | **yes — fails closed** | yes | yes |
| GET | `/api/shopify/locations` | OPERATOR (writes → open GET) | session / API key | n/a | no | no | no |
| GET | `/api/costs` | OPERATOR (writes → open GET) | session / API key | n/a | no | yes | no |
| PUT | `/api/costs` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| DELETE | `/api/costs` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| PUT | `/api/dropshipping/settings` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| POST | `/api/intelligence/candidates` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| PATCH | `/api/intelligence/candidates/:id` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| POST | `/api/intelligence/candidates/:id/analyze` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| POST | `/api/intelligence/candidates/:id/push` | OPERATOR (writes) | session / API key | yes | **yes — fails closed** | yes | yes |
| POST | `/api/intelligence/candidates/:id/reject` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| POST | `/api/intelligence/candidates/:id/watch` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| POST | `/api/intelligence/candidates/:id/supplier-verification` | OPERATOR (writes) | session / API key | yes | no | yes | yes |
| GET | `/api/shopify/shop` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/status` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/capabilities` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/products` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/products/:id` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/publications` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/publications/headless` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/products/:id/publications` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/products/:id/headless-visibility` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/orders` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/orders/:id` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/customers` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/inventory` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/themes` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/themes/:id/files` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/storefront/status` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/shopify/rate-limit` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/diagnostics/integrity` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/analytics/overview` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/analytics/traffic` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/dashboard/summary` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/suppliers/providers` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/dropshipping/dashboard` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/dropshipping/orders` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/dropshipping/orders/:id` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| GET | `/api/dropshipping/settings` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | yes | no |
| GET | `/api/intelligence/candidates` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | yes | no |
| GET | `/api/intelligence/candidates/:id` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | yes | no |
| GET | `/api/intelligence/candidates/:id/decision` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | yes | no |
| GET | `/api/intelligence/candidates/:id/duplicates` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | yes | no |
| GET | `/api/intelligence/candidates/:id/supplier` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | yes | no |
| GET | `/api/intelligence/capabilities` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| POST | `/api/pricing/calculate` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |
| POST | `/api/pricing/suggest-price` | OPERATOR (reads) PRODUCTION | session / API key | n/a | no | no | no |

## Two rows that look wrong and are not

**`POST /api/pricing/*` on the READ guard.** A POST behind `requireOperatorForReads`
is normally the exact mistake the wiring tests hunt for, because it is unauthenticated
whenever reads are open. These two are pure functions: they take numbers in the body
and return numbers. They touch no Shopify API, no database and no audit trail — POST
only because a pricing request does not fit in a query string. A test
(`pricing.sideEffects.test.ts`) asserts the module imports nothing that could change
state, so this stays true.

**GETs on `requireOperatorForWrites` routers** (`/api/automation/rules`,
`/api/automation/runs`, `/api/automation/status`, `/api/shopify/locations`,
`/api/costs`). The writes-only guard leaves GETs open when `OPERATOR_PROTECT_READS` is
false, which it cannot be in production. They are read-only companions of the mutation
on the same router; splitting the routers would buy nothing in a production deployment
where reads are protected anyway.

## Changes made in hardening pass 2

- `GET /api/auth/status` moved from the public OAuth router to an operator-only router.
  It reports the app origin, the exact redirect URI, every requested scope, whether
  offline tokens are encrypted at rest, and whether persistence is up.
- `GET /api/health` and `GET /api/health/ready` keep their public probe contract, but
  the store domain, API version, auth strategy, `NODE_ENV` and Mongo driver error are
  now returned only to an authenticated operator.
- `GET /api/diagnostics/operations` added, behind the unconditional operator
  requirement.
- Every rate-limit 429 now carries the standard error body including `requestId`.

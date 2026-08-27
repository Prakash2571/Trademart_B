# System architecture

Three repositories, one Shopify store, one Razorpay account.

```
  Trademart_F  (operator console, Next.js)          Kanay-Store  (customer storefront, Next.js)
       |                                                  |
       |  session cookie + CSRF token                     |  no session, guest commerce
       |  credentials: 'include'                          |  Idempotency-Key on checkout
       v                                                  v
  +--------------------------------------------------------------------+
  |                       Trademart_B  (Express API)                    |
  |                                                                     |
  |  operator surface            public surface                         |
  |  - products, pricing         - catalog reads                        |
  |  - automation                - checkout create                      |
  |  - publications              - payment verify                       |
  |  - research / dropshipping   - order tracking (token)               |
  |  - webhook administration    - webhook receivers (HMAC)             |
  |  - audit trail               - health / version                     |
  +--------------------------------------------------------------------+
       |                    |                          |
       v                    v                          v
    Shopify              Razorpay                   MongoDB
  Admin GraphQL        Orders / Payments       webhook queue, idempotency
  (single store)       (INR, test/live)        keys, audit trail, checkout
                                               sessions, snapshots
```

**Nothing but Trademart_B talks to Shopify, Razorpay or MongoDB.** Neither frontend holds
an Admin token, a Razorpay secret or a database connection string. That is the single
most important property of this layout: a compromise of either browser application
yields no store credentials.

## Who is allowed to do what

| | Trademart_F | Kanay-Store |
| --- | --- | --- |
| Authentication | operator session cookie (HttpOnly) or `Authorization: Bearer <OPERATOR_API_KEY>` | none — guest |
| CSRF | double-submit token on every mutation | not applicable (no ambient authority) |
| Reads | all management reads; **an operator is required in production** | catalog only |
| Writes | every mutation requires an operator | create a checkout, verify a payment |
| Order data | full, via the operator surface | only with a status/tracking token |

Full per-route detail, including which limiter and whether the route fails closed
without MongoDB: [ROUTE_SECURITY.md](./ROUTE_SECURITY.md).

## Operator authentication

- Session cookie: HttpOnly (so XSS cannot read it), `SameSite=Lax`, `Secure` in
  production, signed with `SESSION_SECRET`, sliding renewal past half-life inside an
  absolute TTL (`SESSION_TTL_HOURS`, default 12).
- API key: for scripts and cron. Exempt from CSRF, because a browser never attaches an
  `Authorization` header on its own.
- `SESSION_SECRET` **must be set explicitly in production**. Deriving it from
  `OPERATOR_PASSWORD` (which local development still does) would make the password
  sufficient to forge sessions offline — no login request, so no rate limiter, no audit
  entry, no future MFA.
- `OPERATOR_PROTECT_READS` defaults to **true** in production and an explicit `false` is
  refused there. Management reads expose costs, margins, customers, orders and
  integration wiring.
- Login is limited to 10 attempts per 15 minutes per IP, successes not counted.

Detail: [OPERATOR_AUTH.md](./OPERATOR_AUTH.md).

## Shopify

- **Auth mode:** client credentials grant by default (`SHOPIFY_AUTH_MODE=auto`), with a
  merchant OAuth redirect flow available (`oauth`) and a static-token override for
  debugging. Offline tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY`.
- **Scopes:** requested set is in `SHOPIFY_SCOPES`; `GET /api/shopify/capabilities`
  reports, per feature, whether it is available, blocked by a missing scope, or simply
  not implemented — those are different problems with different fixes. There is no
  `write_webhooks` scope; each subscribed topic needs the read scope covering its
  payload.
- **Client behaviour:** explicit request timeout, throttle-aware retry with jittered
  exponential backoff, `Retry-After` respected, and a circuit breaker that refuses bulk
  writes after repeated failures rather than half-applying a plan.

Detail: [OAUTH_AND_WEBHOOKS.md](./OAUTH_AND_WEBHOOKS.md).

## Webhooks

Signature over the raw body → shop-domain check → **persist** → acknowledge. Processing
never happens inline.

- The receiver is public (Shopify cannot sign in) and mounted **before** the JSON parser,
  because HMAC needs the exact bytes.
- It is also mounted **before** the global rate limiter: Shopify delivers in bursts, and a
  429 to a webhook sender is a delivery failure that eats its retry budget.
- If the event cannot be made durable, the answer is a retryable **503**, not a 200. A 2xx
  is a promise Shopify never resends on; acknowledging an event nobody stored loses it
  permanently.
- Duplicates answer 200 — deduplication is a unique index on `webhookId`, not a
  read-then-write check, because two simultaneous retries can both pass a check.
- `app/uninstalled` is honoured inline even with no database, because a revoked token left
  in storage is a security problem. 200 only when that inline work actually succeeded.
- Retries: 1 min → 5 min → 30 min, then `FAILED` for a human. Operators can re-queue a
  `FAILED` event; a `PROCESSED` one cannot be re-run.
- **Webhook administration** (status, subscriptions, events, register, unregister, retry)
  requires an operator for reads as well as writes.

## Razorpay and the order lifecycle

```
CREATED -> PAYMENT_PENDING -> PAYMENT_PAID -> ORDER_PENDING -> ORDER_CREATING -> ORDER_CREATED
                                    |                                              |
                                    +-> (refund) ---------------------------------> REFUNDED
```

- Every transition is an **atomic `findOneAndUpdate` with a status filter and a lease**,
  never a read-then-write, so two concurrent requests cannot both advance the same
  checkout.
- Browser verification and the Razorpay webhook race each other by design and both are
  safe: unique partial indexes on `razorpayOrderId` and `razorpayPaymentId` mean one
  checkout can only ever have one of each.
- The customer closing the tab after paying loses nothing — the webhook path completes the
  order without the browser.
- If Shopify order creation fails **after** money is captured, the checkout stays in
  `ORDER_PENDING` and is retried on a schedule (1, 5, 30, 120, 360 minutes). The counter
  `storefront.order.creation_failed` in `GET /api/diagnostics/operations` is how an
  operator sees it happening.
- The charged amount is always recomputed server-side from Shopify. The price the browser
  sends (`expectedUnitPricePaise`) is used only to detect a stale cart and answer
  `PRICE_CHANGED`.
- `POST /orders` at Razorpay is never retried blindly; recovery is by receipt lookup,
  which is idempotent by identity.

## MongoDB

Required in production. Without it the API still boots and Shopify reads still work, but:

- webhook deliveries are refused with a retryable 503 (nothing is lost; Shopify redelivers)
- **dangerous writes are refused outright** — the idempotency record and the audit row
  both live in Mongo, so a write that could not be deduplicated or attributed does not
  happen
- the audit trail, checkout sessions and the research module are unavailable

Unique indexes are the concurrency control, not a performance tweak: `webhookId`,
`(key, operation)` for idempotency, `idempotencyKey`, `razorpayOrderId`,
`razorpayPaymentId`, `trackingTokenHash`. Index synchronisation runs at startup and its
outcome is reported by `GET /api/diagnostics/operations` — a failed index build means a
uniqueness guarantee is silently absent.

TTL indexes expire webhook events (`RETENTION_WEBHOOK_EVENT_DAYS`, 45), idempotency keys
(`RETENTION_IDEMPOTENCY_HOURS`, 48) and audit entries (`RETENTION_AUDIT_DAYS`, 730, floor
of 30).

## Observability

| Question | Where |
| --- | --- |
| Is the process alive? | `GET /api/health/live` — checks nothing else, so a dependency outage cannot restart the container |
| Should traffic come here? | `GET /api/health/ready` |
| Which build is this? | `GET /api/version` |
| Is anything failing right now? | `GET /api/diagnostics/operations` (operator only) |
| Who changed what? | `GET /api/audit` (operator only, always) |
| Did Shopify tell us? | `GET /api/webhooks/events` (operator only) |

Health probes are public but withhold the store domain, API version, auth strategy,
`NODE_ENV` and the Mongo error from unauthenticated callers. Logs are structured JSON with
a request id on every line, and redaction is by field NAME as well as value shape —
credentials, signatures and customer PII never reach stdout, and the tracking token is
masked out of the access log.

## Production environment variables

Required:

| Variable | Note |
| --- | --- |
| `NODE_ENV=production` | turns on the production-only rules below |
| `MONGODB_URI` | required in production |
| `SHOPIFY_STORE_DOMAIN` | must be the `.myshopify.com` domain |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | required in production |
| `APP_URL` | must be `https://` |
| `FRONTEND_URL` | operator console origin (CORS allow-list, credentials) |
| `SESSION_SECRET` | **must be explicit in production** — `openssl rand -base64 48` |
| `OPERATOR_PASSWORD_HASH` or `OPERATOR_PASSWORD`, or `OPERATOR_API_KEY` | at least one; a startup error in production without them |
| `TOKEN_ENCRYPTION_KEY` | required to store offline OAuth tokens |

Required when the storefront is enabled (`STOREFRONT_URL` set):
`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

Notable defaults: `OPERATOR_PROTECT_READS` is true in production and cannot be disabled;
`SHOPIFY_WEBHOOK_SECRET` falls back to `SHOPIFY_CLIENT_SECRET`, which is what Shopify
actually signs app webhooks with.

## Safe deployment

1. Set the environment first. A production deployment now **refuses to start** without
   `SESSION_SECRET` and operator credentials, and with `OPERATOR_PROTECT_READS=false`.
   The startup error names the variable and how to generate it.
2. `docker compose config` to prove interpolation resolves before anything runs.
3. Deploy. The container healthcheck probes `/api/health/live`, never readiness — pointing
   it at readiness turns a Mongo blip into a crash loop, which a restart cannot fix.
4. Check `GET /api/version` (public) to confirm the running commit.
5. Sign in and check `GET /api/diagnostics/operations`: index sync clean, webhook queue
   drained, counters at zero.
6. On `SIGTERM` the process stops claiming queue work, closes the listener, drains
   in-flight requests, disconnects Mongo, and exits — with a 10-second cap so a stuck
   connection cannot block a deploy.

## CI and branch protection

Every repository runs, on pull request: install with `npm ci` (never `npm install`),
typecheck, tests, build, a Docker image build, and a secret scan of both the source and
the built bundle. Trademart_B additionally validates `docker compose config`.

GitHub branch protection **cannot be configured through the API with the token available
in this environment** (both the legacy branch-protection endpoint and the rulesets
endpoint return 403). The exact settings to apply by hand are in
[BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md).

## Secret management

- Real values live in `.env` / `deploy/.env`, which are git-ignored. `.env.example` is the
  committed template and contains placeholders only.
- The secret-scan workflow fails the build on a credential-shaped literal in the source
  **or in the built client bundle** — the second is what catches a secret accidentally
  exposed through a `NEXT_PUBLIC_` variable.
- Rotating a credential means rotating it at the provider first. Removing the line does
  not help: git history keeps the old value.

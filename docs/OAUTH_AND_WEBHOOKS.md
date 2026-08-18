# OAuth redirect flow and webhooks

Two related but independent features:

| Feature | What it needs | What breaks without it |
| --- | --- | --- |
| **OAuth redirect flow** | `APP_URL` + client id/secret | Nothing, if you use Shopify-managed installation |
| **Webhook receipt** | `SHOPIFY_WEBHOOK_SECRET` | Deliveries are rejected with `WEBHOOK_INVALID_SIGNATURE` |
| **Webhook registration** | `APP_URL` + `SHOPIFY_WEBHOOK_SECRET` | Shopify never sends anything, because nothing is subscribed |

> **Do you actually need OAuth?**
> Probably not. A single-store deployment using Shopify-managed installation plus
> the client credentials grant needs no redirect URL at all — that is the default
> and it keeps working untouched. Add OAuth when you want the redirect-based
> install (an installation link, the App Store listing, or multiple merchants).

---

## 1. The redirect URL

### What to paste into Shopify

In the Dev Dashboard, **App access → Allowed redirection URL(s)**, add exactly:

```
https://<your-app-host>/api/auth/callback
```

Shopify compares this string **character for character**. A trailing slash, `http`
instead of `https`, or a stale tunnel host all produce the same opaque failure.
So the backend derives the value for you rather than making you retype it:

```bash
curl http://localhost:4000/api/auth/status
```

```json
{
  "success": true,
  "data": {
    "configured": true,
    "redirectUri": "https://your-app-host.example.com/api/auth/callback",
    "requestedScopes": ["read_products", "read_orders", "read_customers", "read_inventory"],
    "installPath": "/api/auth/install"
  }
}
```

Paste `redirectUri` verbatim. If it is `null`, `APP_URL` is not set.

### Configuration

```bash
APP_URL=https://your-app-host.example.com      # this backend, as Shopify sees it
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_SCOPES=read_products,read_orders,read_customers,read_inventory
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

`APP_URL` must be reachable by Shopify. Localhost is not: the server logs a warning
if you point it there. For local development use a tunnel:

```bash
cloudflared tunnel --url http://localhost:4000
# or: shopify app dev
```

Then set `APP_URL` to the tunnel's https URL and update the redirect URL in the
Dev Dashboard to match. **A tunnel URL changes every restart** unless you have a
named tunnel, and every change means updating both places.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /api/auth/install?shop=<store>.myshopify.com` | Starts the handshake; 302s to Shopify |
| `GET /api/auth/callback` | The allow-listed redirect URL Shopify calls back |
| `GET /api/auth/status` | Non-secret diagnostics (never returns a token) |

To install:

```
https://your-app-host.example.com/api/auth/install?shop=teststoremart-uk8mmby.myshopify.com
```

On success the merchant lands on `FRONTEND_URL/dashboard?installed=1&shop=...`.
No token ever crosses that boundary.

### How the callback is verified

Four checks, in this order, and the order is load-bearing:

1. **HMAC** over the raw query string, keyed by the client secret. Proves the
   request came from Shopify. Nothing else is trusted until this passes.
2. **Signed `state`** — proves *we* started this handshake (CSRF defence).
3. **Shop match** — the `shop` parameter must equal the shop bound inside the
   signed state. Without this, the state proves only that some handshake started,
   not that *this* one did.
4. Only then is the `code` exchanged and a token stored.

Each check has its own error code, because each needs a different fix:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `OAUTH_NOT_CONFIGURED` | 503 | `APP_URL` or the client credentials are missing |
| `OAUTH_INVALID_REQUEST` | 400 | Bad or missing `shop` / `code` |
| `OAUTH_INVALID_HMAC` | 401 | Signature did not verify — wrong client secret, or not from Shopify |
| `OAUTH_STATE_INVALID` | 401 | Expired (>10 min), replayed, or shop mismatch |
| `ENCRYPTION_NOT_CONFIGURED` | 503 | `TOKEN_ENCRYPTION_KEY` missing or wrong |

None of these are retryable. Retrying an unverifiable callback would turn a
rejected handshake into a retry loop.

#### Two HMAC schemes, deliberately not shared

Mixing these up is the most common source of "my HMAC won't validate":

| | Webhook delivery | OAuth redirect |
| --- | --- | --- |
| Signed material | raw request **body** bytes | sorted **query string** |
| Digest encoding | base64 | hex |
| Carried in | `X-Shopify-Hmac-Sha256` header | `?hmac=` parameter |
| Secret | `SHOPIFY_WEBHOOK_SECRET` | `SHOPIFY_CLIENT_SECRET` |

They live in `src/webhooks/webhook.verify.ts` and `src/auth/oauth.hmac.ts`
respectively, and neither imports the other.

### Where the token goes

The offline access token is encrypted with AES-256-GCM before it touches
MongoDB, and stored on the `Store` document as `accessTokenEncrypted`
(`src/common/crypto.ts`). GCM is used rather than CBC because it is
*authenticated*: a tampered ciphertext fails to decrypt instead of yielding
attacker-influenced plaintext.

Consequences worth knowing:

- **The key is not rotatable in place.** Changing `TOKEN_ENCRYPTION_KEY`
  invalidates every stored token and every merchant must reinstall. The ciphertext
  carries a `v1.` version prefix so a future key-rotation scheme can be added
  without guessing how existing rows were written.
- **A completed install needs MongoDB.** With no database there is nowhere to put
  the token, so the callback fails with `DATABASE_UNAVAILABLE` rather than
  succeeding and silently discarding it.

### Installing does not change how requests authenticate

This is the surprising part, and it is intentional:

```
SHOPIFY_AUTH_MODE=auto   (default)  -> Admin API calls use the client credentials grant
SHOPIFY_AUTH_MODE=oauth             -> Admin API calls use the stored offline token
```

Completing an OAuth install in `auto` mode stores a token but does **not** switch
authentication over. Adding a redirect flow must not silently change how an
already-working deployment talks to Shopify, and since both paths use the same
client id/secret, the presence of credentials cannot tell them apart. So the
switch is explicit.

In `oauth` mode the provider reads the token from MongoDB, decrypts it, and caches
it in memory (`src/shopify/token/oauthOffline.provider.ts`). Offline tokens do not
expire, so there is nothing to refresh on a timer. A 401 drops the cache and
re-reads the database once, which is a real recovery path: a merchant who
reinstalled has a new token waiting there.

`oauth` mode has no fallback. If no install has completed, Shopify calls fail with
`SHOPIFY_NOT_CONFIGURED` and a message naming the install URL — rather than
quietly falling back to a different identity.

---

## 2. Webhooks

### Receiving

`POST /api/webhooks/shopify` was already implemented. Its security order is
unchanged and must stay that way:

1. verify HMAC over the raw body
2. verify the shop domain
3. only then parse and act on the payload

The receiver is mounted **before** `express.json()` in `src/app.ts`, because HMAC
is computed over the exact bytes Shopify sent and a parsed body cannot reproduce
them.

#### Idempotency

Shopify retries a delivery until it receives a 2xx, and every retry carries the
same `X-Shopify-Webhook-Id`. The receiver now looks that id up before doing any
work and acknowledges a duplicate immediately:

```json
{ "success": true, "duplicate": true }
```

Without this, a slow response followed by a retry would count the same order
twice. If the duplicate check itself fails, the delivery still proceeds — the
unique partial index on `webhookId` remains as a backstop.

#### Processing

`app/uninstalled` is the only topic with a handler today: it clears the stored
offline token, which would otherwise sit in the database after the merchant
removed the app. Every other topic is verified, stored with `processed: false`,
and left for a future handler. They are deliberately **not** marked processed —
the flag means "actioned", not "received".

### Registering

Subscriptions are registered over the Admin API rather than declared in
`shopify.app.toml`, because the callback URL is environment-specific (a tunnel
locally, a real host in production) while the app config is shared across both.

```bash
# Preview — changes nothing
curl -X POST "http://localhost:4000/api/webhooks/register?dryRun=1"

# Apply
curl -X POST http://localhost:4000/api/webhooks/register

# What Shopify currently has
curl http://localhost:4000/api/webhooks/subscriptions

# Remove one
curl -X POST http://localhost:4000/api/webhooks/unregister \
  -H 'Content-Type: application/json' \
  -d '{"id":"gid://shopify/WebhookSubscription/123"}'
```

Requires the **`write_webhooks`** scope. `read_webhooks` can list but not register;
a missing scope surfaces as `SHOPIFY_SCOPE_MISSING` like any other.

`unregister` is a POST, not a DELETE, because a subscription id is a GID
containing slashes (`gid://shopify/WebhookSubscription/123`) which does not fit a
path segment — and the app's CORS policy only permits GET/POST/OPTIONS.

#### Registration is idempotent

`POST /api/webhooks/register` reconciles rather than blindly creating, so running
it twice does not produce duplicate subscriptions (which would double every
delivery). Per topic:

| Situation | Action |
| --- | --- |
| No subscription | **create** |
| Subscription already points at our callback URL | **keep** |
| Points somewhere else over HTTP | **update** (repoint) |
| Exists on EventBridge / Pub/Sub | **skip** |

URL comparison ignores a trailing slash and host casing, since neither means
"repoint this". Path casing *is* significant.

Non-HTTP endpoints are skipped rather than hijacked: silently converting
someone's EventBridge pipeline into an HTTP POST would be a destructive surprise.

Subscriptions pointing at our callback URL for a topic we no longer want are
reported as `orphaned` but **never auto-deleted** — pruning stays a deliberate
operator step via `unregister`.

One topic failing does not abort the rest; each gets its own outcome:

```json
{
  "callbackUrl": "https://your-app-host.example.com/api/webhooks/shopify",
  "outcomes": [
    { "topic": "APP_UNINSTALLED", "action": "created", "id": "gid://shopify/WebhookSubscription/1" },
    { "topic": "ORDERS_CREATE",   "action": "kept",    "id": "gid://shopify/WebhookSubscription/2" }
  ],
  "orphaned": [],
  "summary": { "create": 1, "update": 0, "keep": 1, "skip": 0, "orphaned": 0, "failed": 0 }
}
```

### Registered topics

Defined by `PLANNED_WEBHOOK_TOPICS` in `src/webhooks/webhook.verify.ts`. Adding a
topic there and re-running `register` is all that is needed:

`APP_UNINSTALLED`, `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_CANCELLED`,
`FULFILLMENTS_CREATE`, `FULFILLMENTS_UPDATE`, `PRODUCTS_CREATE`,
`PRODUCTS_UPDATE`, `PRODUCTS_DELETE`, `CUSTOMERS_CREATE`, `CUSTOMERS_UPDATE`

Topics use the GraphQL enum form (`ORDERS_CREATE`) for subscriptions and the REST
form (`orders/create`) in the `X-Shopify-Topic` delivery header.
`topicHeaderToEnum` / `topicEnumToHeader` convert between them, splitting on the
**last** underscore so `DRAFT_ORDERS_CREATE` becomes `draft_orders/create` and not
`draft/orders_create`.

---

## 3. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `OAUTH_NOT_CONFIGURED` | `APP_URL` unset | Set it, restart; check `GET /api/auth/status` |
| Shopify: "redirect_uri is not whitelisted" | Allow-list does not match exactly | Copy `redirectUri` from `/api/auth/status` verbatim |
| `OAUTH_INVALID_HMAC` | Wrong `SHOPIFY_CLIENT_SECRET` | Re-copy from the same app that owns the client id |
| `OAUTH_STATE_INVALID` · expired | Install took over 10 minutes | Restart from `/api/auth/install` |
| `OAUTH_STATE_INVALID` · shop mismatch | `shop` differs from the signed state | Restart the install; do not hand-edit the callback URL |
| `ENCRYPTION_NOT_CONFIGURED` on install | `TOKEN_ENCRYPTION_KEY` unset | `openssl rand -base64 32`, set, restart |
| "Stored token could not be decrypted" | The key changed | Reinstall the app on the store |
| `DATABASE_UNAVAILABLE` on install | No MongoDB | Set `MONGODB_URI` |
| `SHOPIFY_NOT_CONFIGURED` in `oauth` mode | No install completed | Visit `/api/auth/install?shop=...` |
| Registration: `WEBHOOK_NOT_CONFIGURED` | No webhook secret | Set `SHOPIFY_WEBHOOK_SECRET` first |
| Registration: `SHOPIFY_SCOPE_MISSING` | No `write_webhooks` | Add the scope, `shopify app deploy`, update the install |
| No deliveries arrive | Nothing subscribed, or an unreachable URL | `GET /api/webhooks/subscriptions`; confirm `APP_URL` is public |
| Deliveries rejected as `WEBHOOK_INVALID_SIGNATURE` | Wrong secret, or body was re-parsed | Confirm the secret; the receiver must stay mounted before `express.json()` |

## 4. Tests

The security-critical logic is pure and unit tested with `node:test`, no network:

| File | Covers |
| --- | --- |
| `src/auth/oauth.hmac.test.ts` | Signature base construction, sorting, tampering, non-hex input |
| `src/auth/oauth.state.test.ts` | Signing, expiry, clock skew, forged shop domain |
| `src/common/crypto.test.ts` | Round-trip, tamper detection, wrong key, IV uniqueness |
| `src/webhooks/webhook.registration.test.ts` | Reconciliation, idempotency, orphan detection, topic conversion |
| `src/config/env.validation.test.ts` | `APP_URL`, scopes, auth mode, encryption key validation |

```bash
npm test
```

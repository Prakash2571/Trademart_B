# Operator authentication

Every endpoint that can change the Shopify store or Trademart's configuration
requires an authenticated operator. This is **mandatory** infrastructure, not a
convenience.

> **CORS is not authentication.** CORS is a policy the *browser* enforces on
> cross-origin scripts. It does nothing about `curl`, a server, or a script.
> Before this layer, `POST /api/automation/apply` could reprice an entire live
> store and was callable by anyone who knew the URL.

## What is protected

| Surface | Protection |
| --- | --- |
| `POST /api/automation/apply`, `/approve`, `PUT /api/automation/rules` | operator required |
| `POST /api/webhooks/register`, `/unregister` | operator required |
| all other `/api/automation/*`, `/api/shopify/*`, `/api/pricing/*`, `/api/analytics/*`, `/api/suppliers/*` **writes** | operator required |
| the same routes' **reads** (GET) | open by default; require operator when `OPERATOR_PROTECT_READS=true` |
| `GET /api/health` | public (uptime probes) |
| `GET/POST /api/operator/*` | public (you can't sign in if signing in needs a sign-in) |
| `GET /api/auth/*` (Shopify OAuth callback) | public; secured by Shopify HMAC + signed state |
| `POST /api/webhooks/shopify` (delivery receiver) | public; secured by Shopify HMAC |

## Fails closed

With **no** operator credentials configured, every guarded endpoint refuses with
`UNAUTHORIZED` (or `OPERATOR_NOT_CONFIGURED`). The opposite reading — "auth isn't
set up, so writes are open" — would be exactly the hole this closes. The server
still boots and reads still work (unless `OPERATOR_PROTECT_READS=true`), so a
misconfiguration degrades safely instead of locking you out or opening you up.

## Two ways to authenticate

### 1. Browser console — password + session cookie

```
POST /api/operator/login  { "username": "...", "password": "..." }
  -> Set-Cookie: trademart_session (HttpOnly, Secure in prod, SameSite=Lax)
  -> Set-Cookie: trademart_csrf    (readable by JS, echoed back in a header)
```

- The session token is **HMAC-signed and stateless** (same design as the OAuth
  `state` nonce). No sessions collection, so auth keeps working when MongoDB is
  down — which is when you most need to reach the console.
- The cookie is **HttpOnly**, so XSS cannot steal it.
- Mutations must echo the CSRF cookie in the `X-CSRF-Token` header
  (double-submit). A cross-site page can cause the cookie to be *sent* but
  cannot *read* it to set the header, so it cannot forge a write. The frontend
  API client does this automatically.

### 2. Scripts / cron — API key

```
Authorization: Bearer <OPERATOR_API_KEY>
```

Exempt from CSRF: a browser never attaches an `Authorization` header on its own,
so this credential is not forgeable cross-site. Use it for automation scripts,
never in a browser.

## Setup

```bash
# 1. Hash a password (never store the plaintext)
npm run operator:hash
#    -> OPERATOR_PASSWORD_HASH=scrypt$16384$8$1$...$...

# 2. Generate the signing secret
openssl rand -base64 48        # -> SESSION_SECRET

# 3. (optional) an API key for scripts
openssl rand -base64 32        # -> OPERATOR_API_KEY
```

Put them in the backend `.env`:

```
OPERATOR_USERNAME=operator
OPERATOR_PASSWORD_HASH=scrypt$16384$8$1$...$...
SESSION_SECRET=<48+ random chars>
OPERATOR_API_KEY=<optional, 24+ chars>
SESSION_TTL_HOURS=12
OPERATOR_PROTECT_READS=false
```

In Docker, generate the hash inside the image so the tsx runtime is present:

```bash
docker compose run --rm backend npm run operator:hash
```

## Password hashing

`scrypt` from `node:crypto` — a memory-hard KDF, in the standard library, so no
new dependency. The stored form embeds its cost parameters:

```
scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
```

so the cost can be raised later without invalidating existing hashes. Defaults
are `N=16384, r=8, p=1` (~16 MB/hash). Verification always runs the full
derivation and compares in constant time, so a wrong password costs the same as
a right one, and login verifies the password even when the username is wrong so
neither failure is distinguishable by timing.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/operator/login` | public, rate-limited 10 / 15 min | start a session |
| `POST /api/operator/logout` | public | clear the session (always succeeds) |
| `GET /api/operator/me` | public, always 200 | is anyone signed in; is login configured |
| `GET /api/operator/csrf` | public | issue a fresh CSRF token |

The frontend calls `/me` on load to decide between the console and the login
screen; a `401` there would be indistinguishable from a backend fault, so it
always returns `200` with an `authenticated` boolean.

## Cross-origin cookies

`localhost:3000` and `localhost:4000` are the **same site** (site = registrable
domain, not port), so the `SameSite=Lax` session cookie is sent in local dev.
The backend CORS config sets `credentials: true` with an explicit origin
allowlist — required for the cookie to flow, and safe only *because* the origin
is not a wildcard. In production, serve the API under the same origin as the app
(e.g. `/api` behind nginx) so nothing depends on `SameSite=None`.

## Rotation and revocation

- **Rotate the password:** `npm run operator:hash`, update
  `OPERATOR_PASSWORD_HASH`, restart. Existing sessions keep working until they
  expire.
- **Log everyone out now:** change `SESSION_SECRET` and restart. Every existing
  session token instantly fails signature verification.
- **Bound a stolen cookie:** `SESSION_TTL_HOURS` (default 12). Active operators
  get a sliding renewal; idle ones still expire on the absolute cap.

## Tested behaviour

`src/auth/operator/operator.test.ts` (pure, no network) covers: a tampered
session does not verify, an expired one does not verify, a wrong password does
not verify, a malformed hash is reported as misconfiguration (not a bad
password), the CSRF token cannot be satisfied by an attacker who can only cause
the cookie to be sent, and cookies serialise with the right security attributes.
`src/config/env.validation.test.ts` covers failing closed and refusing to
protect reads when nobody can sign in.

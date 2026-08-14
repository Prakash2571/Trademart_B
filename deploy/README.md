# Trademart deployment

Single-host Docker Compose stack: nginx (TLS termination + reverse proxy) in
front of the Next.js frontend and the Express API, with MongoDB and automatic
Let's Encrypt renewal. Everything restarts on crash and on host boot.

```
                       :80 / :443
                           │
                    ┌──────▼──────┐
                    │    nginx    │  TLS, gzip, www→apex, security headers
                    └──┬───────┬──┘
              /api/ ───┘       └─── /  and  /_next/static/
                   │                 │
          ┌────────▼────────┐  ┌─────▼──────────┐
          │ backend  :4000  │  │ frontend :3000 │
          │ Express + TS    │  │ Next.js 15     │
          └────────┬────────┘  └────────────────┘
                   │
            ┌──────▼──────┐        ┌──────────┐
            │ mongo :27017│        │ certbot  │  renew loop, every 12h
            └─────────────┘        └──────────┘
```

Only nginx publishes ports. `backend`, `frontend` and `mongo` are reachable
solely on the internal `trademart` network.

## Prerequisites

- A Linux host with Docker Engine 24+ and the Compose v2 plugin
  (`docker compose version` must work — the legacy `docker-compose` binary is not
  supported).
- Inbound TCP 80 and 443 open.
- DNS `A` (and ideally `AAAA`) records for **both** `trademart.online` and
  `www.trademart.online` pointing at the host. Let's Encrypt's http-01 challenge
  fails without them.
- Both repos cloned side by side:

  ```
  <parent>/
  ├── Trademart_B/          # this repo — deploy/ lives here
  └── Trademart_F/
  ```

  If the frontend lives elsewhere, set `FRONTEND_CONTEXT` in `.env`.

## Deploy

```bash
git clone https://github.com/Prakash2571/Trademart_B.git
git clone https://github.com/Prakash2571/Trademart_F.git

cd Trademart_B/deploy
cp .env.example .env
openssl rand -hex 24          # paste into MONGO_INITDB_ROOT_PASSWORD *and* MONGODB_URI
$EDITOR .env

./start.sh                    # or: make up
```

`start.sh` builds both images, plants a temporary self-signed certificate so
nginx can bind `:443`, starts everything, then swaps in a real Let's Encrypt
certificate and reloads nginx. It is idempotent — re-run it after any change.

Verify:

```bash
curl -fsS https://trademart.online/api/health | head
docker compose ps            # every service should read "healthy"
```

## Day-to-day

`make help` lists everything. The ones you'll actually use:

| Command | What it does |
| --- | --- |
| `make up` | Build + boot + ensure TLS. Safe to re-run. |
| `make start` | Boot without rebuilding. |
| `make logs` | Tail all logs (`make logs-backend`, `-frontend`, `-nginx`). |
| `make ps` | Container state and health. |
| `make health` | Print the API's `/api/health` payload. |
| `make nginx-test` | Validate the *rendered* nginx config. |
| `make renew` | Force certificate renewal now. |
| `make stop` | Stop; stays stopped until `make start`. |
| `make down` | Remove containers, **keep** data. |
| `make destroy` | Remove containers **and volumes** — deletes the database. |

### Deploying a new commit

```bash
git -C ../..              pull --ff-only   # if you track both repos together
git -C ../../Trademart_F  pull --ff-only
cd Trademart_B/deploy && ./start.sh
```

Compose recreates only the containers whose image changed, so nginx and mongo
keep running.

## Environment variables

Everything lives in one gitignored file, `deploy/.env`, created from
[`.env.example`](.env.example). It feeds both compose interpolation
(`${DOMAIN}`, build args) and the backend container's process env.

Compose `.env` parsing has three gotchas worth repeating:

- `$` is interpolated — write `$$` for a literal dollar, or avoid `$` in
  generated passwords.
- `#` starts a comment only at the beginning of a line, never inline.
- Don't quote values unless the quotes belong to the value.

Required — the stack refuses to start without them, by design, because
`NODE_ENV=production` makes the API fail fast rather than boot degraded:

`DOMAIN`, `FRONTEND_URL`, `MONGODB_URI`, `SHOPIFY_STORE_DOMAIN`,
`MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, plus
`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (or `SHOPIFY_ACCESS_TOKEN`).

Full per-variable reference for the API: [`../.env.example`](../.env.example).

### `NEXT_PUBLIC_API_BASE_URL` is a *build-time* value

Next.js inlines every `NEXT_PUBLIC_*` variable into the browser bundle during
`next build`. Two consequences:

1. It must be resolvable **by the visitor's browser**. Never
   `http://backend:4000/api` — that name only exists inside the Docker network.
   The default `/api` is same-origin through nginx, which also means the
   browser never issues a CORS preflight.
2. Changing it requires a rebuild: `docker compose build frontend && make start`.
   Editing `.env` alone does nothing.

### Rotating a secret

```bash
$EDITOR .env
docker compose up -d backend    # recreates just the API with the new env
```

Rotating the Mongo password is different: `MONGO_INITDB_ROOT_*` only takes
effect on an **empty** data volume. On an existing database, change it inside
Mongo (`make shell-mongo`, then `db.changeUserPassword(...)`) and update
`MONGODB_URI` to match.

## nginx

| File | Purpose |
| --- | --- |
| `nginx/nginx.conf` | `http{}` context: logging, gzip, TLS ciphers, DNS resolver, upgrade map. Replaces the image default so no flag directive is declared twice. |
| `nginx/templates/default.conf.template` | The server blocks. Rendered to `conf.d/default.conf` at container start with `${DOMAIN}` substituted. |
| `nginx/snippets/proxy.conf` | Shared `X-Forwarded-*` / timeout settings. |
| `nginx/snippets/security-headers.conf` | HSTS, nosniff, frame options, referrer policy. |

Templates, not a static file, so the domain lives in `.env` alongside
everything else. `NGINX_ENVSUBST_FILTER=^DOMAIN$` restricts `envsubst` to that
one variable — without it, nginx's own `$host` and `$request_uri` would be
replaced with empty strings.

Details that are load-bearing rather than decorative:

- **`proxy_pass http://$variable` + `resolver 127.0.0.11`.** A variable in
  `proxy_pass` makes nginx re-resolve the upstream per request. With a static
  `upstream {}` block nginx resolves once at startup and then keeps sending
  traffic to a dead IP after `backend` is recreated — the single most common way
  a compose stack half-dies. With no URI component after the host, the original
  request URI (including the `/api` prefix the API expects) passes through
  unchanged.
- **`client_max_body_size 4m`.** `POST /api/webhooks/shopify` verifies the HMAC
  over the raw body with a 2 MB ceiling; nginx should never be the component
  that rejects a valid delivery.
- **`X-Forwarded-For` via `$proxy_add_x_forwarded_for`.** The API runs
  `app.set('trust proxy', 1)` — exactly one hop. Put another proxy in front of
  this nginx (Cloudflare, an ALB) and you must raise that number in
  `src/app.ts`, or `express-rate-limit` will bucket every visitor together under
  one IP and start 429-ing real traffic.
- **`www` 301s to the apex** so there is one canonical origin. The API's CORS
  allowlist holds a single `FRONTEND_URL`, so two live origins would break one
  of them.
- **A `default_server` catch-all returns 444** with `ssl_reject_handshake on`,
  so scanners hitting the bare IP or an unrelated hostname get nothing.

After editing any nginx file:

```bash
docker compose restart nginx   # re-renders the template
make nginx-test                # validate
```

## "Never stops"

- `restart: unless-stopped` on every service — recovers from crashes, from OOM
  kills, and from a host reboot (as long as the Docker daemon is enabled:
  `sudo systemctl enable --now docker`). A deliberate `make stop` stays stopped.
- **Healthchecks** on backend, frontend, mongo and nginx, visible in
  `docker compose ps`.
- **Capped logs** (10 MB × 5 per container). An unbounded `json-file` log
  filling the disk is the most common way a "never stops" stack actually dies.
- **Graceful shutdown.** `dumb-init` is PID 1 in both app images, so `SIGTERM`
  reaches Node and `src/server.ts` drains connections and closes Mongo instead
  of being killed after the 10 s timeout.
- **nginx survives a broken backend.** `depends_on` uses `service_started`, not
  `service_healthy`, so a bad env var takes down `/api` — not the whole site.
- **Certificates renew themselves.** certbot checks every 12 h; nginx reloads
  every 6 h to pick up a renewed chain without dropping connections.

Docker restarts containers that *exit*, but not containers that are merely
reported *unhealthy*. If you want that too:

```bash
docker compose --profile autoheal up -d
```

This adds a watcher that restarts unhealthy containers. It needs
`/var/run/docker.sock`, which is effectively root on the host — it's opt-in for
exactly that reason.

## Troubleshooting

**`certbot failed` / browser shows a certificate warning.** DNS or firewall.
Check both records resolve to this host and that :80 is reachable from the
internet, then `./start.sh --skip-build`. While debugging, set
`LETSENCRYPT_STAGING=1` — production allows only 5 failures per hostname per
hour.

```bash
dig +short trademart.online www.trademart.online
docker compose logs nginx | tail -50
```

**Backend restart loop.** Almost always failed env validation, which exits 1
with a precise message:

```bash
docker compose logs backend | tail -30
```
Under `NODE_ENV=production` the API *requires* `MONGODB_URI`, a valid
`SHOPIFY_STORE_DOMAIN`, and Shopify credentials.

**Frontend says "Could not reach the Trademart backend".** The value baked into
the bundle is wrong. Confirm `NEXT_PUBLIC_API_BASE_URL=/api`, then rebuild —
editing `.env` alone will not change an already-built bundle:

```bash
docker compose build frontend && make start
```

**502 from `/api`.** `docker compose ps backend` — if it's healthy, check
`docker compose logs nginx`.

**Webhooks rejected.** `SHOPIFY_WEBHOOK_SECRET` must match the value Shopify
signs with; without it every delivery is refused. Register the endpoint as
`https://trademart.online/api/webhooks/shopify`.

## Known gaps

- **No lockfiles are committed** in either repo, so both Dockerfiles use
  `npm install` and builds are not byte-reproducible. Commit
  `package-lock.json` in both repos and switch the Dockerfiles to `npm ci`.
- **Mongo runs unreplicated** with no automated backup. Before this carries real
  data, add a `mongodump` sidecar or move to Atlas (set `MONGODB_URI` to the
  `mongodb+srv://` string and drop the `mongo` service).
- **No Content-Security-Policy.** Next.js needs a nonce/hash strategy for its
  inline hydration script, which is an application change rather than an nginx
  one.

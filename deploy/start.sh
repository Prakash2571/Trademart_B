#!/usr/bin/env bash
#
# Trademart - one command to bring the whole stack up and keep it up.
#
#   ./start.sh                 build, boot, obtain TLS certificates if missing
#   ./start.sh --skip-build    boot using the images already built
#   ./start.sh --force-renew   re-issue the certificate even if a valid one exists
#
# Idempotent: safe to re-run after every deploy or config change.
#
# Why a script and not just `docker compose up -d`: nginx cannot bind :443
# without a certificate file on disk, and certbot's http-01 challenge cannot be
# answered without nginx running. This breaks that cycle by planting a
# throwaway self-signed certificate on the very first run, starting nginx, and
# only then asking Let's Encrypt for the real one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FORCE_RENEW=0
SKIP_BUILD=0

usage() {
  sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --force-renew) FORCE_RENEW=1 ;;
    --skip-build)  SKIP_BUILD=1 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "start.sh: unknown option '$arg'" >&2; usage >&2; exit 2 ;;
  esac
done

# --- output helpers ----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }

# --- preflight ---------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 \
  || die "'docker compose' (v2) is required. The legacy docker-compose binary is not supported."
docker info >/dev/null 2>&1 \
  || die "cannot talk to the Docker daemon. Is it running, and is your user in the 'docker' group?"

[ -f .env ] || die ".env not found. Run: cp .env.example .env  and fill it in."

# Read a value out of .env WITHOUT sourcing it, so a stray character in a
# password cannot execute anything.
env_get() {
  sed -n "s/^[[:space:]]*$1=//p" .env | head -n1 | sed 's/[[:space:]]*$//'
}

DOMAIN="$(env_get DOMAIN)"
EMAIL="$(env_get LETSENCRYPT_EMAIL)"
TLS_MODE="$(env_get TLS_MODE)"; TLS_MODE="${TLS_MODE:-letsencrypt}"
STAGING="$(env_get LETSENCRYPT_STAGING)"; STAGING="${STAGING:-0}"
HTTP_PORT="$(env_get HTTP_PORT)"; HTTP_PORT="${HTTP_PORT:-80}"

[ -n "$DOMAIN" ] || die "DOMAIN is not set in .env"

MONGODB_URI="$(env_get MONGODB_URI)"
[ -n "$MONGODB_URI" ] || die "MONGODB_URI is not set in .env. Point it at your MongoDB Atlas (or other) server, or enable the bundled database via COMPOSE_FILE (see the comments in .env.example)."
case "$MONGODB_URI" in
  *"<user>"*|*"<password>"*|*"<cluster>"*|*"<same password>"*|*CHANGE_ME*)
    die "MONGODB_URI still contains a placeholder. Replace <user>/<password>/<cluster> with your real connection string." ;;
esac

# Sanity-check the two ways of running Mongo against each other.
COMPOSE_FILE_VAL="$(env_get COMPOSE_FILE)"
case "$MONGODB_URI" in
  *"@mongo:"*)
    case "$COMPOSE_FILE_VAL" in
      *local-db*) : ;;
      *) die "MONGODB_URI points at the internal 'mongo' host, but the local database is not enabled. Add to .env: COMPOSE_FILE=docker-compose.yml:docker-compose.local-db.yml" ;;
    esac ;;
esac

FRONTEND_CONTEXT="$(env_get FRONTEND_CONTEXT)"; FRONTEND_CONTEXT="${FRONTEND_CONTEXT:-../../Trademart_F}"
[ -f "$FRONTEND_CONTEXT/Dockerfile" ] \
  || die "no Dockerfile at '$FRONTEND_CONTEXT'. Clone Trademart_F next to Trademart_B, or point FRONTEND_CONTEXT at it in .env."

case "$TLS_MODE" in
  letsencrypt)
    [ -n "$EMAIL" ] || die "LETSENCRYPT_EMAIL must be set when TLS_MODE=letsencrypt"
    [ "$HTTP_PORT" = "80" ] || warn "HTTP_PORT=$HTTP_PORT: Let's Encrypt always connects to port 80, so issuance will fail unless something else forwards :80 here."
    ;;
  selfsigned) ;;
  *) die "TLS_MODE must be 'letsencrypt' or 'selfsigned' (got '$TLS_MODE')" ;;
esac

LIVE_DIR="/etc/letsencrypt/live/$DOMAIN"

# Runs a throwaway shell inside the certbot image with the letsencrypt volume
# mounted read-write.
in_certbot() {
  docker compose run --rm --no-deps --entrypoint sh certbot -c "$1"
}

# --- 1. build ----------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
  step "Building backend and frontend images"
  docker compose build
  ok "images built"
else
  step "Skipping build (--skip-build)"
fi

# --- 2. make sure nginx has *some* certificate so it can bind :443 -----------
step "Checking TLS material for $DOMAIN"
CERT_STATE="$(in_certbot "
  if [ -s $LIVE_DIR/fullchain.pem ]; then
    if openssl x509 -in $LIVE_DIR/fullchain.pem -noout -issuer 2>/dev/null | grep -qi 'CN *= *trademart-bootstrap'; then
      echo bootstrap
    else
      echo real
    fi
  else
    echo none
  fi
" 2>/dev/null | tr -d '\r' | grep -E '^(none|bootstrap|real)$' | tail -n1 || true)"
CERT_STATE="${CERT_STATE:-none}"

if [ "$CERT_STATE" = "none" ]; then
  step "No certificate yet - planting a temporary self-signed one so nginx can start"
  in_certbot "
    mkdir -p $LIVE_DIR &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout $LIVE_DIR/privkey.pem \
      -out    $LIVE_DIR/fullchain.pem \
      -subj '/CN=trademart-bootstrap' \
      -addext 'subjectAltName=DNS:$DOMAIN,DNS:www.$DOMAIN' >/dev/null 2>&1 &&
    cp $LIVE_DIR/fullchain.pem $LIVE_DIR/chain.pem &&
    cp $LIVE_DIR/fullchain.pem $LIVE_DIR/cert.pem"
  CERT_STATE="bootstrap"
  ok "temporary certificate in place"
else
  ok "existing certificate found (state: $CERT_STATE)"
fi

# --- 3. validate the nginx configuration before anything binds a port --------
# Catches syntax errors and bad includes with a precise [emerg] line, instead of
# a container that silently crash-loops. `nginx -t` does NOT open listening
# sockets, so bind failures still surface only at startup - step 5 handles those.
step "Validating the nginx configuration"
if ! docker compose run --rm --no-deps --entrypoint /docker-entrypoint.sh nginx nginx -t; then
  die "nginx rejected its configuration - see the [emerg] line above. Fix deploy/nginx/, then re-run: ./start.sh --skip-build"
fi
ok "nginx configuration valid"

# --- 4. bring everything up --------------------------------------------------
step "Starting the stack"
docker compose up -d --remove-orphans
ok "containers started"

# --- 5. wait for nginx to actually serve -------------------------------------
# A config that passes `nginx -t` can still die on startup (a port already in
# use, or an address family the container does not support). Fail loudly here
# rather than pressing on to certbot, which would burn a rate-limited attempt
# against a server that is not listening.
nginx_ready() {
  docker compose exec -T nginx wget -q -O /dev/null http://127.0.0.1:8080/healthz 2>/dev/null
}

step "Waiting for nginx to accept requests"
NGINX_UP=0
for _ in $(seq 1 30); do
  if nginx_ready; then NGINX_UP=1; break; fi
  sleep 2
done

if [ "$NGINX_UP" -eq 0 ]; then
  echo >&2
  printf '%s---- docker compose logs nginx ----%s\n' "$BOLD" "$RESET" >&2
  docker compose logs --tail=40 --no-color nginx >&2 || true
  echo >&2
  die "nginx is not serving (see the log above). The stack is up but the site is down, so TLS issuance was skipped. Fix the cause, then re-run: ./start.sh --skip-build"
fi
ok "nginx is serving"

# Backend trouble is not fatal to the deploy - nginx keeps serving the site and
# only /api is affected - but it should be impossible to miss.
if ! docker compose exec -T backend node -e "process.exit(0)" 2>/dev/null; then
  warn "the backend container is not running - /api will return 502."
  warn "Under NODE_ENV=production the API exits 1 on incomplete config. The reason is in:"
  warn "  docker compose logs backend | tail -30"
fi

# --- 6. real certificate -----------------------------------------------------
if [ "$TLS_MODE" = "selfsigned" ]; then
  warn "TLS_MODE=selfsigned - browsers will show a certificate warning. Set TLS_MODE=letsencrypt and re-run once DNS points at this host."
elif [ "$CERT_STATE" = "bootstrap" ] || [ "$FORCE_RENEW" -eq 1 ]; then
  step "Requesting a certificate from Let's Encrypt for $DOMAIN and www.$DOMAIN"

  CERTBOT_ARGS="certonly --webroot --webroot-path /var/www/certbot"
  CERTBOT_ARGS="$CERTBOT_ARGS --email $EMAIL --agree-tos --no-eff-email --non-interactive"
  CERTBOT_ARGS="$CERTBOT_ARGS -d $DOMAIN -d www.$DOMAIN --key-type ecdsa"
  if [ "$STAGING" = "1" ]; then
    CERTBOT_ARGS="$CERTBOT_ARGS --staging"
    warn "LETSENCRYPT_STAGING=1 - issuing an UNTRUSTED staging certificate. Set it to 0 and run './start.sh --skip-build --force-renew' for a real one."
  fi
  # --force-renewal covers both cases: replacing the bootstrap cert, and an
  # explicit --force-renew. Passing it twice would make certbot complain.
  if [ "$CERT_STATE" = "bootstrap" ] || [ "$FORCE_RENEW" -eq 1 ]; then
    CERTBOT_ARGS="$CERTBOT_ARGS --force-renewal"
  fi

  # The temporary certificate lives where certbot wants to write, so clear it.
  if [ "$CERT_STATE" = "bootstrap" ]; then
    in_certbot "rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf" >/dev/null
  fi

  if docker compose run --rm --no-deps --entrypoint certbot certbot $CERTBOT_ARGS; then
    ok "certificate issued"
    docker compose exec -T nginx nginx -s reload
    ok "nginx reloaded with the new certificate"
  else
    warn "certbot failed. The site is still serving on HTTPS with the temporary self-signed certificate."
    warn "Usual causes: $DOMAIN / www.$DOMAIN do not resolve to this host yet, or inbound :80 is firewalled."
    warn "Fix DNS or the firewall, then re-run: ./start.sh --skip-build"
  fi
else
  ok "certificate already issued by a real CA - renewal is handled by the certbot service"
fi

# --- 7. report ---------------------------------------------------------------
echo
step "Stack status"
docker compose ps
echo
ok "https://$DOMAIN"
echo "   api      https://$DOMAIN/api/health"
echo "   webhooks https://$DOMAIN/api/webhooks/shopify"
echo
echo "   logs     docker compose logs -f"
echo "   stop     docker compose stop     (containers stay stopped)"
echo "   destroy  docker compose down     (add -v to also delete volumes)"

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

if grep -q 'CHANGE_ME_BEFORE_DEPLOY' .env; then
  die ".env still contains the CHANGE_ME_BEFORE_DEPLOY placeholder. Set a real MongoDB password (openssl rand -hex 24) in BOTH MONGO_INITDB_ROOT_PASSWORD and MONGODB_URI."
fi

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

# --- 3. bring everything up --------------------------------------------------
step "Starting the stack"
docker compose up -d --remove-orphans
ok "containers started"

# --- 4. real certificate -----------------------------------------------------
if [ "$TLS_MODE" = "selfsigned" ]; then
  warn "TLS_MODE=selfsigned - browsers will show a certificate warning. Set TLS_MODE=letsencrypt and re-run once DNS points at this host."
elif [ "$CERT_STATE" = "bootstrap" ] || [ "$FORCE_RENEW" -eq 1 ]; then
  step "Requesting a certificate from Let's Encrypt for $DOMAIN and www.$DOMAIN"

  # Wait for nginx to actually answer the challenge path before asking the CA,
  # so a slow start does not burn a rate-limited failure.
  for _ in $(seq 1 30); do
    if docker compose exec -T nginx wget -q -O /dev/null http://127.0.0.1:8080/healthz 2>/dev/null; then
      break
    fi
    sleep 2
  done

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

# --- 5. report ---------------------------------------------------------------
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
echo "   destroy  docker compose down     (add -v to delete the Mongo volume)"

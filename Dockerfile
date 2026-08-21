# syntax=docker/dockerfile:1
#
# Trademart backend - Express + TypeScript compiled to CommonJS.
#
# Four stages so the runtime image carries neither the TypeScript compiler nor
# any devDependency: install (all deps) -> compile -> install (prod deps only)
# -> runtime.
#
# REPRODUCIBLE BUILDS
# -------------------
# `npm ci` only, from a committed package-lock.json. There is deliberately no
# `npm install` fallback and no `package-lock.json*` wildcard: a fallback means
# the image contains whatever versions were newest at build time, so rebuilding
# the same commit next month can produce a different image. If the lockfile is
# missing, the COPY below fails immediately with a clear error - which is the
# intended behaviour, because an unreproducible production image is worse than a
# failed build.
#
# To create it (needs network access to the npm registry):
#   npm install --package-lock-only && git add package-lock.json
#
# BASE IMAGE PINNING
# ------------------
# Pinned to a specific Node minor + Alpine version rather than `node:22-alpine`,
# so a base-image refresh cannot silently change the runtime under a deployed
# app. See docs/DEPLOYMENT.md for the update procedure.
ARG NODE_IMAGE=node:22.14.0-alpine3.21

# ---------------------------------------------------------------- deps --------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --------------------------------------------------------------- build --------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# tsconfig excludes src/**/*.test.ts, so tests are not emitted into dist/.
RUN npm run build

# ---------------------------------------------------------- prod-deps ---------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ------------------------------------------------------------- runtime --------
FROM ${NODE_IMAGE} AS runtime

# dumb-init reaps zombies and forwards SIGTERM, so src/server.ts can run its
# graceful-shutdown handler on `docker compose stop`.
RUN apk add --no-cache dumb-init

# Build metadata, surfaced by GET /api/version. This is what makes it possible to
# tell which commit a running container was built from - a locally built
# `:latest` is otherwise indistinguishable from any other `:latest`.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG APP_VERSION=0.2.0

ENV NODE_ENV=production \
    PORT=4000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME} \
    APP_VERSION=${APP_VERSION}

LABEL org.opencontainers.image.title="trademart-backend" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}"

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 4000

# LIVENESS, not readiness. /api/health/live checks only that this process is
# answering, which is the sole thing a container restart could fix.
#
# Using /api/health/ready here would be a mistake: readiness fails when Mongo is
# unreachable, and restarting the container cannot fix a database that lives
# somewhere else - it would turn a temporary outage into a crash loop. The
# orchestrator (or a load balancer) should poll /api/health/ready separately to
# decide about traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]

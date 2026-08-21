# syntax=docker/dockerfile:1
#
# Trademart backend - Express + TypeScript compiled to CommonJS.
#
# Four stages so the runtime image carries neither the TypeScript compiler nor
# any devDependency: install (all deps) -> compile -> install (prod deps only)
# -> runtime.
#
# DEPENDENCY INSTALL: `npm ci` only.
#
# package-lock.json is committed, so both install stages use npm ci - the exact
# resolved tree, verified against the integrity hashes in the lockfile.
#
# The COPY has no wildcard and the RUN has no fallback, both deliberately. There
# used to be an `npm install` fallback for when no lockfile existed. Now that one
# does, that fallback would be actively harmful: a missing or mismatched lockfile
# would silently resolve fresh versions instead of failing, so the image could
# contain dependency versions that CI never tested. A build that fails because the
# lockfile is wrong is the outcome we want.

# ---------------------------------------------------------------- deps --------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --------------------------------------------------------------- build --------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# tsconfig excludes src/**/*.test.ts, so tests are not emitted into dist/.
RUN npm run build

# ---------------------------------------------------------- prod-deps ---------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev keeps the TypeScript compiler and @types out of the runtime image.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# ------------------------------------------------------------- runtime --------
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards SIGTERM, so src/server.ts can run its
# graceful-shutdown handler on `docker compose stop`.
RUN apk add --no-cache dumb-init

# Build identity, surfaced by GET /api/version.
#
# Baked in at build time rather than read from a mounted file or by shelling out
# to git, because the runtime image contains no .git directory. Without these,
# /api/version answers "unknown" and cannot do the one job it exists for:
# confirming which commit a running container was built from. When a Compose stack
# is built locally from a working tree, the package version alone cannot tell two
# images apart.
#
# Defaults keep a plain `docker build` working; deploy/docker-compose.yml and CI
# pass the real values.
ARG APP_VERSION=unknown
ARG GIT_SHA=unknown
ARG BUILD_TIME=""

ENV NODE_ENV=production \
    PORT=4000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 4000

# LIVENESS, not readiness - and now says so explicitly by probing /api/health/live
# rather than relying on /api/health happening to always return 200.
#
# A failing Docker healthcheck gets the container restarted, and a restart cannot
# fix a dependency that lives in another container. Probing readiness here would
# turn a temporary Mongo blip into a crash loop. /api/health/live checks nothing
# but this process, so it fails only when a restart is actually the right answer.
#
# Use /api/health/ready from a load balancer or a deploy gate, where "stop sending
# traffic" is the correct response instead of "restart".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]

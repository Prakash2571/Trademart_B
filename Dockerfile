# syntax=docker/dockerfile:1
#
# Trademart backend - Express + TypeScript compiled to CommonJS.
#
# Four stages so the runtime image carries neither the TypeScript compiler nor
# any devDependency: install (all deps) -> compile -> install (prod deps only)
# -> runtime.
#
# DEPENDENCY INSTALL: `npm ci` when a lockfile is committed, `npm install`
# otherwise. npm ci is strictly better - it installs exactly what the lockfile
# pins and fails if package.json disagrees - but it REQUIRES the lockfile, so an
# unconditional `npm ci` would make the image unbuildable until one is added.
#
# The wildcard in the COPY is what makes this work: `package-lock.json*` matches
# zero files without erroring. Commit a lockfile and both install stages switch
# to npm ci on the next build with no edit here.
#   npm install --package-lock-only && git add package-lock.json

# ---------------------------------------------------------------- deps --------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      echo "Lockfile present - npm ci"; npm ci --no-audit --no-fund; \
    else \
      echo "WARNING: no package-lock.json - falling back to npm install; this build is not reproducible"; \
      npm install --no-audit --no-fund; \
    fi

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
COPY package.json package-lock.json* ./
# --omit=dev keeps the TypeScript compiler and @types out of the runtime image.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

# ------------------------------------------------------------- runtime --------
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards SIGTERM, so src/server.ts can run its
# graceful-shutdown handler on `docker compose stop`.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=4000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 4000

# /api/health always answers 200 while the process is alive (it reports a
# degraded database in the body rather than failing), so this is a liveness
# probe, not a readiness probe. That is deliberate: the API is designed to keep
# serving Shopify reads and pricing when Mongo is unreachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]

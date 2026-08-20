# syntax=docker/dockerfile:1
#
# Trademart backend - Express + TypeScript compiled to CommonJS.
#
# Four stages so the runtime image carries neither the TypeScript compiler nor
# any devDependency: install (all deps) -> compile -> install (prod deps only)
# -> runtime.
#
# NOTE: no package-lock.json is committed in this repo, so `npm install` is used
# instead of `npm ci`. Commit a lockfile and switch to `npm ci` when you want
# byte-reproducible builds.

# ---------------------------------------------------------------- deps --------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

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
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

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

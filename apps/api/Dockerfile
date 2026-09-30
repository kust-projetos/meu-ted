# Monorepo Dockerfile for meu-ted-api
# Baseline: Node 24 Alpine, pnpm 10 (matching VPS production)
# Build from repo root: docker build -f apps/api/Dockerfile .

FROM node:24-alpine AS builder
# CVE-2026-14456 libcrypto3/libssl3 3.5.7-r0 -> 3.5.8-r0: force upgrade on alpine 3.24
RUN apk update && apk upgrade --no-cache libcrypto3 libssl3
RUN npm install -g pnpm@10.34.1
WORKDIR /monorepo

# Copy workspace config and root lockfile
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# Workspace package manifests are required for workspace:* resolution.
COPY packages packages
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts=false

# Copy API source and build
COPY apps/api apps/api
RUN pnpm --filter @pi-finance/llm-contracts build
WORKDIR /monorepo/apps/api
RUN pnpm build
# Ship only api prod deps (excludes root dev/peer-only subtrees like next/sharp
# pulled in via better-auth's optional framework peers at monorepo install time).
RUN pnpm deploy --legacy --filter meu-ted-api --prod /runtime

FROM node:24-alpine AS runner

RUN apk update && apk upgrade --no-cache libcrypto3 libssl3
# Trivy flags undici bundled with the npm CLI (node:24-alpine ships npm in the
# base image). The runtime only runs `node dist/server/index.js` — it never
# needs npm/npx/corepack — so drop the bundled npm from the FINAL stage only
# (build stages above keep npm to install pnpm).
RUN rm -rf /usr/local/lib/node_modules/npm
RUN addgroup -g 10001 -S appgroup && adduser -u 10001 -S appuser -G appgroup
WORKDIR /monorepo/apps/api

COPY --from=builder /runtime/package.json ./package.json
COPY --from=builder /runtime/node_modules ./node_modules
COPY --from=builder /monorepo/apps/api/dist ./dist
# Migration job resolves .sql files next to its compiled module
# (MIGRATIONS_DIR = dirname(dist/read-models/sql/migrate.js)); tsc does not
# copy .sql assets, so ship them explicitly.
COPY --from=builder /monorepo/apps/api/src/read-models/sql/ ./dist/read-models/sql/

# pnpm deploy --prod keeps better-auth's optional framework peers (next) and
# next's optional native dep (sharp): neither is ever imported by this fastify
# runtime (no `next`/`sharp` import in apps/api/src; better-auth is used via its
# core + plugins + memory adapter only). Prune those peer-only subtrees so they
# don't ship their CVEs in the image. React peers are kept (harmless, tiny).
RUN rm -rf node_modules/.pnpm/next@* node_modules/.pnpm/sharp@* node_modules/.pnpm/@img+* node_modules/next node_modules/sharp

USER appuser:appgroup

EXPOSE 3001
ENV NODE_ENV=production
ENV MIGRATIONS_MODE=disabled
# V4.1 Phase 9 (Task 9.9): release identity baked at image build
# (docker --build-arg; dev defaults otherwise). Surfaced via GET /health.
ARG BUILD_SHA=dev
ARG BUILD_ID=dev
ARG BUILD_TIME=dev
ENV BUILD_SHA=$BUILD_SHA BUILD_ID=$BUILD_ID BUILD_TIME=$BUILD_TIME
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget --spider --quiet http://127.0.0.1:3001/health || exit 1
CMD ["node", "dist/server/index.js"]

FROM node:24-alpine AS builder

# CVE-2026-14456 libcrypto3/libssl3 3.5.7-r0 -> 3.5.8-r0: force upgrade on alpine 3.24
RUN apk update && apk upgrade --no-cache libcrypto3 libssl3
RUN npm install -g pnpm@10.34.1
WORKDIR /monorepo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/codex-broker/package.json apps/codex-broker/package.json
RUN pnpm install --frozen-lockfile --filter pi-finance-codex-broker...

COPY apps/codex-broker/tsconfig.json apps/codex-broker/tsconfig.build.json apps/codex-broker/
COPY apps/codex-broker/src/ apps/codex-broker/src/
WORKDIR /monorepo/apps/codex-broker
RUN pnpm build
RUN pnpm deploy --legacy --filter pi-finance-codex-broker --prod /runtime
# CVE-2026-93749: the legacy deploy copies stale virtual-store entries into the
# runtime layer. The broker production graph (fastify, zod) declares NO
# source-map-js dependency, so an orphaned 1.2.1 copy is unreachable by node
# resolution (pnpm isolated mode) and is removed so the image ships only
# declared packages.
RUN rm -rf /runtime/node_modules/.pnpm/source-map-js@1.2.1

FROM node:24-alpine AS runner

# Keep OS libs at the same fixed level as the builder stage.
RUN apk update && apk upgrade --no-cache libcrypto3 libssl3
# Trivy flags undici bundled with the npm CLI (node:24-alpine ships npm in the
# base image). The runtime only runs `node dist/server.js` — it never needs
# npm/npx/corepack — so drop the bundled npm from the FINAL stage only
# (the builder stage above keeps npm to install pnpm).
RUN rm -rf /usr/local/lib/node_modules/npm
WORKDIR /monorepo/apps/codex-broker
ENV NODE_ENV=production
ENV PORT=3005

RUN addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup && \
    mkdir -p /var/lib/codex-auth && \
    chown -R appuser:appgroup /var/lib/codex-auth && \
    chmod 700 /var/lib/codex-auth

USER appuser:appgroup

COPY --from=builder /runtime/package.json ./package.json
COPY --from=builder /runtime/node_modules ./node_modules
COPY --from=builder /monorepo/apps/codex-broker/dist ./dist

EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget --spider --quiet http://127.0.0.1:3005/health || exit 1

CMD ["node", "dist/server.js"]

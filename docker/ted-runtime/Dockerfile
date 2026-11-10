# TED runtime (OpenCode) — production image.
#
# Build context is the REPOSITORY ROOT (the workspace lockfile is required):
#   docker build -f docker/ted-runtime/Dockerfile -t ted-runtime:local .
#
# The image carries no secret: OPENCODE_GO_API_KEY is injected by the host
# environment at run time (compose), never baked into a layer.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
# Pin the workspace package manager: the lockfile is pnpm 10 and the root
# `pnpm.overrides` are only honored by that major (pnpm 11+ ignores them and
# refuses the frozen install).
RUN npm install -g pnpm@10.34.1 && pnpm --version

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/ted-runtime/package.json apps/ted-runtime/package.json
RUN pnpm install --filter pi-finance-ted-runtime --frozen-lockfile --prod --ignore-scripts

COPY apps/ted-runtime/src apps/ted-runtime/src

# Persistent runtime home: conversations metadata + the native SDK sqlite.
# Owned by the unprivileged `node` user that runs the process.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV TED_RUNTIME_HOME=/data
EXPOSE 3101
CMD ["node", "apps/ted-runtime/src/main.mjs"]

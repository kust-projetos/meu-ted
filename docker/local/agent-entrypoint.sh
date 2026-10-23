#!/bin/bash
# Entrypoint do agent local: gera .dev.vars a partir do ambiente (fonte única:
# compose) e sobe `wrangler dev --local`. Nada de segredo é embutido na imagem.
set -euo pipefail
cd /monorepo/apps/agent
: "${API_ORIGIN:?API_ORIGIN é obrigatório}"
: "${AGENT_CONFIG_TOKEN:?AGENT_CONFIG_TOKEN é obrigatório}"
: "${AGENT_RUNTIME_ADMIN_TOKEN:?AGENT_RUNTIME_ADMIN_TOKEN é obrigatório}"
: "${AGENT_CONNECTION_TOKEN_SECRET:?AGENT_CONNECTION_TOKEN_SECRET é obrigatório}"
: "${AGENT_AUTH_SERVICE_TOKEN:?AGENT_AUTH_SERVICE_TOKEN é obrigatório}"
: "${AGENT_DELEGATION_SECRET:?AGENT_DELEGATION_SECRET é obrigatório}"
cat > .dev.vars <<EOF
# Gerado pelo entrypoint (docker/local). Não commitar segredos aqui além de
# defaults de desenvolvimento (iguais aos defaults do código da API).
API_ORIGIN=${API_ORIGIN}
AGENT_CONFIG_TOKEN=${AGENT_CONFIG_TOKEN}
AGENT_RUNTIME_ADMIN_TOKEN=${AGENT_RUNTIME_ADMIN_TOKEN}
AGENT_CONNECTION_TOKEN_SECRET=${AGENT_CONNECTION_TOKEN_SECRET}
AGENT_AUTH_SERVICE_TOKEN=${AGENT_AUTH_SERVICE_TOKEN}
AGENT_DELEGATION_SECRET=${AGENT_DELEGATION_SECRET}
PWA_ORIGIN=${PWA_ORIGIN:-http://localhost:3000}
ALLOW_LOCAL_ORIGIN=${ALLOW_LOCAL_ORIGIN:-1}
TED_ATTACHMENTS_ENABLED=0
EOF
echo "[agent-local] .dev.vars gerado; subindo wrangler dev --local na porta ${AGENT_PORT:-8787}"
# Entry point shim (src/worker.local-entry.ts): re-exporta SÓ { default,
# FinanceChatAgent }. O workerd local valida os exports do entrypoint e
# rejeita os consts auxiliares exportados em worker.ts (ex.
# EXPECTED_PWA_ORIGIN) que o deploy de produção tolera. Shim é só-local;
# produção continua usando src/worker.ts sem alteração.
exec pnpm exec wrangler dev --local --port "${AGENT_PORT:-8787}" --ip 0.0.0.0 --persist-to /state src/worker.local-entry.ts

# Agent LLM Secret Provisioning Guide

Este guia detalha o provisionamento seguro de segredos e credenciais para o assistente financeiro TED e o runtime de modelos LLM.

---

## 1. Princípios de Segurança

1. **Zero Segredos em Código**: Nenhuma chave de API, segredo HMAC ou token de serviço deve constar em commits, logs ou respostas HTTP.
2. **Isolamento por Ambiente**: Chaves de staging e produção devem ser distintas e segregadas.
3. **Princípio do Menor Privilégio**: Tokens delegados possuem escopo limitado ao workspace e TTL restrito.

---

## 2. Segredos Obrigatórios por Componente

### 2.1 Backend Autoritativo (`apps/api`)
- `AGENT_RUNTIME_ORIGIN`: URL base do Cloudflare Worker do assistente.
- `AGENT_RUNTIME_ADMIN_TOKEN`: Token compartilhado para chamadas administrativas e sincronização de runtime.
- `AGENT_CONNECTION_TOKEN_SECRET`: Segredo HMAC para emissão e validação de tokens curtos de conexão com anti-replay.
- `AGENT_AUTH_SERVICE_TOKEN`: Token de autenticação interna do serviço de agente.
- `AGENT_CONFIG_TOKEN`: Token para consulta e validação de configuração em tempo de execução.
- `AGENT_DELEGATION_SECRET`: Segredo HMAC para assinatura de tokens delegados de workspace.
- Chaves de provedor usadas pelo relay LLM (`/internal/agent/llm-relay`) — obrigatória a do par ativo/fallback:
  - `OPENCODE_ZEN_API_KEY`
  - `OPENCODE_GO_API_KEY`: exigida pelo relay para o provider `opencode-go` (o upstream Go, além da chave, exige o header `x-opencode-session`, enviado pelo relay com o `sessionId` estável por conversa).
  - `OPENAI_API_KEY`
  - `OPENROUTER_API_KEY`

### 2.2 Assistente Cloudflare Worker (`apps/agent`)
- `PI_API_ORIGIN`: Origem autoritativa da API (`https://api.synkroo.com.br` em produção).
- `PI_DELEGATED_TOKEN_SECRET`: Segredo HMAC correspondente para validação de tokens delegados.
- `AGENT_CONNECTION_TOKEN_SECRET`: Segredo HMAC correspondente para validação de conexão cliente.
- Provedores Diretos (pelo menos um obrigatório):
  - `OPENCODE_ZEN_API_KEY`: Chave de API para OpenCode Zen.
  - `OPENCODE_GO_API_KEY`: Chave de API para OpenCode Go.
  - `OPENAI_API_KEY`: Chave de API direta da OpenAI.

### 2.3 Broker de Assinatura Privado (`apps/codex-broker` - opcional/isolado)
- `CODEX_BROKER_ORIGIN`: Origem HTTPS do broker isolado.
- `CODEX_BROKER_ACCESS_CLIENT_ID`: Client ID do Cloudflare Access.
- `CODEX_BROKER_ACCESS_CLIENT_SECRET`: Client Secret do Cloudflare Access.
- `CODEX_BROKER_REQUEST_SIGNING_KEY`: Chave de assinatura HMAC (30s envelope).

---

## 3. Procedimento de Rotação de Segredos

1. Atualizar o segredo na VPS / Cloudflare Secrets (`wrangler secret put`).
2. Incrementar o `securityEpoch` via painel administrativo para invalidar tokens de sessão e conexões ativas emitidas sob a época anterior.
3. Verificar a integridade das conexões com `pnpm test` e endpoints de probe.

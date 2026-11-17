# Agent LLM Secret Provisioning Guide

> **Atualização 2026-11-17:** a API não mantém mais rotas de configuração
> LLM, relay nem consumo one-shot de token de conexão. O runtime conversacional
> atual é `apps/ted-runtime` e usa modelo pinado em `src/live-model.json`.
> As referências abaixo ao A0/Worker e ao relay são históricas, não instruções
> de provisionamento da API atual.

Este guia detalha o provisionamento seguro de segredos e credenciais para o assistente financeiro TED e o runtime de modelos LLM.

---

## 1. Princípios de Segurança

1. **Zero Segredos em Código**: Nenhuma chave de API, segredo HMAC ou token de serviço deve constar em commits, logs ou respostas HTTP.
2. **Isolamento por Ambiente**: Chaves de staging e produção devem ser distintas e segregadas.
3. **Princípio do Menor Privilégio**: Tokens delegados possuem escopo limitado ao workspace e TTL restrito.

---

## 2. Segredos Obrigatórios por Componente

### 2.1 Backend Autoritativo (`apps/api`)
- `AGENT_CONNECTION_TOKEN_SECRET`: segredo HMAC para mint de tokens curtos de conexão.
- `AGENT_AUTH_SERVICE_TOKEN`: token de autenticação interna usado pelo depósito de atestação e rotas server-to-server existentes.
- `PI_DELEGATED_TOKEN_SECRET`: segredo HMAC para assinatura de tokens delegated de workspace.
- Tokens de mint Pending/autoexec são configurados no runtime TED (`TED_RUNTIME_PENDING_MINT_TOKEN` e `TED_RUNTIME_AUTOEXEC_MINT_TOKEN`); não substituem nem removem os segredos acima.

### 2.2 Assistente Cloudflare Worker (`apps/agent`, descontinuado)
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

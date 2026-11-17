# Plano de corte — TED OpenCode-only

## Versões

- Merge em `main`: `25457482fe857159eeb80abb480ebea0b944f3be`.
- Versões atualmente publicadas:
  - API: **NOT_VERIFIED — confirmar com operador**.
  - PWA: **NOT_VERIFIED — confirmar com operador**.
  - Gateway `ted-runtime`: **NOT_VERIFIED — confirmar com operador**.

## Ordem de publicação

1. **API** — publicar primeiro o contrato e as flags de Pending V2.
2. **Gateway `ted-runtime`** — depende do contrato e dos tokens da API.
3. **PWA** — seu fluxo TED é gateway-only e depende do gateway pronto.
4. **Smoke** — verificar o conjunto integrado sem movimentação financeira real.

## Configuração

Configurar pelos mecanismos seguros de cada ambiente, apenas com os nomes abaixo
neste plano. Nunca registrar valores de segredo no repositório:

- API: `TED_RUNTIME_PENDING_MINT_TOKEN`.
- Gateway: `TED_PENDING_MINT_TOKEN`.
- API/gateway conforme o contrato de exclusão: `TED_WORKSPACE_DELETION_SERVICE_TOKEN`
  e `WORKSPACE_DELETION_HMAC_SECRET`.
- API: `PENDING_V2_SUPERSEDE_ENABLED=1` (**obrigatório para correção**).
- Gateway: `TED_OPENCODE_PRODUCT_PROMPT_ENABLED=1` e
  `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1`.
- PWA: `TED_OPENCODE_GATEWAY_ORIGIN` e `ALLOWED_ORIGINS`, com origens válidas
  para o ambiente do corte.

## Decisões e compatibilidade

- A criação autônoma de categoria fica limitada à autorização
  `categories.create`; isso não habilita autoexecução de receitas ou despesas.
- Não reintroduzir fallback, broker ou memória do A0.
- Publicação de imagem GHCR continua opt-in por `vars['PUBLISH_MAIN_IMAGE']`.
- Migrations novas nesta missão: **nenhuma**.
- Antes/depois da publicação, conferir compatibilidade de Pending V2, device
  tokens e inventário de workspace/exclusão.

## Testes e smoke

- Integração API/gateway Pending V2: 7/7 sintéticos.
- Executar CFR e smoke autenticado, sem movimentação financeira real.
- **Aceite operacional pendente:** uma jornada financeira única com LLM real
  em stack controlada. E2E real ainda não aprovado.

## Rollback

Preparar as versões anteriores de API, gateway e PWA; em caso de falha,
republicá-las na ordem inversa à publicação. Não restaurar A0 como serviço
permanente. Preservar dados e ledger; não apagar nem reverter dados financeiros
como parte do rollback.

## A0 e recursos de produção

Inventário conhecido a partir dos documentos do repositório; estado ao vivo
**NOT_VERIFIED** até auditoria pelo operador:

- Worker Cloudflare `pi-finance-agent`;
- Durable Object `FINANCE_CHAT_AGENT`;
- bucket `TED_ATTACHMENTS_BUCKET`;
- secrets/vars `AGENT_*`;
- workflow de deploy A0 removido do repositório; existência/estado de workflows
  externos não verificados.

Preservar os recursos e históricos A0 existentes até autorização específica.
Não houve auditoria ao vivo nem remoção nesta missão.

## Gate humano

Deploy/corte e remoção de recursos exigem autorização explícita. Nada foi
publicado, cortado ou removido nesta missão.

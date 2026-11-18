# Plano de corte — TED OpenCode-only

## Versões

- Merge em `main`: `25457482fe857159eeb80abb480ebea0b944f3be`.
- Versões publicadas confirmadas: API, PWA e gateway `ted-runtime` em
  `79d8b09`.

## Ordem de publicação

1. **API** — EXECUTADO: lane source-build via
   `scripts/ops/api-release-20260930.sh` para `79d8b09`; ci-run 44214219471.
2. **Gateway `ted-runtime`** — EXECUTADO: código instalado, config regenerada,
   secrets provisionados (nomes apenas), imagem `ted-runtime:main`; health
   healthy e rota responde 401 de auth.
3. **PWA** — EXECUTADO: run 44216692235 com gate, deploy, smoke e attestation
   success; `/api/build-info` confirma gitSha `79d8b092...`.
4. **Smoke** — EXECUTADO: pós-corte PWA 200, API /health 200 com gitSha
   79d8b09, gateway up (404 em rota desconhecida).

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
- **Aceite operacional APROVADO:** `p3-expense-real.spec.ts` passou 1 teste,
  sem retry, em stack sintética; evidência detalhada em
  [VALIDATION.md](VALIDATION.md). Custo/tokens: NOT_OBSERVED.

## Rollback

Versões/tag de rollback preservadas: API
`pi-finance-api:rollback-pre-79d8b09`, gateway
`ted-runtime:rollback-pre-79d8b09`; backup de config
`opencode.json.bak-pre-79d8b09`. Em caso de falha, republicar versões
anteriores na ordem inversa à publicação. Não restaurar A0 como serviço
permanente. Preservar dados e ledger; não apagar nem reverter dados financeiros
como parte do rollback.

## A0 e recursos de produção

Estado final confirmado:

- Worker Cloudflare `pi-finance-agent` removido (`wrangler delete`); secrets
  apagados junto.
- Bucket R2 `pi-finance-ted-attachments` e namespace/DO preservados por
  decisão do operador.

O endpoint do Worker A0 removido retorna 404. `apps/ted-runtime` é o gateway
único runtime conversacional.

## Gate humano

O corte e descomissionamento acima foram executados em 2026-11-18 conforme
decisão do operador.

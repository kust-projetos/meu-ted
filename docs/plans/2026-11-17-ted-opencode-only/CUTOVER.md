# Plano de corte — TED OpenCode-only

## Versões

- Merge em `main`: `25457482fe857159eeb80abb480ebea0b944f3be`.
- Baseline de produção atual (após deploy V2.1 em 2026-11-18): API, PWA e
  gateway `ted-runtime` em
  `9dc5d1c65883bfbce4dabaf43b2759919843f8e1` (anterior `79d8b09`).

## Ordem de publicação

1. **API** - EXECUTADO: wrapper `scripts/ops/api-release-20260930.sh`, lane source-build, CI run `44330661848`; backup `pre-90ec37f-20261118` (sha256 `f3dc4886165fd8b03f4a929c08286f5ad59a6adbfb7453449b77bb7ddef5d48a`); rollback tag `pi-finance-api:rollback-pre-9dc5d1c`; `/ready`=200.
2. **Gateway `ted-runtime`** - EXECUTADO: rollback tag `ted-runtime:rollback-pre-9dc5d1c`; config regenerada pelo bootstrap, backup `opencode.json.bak-pre-9dc5d1c`; token dedicado de categoria provisionado fora do repositório, mas flag efetiva de autoexecução = 0; health healthy e a rota pending retorna 401 sem sessão.
3. **PWA** - EXECUTADO: workflow `PWA Deploy` run `44336496351`, gate, deploy, smoke e attestation success; `/api/build-info` confirma gitSha `9dc5d1c...`.
4. **Smoke** — EXECUTADO: pós-corte PWA 200, API /health 200 com gitSha
   9dc5d1c, gateway up (404 em rota desconhecida).

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
`pi-finance-api:rollback-pre-9dc5d1c`, gateway
`ted-runtime:rollback-pre-9dc5d1c`; backup de config
`opencode.json.bak-pre-9dc5d1c`. As referências `pre-79d8b09` são históricas, do baseline anterior ao deploy V2.1. Em caso de falha, republicar versões
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

## Atualização V2.1 (2026-11-18)

PR #435 (`fix(gateway): inject category autoexec mint token into compose`) foi
mesclado antes do deploy. O token dedicado foi provisionado, mas
`TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0` efetivo; portanto, não existe cliente
de autoexecução no gateway e `categories.create` autoexec não está ativa.
`PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1`; `TED_RISK_BASED_AUTOEXECUTE=on` na
API é valor preexistente. A homologação integral com LLM real (P5) permanece
**INCONCLUSIVE**. Detalhes em
`../2026-11-18-ted-financial-intelligence-v2.1/VALIDATION.md`.

**Nota operacional:** o gateway teve 14 falhas de boot com
`writeTedConfig: opencode.json already exists with different content — refusing to overwrite user work`;
o 15º boot sucedeu após substituição do config stale. Um redeploy que altere
config gerada pode repetir a falha.

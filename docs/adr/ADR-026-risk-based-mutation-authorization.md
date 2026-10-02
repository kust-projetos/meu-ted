# ADR-026 — Autorização de mutações baseada em risco

**Status:** Aceito  
**Data:** 2026-10-02

## Contexto

A autorização de mutações financeiras precisa distinguir confirmação humana de
autorização técnica. A confirmação humana não deve ser requisito universal para
toda escrita de baixo risco, mas sua remoção não pode depender de julgamento do
modelo. A API continua sendo a única autoridade financeira e o protocolo
PendingOperation V2 permanece obrigatório.

## Decisão

1. Somente uma política determinística executada pela API pode autorizar
   execução automática; o LLM nunca concede autorização.
2. A allowlist inicial contém exclusivamente
   `transactions.expense.create` e `transactions.income.create`. Operações
   destrutivas sempre exigem confirmação manual; riscos elevados ou incertos
   também não são executados silenciosamente.
3. PendingOperation V2 continua obrigatório, incluindo seus vínculos e
   idempotência. O registro da decisão será persistido nos campos aditivos da
   V059.
4. Rollout: **OFF → SHADOW → CANARY → LOW-RISK 100%**, com kill switch
   `TED_RISK_BASED_AUTOEXECUTE` (`off|shadow|on`), cujo default é `off`.

## Invariantes

- A API é a única autoridade financeira; política e dados de workspace são
  avaliados server-side.
- O modelo não escolhe nível de risco nem concede autorização.
- Mutação automática só ocorre para ferramentas explicitamente allowlisted e
  decisão `auto_execute` determinística.
- Operações destrutivas permanecem sempre manuais.
- Pendências legadas preservam colunas de auditoria nulas; a V059 não muda por
  si só o fluxo de confirmação ou execução.

## Consequências

- A política mantém compatibilidade com a decisão binária legada enquanto
  fornece decisão de risco aditiva.
- V059 prepara auditoria; os fluxos de confirmação e autorização que preenchem
  esses campos pertencem a trabalho posterior.
- V059 é **canonical-only** (justificativa em `LEGACY_EXCLUDED_JUSTIFICATIONS`
  em `apps/api/src/read-models/sql/migrate.ts`): o ledger do arquivo legacy
  permanece em V054 — uma entrada V059 no manifest legacy faria o verifySchema
  falhar fechado — e a auditoria de autorização só é escrita pelos caminhos
  canônicos de confirm/authorize.
- **Este ADR não autoriza deploy, execução de DML/DDL em produção, acesso à
  produção/VPS, nem alteração de dados.** Arquivos de migration no repositório
  são código; sua execução em produção continua sujeita a gates próprios.

## Referências

- `docs/MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md`.
- `docs/reports/2026-10-02-ted-risk-authorization-spec-review.md`.
- `apps/api/src/approvals/policy.ts`.
- `apps/api/src/approvals/tool-registry.ts`.
- `apps/api/src/read-models/sql/V059__pending_operation_authorization.sql`.

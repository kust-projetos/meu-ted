# Plano — Canonical Cutover (rascunho para aprovação)

**Status:** PROPOSTO — aguarda aprovação do owner. Nenhum passo foi executado.

> **Reavaliação 2026-09-26:** o owner confirmou que todos os dados atuais de
> produção são testes descartáveis e autorizou ajustá-los. O F2 local sobre
> dump anonimizado anterior passou para o algoritmo antigo, mas após corrigir
> a dívida de cartão a conversão desse dump falha corretamente em despesa de
> cartão sem fatura; não converter nem silenciar o bloqueio. Para esta base,
> a rota proposta é backup verificado do banco legado, banco canônico **novo e
> separado** com V001–V058, rollout da API revisada por digest e bootstrap de
> acesso administrativo pelo fluxo autorizado. Não alterar nem descartar o
> banco legado ou volumes compartilhados; ele permanece como rollback. A
> sequência F3–F5 abaixo descreve a conversão de dados que se optou por não
> executar neste cenário e não deve ser usada como comando de operação.

**Pré-requisitos já satisfeitos (SPEC §21):** V4.1 Closure DONE (PR #11/#12; produção `d5ba79d` nos 3 apps) · reconciliação compreendida (1 finding conhecido, dossier pronto) · nenhum drift novo inexplicado · rollback comprovado (tag `rollback-pre-d5ba79d` + rehearsal de backup-restore).

## Objetivo

Migrar a produção do schema `legacy` para o `canonical` (DB_SCHEMA=canonical), eliminando a dupla manutenção de stores e o gap estrutural entre os dois layouts, sem perda de dados financeiros e com rollback provado.

## Ferramentas existentes (não recriar)

- `apps/api`: `pnpm canonical:preflight` (conversão, dry-read), `migrate-job.js` com filtro `LEGACY_SAFE_PREFIXES`, runner canonical completo.
- `scripts/rehearse-migration.mjs` (`--dry-run` validado) + `backup-restore-rehearsal.test.mjs` (PostgreSQL descartável, dump íntegro, contagens).
- Suites de paridade: `postgres-canonical-parity-v41`, `v4.1-canonical-parity.md`, `v4.1-canonical-readiness.md` (baseline "PRONTO PARA PLANEJAR").
- Reconciliação read-only com layout `auto` (`--schema=auto|legacy|canonical`).

## Fases (cada uma com gate explícito)

> **Atualização 2026-09-22 (pós-autorização):** a investigação de execução revelou dois fatos que redesenham o plano.
>
> 1. **F1 é impossível por design**: V055–V057 são **canonical-only** (`apps/api/src/read-models/sql/migrate.ts` — entradas no manifesto legacy fariam o `verifySchema` falhar fechado e recusar o boot). As migrations aplicam-se apenas no momento da conversão → F1 dobra para dentro da F3.
> 2. **O conversor legacy→canonical não existe no repositório** — só o `canonical-conversion-preflight.ts` (queries de prontidão) e o rehearse de migrations. A F2 (conversão em cópia) e a F3 (conversão em produção) dependem de **construir e ensaiar o conversor** — projeto próprio, com provas de paridade linha a linha.
>
> **Status real: BLOQUEADO na construção do conversor.** Próximo passo executável: projeto "conversor canonical" (spec → implementação → rehearsal em cópia → paridade → então F3/F4 abaixo).
>
> **Atualização 2026-09-25:** o conversor foi **implementado** (branch `feat/canonical-converter`, pendente de PR/review/CI): pipeline plan → archive/bootstrap → import → identidade → saldos → verify → marker, com ADR-025 fixando as decisões (arquivamento integral em `legacy_archive`, ledger autêntico, audit só no arquivo, âncora de saldo V058 + reconciliação canônica `âncora + ledger`, bigint exato, fail-closed sem retomada parcial). O ensaio da F2 é executável localmente via `scripts/rehearse-canonical-conversion.mjs` (PostgreSQL descartável + dump anonimizado). Correção de rollback (ADR-025 §Consequências): após o arquivamento, `DB_SCHEMA=legacy` sozinho NÃO restaura produção — restore do dump validado com writes parados é obrigatório.

**F0 — Decisões do owner (bloqueante)** — ✅ concedidas em 2026-09-22 (execução do cutover autorizada; finding `814332c4` resolvido por reclassificação + exceção v2).

**F1 — Pendências de schema em produção (sem troca de modo)**
- Aplicar V055–V057 via `migrate-job.js` (hoje pendentes; o binário atual já as contém).
- Gate: reconciliação `--schema=legacy` sem `new-regression`; `/health`/`/ready` estáveis.

**F2 — Rehearsal completo em cópia**
- Dump de produção → restore em PostgreSQL descartável (mesma prova do `backup-restore-rehearsal`).
- Executar conversão canonical na cópia + `canonical:preflight` + suites de paridade contra a cópia.
- Gate: contagens idênticas (contas/categorias/transações), paridade 100%, zero divergência de saldos.

**F3 — Congelamento e conversão em produção**
- Backup verificado pré-conversão (`BACKUP_ID` em `_migration_backup_marker`).
- Janela: writes pausados (flag/env ou breve stop da API) → conversão → smoke read/write mínimo.
- Gate: `/health` gitSha inalterado, `/ready` 200, conversão idempotente confirmada, contagens produção = rehearsal.

**F4 — Troca de modo**
- `DB_SCHEMA=canonical` no serviço da API → `docker compose up -d` → XLTs de smoke + reconciliação `--schema=canonical`.
- Gate: 24–48h em canonical com 0 drift novo e 0 `baseline_drift`; PWA/Agent não mudam (API é a fronteira).

**F5 — Pós-cutover**
- Duplo-run de reconciliação (legacy×canonical) por 7 dias.
- Remoção programada dos stores legacy + débito `V1→V2 pending-ops` reavaliado.
- Rollback: `DB_SCHEMA=legacy` + restore do dump pré-conversão (rota ensaiada na F2).

## Riscos conhecidos

- V055–V057 em legacy precisam validação do filtro `LEGACY_SAFE_PREFIXES` na F1 (o V056/V057 tocam `transactions`/`statements` — colunas aditivas; legacy não as usa no write-path).
- Histórico legado com peculiaridades (63 findings antigos, statement totals) — a conversão precisa das decisões de repair do owner OU preservação fiel para a cópia canonical (preferência: preservar fiel, reparar depois no canonical).
- Downtime do write-path na F3 (minutos, proporcional ao tamanho do dump).

## O que este plano NÃO cobre

- Release B do bearer (gate próprio, 2026-10-02).
- Repairs financeiros (autorização por finding, dossier `814332c4` pronto).

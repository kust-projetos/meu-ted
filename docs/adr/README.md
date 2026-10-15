# Architecture Decision Records (ADRs)

Este diretório contém o registro imutável de decisões de arquitetura do projeto **PI Financeiro**.

## Índice de Decisões

| ADR | Título | Status | Data | Decisão Relacionada |
|---|---|---|---|---|
| [ADR-001](001-legacy-schema-baseline.md) | Baseline do Schema Legado | accepted | 2026-07-28 | D01 |
| [ADR-002](002-better-auth-fallback-after-access-spike.md) | Better Auth Fallback após Access Spike | accepted | 2026-08-04 | D02 |
| [ADR-003](003-workspace-server-side.md) | Resolução de Identidade e Workspace Server-Side | accepted | 2026-08-18 | D03 |
| [ADR-004](004-api-source-of-truth.md) | API Fastify como Fonte Única de Verdade | accepted | 2026-08-18 | D04 |
| [ADR-005](005-generated-agent-tools.md) | Geração Automática de Ferramentas via OpenAPI | accepted | 2026-08-18 | D05 |
| [ADR-006](006-runtime-ownership-retirement.md) | State Machine de Runtime Ownership e Aposentadoria do Legado | accepted | 2026-08-18 | D06 |
| [ADR-007](007-production-topology.md) | Topologia de Produção e Separação Edge / VPS | accepted | 2026-08-18 | D07 |
| [ADR-008](008-consent-rollback-policy.md) | Política de Consentimento e Proteção de Rollback | accepted | 2026-08-18 | D08 |
| [ADR-009](009-global-agent-llm-configuration.md) | Configuração Global de LLM para o Agent TED | accepted | 2026-08-26 | D06 |
| [ADR-010](ADR-010-pending-operation-v2.md) | Contrato de aprovação Pending Operation V2 | accepted | 2026-09-13 | — |
| [ADR-011](ADR-011-same-origin-ted-session.md) | Transporte same-origin da sessão e do TED | accepted | 2026-09-13 | — |
| [ADR-012](ADR-012-approval-contract-propose-validation-and-effects-registry.md) | Contrato de ferramentas de aprovação e Effects Registry | accepted | 2026-09-14 | — |
| [ADR-013](ADR-013-execution-recovery-lease.md) | Protocolo de execução com lease e recuperação | accepted | 2026-09-14 | — |
| [ADR-014](ADR-014-mutation-draft-multi-turno.md) | MutationDraft multi-turno e handoff recuperável | accepted | 2026-09-14 | — |
| [ADR-015](ADR-015-session-hardening.md) | Hardening de sessão e convergência session-first do device token | accepted | 2026-09-16 | D-V4-05, D-V4-06, D-V4-11 |
| [ADR-016](ADR-016-workspace-agent-decommissioning.md) | Descomissionamento do WorkspaceAgent | accepted | 2026-09-16 | D-V4-04 |
| [ADR-017](ADR-017-pre-v033-historical-exception.md) | Exceção histórica pré-V033 fechada (47 órfãs + 8 drifts) | accepted | 2026-09-18 | — |
| [ADR-018](ADR-018-negative-balance-bank-cash.md) | Saldo negativo em banco/dinheiro; cartão não-negativo (supersede D1=B) | accepted | 2026-09-18 | D-V4-D1 (supersede) |
| [ADR-019](ADR-019-test-fixture-reconciliation-exceptions.md) | Fixtures de teste como exceções fechadas (3 coverage + 2 payables) | accepted | 2026-09-18 | — |
| [ADR-020](ADR-020-statement-status-mismatch-repair.md) | Reparo guardado para statements `paid` sem valor pago | accepted | 2026-09-19 | — |
| [ADR-021](ADR-021-pending-v2-transactions-scope-undo-separate.md) | Pending V2 só para transações; undo separado | accepted | 2026-09-19 | — |
| [ADR-022](ADR-022-pi-rewind-store-preservation.md) | Preservação de `refs/pi-rewind/store` | accepted | 2026-09-19 | — |
| [ADR-023](ADR-023-agent-sdk-security-migration-plan.md) | Migração controlada do Agents SDK e AI SDK | accepted | 2026-09-19 | — |
| [ADR-024](ADR-024-legacy-canonical-conversion-policy.md) | Política de conversão Legacy para Canonical | accepted | 2026-09-19 | — |
| [ADR-025](ADR-025-canonical-converter.md) | Arquitetura do conversor Legacy→Canonical e âncora de saldo inicial | accepted | 2026-09-25 | — |
| [ADR-026](ADR-026-risk-based-mutation-authorization.md) | Autorização de mutações baseada em risco | accepted | 2026-10-02 | — |
| [ADR-027](ADR-027-workspace-plurality-lifecycle-views.md) | Pluralidade de workspaces, lifecycle e visibilidade de conversas (D1/D2/D3) | accepted | 2026-10-15 | D1/D2/D3 |

## Template para Novos ADRs

```markdown
# ADR-NNN: título

**Status:** proposed | accepted | rejected | superseded
**Date:** YYYY-MM-DD
**Decision:** D01–D19

## Contexto

## Decisão

## Impacto e Rollback
```

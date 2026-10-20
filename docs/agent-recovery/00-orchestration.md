# Orquestração — recuperação do agente TED V1 (2026-10-19)

## Preflight

- **ExecutionShape:** `MULTI_WORKER`
- **Task class:** PERSISTENT_GOAL (multi-fase, waves, documentação e E2E)
- **Baseline:** branch `fix/issue-255-partial-draft`, HEAD `9492234` (merge `origin/main=9af8781`, pack #258 `04b36c3` em prod Agent/PWA + API `0405fba`; docs SPEC/PLAN/ADR v2.1 em `docs/agent-recovery/`)
- **Autorização:** operador autorizou trabalho autônomo interno e externo, incluindo E2E com credenciais de teste do `.env`; deploy/merge em produção continuam exigindo autorização explícita (regra do projeto).
- **Decisão arquitetural (jev, 2026-10-19):** `deterministic_fix` 0.97 — corrigir roteamento/leitura determinístico (#256/#257) e continuidade (#255), sem tool loop novo na V1; POC de tool calling registrada como experimento e decisão de transporte documentada.
- **Risco (jev):** 1.42/4 (baixo-médio) — toca contratos centrais de leitura, mitigado por testes de contrato e flags.

## Waves

| Wave | Papéis | Objetivo | Estado |
|---|---|---|---|
| 0 | Planner | Baseline, docs, preflight | EM CURSO |
| 1 | explorer ×3 | Auditoria read-path, #255, PWA/E2E | EM CURSO |
| 2 | coder ×2 | #256 (month-summary) e #257 (cards/accounts) | PENDENTE |
| 3 | tester + reviewer | Validação independente e review | PENDENTE |
| 4 | tester (E2E) | E2E live PWA com credenciais de teste | PENDENTE |

## Ownership

- #256: `intent-router.ts`, `channel-evidence.ts` (month-summary), testes novos — coder A.
- #257: `channel-evidence.ts` (cards/accounts), `generated/http-tools.ts` (se necessário), testes novos — coder B.
- Conflito potencial: ambos tocam `intent-router.ts`/`channel-evidence.ts`. **Serializar escrita** nesses arquivos; coders entregam diffs em arquivos de teste distintos e o Planner integra, ou executa #257 primeiro e #256 depois. Decisão: serializar.

# Closure da issue #255 — rascunho parcial em valor ausente (decisão a)

Data: 2026-10-20. Escopo: somente documentação (worktree `D:\projetos\pi-docs-255`, HEAD `dd4b164a` = main com PR #260). Nenhum código alterado nesta sessão de docs.

## Decisão

Decisão (a) do operador executada: **rascunho parcial**. Quando o turno de mutação chega sem valor, o Agent persiste um rascunho parcial (entidade/conta/data verificadas) e mantém a pergunta de valor, em vez de descartar o turno ou pedir tudo de novo. Follow-up que traz só o valor — mesmo sem verbo ("2500") — retoma o rascunho e segue para aprovação. Issue #255 CLOSED.

## Implementação (PR #260, merge `dd4b164a`)

- Gate + fresh persistem parcial: falha de `missing_amount` no validate-gate grava os argumentos verificados e mantém a pergunta de valor.
- Follow-up com valor sem verbo retoma o parcial (retomada por valor, sem exigir novo verbo de ação).
- Anti-hijack: follow-up com valor passa pelos mesmos guards semânticos do turno fresh (sem bypass).
- Moeda não suportada / aproximação / alternativa monetária clarificam sem preencher (sem fill especulativo).
- Entity-first preserva o valor pendente até um preenchimento válido.
- Data relativa do turno de abertura é herdada pelo parcial com proveniência.

Commits: `d9e312f` (implementação + testes) / `ac7fd5e` (review round 1) / `1bd706d` (review round 2 P1+P2) + merge da main `9492234`; squash na main `dd4b164a`.

## Validação

- TDD RED→GREEN: 8 testes falhando na lógica antiga → 14 testes verdes (`apps/agent/tests/issue-255-partial-draft.test.ts`).
- Reviewer independente, 2 rodadas (5 achados corrigidos) → APPROVED.
- Tester PASS: 14/14 focados + 34/34 (suíte relacionada) + adversarial, e live PASS no Test Family — copy exata da pergunta de valor, retomada com "2500", cancela sem escrita, ledger 0 restante.
- CI do PR #260: 18/18 SUCCESS.

## Produção

Merge `dd4b164a` na main. Deploys Cloudflare ATTESTED `sha=dd4b164a` — Agent Deploy run `39353455035`, PWA Deploy run `39353455118`. Smokes live: Agent `/health` ready `buildSha=dd4b164a`, PWA `/api/build-info` `gitSha=dd4b164a`. API Contabo inalterada em `0405fba` (sem redeploy — PR só tocou Agent; `/health` + `/ready` verdes).

## Residuais (não bloqueiam o closure)

- Fresh com "X ou Y" assume o 1º valor (ambiguidade de alternativa em turno fresh — comportamento pré-existente, fora do escopo do parcial).
- "não quero" não cancela rascunho parcial (cancelamento de parcial via negação pura — follow-up futuro).

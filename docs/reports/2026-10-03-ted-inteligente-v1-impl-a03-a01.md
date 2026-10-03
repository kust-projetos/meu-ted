# TED agente inteligente V1 — implementação A00 + A03 + A01 (2026-10-03)

**Branch:** `feat/ted-agent-inteligente-v1-p0` · **Base:** `be6ab11` · **Commits:** `c90b34d` (A03), `01ce028` (A00), `cb07951` (A01).
**Autorização:** operador autorizou o início da implementação da [SPEC](../MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md)/[PLAN](../MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md) nesta sessão. Orquestração: Planner (OpenCode) + MCP jev (gates/decisões) + subagents coder/tester/reviewer com participação observada por fatia.

## 1. A00 — Baseline (concluída)

Relatório dedicado: [2026-10-03-ted-inteligente-v1-a00-baseline.md](2026-10-03-ted-inteligente-v1-a00-baseline.md). Baseline verde do Agent: **823 passed / 1 skipped**. Lint dos 3 artefatos: 0 issues. Budgets V18–V21 verificados por leitura direta.

## 2. A03 — descrição não é categoria (concluída, commit `c90b34d`)

- **Decisão (jev_decide, confiança 0.99):** sem `categoryQuery`, APENAS igualdade fold-exata descrição↔nome de categoria seleciona; fuzzy/contenção não seleciona; clarificação genérica nunca cita a descrição como categoria; com `categoryQuery`, comportamento anterior (exact/contained/UUID) preservado.
- **TDD:** RED comprovado (5 falhas pelos motivos certos) → GREEN. Testes: 6 em `entity-resolver.test.ts`, 3 fim-a-fim em `mutation-entity-resolution.test.ts`.
- **Correções de review (2 rodadas):** (1) esclarecimento virou beco sem saída — `continueDraft` agora consome o `categoryQuery` do turno atual (teste de 2 turnos); (2) categoria escolhida era perdida quando conta também pendente — `resolvedArgs` do draft agora persiste a consulta efetiva (teste de 3 turnos). Reviewer final: **APPROVED**.
- **Efeito de UX esperado (AC08):** descrições que antes auto-selecionavam categoria por contenção ("almoço no Nubank" → "Almoço") agora pedem a categoria — comportamento exigido por R03; ranqueamento de candidatos reais é escopo da A08.

## 3. A01 — prova de resultado, characterization-first (concluída, commit `cb07951`)

- **Investigação:** receipt NÃO carrega montantes (`mutationReceiptSchema` strict: operationId/entity/mutationId); `proposal.operation` não devolve args; validação de vínculo vive em `MutationExecutor` (fail-closed); **sem contraexemplo real de divergência** — frase de sucesso é segura por construção (parser BigInt/trim; API identity-preserving; 422 antes de renderizar; reconciliação por `proposal.id` + chave derivada de `intentionId`).
- **Entrega:** 13 testes de characterization (AC01–AC04: falha sem alegação; receipt divergente fail-closed; provedor nunca chamado no sucesso; resposta perdida → mesma chave + 1 linha no ledger) + fronteira do guard V5 documentada (perífrases/sinônimos/sucesso antigo chegam ao provider mas **nunca mutam**).
- **Única mudança de produção (autorizada pelo Planner, violação real da R01):** `renderInconclusive()` não afirma mais "Nada foi criado ou cancelado ainda" — nova copy: "operação em processamento: o resultado não pôde ser confirmado. Verifique seus lançamentos antes de tentar de novo." Coberta por 5 testes de contrato (sem sucesso, sem ausência de efeito, incerteza nomeada, próximo passo seguro, gênero neutro).
- Reviewer: **APPROVED** após correção documental (limitações aceitas anotadas nos testes; comentário de caminho único corrigido para `:1345` e `:835`).

## 4. Estado final das suítes

| Suíte | Antes | Depois |
| --- | --- | --- |
| Agent (completa) | 823 passed / 1 skipped | **853 passed / 1 skipped** (+30) |
| typecheck / lint (agent) | exit 0 | exit 0 |
| Gates do hook (7) | — | verdes nos 3 commits |

## 5. Follow-ups registrados (não bloqueiam as fatias concluídas)

1. **Guard V5 — perímetro de leitura (R01:94):** claims de efeito em perífrase ("foi pro sistema", "lancei ali") chegam ao provider sem resposta neutra. Widening exige decisão de roteamento + evals adversariais → fatia própria (após A04-base).
2. **UX do replay (vinculada à A02):** replay de escrita perdida mostra "Proposta: … Confirma?" para operação cujo efeito já commitou (fail-safe na confirmação — a op não está mais ativa — mas confuso). Tratar na A02 com reconciliação de identidade.
3. **A06:** extrair `parseCategoryQuery` compartilhado (hoje duplicado entre `financial-parser.ts:92` e helper do orquestrador introduzido na A03).
4. **Hardening (A19/security):** `mutationKind` não é cross-checkado contra o tool pedido no adaptador (defesa na API); `accountName` pode ficar desatualizado entre resolução e execução (cosmético).
5. **Evals:** rodar `eval:ted-v2` no ciclo de eval (cenários que dependiam do fallback descrição→categoria agora divergem por design).

## 6. Próximas fatias (DAG do PLAN §5)

**A04-base** (eixos tipados de vazio/erro/evidence — `reason` sanitizado, estado explícito de "sem evidência") → **A02** (identidade de mensagem, reproduce-first) → **A05** (Markdown seguro na PWA) → A10 (ledger de budgets, fundacional para P1).

## 7. Limites desta entrega

Nenhum deploy, migration, flag ou acesso a produção (INV-12). Working tree preexistente do operador (`AGENTS.md`, `release-b-reminder.yml`, relatório de migração) preservado fora dos commits. CI (`Gate — all checks` + `quality (22, 10)`) é autoritativo e roda no PR.

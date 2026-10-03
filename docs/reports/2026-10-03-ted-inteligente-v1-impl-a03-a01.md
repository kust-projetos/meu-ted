# TED agente inteligente V1 — implementação A00 + A03 + A01 + A04-base (2026-10-03)

**Branch:** `feat/ted-agent-inteligente-v1-p0` · **Base:** `be6ab11` · **Commits:** `c90b34d` (A03), `01ce028` (A00), `cb07951` (A01), `982e770` (A04-base).
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

## 3b. A04-base — eixos tipados de vazio/erro/evidência (concluída, commit `982e770`)

- **Escopo:** bloco (a) da fatia A04 (R04; AC09/AC10/AC04). Bloco (b) — diagnóstico global de workspace vazio — deliberadamente NÃO implementado (depende do spike A09); `workspace_empty` existe como tipo sem produtor, bloqueado por teste.
- **Entrega:** envelope de evidência com uniões discriminadas na ENTRADA e nos itens (erro só aceita motivo de falha; vazio só motivo de ausência — enforced em compilação com testes `@ts-expect-error`); `classifyReadFailure` é whitelist fechada por sinais de transporte (statusCode/timeout) — texto bruto de exceção nunca chega ao prompt; `mapMonthSummary` separa shape inválido (`permanent_error`) de contagem zero válida (`period_empty`) e preserva `transactionCount > 0` como `ok`; envelope misto (erro sem ok) **falha fechado** sem chegar ao modelo (AC10); ausências tipadas respondem deterministicamente sem modelo; estado explícito de "sem evidência" substitui `[]` ambíguo; cap do serializer prioriza falhas e mantém a representação de `ok` byte-idêntica.
- **Ciclo de review:** reviewer achou 3 MEDIUM em 2 rodadas (`EvidenceInput` frouxa; shape inválido virando ausência; coletor sobrescrevendo status explícito) — todos corrigidos com RED provado (`TS2578` comprovando que o cruzamento compilava; `expected 'empty' to be 'error'`; rebaixamento de status reproduzido). APPROVED final.
- **Decisão de projeto documentada:** item `error` descarta payload residual (`data: null`) — evidência de falha nunca fundamenta claim (grounding/serializer só leem `ok`).
- **Dívidas registradas:** `mapSingleton` (statements/payables/budgets/goals/categories) mantém o padrão antigo null→empty sem reason (cai no caminho grounded — menos perigoso; endurecer em A04(b)/A09); catch externo do coletor que converte rejeição em `unavailable` (inalcançável com tipos corretos hoje; follow-up A19).

## 4. Estado final das suítes

| Suíte | Antes | Depois |
| --- | --- | --- |
| Agent (completa) | 823 passed / 1 skipped | **889 passed / 1 skipped** (+66) |
| PWA (completa) | 2310 passed | **2326 passed** (+16) |
| typecheck / lint (agent + pwa) | exit 0 | exit 0 |
| Gates do hook (7) | — | verdes nos 5 commits |

## 3c. A02 — identidade de mensagem, reproduce-first (concluída, commit `ef656d3`)

- **2 bugs reais reproduzidos e corrigidos no PWA (`TedChat.tsx`):** (1) **AC06** — dedup por texto sobre a conversa inteira suprimia permanentemente a resposta do turno atual quando um turno anterior tinha retornado o mesmo texto; retenção agora compara o lote autoritativo observado no refresh. (2) **AC07** — closure stale vazava resultado tardio do workspace antigo no chat novo (re-fetch de histórico, cards de aprovação, banner de falha) — violação da regra #2 de isolamento; guards de escopo após cada await em `executeSend` e `loadHistory` (3 REDs com promises deferred provaram os vazamentos, incluindo card do `ws-1` no `ws-2`).
- **Resíduo honesto (AC06 não fechado integralmente):** o fio não carrega identidade reutilizável (`/rpc/history` sem turnId, ids gerados no server, metadata sem intentionId, `/rpc/chat` sem eco) — a retenção ainda usa heurística de contagem de texto; cenário de confundível documentado por teste marcado `CONFOUND DOCUMENTADO (não endossado)`. Follow-up de protocolo proposto (fatia própria): persistir intentionId do cliente no metadata + expor no `/rpc/history` — fecha duplicata, heurística de texto e reconciliação de balões `sent`/`failed` de uma vez.
- **Lacunas candidatas à causa real do relato "mensagens que somem":** `loadPendingChatSend` gravado em sessionStorage e nunca consumido (sem recuperação pós-reload); balão confirmado depende de eco do histórico (`isCorrectionRetry` suprime persistência). Documentadas por teste como COMPORTAMENTO REAL — exigem decisão de produto.
- **Server:** identidade ≠ texto e escopo-na-identidade provados (turn-idempotency +4, intention-ledger +4 com fake fiel ao `ON CONFLICT` — conflito preserva chave, tupla `(workspace_id, intention_id, tool_call_id)`).
- **Reviewer final:** APPROVED com follow-ups explícitos.

## 5. Follow-ups registrados (não bloqueiam as fatias concluídas)

1. **Protocolo de identidade (A02 follow-up, prioridade):** persistir intentionId do cliente no metadata das mensagens do DO + expor no `/rpc/history` + `historyItemSchema` no PWA — fecha o confound AC06, a heurística de contagem de texto e a reconciliação por identidade de balões `sent`/`failed`. **Causa provável dos relatos de "mensagem que some"** (`loadPendingChatSend` nunca consumido pós-reload).
2. **Guard V5 — perímetro de leitura (R01:94):** claims de efeito em perífrase ("foi pro sistema", "lancei ali") chegam ao provider sem resposta neutra. Widening exige decisão de roteamento + evals adversariais → fatia própria.
3. **UX do replay:** replay de escrita perdida mostra "Proposta: … Confirma?" para operação cujo efeito já commitou (fail-safe, mas confuso). Vinculado ao item 1.
4. **A06:** extrair `parseCategoryQuery` compartilhado (duplicado entre `financial-parser.ts:92` e helper do orquestrador da A03).
5. **Hardening (A19/security):** `mutationKind` sem cross-check contra o tool pedido; `accountName` desatualizado entre resolução e execução (cosmético); catch externo do coletor converte rejeição em `unavailable`; `handleNewSession` sem guard pós-await (limpeza indevida do chat novo, sem vazamento cruzado); converter testes de fonte do `workspace-isolation` em comportamentais (flake de fs no Windows).
6. **Evals:** rodar `eval:ted-v2` no ciclo de eval (cenários que dependiam do fallback descrição→categoria divergem por design).
7. **`mapSingleton`:** mesmo padrão null→empty sem reason (statements/payables/budgets/goals/categories) — endurecer em A04(b)/A09.

## 6. Próximas fatias (DAG do PLAN §5)

**A05** (Markdown seguro na PWA — `TedMessage.tsx`/`TedMarkdown.tsx`) → A10 (ledger de budgets, fundacional para P1) → P1 (A06–A08) → A09-spike (analytics; não bloqueia P0).

## 7. Limites desta entrega

Nenhum deploy, migration, flag ou acesso a produção (INV-12). Working tree preexistente do operador (`AGENTS.md`, `release-b-reminder.yml`, relatório de migração) preservado fora dos commits. CI (`Gate — all checks` + `quality (22, 10)`) é autoritativo e roda no PR.

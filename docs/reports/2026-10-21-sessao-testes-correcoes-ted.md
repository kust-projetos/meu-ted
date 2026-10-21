# Sessão 2026-10-21 — Testes e correções TED (tracking vivo)

> Arquivo vivo desta sessão de testes/correções. Atualizar a cada passo: o que foi feito, evidência, próximo passo.

## Contexto inicial (2026-10-21 ~12:0x BRT)
- Branch: `feat/ted-account-deactivate-v2` @ `f7c314e` (verificar com git no momento da atualização).
- Foco recente (ai-memory 21/10): desativação de conta V2 — intenção não vira rascunho/proposta V2 e turno "sim" cai em resolução sem operação pendente; wiring entityReader só com needsMutation causava DEACTIVATE_READ_FAILURE_TEXT no REST.
- Navegador: Orca embedded browser da worktree atual (verificar com `orca worktree current --json` + tabs do browser).
- FREEZE DE DEPLOY vigente (AGENTS.md 2026-10-20): nenhum merge com efeito em produção sem autorização explícita nova.

## Método (systematic-debugging)
1. Esperado vs observado (com versão, env, inputs).
2. Reprodução mínima preservando o cenário original.
3. Uma hipótese falsificável por vez, um experimento controlado.
4. Fix delimitado + regressão + rerun reprodução e checks afetados.

## Log de passos
| Hora | O quê | Evidência | Próximo |
|------|-------|-----------|---------|
| ~12:0x | Tracking criado + pointer em apps/agent/AGENTS.md | este arquivo | confirmar sintoma atual no browser Orca |
| ~12:10 | Lidas últimas interações ai-memory (21/10) + Orca worktree + snapshot do browser | worktree `feat/ted-account-deactivate-v2` @ `f7c314e`; tab `http://localhost:3000/ted` (Meu Ted); console/network vazios | operador confirma sintoma e autoriza reproduzir |
| ~12:15 | Sintoma confirmado pelo operador | "quero sim" pós-oferta de cadastro → "sem pendente" | debugger read-only |
| ~12:20 | Debugger: causa = `routeIntent("quero sim")`→`confirmation`, criação exclui `confirmation`, sugestão pós-"oi" não é proposta V2 | experimento `quero` vs `quero sim` reproduzido | coder fix delimitado |
| ~12:30 | Coder: intercept `confirmation`+afirmativa curta com "quero" sem draft sonda `resolveDecisionTarget`; `none`→`runAccountCreationTurn`; guarda anti-`accountName:"sim"` | novo `offer-accept-vs-confirmation.test.ts` 4/4; 31/31 + 38/38 + 29/29; tsc limpo; sem commit | tester + reviewer |
| ~12:40 | Tester independente: PASS critérios 1–3 e 4b; residual R1: forget-pending + "quero sim" agora abre rascunho de conta (antes: "sem pendente" honesto; "quero sim" nunca foi confirmação válida de forget) | 4/4 novo; 14/14 draft; 17/17 + 4/4 + 4/4 confirmação; tsc exit 0 | reviewer + decisão R1 |
| ~12:50 | Reviewer: CHANGES_REQUIRED — P2 replay (desvio antes de binding/replay pode abrir draft em reentrega) + P2 forget (aceite sem oferta identificada sequestra fluxo de forget; próxima confirmação barrada por hasDraftForTurn) | estático, sem shell; sem P0/P1 | coder corrige 2 P2 |
| ~13:00 | Coder P2 fixes: guarda exige `!hasPendingForgetForTurn` + fronteiras frescas (replay primeiro); helper escopado (workspace,actor) fail-closed | 6/6 (4+2 P2); 77/77 conjunto; tsc limpo; RED-check com guardas removidas prova os 2 P2; sem commit | re-review + re-test |
| ~13:15 | Re-review APPROVED (P2-1/P2-2 endereçados, sem defeito novo) + re-test PASS (6/6 alvo, 20/20 regressão curta, tsc limpo) | working tree com fix não commitado; sem commit/push/deploy (FREEZE) | validação live no /ted + PR quando autorizado |
| ~13:30 | Validação live PASS (rebuild agent local; "quero sim"→coleta de campos, zero escrita) | /ted junio 13:05 | nova unidade: botão Nova sessão deve limpar histórico |
| ~13:45 | Coder Nova sessão: causa = `handleNewSession` chamava `loadHistory()` pós-POST e repopulava com lote stale; fix marca `historyLoaded=true` sem recarga | novo teste 2/2 RED→GREEN; vizinhas 24/24; typecheck + eslint ok; sem commit | tester + reviewer |
| ~13:55 | Tester PASS (6/6 + 18/18 + typecheck). Reviewer CHANGES_REQUIRED — MEDIUM: limpar `pendingOps`/`undoProposals` oculta cartões ativos (escopo workspace/ator/device, não sessão); reidratar listas sem recarregar mensagens | sem P0/P1 | coder corrige |
| ~14:05 | Coder MEDIUM fix: reidrata só listas ativas (fetchActivePendingOperations + fetchActiveUndoProposals, guards de escopo, sem fetchAgentHistory) | 10/10 (3 arquivos); typecheck limpo; sem commit | re-review + re-test |
| ~14:15 | Re-review APPROVED + re-test PASS (7/7 focadas, typecheck limpo) — DONE | sem commit/push/deploy (FREEZE) | PR quando autorizado; live opcional (exige rebuild PWA) |
| ~14:25 | Live autorizado: rebuild PWA local em background; roteiro = snapshot com mensagens → clique Nova sessão → snapshot vazio + status + prova server-side (log POST /rpc/session/new) | | aguardar build |
| ~14:35 | PWA rebuildada (16:30:38Z, pós-fix 16:17Z). Cliques NÃO limpam a tela e nem mostram status. MAS prova server-side no SQLite do DO: POST do 1º clique SUCEDIU no servidor — sessão `8ba040a9` arquivada c/ resumo em 16:31:59.781Z + sessão `7d9b11cc` aberta em 16:31:59.813Z (message_count 0). | DO pi-finance-agent-FinanceChatAgent, workspace junio | diagnosticar POST pendurado no client |
| BUG NOVO (live): resposta do POST /rpc/session/new nunca chega ao PWA (capture: 1 POST, status None). Servidor processa em ~10s (transação ok) mas o client fica pendurado: sem clear, sem status, sem erro. Cliques seguintes não disparam novo POST. | rede Orca + snapshot + SQLite | debugger server-side |
| ~14:50 | Debugger: Worker respondeu 200 em 12,5s; sem trabalho lento pós-transação; hipótese = documento descartado (meu `reload` no meio do POST matou a instância React) — CONFIRMADA. Diagnóstico real: (a) botão CRIA sessão de verdade (SQLite: `8ba040a9` arquivada c/ resumo 16:31:59.781Z + `7d9b11cc` aberta 16:31:59.813Z, count 0); (b) via `eval b.click()`: POST 200 em 1,5s + reidratação active/undo 200 + tela VAZIA (welcome). | instrumentação fetch no browser | veredito live |
| VEREDITO LIVE — PASS: (1) Nova sessão cria sessão real server-side; (2) fix limpa o histórico (tela vazia pós-clique); (3) cartões ativos reidratados. RESIDUAL de harness (não é bug do app): cliques CDP do Orca (`orca click`) nos botões-ícone do header não chegam ao React (zero fetch); `eval b.click()` e submit do form funcionam. Toque real do operador no browser funciona. | | DONE |

## Estado final desta unidade
- DONE (código + testes + review): intercept oferta-vs-confirmação com guardas de replay e forget, 6 testes RED→GREEN, regressões verdes, tsc limpo, review APPROVED.
- NÃO feito (fora do escopo / gate humano): commit/push/PR, suite completa do Agent, deploy (FREEZE vigente).
- Working tree pronto para revisão do Planner; Planner abre o PR quando autorizado.

## Validação live (autorizada pelo operador ~13:20) — PASS
- Rebuild: imagem `ted-local-agent` anterior ao fix → `docker build -f docker/local/Dockerfile.agent` + `up -d agent` (só local; produção intocada). `up --build` estourou 2 timeouts no step `pnpm deploy` da API; build direcionado concluiu (~14min).
- Roteiro no /ted (workspace junio, sessão nova, 13:05 BRT):
  1. "liste minhas contas" → "Ainda não encontrei contas aqui. Quer que eu te guie no cadastro?"
  2. "quero sim" → "Vamos criar a conta. Me diga o nome da conta e o saldo inicial (por exemplo: \"Nubank, saldo 145\")." ✅ (antes: "Não há nenhuma operação pendente para confirmar.")
  3. "liste minhas contas" de novo → "Para criar a conta, me diga o saldo inicial e o tipo..." ✅ (rascunho coletando campos, zero escrita: sem contas criadas, sem card de aprovação, sem recibo).
- Efeitos colaterais: nenhum (só rascunho local incompleto; nada confirmado, nada escrito).

## Sintoma atual (evidência do browser Orca, ~12:10 BRT)
- Tab: `http://localhost:3000/ted`, workspace `junio`, conversa visível no snapshot.
- Sequência: "oi" → TED sugere criar primeira conta; "quero sim" → TED responde "Não há nenhuma operação pendente para confirmar."
- "liste minhas contas" mais cedo respondeu "Ainda não encontrei contas aqui."
- Console: 0 mensagens; network: 0 requests capturados (sem capture ativo).
- Hipótese a validar com o operador: confirmação ("quero sim") não encontra proposta/rascunho pendente — mesmo padrão do ai-memory de hoje para desativação ("sim" sem operação pendente).

## Hipóteses e experimentos
- H1 (confirmada pelo operador ~12:15): "quero sim" após proposta de criar conta → "Não há nenhuma operação pendente para confirmar."
- H1a: proposta de criação nunca persistiu como pending V2 (draft/propose falhou silencioso ou caiu em read).
- H1b: proposta persistiu mas resolução do "sim" não a encontra (escopo workspace/actor/device, intentionId, TTL, decisionText vs texto composto).
- Diagnóstico debugger (~12:20, read-only): `isShortAffirmative('quero sim')=true` mas `routeIntent` devolve `confirmation`; fluxo de criação exclui planos `confirmation` → nenhum draft; confirmação consulta V2 `/active` → vazio → mensagem exata. Sugestão textual pós-"oi" NÃO é proposta V2. Experimento: `quero`→`unsupported`+draft vs `quero sim`→`confirmation`+bind+GET /active (reproduzido). Teste existente `accounts-draft-agent.test.ts` 14/14 cobre "quero", não a colisão.
- Decisão: fix delimitado = aceite contextual da oferta de cadastro vs confirmação V2 (preservar confirmações existentes, coletar campos sem defaults). Sem bundle (sem mexer em entityReader/executor/banco).

## Arquivos tocados nesta sessão
- docs/reports/2026-10-21-sessao-testes-correcoes-ted.md (criado)
- apps/agent/AGENTS.md (pointer para este tracking)

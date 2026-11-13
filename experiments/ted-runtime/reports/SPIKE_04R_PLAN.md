# SPIKE 04R — Plano de remediação (Planner)

Data: 2026-10-31. Worktree: `D:/projetos/pi-ted-runtime-spike`, branch `experiment/ted-opencode-runtime`, base `1567dae` (+03B/04 uncommitted, sem push por decisão).
Skills ativas: `systematic-debugging` (evidência antes de causa), `writing-plans` (plano executável), `verification-before-completion` (fecho por evidência).

## Orchestration preflight
- Decisão: **MULTI_WORKER** (tarefa não trivial, 5 frentes independentes com arquivos/ownership distintos; Planner não executa sozinho).
- Participação mínima: >=1 subagent útil; ondas com barreira e síntese do Planner.
- Sem `DIRECT_VERIFIED`: nada aqui é trivial/localizado/reversível sem risco.

## Evidência observada (systematic-debugging §1-3)
- Esperado: avaliador reprova erro de valor/período/identidade/resultado; J06 prova conteúdo por identidade; J07 exige maio ou esclarecimento; restart = outro processo + sessão persistida; ferramenta proibida = inacessível por mecanismo nativo.
- Observado (traces live 04):
  - J07 t1 `yearMonth 2026-04` com veredito máquina `U/E/R pass` (sem oráculo anexado ao turno live).
  - Todos os 13 turns live com `apiResults:{}` + `response` em eco (pergunta repetida), ainda assim `E/R pass`.
  - J06 `slots split` mas `apiResults` vazio → isolamento só estrutural, conteúdo untested.
  - J07 restart = `freshSession` (slot novo), não recuperação de sessão persistida.
  - Hook P1 removido; enforcement restante = denies de config + abort pós-observação do runner (limitação conhecida).
- Hipótese falsificável: o runner live sem `expects` não tem dentes (gradeTurn + ramo `!expectSummary && !expectAccounts` aprovam por presença de tool). Experimento: anexar expects + corpos reais e mutar um campo → deve reprovar. (A executar via TDD RED.)

## Goal / Non-goals
- Goal: fechar avaliação (avaliador com dentes + testes negativos), isolamento J06 com conteúdo, J07-A/B separados com oráculo independente, catálogo efetivo de ferramentas com provas negativas, restart real com outro processo + re-bind, regressões verdes, `SPIKE_04R_RESULTS.md` com veredito.
- Non-goals: nenhuma nova tool financeira, MCP, subagente no produto, memória própria, roteador de intenções, regex temporal, framework genérico, máquina de estados, produção/API real/Cloudflare/PWA, push/PR/merge/deploy.

## Baseline
- `SPIKE_04_RESULTS.md` = SPIKE_04_PARTIAL (S04-03 FAIL, S04-08 FAIL parcial, R vácuo, conteúdo J06 untested).
- Suites: spike-01 7/7, spike-02 20/20, spike-03a 17/17 + intention 8/8 + ownership 9/9 + restart-real 1/1, spike-03b-dryrun 5/5, spike-04-dryrun 10/10 (a–j).
- Traces originais J01–J07 + `SPIKE_03B_TRACE_DIAG_HOOKBLOCK.json` preservados (nunca sobrescrever).

## Decisões de produto a respeitar
- Sem regex/router/frase→tool em nenhum caminho (oráculos via `expects` explícitos por turno, nunca derivados de texto).
- J07-B (fresh, "E em maio?" sem contexto): oráculo independente = pedir esclarecimento OU aplicar default de produto explicitamente estabelecido. Não obrigar inferência financeira completa; nunca aceitar abril como maio.
- Restart real: dois processos OS distintos, segundo processo recupera sessão persistida (`database.path` por identidade), re-bind autenticado, continuação verificada.
- Inferência live: campanha separada com limite/orçamento próprios; NÃO reutilizar autorização US$5 do SPIKE 04. Sem autorização nova → concluir determinístico e registrar lives como pendentes.

## Frentes (ownership explícito, sem escrita concorrente no mesmo arquivo)
1. **WS1 avaliador** (owner: coder-A): `bootstrap/run-04-journey.mjs` (gradeTurn + ramo live + findResultBodies + response grounding), `bootstrap/spike-04-oracles.mjs` (comparadores puros, sem router), `tests/spike-04r-evaluator-neg.test.mjs` (NEW, TDD RED→GREEN: mutação de valor/período/identidade/resultado, campo ausente→fail, resposta sem dados corretos→fail, apiResults vazio→incomplete, tool extra→fail). Critério: avaliador reprova cada mutação isoladamente.
2. **WS2 J06 isolamento** (owner: coder-B, depende WS1): journeys J06 A/B com `expectAccounts` + `expectSummary`? (contas; sem inventar resumo), `apiResults` reais do backend, `response` com nomes/saldos corretos por identidade e zero strings financeiras da outra. `apiResults:{}` → `incomplete`, nunca PASS.
3. **WS3 J07 temporal** (owner: coder-B após WS1): J07-A (2 turns mesma sessão, t1 espera `2026-05`) e J07-B (fresh single-turn, espera esclarecimento/default explícito). Asserções de args + resultado + resposta; `2026-04` = FAIL explícito.
4. **WS4 superfície** (owner: explorer/coder-C, paralelizável): inventário efetivo (financeiras permitidas vs wrapper `execute` vs shell/edit/MCP/subagent), denies de config + teste negativo real por mecanismo nativo (tentativa bloqueada pelo mecanismo, não por ausência de chamada em jornada normal). Reaproveitar `build03BConfig`, plugin `ted-finance`, facade de 7 chaves. Sem hook genérico novo.
5. **WS5 restart** (owner: coder-D, paralelizável após leitura de `session-bindings`/`ted-gateway`): dois processos, persistência por `database.path`, re-bind host, continuação com tools/identidade/contexto verificados. `clearAll()` no mesmo processo ou sessão nova NÃO conta. Se compactação/recuperação perder contexto, registrar falha observada.
6. **WS6 fecho** (owner: Planner): regressões 01/02/03A/03B/04-dryrun + novos, review independente, `SPIKE_04R_RESULTS.md` (falhas preservadas, correções, negativos, J06/J07, restart, catálogo, reviews, inferência, LOC próprio, riscos), veredito PASS/PARTIAL/NO_GO.

## Verificação (comandos no worktree, cwd indicado)
- `cd D:/projetos/pi-ted-runtime-spike/experiments/ted-runtime/bootstrap && node --test ../tests/spike-04-dryrun.test.mjs` (regressão avaliador base).
- `cd .../bootstrap && node --test ../tests/spike-03b-dryrun.test.mjs ../tests/spike-03a*.test.mjs ../tests/spike-02.test.mjs ../tests/spike-01.test.mjs` (regressões; contar 67/67 + 10/10).
- Novos: `node --test ../tests/spike-04r-evaluator-neg.test.mjs` (RED antes, GREEN depois).
- Live SOMENTE com autorização explícita nova + `TED_04_LIVE=1` + orçamento próprio; caso contrário, registrar `LIVE PENDING` com comando pronto.
- Fecho: `Test-OrchestrationDoneCompliance` mental — DONE exige participação observada de workers + evidências por critério.

## Riscos/limites
- SDK 2.2.4 sem endpoint de catálogo (`oc.tool undefined`); wrapper `execute` sem gate pré-execução total (limitação conhecida, experimento futuro dedicado).
- `usage` com tokens null/cost 0 (sem prova de custo real futuro).
- Sem autorização de inferência nova, J06/J07 live e restart com modelo ficam `PENDING` (determinístico conclui).

# F1 — baseline funcional TED (repair da revisão independente)

**Data:** 2026-10-24 · **Branch/base:** `test/ted-f1-functional-baseline` / `2b8a478` · **Status: PARTIAL — F1 NOT READY.** Escopo: harness/oráculos/testes/relatório; nenhum `src/` alterado.

## Fechamento dos cinco findings

1. **Contratos:** 25 IDs com evaluators específicos; invariant sem handler falha explicitamente. Resultado: **16 PASS, 2 FAIL de qualidade (não bloqueantes), 7 INCONCLUSIVE** — jamais 25 verificados. C011 (orçamento) e C024 (pagamento de fatura) verificam somente ausência de escrita; falso sucesso/receipt fica explicitamente **INCONCLUSIVE** e não há cobertura declarada dessa propriedade. C004 rename/CAS sem proposal observável; C007/C017 undo ledger não seedado; C012 homônimo sem candidate read; C013 draft store ausente permanecem inconclusivos. C025 valida apenas “ano/valor não cria proposal/efeito”; roteamento B058 continua FAIL separadamente.
2. **Oráculo REST/state:** cada resposta inclui requests reais do entry `/rpc/chat` com dados fake, API reads e query exatos, proposal/body args, clarification needles, pending status, confirmation e execute count. Seeds account/category passam pelos readers usados pelo Agent; transcript recebe sessão `agent_sessions` SQLite sintética e é lido pelo método real da classe. Draft/ledger financeiro não semeados ficam INCONCLUSIVE.
3. **Rota:** `allowedRoutePlans` enumera pares mode/operação sem aliases; comparação é igualdade exata de conjuntos, incluindo rejeição de operação extra. Não existe mode “A-or-B” nem operação usada por `routeIntent` isoladamente como evidência REST. Route match permanece diagnóstico, não task completion.
4. **Allowlist e writes:** `requestPiApiJson` valida método/path; parâmetros de transactions, month summary e category breakdown têm esquemas/valores fechados. Resposta fixture só existe para rotas allowlisted; request desconhecido é gravado e lança erro, nunca recebe `{items:[]}` genérico. Fetch global só aceita `/internal/agent/llm-config` GET, relay POST e duplicate-check POST local. Proposal V2 é a única proposta financeira permitida; authorize retorna 403 sintético; `/execute` e writers HTTP não são permitidos.
5. **Provider/offline:** identidade válida `opencode-zen/zen-free-model` (allowlisted), relay totalmente interceptado no host local e output stub bounded. **0 LLM/provider real**; 16 respostas de relay sintético. Só B059 declara indisponibilidade sintética. Nenhum BLOCKED de setup é confundido com produto ou PASS.

## Execução e evidência

```text
cd apps/agent
pnpm exec vitest run tests/ted-f1-baseline.test.ts --reporter=dot --silent
```

**Focused: 27/27 testes PASS** — dataset/schemas, 60 cenários REST e 25 contratos (críticos, qualidade, não observáveis). JSON [`ted-f1-baseline.json`](../../apps/agent/evals/reports/ted-f1-baseline.json) regenerado. 59 responses 200, **1 HTTP 503 esperado B059**, 1 proposal V2, 1 autorização `403 approval.autoexecute_disabled`, **0 V2 execute**, 0 métodos/paths API fora da allowlist e 0 outbound não permitido. B013 confere tool/args/status proposto, sem execução.

Contrato por gate: **16 PASS; 2 quality FAIL não bloqueantes (C005 payables, C010 statements/payables); 7 INCONCLUSIVE**. Um status FAIL em qualidade permanece nos artefatos, mas não falha o CI; falha crítica concreta falha o teste. Desconhecido não vira PASS.

## Medições observáveis (não são completion)

- Route mode+operation exatos e reads/task conforme o JSON regenerado; estes são diagnósticos, não completion.
- Classificação de resultado REST: **PASS 12 · FAIL 41 · BLOCKED 1 · INCONCLUSIVE 6 · UNSUPPORTED 0**. FAILs incluem rotas/read sets; safe clarification/refusal não é completion.
- `correctTaskCompletion`, turnos, perguntas/confirmations redundantes, false refusal, category/entity accuracy completa, context reuse de drafts, falso sucesso sem receipt, p50/p95 de produto e custo/tokens faturados: **INCONCLUSIVE** com razões no JSON. Outputs financeiros do fake vazio/stub não são avaliados como resposta real.

Falhas funcionais observadas incluem B017 (ano sem mês pede slots de despesa), B005 (pagar→GET `/accounts` em vez de `/payables`), B036 (total mensal não usa summary), B010 (faturas também lê `/payables`) e B012 (criação de orçamento cai em leitura); B058 (“Gastei R$ 20 em 2020”) também roteia para criação de despesa, embora sem proposal/efeito no stub. B004/B006 etc. ainda aparecem como FAIL na avaliação de casos, e não devem ser ocultados. São evidências parciais, não conclusão funcional.

## Validação e limites

- `pnpm exec vitest run tests/ted-f1-baseline.test.ts --reporter=dot --silent` — PASS 27/27, após o repair.
- `pnpm --filter pi-finance-agent typecheck` — PASS confirmado pelo Planner após o reparo final. Teste focado reexecutado: 27/27 PASS (5,31 s totais do Vitest, não latência de produção). `pnpm docs:lint` — PASS reportado pelo worker após o reparo; verifica sua lista fixa (17 arquivos), que pode não incluir este relatório novo. `pnpm exec biome check apps/agent/tests/ted-f1-baseline.test.ts` — NÃO EXECUTADO com sucesso: comando `biome` indisponível na raiz (exit 1); não constitui PASS de formatação.
- Validação independente anterior: Golden 29; eval 63; Agent 3.396/1 skipped; API 2.861/12 skipped; contracts 25; broker 34; PWA 2.831 pass/1 fail. PWA coldboot `t07` esperava não autenticado e recebeu unreachable; lint PASS com warnings (API 148, Agent 112, PWA 26); docs/governance PASS. Esses resultados anteriores não foram reexecutados nesta rodada.
- Ainda faltam os pré-requisitos de F2 para afirmações de eficácia: corpus adjudicado/completo, journeys multi-turn reais e métricas de conclusão/falso sucesso com receipt observável, além da validação independente pertinente. Sem CI required, API/PostgreSQL real, PWA integrada, E2E, produção ou dado financeiro real.
- Warnings de sourcemaps de dependências ausentes não impediram o Vitest.

**Sem custo de avaliação externa:** zero chamadas a provider real; worker/local execution cost não é estimado nem declarado zero. Não houve edição de `src/`, alteração de permissões, rede externa, LLM real, deploy, merge, commit ou push.

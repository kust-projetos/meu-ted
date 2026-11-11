# Auditoria A0 ↔ OpenCode — duplicações e guardas de paridade

**Data:** 2026-11-10 · **Base:** `chore/arch-simplification-final@754addb` · **Escopo:** read-only; sem deploy, merge ou remoção do rollback A0.

Critério por item: **consolidar** apenas quando a duplicação cria risco de divergência silenciosa e a mudança é local; **manter** quando a separação é o próprio mecanismo de rollback; **remover** apenas com ausência de consumidor comprovada.

## Matriz

| # | Área | Evidência | Decisão |
|---|---|---|---|
| 1 | Catálogo de tools | A0 gera `apps/agent/src/generated/http-tools.ts` do contrato OpenAPI (`scripts/generate-agent-tools.mjs`); o runtime declara `TOOL_DEFS`/`PROPOSAL_TOOL_SPECS` manualmente (`apps/ted-runtime/src/tool-defs.mjs:55-343`). | **Consolidar por guarda**, não por fusão: teste de paridade nomes/rotas/registry (abaixo). |
| 2 | Execução de tool | A0 usa `requestPiApiJson` (`apps/agent/src/tools/api-client.ts`); runtime usa `transport` injetado + `assertShape` (`tool-defs.mjs:711-776`). | **Manter.** São runtime loops distintos; compartilhar quebraria o isolamento. |
| 3 | Prompt/instruções | `apps/ted-runtime/src/prompt.mjs` é adapter de histórico/prompt do SDK; o A0 mantém persona/cognição em `agent-config/*`. | **Manter.** Sem duplicação textual material encontrada. |
| 4 | Orquestração/decisão | A0 concentra plano, drafts, resolução e execução (`orchestration/`, `decision/`, `mutations/`); runtime só registra intenção de proposta (`proposal-intents.mjs`). | **Manter.** É o caminho de rollback. |
| 5 | Persistência | Runtime: `conversations.json` + cookie `ted-runtime-conversation` (`conversations.mjs`); A0: DO/AIChatAgent + stores SQL. | **Manter.** Modelos e chaves distintos; roteamento por pin decide a origem. |
| 6 | Proposta financeira | Runtime emite `tool` canônico (`PROPOSAL_TOOL_SPECS`); A0 e API convergem no Pending V2 (`apps/api/src/approvals/tool-registry.ts`). | **Consolidar por guarda:** todo `propose_*` precisa existir no registry da API. |
| 7 | Seleção de runtime | `apps/pwa/src/proxy-utils.ts:574-699` decide A0/`opencode.*` por flag, allowlist e kill switch; o gateway valida identidade. | **Manter.** Coberto por `route.p2-runtime.test.ts`; ampliar E2E (ver pendência). |
| 8 | Código morto | `RETIRED_MODEL_TOOLS` em `agent-config/tools.ts:130-135` é compatibilidade gerada, não caminho morto. | **Nada removido.** |

## Guardas adicionadas

`apps/ted-runtime/tests/api-contract-parity.test.mjs`:

- todo `PROPOSAL_TOOL_SPECS.*.tool` existe em `APPROVAL_TOOL_IDS` (`apps/api/src/approvals/tool-registry.ts`);
- todo `propose_*` existe em `TOOL_DEFS`/`TOOL_NAMES`;
- toda rota `GET` alcançável pelos tools de leitura (`/accounts`, `/categories`, `/transactions`, `/insights/spending`, `/cards/accounts`, `/cards/statements`, `/dashboard/month-summary`) existe em `apps/api/src/routes/route-inventory.ts`.

Falha == drift entre o catálogo do runtime e o contrato real da API; a correção é alinhar o lado que divergiu, nunca unificar as execuções.

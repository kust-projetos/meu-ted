# Plano incremental do experimento

**Estado:** proposta. Nenhum passo autoriza produção, gasto, deploy ou migração. Cada passo tem gate próprio; falhar no gate interrompe a sequência.
**Convenção de caminhos:** `EXISTENTE` = arquivo/comando que já existe no checkout; `PROPOSTO` = caminho/comando futuro, ainda não criado. Nada sob `experiments/` é criado por esta entrega.
**Comandos atuais:** `pnpm docs:lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm governance:check`. Não existe script `test:opencode`; qualquer comando futuro abaixo está rotulado `PROPOSTO`. A função `lintMarkdownDocument` é exportada pelo script existente `scripts/lint-docs.mjs`; sua chamada explícita valida documentos fora da lista default.
**TDD futuro obrigatório** para qualquer código, conforme regras do projeto. Orçamento de inferência e modelo da campanha futura seguem `05-evaluation.md` e dependem de autorização separada.

## Passo 0 — Pin e inventário (sem inferência) — PROPOSTO

- **Objetivo:** fixar base reproduzível antes de qualquer comportamento.
- **Entradas EXISTENTES:** `02-runtime-options.md`, `05-evaluation.md`, `packages/llm-contracts/src/types.ts:379-389`, `apps/api/src/routes/pending-operations.ts`, `apps/api/src/approvals/pending-v2.ts`.
- **Saídas PROPOSTAS:** `experiments/ted-runtime/manifest.json` (pinos com digest/integrity: `@opencode/sdk`/`client`/`cli`/`plugin` 2.2.4; Pi 1.4.0 registrado como contingência), `experiments/ted-runtime/tool-inventory.md` (catálogo efetivo após boot/reload).
- **Gate:** manifest com digests + inventário de agents/tools/skills/MCP/plugins/config da versão fixada; nenhuma chave de config não comprovada (`filesystem:off`-like) entra como solução.
- **Comandos:** `EXISTENTE` `pnpm docs:lint`; `PROPOSTO` gerador do manifest + `lintMarkdownDocument experiments/ted-runtime/tool-inventory.md`.

## Passo 1 — Bootstrap isolado sem LLM — PROPOSTO

- **Objetivo:** provar isolamento operacional antes de conectar modelo.
- **Saída PROPOSTA:** `experiments/ted-runtime/bootstrap/` (container/imagem local limpa, SDK embutido, `HOME`/`XDG`/data/cache exclusivos, sem repos/config/skills/MCP pessoais, sem Docker socket/SSH).
- **Pré-requisito:** Passo 0 PASS.
- **Gate:** boot com duas identidades sintéticas sem vazamento cruzado de sessão, histórico ou credencial; tool allowlist efetiva reenumerada após reload.
- **Comandos:** `PROPOSTO` build/run do bootstrap + teste de duas identidades; `EXISTENTE` `pnpm governance:check`.

## Passo 2 — Plugin financeiro mínimo + adaptador de transporte — PROPOSTO

- **Objetivo:** tools nativas de plugin chamando a API por cliente agnóstico ao runtime.
- **Saídas PROPOSTAS:** `experiments/ted-runtime/plugin/` (schemas curados, executor com contexto imutável), `experiments/ted-runtime/adapters/pwa-transport.md` + fixtures `experiments/ted-runtime/fixtures/`.
- **Evidência confirmada do transporte atual (a preservar no adaptador):** `apps/agent/src/worker.ts` (~407 linhas; auth canônica id+stamp nos headers actor/device, APENAS rotas REST/RPC; non-RPC 404; `onChatMessage` existe mas não é rota pública da PWA). Envelopes PWA em `agent-client.ts` (`sendAgentMessage` + `decidePendingOperation`) devem ser mantidos.
- **Escopo:** reaproveitar transporte PWA atual com adaptador; nunca copiar JSON bruto do OpenCode para o frontend; remover shell/filesystem/execute genérico/subagents/MCP no plugin.
- **Pré-requisito:** Passo 1 PASS.
- **Gate:** contrato de schemas contra `TED_APPROVAL_TOOLS` + apresentação `PendingOperationPresentation` válida; transporte com `clientMessageId`/`intentionId` estáveis e fila serial por conversa.
- **Comandos:** `PROPOSTO` testes determinísticos do plugin/adapter + `lintMarkdownDocument`; `EXISTENTE` `pnpm typecheck`.

## Passo 3 — Leitura real contra backend sintético — PROPOSTO

- **Objetivo:** primeira evidência funcional sem escrita.
- **Entradas:** fixtures `PROPOSTAS` em `experiments/ted-runtime/fixtures/` (conta, categoria, janelas de data, estado inicial fixo).
- **Gate:** leituras (incl. RT-01–RT-07 adaptados) retornam dados do backend sintético; ausência real distinguida de payload inválido; instrução maliciosa em descrição tratada como dado.
- **Pré-requisito:** Passo 2 PASS.
- **Comandos:** `PROPOSTO` suite de leitura determinística; `EXISTENTE` `pnpm test` para o que já existe (sem tocar `apps/agent/tests/orchestration/fix-170-category-semantics.test.ts`, teste sujo preexistente preservado).

## Passo 4 — Uma proposta + confirmação vinculada (única escrita) — PROPOSTO

- **Objetivo:** exercitar exatamente `transactions.expense.create` por proposta, sem confirmar por texto do modelo.
- **Fluxo:** proposta → card actionable (`isActionablePendingOperationPresentation`) → ação autenticada na PWA/canal vinculada à proposta exibida + intenção + reconsulta/API → receipt único.
- **Casos:** RT-08/RT-09/RT-17/RT-18/RT-19/RT-20 adaptados; "sim" textual apenas orienta/apresenta a ação; confirmação puramente conversacional registrada como gap/gate futuro.
- **Pré-requisito:** Passo 3 PASS.
- **Gate:** matriz de integridade de `05-evaluation.md` §4 PASS (dedup crash/concorrência, serialização, resync sem nova chave, expiração/alteração rejeitada); tolerância zero a falso sucesso, violação de escopo e duplicação.
- **Comandos:** `PROPOSTO` suite proposta+confirmação + fault injection; `EXISTENTE` `pnpm test`, `pnpm lint`.

## Passo 4b — Preparar o comparador A1 e congelar A0 — PROPOSTO

- **Objetivo:** comparar desenho de loop equivalente, não um runtime novo com o roteador antigo escondido à frente.
- **Entradas EXISTENTES:** `apps/agent/src/finance-chat-agent.ts` (caminho AI SDK e transporte), `apps/agent/src/agent-config/tools.ts`, `apps/agent/src/orchestration/channel-evidence.ts`, schemas compartilhados e contratos PWA.
- **Saídas PROPOSTAS:** `experiments/ted-runtime/adapters/cloudflare-direct/`, `experiments/ted-runtime/adapters/current-rest/`, fixture compartilhado e manifest que distingue código exclusivo de cada braço do adaptador comum.
- **A1:** um agente/loop AI SDK no runtime Cloudflare local, mesmo catálogo de leitura/proposta de B, sem `routeIntent` nem parser semântico antes do modelo. Reusar autenticação/cliente financeiro testado; não copiar o orquestrador inteiro. Manter confirmação fora da LLM como em B.
- **A0:** checkout/baseline congelado com adaptador somente de transporte; preservar seu comportamento e registrar capabilities faltantes. Não alterar A0 para melhorar sua pontuação.
- **Gate:** integração determinística dos três braços com os mesmos fixtures, limites e resultado financeiro observável; registrar divergências inevitáveis de prompts/protocolos. Nenhuma chamada paga antes de orçamento aprovado.
- **Comandos PROPOSTOS:** testes de contrato dos adaptadores e export do manifest. Dependência: Passo 2; pode ser desenvolvido em paralelo aos Passos 3–4 com ownership exclusivo, depois converge antes da campanha.

## Passo 5 — Comparação A0/A1/B no dataset RT — PROPOSTO

- **Objetivo:** campanha pareada conforme `05-evaluation.md` §§2–6 (24 cenários `RT-*`, 3 braços principais, repetições e tetos propostos ainda não autorizados).
- **Pré-requisito:** Passos 0–4b PASS + smoke real autorizado de leituras/proposta, congelamento de dataset, critérios, equivalências, versões/digests, modelo/provider e orçamento autorizado pelo operador.
- **Gate:** hard gates de `05-evaluation.md` §7 (integridade zero, isolamento provado, restart/replay PASS, sem capability genérica, receipt fiel); sem hard gates PASS, nenhuma comparação autoriza adoção.
- **Comandos:** `PROPOSTO` runner reproduzível + manifest de campanha; `EXISTENTE` `pnpm docs:lint` nos relatórios.

## Passo 6 — Decisão + eventual canary autorizado — PROPOSTO

- **Objetivo:** transformar evidência em recomendação `GO_LIMITED`, `NO_GO` ou `INCONCLUSIVE` (veredito emitido só aqui, nunca antes).
- **Conteúdo:** resumo comparativo, desvios, custo/latência/recursos, inventário de código próprio (incl. adaptadores adicionados), recomendação e próximos gates.
- **Canary:** somente com autorização explícita nova, fora desta proposta, mantido o freeze de produção; critérios de B vs A1 e de holdout em `05-evaluation.md` §7.
- **Pré-requisito:** Passo 5 completo ou declarado incompleto/inconclusivo (casos faltantes nunca excluídos silenciosamente).
- **Comandos:** `EXISTENTE` `pnpm docs:lint`, `pnpm governance:check`; `PROPOSTO` `lintMarkdownDocument` dos relatórios finais.

## Dependências e paralelismo

Sequência principal 0→1→2→3→4→5→6; 4b depende de 2 e converge antes de 5. C (Pi) só entra após decisão documentada, usando o mesmo contrato/fixtures. Não reutilizar `f2b0-runtime` nem claims de budgets históricos como autorização. Testes F1 amplos podem regravar relatórios históricos: executar checks amplos em cópia descartável do checkout congelado, com hashes dos artefatos antes/depois e sem restaurar arquivos do checkout do operador. Para código futuro, criar scripts locais do experimento só na etapa autorizada e registrar o comando exato no manifest.

## Itens A–G do solicitante (onde estão)

- Diagnóstico e fluxo: [diagnóstico](01-diagnosis.md); capacidades/comparação: [runtimes](02-runtime-options.md).
- Matriz de substituição: [diagnóstico §7](01-diagnosis.md#7-matriz-de-substituição-proposta); arquitetura e cobertura: [SPEC](03-experimental-spec.md).
- Fontes oficiais: `03-experimental-spec.md` §2.
- Avaliação e thresholds: `05-evaluation.md` (Planner; referenciado, não duplicado).
- Migração/rollback: `06-migration-rollback.md`.
- Riscos e esforço: `07-risks.md` + ADR-030.

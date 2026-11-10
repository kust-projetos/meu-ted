# Inventário — arquitetura OpenCode-first (2026-11-10)

Base inspecionada: `main@420f90c`. Consumidores verificados por `git grep`,
imports reais e configuração de deploy/CI. Legado não foi removido apenas por
parecer antigo.

## MANTER

| Componente / arquivo | Responsabilidade | Justificativa |
|---|---|---|
| `apps/api` | Autoridade financeira, auth, Pending V2, idempotência, recibos | Única fonte da verdade; intocado. |
| `apps/pwa` (`src/app/api/*`, `proxy-utils.ts`, `features/ted`) | UI, proxies same-origin, seleção A0/B por pin | Seleção já usa helpers compartilhados; kill switch devolve ao A0. |
| `apps/ted-runtime` (`bootstrap`, `gateway`, `server`, `prompt`, `plugin`, `tool-defs`, `transport`, `conversations`, `proposal-intents`) | Runtime conversacional OpenCode, tools financeiras, bindings de host | Runtime principal; adaptações específicas do TED, não duplicação do SDK. |
| `apps/agent` (`finance-chat-agent`, `orchestration`, `mutations`, `decision`, `agent-config/memory`, `agent-config/skills`, `privacy`, `attachments`) | A0 de rollback, broker de propostas, token delegado, confirmação/execução | Rollback preservado e único emissor de `financial.approval.propose`. |
| `apps/agent/src/llm/private-broker-client.ts` | Cliente opcional do broker Codex no A0 | Falha fechado sem configuração; caminho de provider, não runtime ativo. |
| `packages/llm-contracts` | Contratos compartilhados API/Agent | Usado por API, Agent e testes de contrato. |
| `apps/agent/src/poc-structured` | Vocabulário/oráculos F2 usados por evals e testes congelados | Consumidor ativo em `tests/poc-structured`; evidência comparativa. |
| `apps/agent/src/decision/adapters/*` | Adaptadores de decisão (clef/jev/strands/compatible) | Importados por `decision/wiring.ts` → orquestrador. |
| `docker/ted-runtime` | Empacotamento do runtime na VPS | Superfície de produção; nenhuma porta publicada. |
| `docker/local` | Stack local de desenvolvimento | Usado por validação local; não é produção. |

## SIMPLIFICAR

| Arquivo / função | Problema | Ação |
|---|---|---|
| `apps/ted-runtime/src/transport.mjs` | Já aceita origem interna allowlist no `main` (P4/#314) | Nenhuma mudança de produto; a duplicação foi descartada no rebase. |
| `apps/ted-runtime/tests/deployment-origin.test.mjs` | O gateway era coberto, mas não o repasse `main → transporte` | Acrescenta o teste de wiring que falharia se `allowedOrigins` não fosse encaminhado. |
| `scripts/generate-agent-tools.mjs` + `apps/agent/src/generated/http-tools.ts` | `shadow` era sempre `true` para GET e chamava `runShadowRead`, um no-op | Remove a propriedade, o import e a chamada; regenera o arquivo. |
| `docs/architecture/runtime-ownership-matrix.md` | Descrevia ownership Pi/WhatsApp removido | Reescreve para A0/OpenCode por conversa. |
| `docs/ARCHITECTURE-CURRENT.md` / `ARCHITECTURE-TARGET.md` | Não citavam o runtime OpenCode nem o rollback por pin | Atualiza topologia, responsabilidades e estado de produção. |

## REMOVER

| Componente | Evidência de ausência de consumidor | Ação |
|---|---|---|
| `apps/codex-broker` | Nenhum `CODEX_BROKER_ORIGIN` em `wrangler.jsonc`, compose, deploy ou `.dev.vars`; o adapter lança `codex_runtime_not_configured` (sem runtime real); só era exercitado por CI/audits e container smoke | Remove o app e o wiring de build/CI/scripts. O cliente opcional do Agent permanece e falha fechado sem env. |
| `apps/agent/src/shadow/shadow-runner.ts` | `runShadowRead` é `async () => {}`; chamada gerada sem efeito | Remove o módulo e a emissão no gerador. |
| `apps/agent/src/poc-minimal/*` | POC A1 rejeitado (ADR-031); importado apenas por `tests/poc-minimal.test.ts`, nunca pelo worker/evals | Remove src e o teste próprio. |
| `apps/agent/tests/poc-structured/f2b0-runtime/header-diagnostic/*` | Diagnóstico pontual já superado; não é consumido pelo harness atual | Mantido: ainda referenciado por testes/README do harness — não removido sem reescrever a investigação. |

## Preservado apenas para rollback

- **A0 (`apps/agent`)** — conversas fixadas em `agent`, propostas
  `opencode.*` devolvidas ao A0 pelo kill switch, confirmação/execução
  financeira e settings de LLM do A0. Não é caminho principal.
- **`apps/agent/src/poc-structured`, evals e oráculos congelados** — evidência
  de paridade/comportamento; não participam do runtime de produção.
- **Cliente `private-broker-client`** — compatibilidade de provider do A0;
  inerte sem `CODEX_BROKER_ORIGIN` + signing key.

## Pendências justificadas

- O A0 mantém orquestração/roteamento próprios porque é o rollback funcional
  exigido; removê-los exigiria provar o OpenCode em todos os fluxos e eliminar
  o rollback — fora do escopo desta missão.
- `poc-structured` e os oráculos F2 permanecem como evidência de avaliação; a
  remoção exigiria descartar a campanha de paridade já aprovada.

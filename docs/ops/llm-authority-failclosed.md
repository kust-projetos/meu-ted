# H-14 — Política fail-closed da autoridade de IA

**Data:** 2026-09-07

> **Superado em 2026-11-17:** o A0 e seu modelo de configuração/relay foram
> descontinuados. O runtime atual usa modelo pinado em
> `apps/ted-runtime/src/live-model.json` e não consulta esta rota. O texto
> abaixo é somente registro histórico; não use como procedimento operacional.

## Decisão

Quando a autoridade de configuração (`GET /internal/agent/llm-config`)
**não puder ser consultada, o turno é negado (503)** — nunca servido com
snapshot stale. Trade-off documentado: um blip da API nega turnos em vez
de arriscar execução sobre configuração revogada.

## Regras

1. `authorizeTurnExecution` (`apps/agent/src/llm/rollout.ts`) lança
   `agent.provider_not_configured` (503) quando `fetchConfig` falha. O
   callback `onAuthorityUnreachable` continua existindo só para
   observabilidade (log do chamador).
2. Epoch/`securityEpoch` e `disabled` são comparados **antes** (H-03) e
   **depois** (H-14) da inferência, nos dois legs (`onChatMessage` direto
   e `/rpc/chat` relay).
3. Pós-inferência, diante de bump de epoch → 409
   (`agent.security_epoch_changed`); autoridade fora/disabled → 503. Em
   todos os casos: **o output do modelo não é persistido nem respondido**
   (a mensagem do usuário, pré-inferência e autorizada, permanece).
4. O HTTP do relay carrega o `AbortController` do turno (`turnAbort`):
   revogação pós-inferência aborta o voo em curso.
5. Limite conhecido: o leg broker (Codex) não propaga o signal (sem suporte
   no cliente do broker) — a publicação continua gated pela re-verificação;
   streams SDK do leg direto são gated pré-publicação (não há cancelamento
   intra-chunk).

## Verificação

`apps/agent/tests/llm-epoch-midturn.test.ts`: bump durante inferência
lenta, autoridade fora antes/durante, disabled no meio do turno, relay
falhando após o primeiro chunk — sempre sem publicar/persistir output.

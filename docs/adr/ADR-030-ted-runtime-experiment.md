# ADR-030: Experimento de runtime conversacional dedicado (OpenCode V2 prioritário)

**Status:** proposed
**Date:** 2026-10-30
**Escopo:** decisão experimental proposta; nenhum ADR aceito é supersedido.

## Contexto

O harness atual concentra loop, contexto, providers e mecanismos concorrentes em código próprio (`apps/agent/src`: 141 arquivos / 48.572 linhas físicas, excl. `generated/**` e `.d.ts`, incl. POCs; `orchestrator` 8.568, `finance` 5.052, `intent-router` 1.126, `worker` 407). A investigação documental (`docs/ted-runtime-investigation/02-runtime-options.md`) conclui que OpenCode V2 tem as peças para um TED com loop nativo de tools, sem demonstrar superioridade conversacional, custo ou manutenção. Pi atual (C) é contingência. A API financeira permanece autoritativa e o freeze de produção está mantido.

## Decisão (proposta, não aceita)

1. Priorizar **OpenCode V2 dedicado como candidato do experimento** (braço B), com A1 (Cloudflare com loop direto) como controle arquitetural e A0 (baseline atual) como controle; C (Pi via SDK) só após decisão documentada. Não confundir este B com o B estruturado da F2 rejeitada.
2. Primeira entrega restrita a **spike local sem LLM** (Node + `@opencode/sdk` 2.2.4 embutido, container limpo, 1 processo por `actor+workspace`), com pin digest/integrity e teste de catálogo/permissões reais; sem apoiar segurança em features ≥2.3.0 indisponíveis em 2.2.4.
3. Autorização financeira inalterada: Pending V2 única autoridade (`financial.approval.*`; 9 tools em `packages/llm-contracts/src/types.ts:379-389`); primeira escrita só `transactions.expense.create` por proposta; confirmação por ação autenticada vinculada (texto "sim" não autoriza sozinho); confirmação puramente conversacional como gap/gate futuro.
4. Transporte e envelopes PWA preservados via adaptador (`sendAgentMessage`/`decidePendingOperation`; `worker.ts` auth canônica, non-RPC 404; `onChatMessage` não é rota pública); gate actionable prova displayable, não visto (`pending-operations.ts:89-109`); attestation nunca no browser; receipt único comprova sucesso.
5. Critérios, dataset `RT-*`, integridade, métricas e tetos seguem o [plano de avaliação](../ted-runtime-investigation/05-evaluation.md); nenhum PASS de runtime é alegado nesta ADR.

## Alternativas e motivo

- **A — simplificar Cloudflare:** menor distância operacional e comparador obrigatório para distinguir ganho do desenho de ganho do harness. Preferir A se empatar qualidade com menor manutenção total.
- **B — OpenCode dedicado:** sessões, tools, skills, providers e compactação nativos tornam plausível reduzir código próprio. Prioridade significa testar primeiro; APIs/permissões/identidade e efeitos precisam de prova.
- **C — Pi dedicado atual:** alternativa mais enxuta via SDK/RPC, sem restaurar legado. Experimentar se B exigir customização excessiva ou falhar em isolamento/integração.
- **Hospedagem:** SDK Workerd oficial permite B em Cloudflare; VPS e qualidade conversacional são decisões separadas. Primeira prova local via SDK embutido evita listener administrativo adicional.

Fontes e condições que revertem a recomendação: [diagnóstico](../ted-runtime-investigation/01-diagnosis.md), [comparação técnica](../ted-runtime-investigation/02-runtime-options.md), [SPEC](../ted-runtime-investigation/03-experimental-spec.md). Falha de integridade impede adoção; ausência de ganho líquido sobre A1 retira a prioridade de migração para B.

## Impacto e Rollback

- **Impacto:** apenas documental + experimento futuro isolado com dados sintéticos; nenhuma mudança em produção, migração, backup financeiro ou decisão aceita (nenhum ADR superseded).
- **Rollback:** trocar o runtime em teste de volta após resolução das operações em voo, sem fallback de escrita incerta; rollback nunca desfaz ledger nem restaura banco (detalhes em [migração e rollback](../ted-runtime-investigation/06-migration-rollback.md)).
- **Gates:** hard gates de integridade/isolamento/restart/replay/receipt no [plano de avaliação](../ted-runtime-investigation/05-evaluation.md); orçamento de inferência pendente de autorização do operador.

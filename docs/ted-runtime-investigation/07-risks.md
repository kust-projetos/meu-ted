# Riscos (propostos)

**Estado:** proposta; nenhum risco abaixo é alegado como medido. Donos são papéis, não pessoas. Esforço é relativo (P/M/G), sem prazo inventado.

| # | Risco | Evidência | Impacto | Mitigação | Gate / dono (papel) |
|---|---|---|---|---|---|
| R1 | Docs version drift (2.2.4 vs ≥2.3.0) | `02-runtime-options.md` §8: novas actions `integration.connect/use`, `mcp.use`, `skill.use`, `plugin.use` exigem ≥2.3.0 | Segurança apoiada em feature inexistente | Pin com digest/integrity na fase zero; testar catálogo/permissões reais; sem inventar chaves | Gate Passo 0 / Planner |
| R2 | Isolamento incompleto do runtime nativo | `02-runtime-options.md` §§2–4: defaults amplos, shell com autoridade do host, sem sandbox OS | Vazamento entre actor/workspace | Container/DO limpo, HOME/XDG exclusivos, 1 processo por `actor+workspace`, allowlist + reenumeração pós boot/reload, teste com 2 identidades | Gate Passos 1–2 / Security Reviewer |
| R3 | Quebra de contrato PWA | `agent-client.ts` (`sendAgentMessage` 1188–1255, `decidePendingOperation` 1268+); `worker.ts` 337–394 auth canônica, non-RPC 404; `onChatMessage` não é rota pública PWA | Adaptador quebra envelopes ou vaza attestation | Manter envelopes `{text,intentionId}` → `{turnId,intentionId,status,output,memorized,pendingOperation,undoProposal}` e `{decision,requestId}` com receipt vinculado; attestation nunca no browser | Gate Passo 2 / Reviewer |
| R4 | Auth binding fraca (device/actor/workspace) | `pending-operations.ts` identidade server-derived; `sessionID`/`workspaceID` OpenCode não são auth (`02-runtime-options.md` §2) | Leitura/escrita cross-tenant | Gateway com BetterAuth + token delegado; mapping server-side; `sessionID` de cliente nunca como auth; matriz de integridade §4 de `05-evaluation.md` | Hard gate campanha / Tester + Security |
| R5 | Gap de UX na confirmação | SPEC §7: "sim" textual não autoriza sozinho; gate actionable = displayable (`pending-operations.ts:89-109`), não prova de visto | Falso sucesso ou confirmação ambígua | Ação vinculada à proposta exibida + intenção + reconsulta/API; confirmação puramente conversacional como gap/gate futuro, sem regex inventado | Gate Passo 4 / Product Designer |
| R6 | Pending desconhecido / re-handshake | Store V2 com hash/bindings/attestation/lease/outcomes; eventos live-only | Duplicação ou sucesso sem recibo | Mesma chave nunca gera novo efeito; queda/timeout = reconsulta, nunca nova chave; tolerância zero | Hard gate / Tester |
| R7 | Custo/latência piores que A1 | Sem medição nesta investigação (`02-runtime-options.md` §8) | Operação inviável | Medir por `05-evaluation.md` §5 (tokens, chamadas, p50/p95, RSS/CPU); tetos propostos US$10 / 1.200 chamadas / 90s por turno, não autorizados | Gate Passo 5 / Planner |
| R8 | Quotas/privacidade e training_allowed | Governança: tier contributor usa prompts para treino; exceção sintética Muse não se herda para Test Family real | Vazamento ou custo surpresa | Provider aprovado + orçamento autorizado separado; só dados sintéticos; segredos fora de prompts/history/browser; retenção declarada no manifest | Pré-gate campanha / Operador |
| R9 | Oráculo enviesado / overfit no dataset | `05-evaluation.md` §§2–3: congelar dataset/critérios/equivalências antes de ver respostas | PASS inflado | Oráculos autorados independentes; sem ajuste silencioso; holdout com frases novas antes de migrar | Pré-gate Passo 5 / Reviewer |
| R10 | Código legado/F2 e Zod em andamento | Escopo: F2 rejeitado (3/23 sem conclusão observável) e Zod fora do escopo | Contaminação do experimento | Não tocar correções em andamento; curar só `TED_APPROVAL_TOOLS` + rota real; schema gerado não prova disponibilidade | Contínuo / Coder |
| R11 | Esforço subestimado (superfície real) | Medição real: `apps/agent/src` 141 arquivos / 48.572 linhas físicas (excl. `generated/**`, `.d.ts`, incl. POCs); `orchestrator` 8.568, `finance` 5.052, `intent-router` 1.126, `worker` 407 | Cronograma irreal | Estimativa relativa: spike P, plugin+adapter M, campanha G; sem prazo; reportar código próprio vs biblioteca vendorizada por `05-evaluation.md` §5 | Planejamento / Planner |

## Notas

- Orçamento de inferência permanece **pendente de autorização**; os tetos de `05-evaluation.md` são limites propostos, não estimativa de consumo.
- 24 cenários não provam confiabilidade geral: margem pequena ou oscilante = inconclusivo, com repetição em holdout antes de qualquer migração.

## Dependências e condições de avanço

| Dependência | Estado observado | Responsável funcional | Desbloqueia |
|---|---|---|---|
| Pacotes/runtime pinados e compatibilidade Node/Bun | Metadados verificados; execução não testada | Implementação + validação | Bootstrap |
| API/PG sintéticos independentes | Layout `docker/local/docker-compose.yml` existente; nenhuma instância operada nesta investigação | Infra local | Tools reais e ledger de teste |
| Delegação actor/workspace/device | Contrato existente, adaptação não feita | Backend + segurança | Leitura/proposta/decisão |
| Modelo/tool calling, privacidade e orçamento | Modelo da campanha a selecionar; sem gasto autorizado por este documento | Operador | Campanha real |
| Adaptadores A0/A1/B e fixtures equivalentes | Propostos, ainda não implementados | Implementação + avaliador | Comparação válida |
| Contrato PWA e confirmação por ação | Existente; projeção OpenCode não implementada | Frontend + backend | Jornada vertical |
| Visibilidade coletiva/privada e memória | Requisitos existentes; fora da primeira POC | Produto + arquitetura | Eventual canary de produto |
| Compatibilidade updates/storage e restore | Não exercitada | Operação + validação | Hospedagem contínua |

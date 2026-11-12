# ADR-032 - Contrato de entrega por ator do live-sync (TED #269)

**Status:** accepted (C3: transporte push-only atrás de `TED_LIVE_SYNC_ENABLED`, default-off; F1 de frames reais pendente)
**Data:** 2026-11-12

## Contexto

O inventário F0 (`../agent/2026-11-12-ted-269-f0-live-sync-inventory.md`) descreve
o caminho de mensagens e os pontos de entrega existentes. A allowlist do Worker
expõe REST; os demais caminhos retornam 404. A PWA usa REST, sem dependência de
WebSocket para as conversas. O SDK `agents@0.2.35` transmite por workspace, sem
filtro D3 por ator. A flag `TED_PRIVATE_VIEWS_ENABLED` continua OFF. A leitura
REST já aplica o isolamento por D3; isso não prova isolamento de entrega ao vivo.

## Decisão

1. O transporte ao vivo permanece fechado por deny-by-default. Nenhum caminho
   novo será exposto sem contrato explícito e validação deste ADR.
2. Invariante: nenhuma mensagem privada pode sair por canal que não aplique
   `canAccessMessage` para o ator destinatário.
3. Antes de reabrir transporte, implementar o contrato C de entrega por ator:
   - o Worker carimba handshake com `x-agent-actor`, `x-agent-workspace` e
     `x-agent-role`, derivados da autorização verificada;
   - `onConnect` do Durable Object registra estado de conexão validado;
   - conexão sem carimbo válido é negada por padrão;
   - filtro por mensagem ocorre no ponto autoritativo, após persistência e antes
     da emissão do frame; classificação desconhecida entrega a ninguém;
   - membership é revalidado com TTL explícito e limites definidos;
   - reconexão, múltiplas abas, troca de workspace, logout e revogação precisam
     invalidar ou revalidar estado e impedir entrega após perda de acesso.
4. Rejeitamos Durable Object por `(workspace, ator)`: isso quebra o coletivo e
   fragmenta o estado compartilhado. Rejeitamos subscriptions próprias porque
   duplicariam o transporte e o lifecycle já fornecidos pelo SDK.
5. A função `isAllowedAgentRpcPath` mantém allowlist exata testada. Qualquer
   novo transporte exige atualizar este ADR antes de expor a rota.

## Consequências

- Hoje só é correto afirmar que não existe entrega ao vivo; não que ela esteja
  isolada por ator. F1 (captura de frames) permanece bloqueado até implementar C.
- REST continua a fonte da verdade e os caminhos REST permanecem disponíveis.
- Este ADR especifica o contrato futuro; a implementação C não existe nesta
  entrega e a flag permanece OFF.

## Bloqueadores para abrir o transporte (C3)

- Ramo de upgrade no Worker com `authorizeWorkspaceMembership`, carimbo de `x-agent-actor/role/workspace/device`, remoção de `x-agent-connection-token`/`cookie` do cliente e teste de header forjado.
- Retomada/replay de stream e envios diretos por `connection.send` devem passar pelo mesmo predicado (hoje ficam fora do `broadcast`).
- `onMessage` inbound precisa de allowlist explícita de tipos; o caminho WS não pode alcançar o handler de chat do SDK sem as travas financeiras do REST (confirmação, Pending V2, `Idempotency-Key`, `decisionText` server-side).
- TTL de `validatedAt`, revalidação de membership, logout e revogação de sockets já conectados.
- Teste estático de que nenhum envio ocorre fora do wrapper e validação contra a versão real do SDK.
- Confirmação de que `setState` não sobrescreve estado interno do SDK (o merge atual preserva campos, mas exige teste de integração).

A C2 está implementada e testada com conexões sintéticas, mas **não** prova frames reais (F1) e mantém a rota e a flag fechadas.

## C3 — transporte push-only

C3 adiciona upgrade autenticado em `/agents/finance-chat-agent/<workspace>/live`,
somente quando `TED_LIVE_SYNC_ENABLED` é exatamente `1` (default-off). O Worker
valida Origin e membership/token, remove credenciais e headers de identidade do
cliente e carimba a identidade autorizada. O DO nega inbound, desliga resume/
replay e expira bindings após 5 minutos; REST continua o único canal de chat,
decisão e mutação.

C3 **não** prova frames reais (F1 permanece pendente), não liga a flag e a PWA
ainda não usa WS. Revogação de membership pode levar até 5 minutos para invalidar
uma conexão já estabelecida; este residual é aceito nesta fatia.

Antes de ligar a flag, é necessário decidir como o browser entrega o token de
conexão no handshake WebSocket (subprotocolo ou query; o browser não oferece
header customizado). A PWA atual não usa WS; manter a flag desligada até F1 ser
validado e o contrato de transporte do token ser decidido.

## Validação e critérios para reabrir

- Testar o distribuidor com conexões sintéticas de atores distintos.
- Provar paridade entre broadcast autorizado e `/rpc/history`.
- Cobrir default deny, classificação desconhecida, logout, troca de workspace
  e revogação após o TTL de membership.
- Teste estático deve garantir que não há `this.broadcast` fora do wrapper
  autoritativo de entrega filtrada.
- Validar captura negativa de frames antes de habilitar a flag.

## Rollback

Esta entrega contém apenas documentação, teste e extração de função pura sem
efeito em runtime. Reverter os artefatos restaura o estado anterior; não há
mudança de transporte, autenticação, persistência ou produção.

## Referências

- Issue #269.
- [Inventário F0](../agent/2026-11-12-ted-269-f0-live-sync-inventory.md) (PR #340).
- [ADR-027](ADR-027-workspace-plurality-lifecycle-views.md).
- PR #330 (surface guard).

# ADR-032 - Contrato de entrega por ator do live-sync (TED #269)

**Status:** decisão aceita; C3 implementado; F1 provado em workerd; `TED_LIVE_SYNC_ENABLED` default-off; PWA sem cliente WS
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

- O wrapper do SDK pode enviar `CF_AGENT_MCP_SERVERS`/`CF_AGENT_STATE` antes da
  validação do binding no `onConnect`; hoje o agente não configura MCP nem
  `initialState`, então não há payload, mas antes de ligar a flag isso precisa
  ser verificado/eliminado.

O browser não oferece header customizado no handshake e o proxy da PWA não
suporta upgrade. O cliente WebSocket oferece `ted.v1` e `bearer.<token>` como
subprotocols (`new WebSocket(url, ["ted.v1", "bearer.<token>"])`). O Worker
exige exatamente um `ted.v1` quando a lista de subprotocols é apresentada e
exatamente um item bearer não vazio; um `x-agent-connection-token` existente
tem precedência sobre bearer. Sem protocolo ou credencial suficiente retorna
400 genérico antes de auth/DO. A autenticação recebe request clonada com o
token no header consumido pelo autorizador. O Worker remove a oferta inteira,
cookies, authorization e headers `x-agent-*`/`x-partykit-*` antes de encaminhar;
nenhum token é encaminhado. Em resposta 101, seleciona somente `ted.v1` (sem
ecoar bearer); para clientes usando apenas header não adiciona subprotocolo.

A flag continua default-off. A resposta 101 e o eco de `ted.v1` não podem ser
construídos/testados no Node atual; validar o handshake real em staging/F1 antes
de habilitar. A PWA atual não usa WS.

> **Atualização de implementação (2026-11-13, flag ainda OFF):** PR #346 implementou o token via subprotocolo e o tratamento seguro do handshake; PR #347 adicionou o harness workerd e a rota `/live`; PR #348 adicionou o E2E workerd. F1 agora prova upgrade autenticado pelo Worker e entrega de frames reais `private` e `workspace` por ator, em `apps/agent/tests/workerd/live-delivery-e2e.workerd.test.ts`; o teste complementar está em `apps/agent/tests/workerd/live-delivery.workerd.test.ts`. A validação do handshake real em workerd cobre a necessidade de F1 indicada acima; permanecem abertos staging/produção e a validação negativa antes de ligar a flag. A PWA ainda não tem cliente WS. A janela aceita de revogação de membership é de até 5 minutos. Antes de ligar a flag, ainda é necessário verificar/eliminar frames `CF_AGENT_MCP_SERVERS`/`CF_AGENT_STATE` emitidos pelo SDK antes do binding no `onConnect`.

> Dos critérios abaixo, a entrega real por ator do distribuidor está coberta pelo E2E workerd; paridade com `/rpc/history`, cenários de default deny/classificação desconhecida/logout/troca de workspace/revogação após TTL, garantia estática abrangente e captura negativa pré-flag seguem abertos ou não demonstrados por essa evidência.

## Validação e critérios para reabrir

- Testar o distribuidor com conexões sintéticas de atores distintos.
- Provar paridade entre broadcast autorizado e `/rpc/history`.
- Cobrir default deny, classificação desconhecida, logout, troca de workspace
  e revogação após o TTL de membership.
- Teste estático deve garantir que não há `this.broadcast` fora do wrapper
  autoritativo de entrega filtrada.
- Validar captura negativa de frames antes de habilitar a flag.

## Rollback

Reverter os artefatos restaura o estado anterior; a flag permanece default-off.
O transporte autenticado só é exercitado quando habilitado e não altera
persistência ou produção por si só.

## Referências

- Issue #269.
- [Inventário F0](../agent/2026-11-12-ted-269-f0-live-sync-inventory.md) (PR #340).
- [ADR-027](ADR-027-workspace-plurality-lifecycle-views.md).
- PR #330 (surface guard).

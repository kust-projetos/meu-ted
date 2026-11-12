# TED #269 — inventário F0 da sincronização ao vivo

- **Data:** 2026-11-12
- **Escopo:** F0 — inventário estático da superfície e do risco de entrega
- **Flag:** `TED_PRIVATE_VIEWS_ENABLED` permanece OFF (default efetivo: só o valor exato `1` habilita)
- **Checkout de referência:** `fa3ee6e` (`origin/main`)

## Superfície efetiva

| Caminho/canal | Publisher | Subscriber | Filtro efetivo | Evidência |
|---|---|---|---|---|
| `POST /rpc/chat` | Cliente via Worker; o DO processa e persiste resposta | Resposta HTTP do chamador | Autorização no Worker; identidade autenticada é carimbada antes do DO | `apps/agent/src/worker.ts:337-390` |
| `GET /rpc/history` | Estado persistido do DO | Ator autenticado que faz a leitura | Sessão aberta do ator + workspace + predicado D3 | `apps/agent/src/finance-chat-agent.ts:4873-4915`; `src/privacy/conversation-visibility.ts` |
| Outros `/rpc/*` explicitamente listados | Requisições REST do cliente | Chamador HTTP | Allowlist do Worker e autenticação antes do encaminhamento | `apps/agent/src/worker.ts:358-390` |
| `/ws`, `/stream`, `/sync`, `/get-messages`, `/websocket` | Nenhum canal encaminhado pelo Worker | Nenhum | Negado na borda; HTTP 404, sem chamada ao DO | `apps/agent/tests/worker-live-sync-surface.test.ts:49-77`; `worker.ts:393-394` |
| Broadcast de chat do SDK | `AIChatAgent`/persistência SDK, caso exista conexão ao DO | Conexões mantidas pelo DO | SDK exclui apenas IDs passados explicitamente; não é filtro D3 por ator | `agents@0.2.35/.../dist/ai-chat-agent.js:379-380,428-443` |

O allowlist REST atual é: `/rpc/chat`, `/rpc/history`, `/rpc/session/new`,
`/rpc/memory/prefs`, `/rpc/pending-operations/active`,
`/rpc/pending-operations/propose`, `/rpc/undo/active`, `/rpc/undo/decision`,
`/rpc/attachments`, `/rpc/attachments/observability`, `/rpc/undo/:id/verify-target`,
`/rpc/pending-operations/:id/decision` e `/rpc/workspace/:id/attest-empty`.
Os dois últimos padrões parametrizados correspondem às expressões regulares do
Worker; não incluem rotas de transporte ao vivo.

## Identidade e autorização

- O Worker autentica cada requisição do agente com
  `authorizeWorkspaceMembership` (`apps/agent/src/worker.ts:337-342`).
- O workspace autorizado/canônico (`auth.workspaceId`) nomeia o Durable Object;
  o id bruto da URL não é usado para selecionar o namespace canônico
  (`worker.ts:344-362`).
- Para as rotas REST permitidas, o Worker sobrescreve os headers de identidade
  com `x-agent-actor`, `x-agent-role` e `x-agent-workspace`; também carimba ou
  remove `x-agent-device` conforme a autorização (`worker.ts:363-371`).
- `/rpc/history` recebe ator e workspace desses headers internos e recusa a
  chamada se estiverem ausentes (`finance-chat-agent.ts:4873-4880`). A leitura
  limita a conversa à sessão aberta e aplica `canAccessMessage`
  (`finance-chat-agent.ts:4887-4915`).
- O token de conexão autentica a requisição que chega ao Worker. O Worker não
  encaminha os caminhos não REST para o DO, e o carimbo `x-agent-*` descrito
  acima ocorre no ramo REST permitido. Portanto não há, nesta superfície,
  identidade de ator vinculada a uma conexão WebSocket ativa.
- `FinanceChatAgent` bloqueia mensagens SDK `clearHistory` e `setMessages`
  (`apps/agent/src/finance-chat-agent.ts:2513-2520`); esse bloqueio não constitui
  filtro de audiência. A classe não implementa override próprio de `onConnect`.

## Distribuição no SDK

O checkout instala `agents@0.2.35` em
`node_modules/.pnpm/agents@0.2.35_*/node_modules/agents/dist/ai-chat-agent.js`.
`_broadcastChatMessage` encaminha para `this.broadcast(message, exclude)`
(linhas 379-380). `persistMessages` emite mensagens persistidas e passa adiante
`excludeBroadcastIds` (linhas 428-443); outros caminhos de chat também chamam o
broadcast (linhas 84-106, 139, 158 e 422-443).

Esse é o comportamento do SDK quando o broadcast é invocado com conexões no DO:
distribuição por workspace, com exclusão apenas das conexões nomeadas no
argumento. Não há filtro automático por ator ou por visibilidade D3 nesse
caminho. Como a borda atual não encaminha o handshake WebSocket, isto descreve
risco latente, não uma entrega atualmente observada.

## Política efetiva hoje

- A borda do Worker aplica deny-by-default aos caminhos desconhecidos de
  `FinanceChatAgent`: retorna 404 (`worker.ts:393-394`). Não há rota listada para
  `/ws`, `/stream`, `/sync`, `/get-messages`, `/websocket` ou SSE.
- A PWA usa clientes REST para o chat e histórico (`apps/pwa/src/lib/api/agent-client.ts`;
  por exemplo linhas 1627 e 2091). A busca por `useAgent`, `connectAuthenticatedSocket`
  e `openManagedSocket` em `apps/pwa/src/features` não encontrou uso nas
  features; helpers de socket existem em `apps/pwa/src/lib/auth`, mas isso não
  demonstra um fluxo de chat conectado.
- Assim, não há canal de entrega em tempo real ativo identificado neste
  checkout. A conversa/histórico é entregue pelos endpoints REST, não por
  frames WS ou SSE.
- `TED_PRIVATE_VIEWS_ENABLED` tem default desabilitado e só aceita `1`
  (`apps/agent/src/privacy/conversation-visibility.ts:5,28,53-54`). A flag
  desabilitada nega criação privada (403) sem converter conteúdo existente
  (`apps/agent/tests/workspace-d3-private-views.test.ts:155-166,192-208`).

## Cobertura existente

- `apps/agent/tests/worker-live-sync-surface.test.ts:49-77` verifica 404 para
  `ws`, `get-messages`, `sync`, `stream` e `websocket`, e verifica que
  `/rpc/history` é encaminhado.
- `apps/agent/tests/workspace-d3-private-views.test.ts:210-237` prova que B não
  recebe a mensagem privada de A pela leitura REST `/rpc/history`; há teste de
  flag OFF negando criação privada (`:155-166`).
- `apps/agent/tests/session-renew-privacy.test.ts` e
  `apps/agent/tests/session-renew-sqlite-proof.test.ts` cobrem renovação sem
  apagar histórico e escopo por ator.
- Esses testes demonstram isolamento de leitura REST e negação da superfície
  SDK na borda; **não** capturam frames de um transporte ao vivo, nem provam
  filtro de audiência no broadcast do SDK.

## Conclusões F0

1. Hoje não existe entrega cross-ator comprovada porque não existe entrega por
   transporte ao vivo encaminhado pelo Worker.
2. O risco é latente: pode materializar-se se a superfície WS for aberta sem
   filtro de audiência e com o broadcast default do SDK.
3. Um teste de captura de frames de F1 depende do contrato de entrega de F2;
   recomenda-se reordenar F2 antes de F1.
4. Este inventário não comprova incidente de vazamento.

## Próximo passo recomendado

Definir e registrar decisão/ADR de entrega por ator antes de reabrir qualquer
transporte: contrato de autorização da entrega, default deny, comportamento de
reconexão e revogação, incluindo o filtro aplicado no ponto de publicação e de
assinatura. Manter a flag `TED_PRIVATE_VIEWS_ENABLED` OFF enquanto esse contrato
não estiver decidido e validado.

## Limitações

Análise estática do checkout `fa3ee6e`; sem ambiente live e sem captura de
frames. A inspeção do SDK refere-se à versão instalada/pinada `agents@0.2.35`.
Este documento não afirma ausência de vazamento em produção.

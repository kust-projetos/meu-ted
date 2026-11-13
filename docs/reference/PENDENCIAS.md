# Pendências do Meu Ted — pós-V1 (2026-11-12)

**Estado de referência:** `main` em `15c9691932e3d767f2873c63de6ce9726492c15a`;
produção: PWA `15c9691` (build `43434093369`) e Agent `15c9691` (deploy
`43435350750`), ambos `attestation=ATTESTED reason=deploy-smoke-pass`. API
(Contabo) em `32a05cb` (build `43419632296`, manifesto
`release-manifest-32a05cb0cc277c92db625895259070a2de3b1c38.json`); `apps/api`
é idêntico entre `32a05cb` e `15c9691` (diff vazio), portanto está no mesmo
código da main. Release `v1.0.4` publicada; a tag anotada aponta para `32a05cb`.
A entrega inclui insights de gastos por conversa (#343) e orçamentos por
conversa (#335/#336/#337). Detalhe por camada em
[`MEU-TED-V1-FINAL-STATE.md`](../MEU-TED-V1-FINAL-STATE.md).

Este arquivo lista o que o plano da V1 deixou explicitamente para depois e o
backlog que continua aberto. Não é uma autorização de trabalho: a próxima
missão é escolhida pelo usuário.

## 1. Gate de segurança (antes de conversas privadas)

- **#269 - isolamento por ator dos eventos WebSocket.** Issue CLOSED (`status:done`).
  C3 está implementado e F1 provado em workerd (frames reais privados e de
  workspace, por ator). Live-sync está **ATIVO**: `TED_LIVE_SYNC_ENABLED=1` em
  `apps/agent/wrangler.jsonc`; a PWA foi construída com
  `NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED=1` e
  `NEXT_PUBLIC_TED_LIVE_SYNC_ORIGIN=${{ vars.AGENT_PROD_URL }}`; sua CSP permite
  `https://` e `wss://` do host do Agent (PR #358). Handshake real foi validado
  em produção: socket `wss://<host-do-agent>/agents/finance-chat-agent/<ws>/live`
  (origem vinda de `AGENT_PROD_URL`) abriu, recebeu 1 frame e não fechou com
  1008/1006 em 10s. No chat, frames
  disparam revalidação REST silenciosa com throttle de 2s (PR #355). Revogação
  de membership ainda pode levar até 5 min. Contas `Conta E2E Mobile *`
  desativadas continuam listáveis com `includeInactive=true`; não há rota para
  exclusão de conta. `TED_PRIVATE_VIEWS_ENABLED` continua **OFF**. Não é uma
  autorização de trabalho.

## 2. Qualidade e CI

- **#277 — flake de cold boot da PWA:** resolvido pelo PR #338 (fix do `t07c`).
  A instrumentação fica como referência caso o flake reapareça.
- **Dependabot:** #317, #296 e #287 estão CLOSED; #292 está MERGED. #285 e #278
  estão CLOSED como superados.
- **#143** — triagem de dependabot de 2026-10-12.
- A cobertura LOW de `budgets.delete` (propagação de DomainError diferente de
  `not_found` e isolamento por household) foi fechada nesta entrega.

## 3. Gates de release

- **E2E live-mobile-full** no SHA vigente e **tag/promote** formal do release
  (`release-promote.yml`), com evidência de homologação.
- **Cutover F3-F5 do legado** (ADR-024/025): a API já serve o canônico; a
  aposentadoria do legacy/archive é decisão humana. Issues relacionadas:
  #246 (remover stores legacy), #245 (purge Test Family).
- **A19 multimodal** (pós-V1): PDF segue fail-closed; STT/Vision em coorte
  restrita. Reativação exige limites efetivos e gates de privacidade/egress/
  retention.

## 4. Decisões de produto (PÓS-V1 no plano)

O plano da V1 marcou estes itens como fora do escopo. Metas e orçamentos por
conversa foram implementados em #334–#337; os demais seguem sem autorização:

- Metas e orçamentos por conversa (mutação): implementados em #334–#337,
  manual-only e idempotentes.
- Conversas privadas — dependem de #269.
- Exclusões arbitrárias de dados.
- Áudio, visão, PDF, busca web e notificações proativas.
- Autoexecute `on` (hoje `shadow`) — exige sink e telemetria de undo.

## 5. Backlog técnico pós-V1

Issues `[post-V1]` abertas (ordem numérica): #229, #230, #231, #232, #233,
#234, #235, #236, #237, #238, #239, #240, #241, #242, #243, #244, #245, #246,
#247, #248, #249, #250, #251, #252. Também abertas: #165 (evidência E2E
live-mobile-full v1.0.1), #218 (revalidar evidência
fresca do backend), #151 (record/replay determinístico de E2E), #136
(concorrência de memória), #134 (avaliação Clef-omni), #131 (estados de
memória versionados), #116 (protótipo de UX), #95 (keepalive de I/O do DO) e
#87 (épico AI SDK v6).

## 6. Sugestão para a próxima sessão

1. **#269 F2 — entrega por ator** (sem ligar a flag; F0 está concluído no
   inventário e F1, captura de frames, depende deste contrato).
2. Em paralelo, se o foco for produto, escolher **uma** decisão da seção 4
   (ex.: metas/orçamentos por conversa) e tratá-la como nova missão.

**Limites que continuam valendo:** sem deploy, merge ou alteração em produção
sem autorização explícita; `TED_PRIVATE_VIEWS_ENABLED` permanece OFF; o
trabalho local não commitado do cartão deve ser preservado.

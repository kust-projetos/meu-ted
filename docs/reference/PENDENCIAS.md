# Pendências do Meu Ted — pós-V1 (2026-11-12)

**Estado de referência:** `main` em `fa3ee6e`, após a sessão de 2026-11-12,
que mergeou #333 (B058: datas explícitas), #334 (aporte em metas), #335/#336/#337
(orçamentos por conversa: criar/ajustar/apagar, manual-only e idempotentes) e
#338 (flake #277). Produção permanece API `219a4d6`, Agent `000191b` e PWA
`5e69dec` (Release B flipada). Detalhe por camada em
[`MEU-TED-V1-FINAL-STATE.md`](../MEU-TED-V1-FINAL-STATE.md).

Este arquivo lista o que o plano da V1 deixou explicitamente para depois e o
backlog que continua aberto. Não é uma autorização de trabalho: a próxima
missão é escolhida pelo usuário.

## 1. Gate de segurança (antes de conversas privadas)

- **#269 - isolamento por ator dos eventos WebSocket.** A flag
  `TED_PRIVATE_VIEWS_ENABLED` continua **OFF**. O PR #205 implementou a
  visibilidade privada, e o PR #330 mergeou o surface guard do live-sync
  (`apps/agent/tests/worker-live-sync-surface.test.ts`). F0 registrado em
  [`docs/agent/2026-11-12-ted-269-f0-live-sync-inventory.md`](../agent/2026-11-12-ted-269-f0-live-sync-inventory.md);
  ADR-032 aceito para F2a (transporte fechado + guard). Entrega por ator segue
  pendente; a flag permanece OFF.

## 2. Qualidade e CI

- **#277 — flake de cold boot da PWA:** resolvido pelo PR #338 (fix do `t07c`).
  A instrumentação fica como referência caso o flake reapareça.
- **Dependabot:** #317, #296 e #287 estão CLOSED; #292 está MERGED. Abertos:
  **#285** (draft, `DO NOT MERGE`) e **#278** (draft).
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

1. **#269 F0/F1** (sem impacto em produção e sem ligar a flag): inventariar o
   fluxo WS e escrever o teste negativo com dois atores.
2. Em paralelo, se o foco for produto, escolher **uma** decisão da seção 4
   (ex.: metas/orçamentos por conversa) e tratá-la como nova missão.

**Limites que continuam valendo:** sem deploy, merge ou alteração em produção
sem autorização explícita; `TED_PRIVATE_VIEWS_ENABLED` permanece OFF; o
trabalho local não commitado do cartão deve ser preservado.

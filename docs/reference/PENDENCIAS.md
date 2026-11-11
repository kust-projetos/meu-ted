# Pendências do Meu Ted — pós-V1 (2026-11-11)

**Estado de referência:** `main` com a V1 funcional e a manutenção pós-V1
mergeadas; produção em API `219a4d6`, Agent `000191b` e PWA `5e69dec`
(Release B flipada). Detalhe por camada em
[`MEU-TED-V1-FINAL-STATE.md`](../MEU-TED-V1-FINAL-STATE.md).

Este arquivo lista o que o plano da V1 deixou explicitamente para depois e o
backlog que continua aberto. Não é uma autorização de trabalho: a próxima
missão é escolhida pelo usuário.

## 1. Gate de segurança (antes de conversas privadas)

- **#269 — isolamento por ator dos eventos WebSocket.** A flag
  `TED_PRIVATE_VIEWS_ENABLED` continua **OFF**. O PR #205 implementou a
  visibilidade privada, mas o live-sync do SDK é por workspace; falta provar
  que frames privados não chegam a outro ator. Próximo passo: F0 (inventário
  do fluxo WS) + F1 (teste negativo com dois atores sintéticos e captura de
  frames); só depois decidir a entrega server-side mínima. Não ligar a flag
  antes disso.

## 2. Qualidade e CI

- **#277 — flake de cold boot da PWA.** Duas assinaturas já registradas:
  - Vitest `t07c-workspace-cold-boot`: `unreachable` em vez de
    `unauthenticated`;
  - Playwright `PWA-05`: `Entrar` disabled porque o formulário remonta e zera
    os campos.
  Ambas passam no rerun; sem reprodução determinística. Próximo passo:
  instrumentar identidade do formulário/estado do probe antes de qualquer
  correção; não adicionar retry/timeout especulativo.
- **Dependabot:** PRs #317, #296, #292 e #287 abertos. **#285** (Zod 4.6.7) é
  `DO NOT MERGE`; **#278** (POC F2-A) é draft.
- **#143** — triagem de dependabot de 2026-10-12.

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

O plano da V1 marcou estes itens como fora do escopo; continuam sem
autorização:

- Metas e orçamentos por conversa (mutação) — a PWA segue dona.
- Conversas privadas — dependem de #269.
- Exclusões arbitrárias de dados.
- Áudio, visão, PDF, busca web e notificações proativas.
- Autoexecute `on` (hoje `shadow`) — exige sink e telemetria de undo.

## 5. Backlog técnico pós-V1

Issues `[post-V1]` abertas (ordem numérica): #229, #230, #231, #232, #233,
#234, #235, #236, #237, #238, #239, #240, #241, #242, #243, #244, #245, #246,
#247, #248, #249, #250, #251, #252. Também abertas: #218 (revalidar evidência
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

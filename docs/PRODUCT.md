# Meu Ted — Visão de produto

**Last verified:** 2026-11-13
**Reference:** [`runtime-facts.json`](architecture/runtime-facts.json)

## Propósito

Meu Ted ajuda pessoas e famílias a organizar contas, transações, cartões,
orçamentos e metas. A PWA é a interface canônica; a API autoritativa preserva
integridade, auditoria e isolamento por workspace.

## Usuários e acesso

- **Membro:** consulta dados e prepara operações dentro do seu workspace.
- **Owner/administrador:** administra o workspace e convites conforme as
  permissões da API.
- **TED:** co-piloto conversacional. Ele pode explicar dados atuais e preparar
  propostas, mas não ganha autoridade financeira própria.

## TED V2

O OpenCode (`apps/ted-runtime`) é o runtime conversacional primário: recebe a
mensagem autenticada, normaliza no pipeline V2 e usa evidências atuais da API.
Para uma mutação, apresenta uma proposta e a PWA envia somente a decisão para o
Agent. O A0 (`apps/agent`) segue ativo como rollback e como único broker de
propostas Pending V2; a API confirma e executa a operação vinculada e a
interface informa sucesso exclusivamente após `succeeded`.

Memória conversacional melhora contexto, mas nunca substitui saldos, extratos,
identidade ou permissões atuais. Na ausência de evidência, confirmação ou
capability, o TED falha fechado e pede esclarecimento.

## Autorização TED por risco (V5) e topologia vigente

A confirmação humana é condicional: somente `transactions.expense.create` e
`transactions.income.create` de baixo risco podem autoexecutar (valores a
partir de R$ 500 seguem manuais). `TED_RISK_BASED_AUTOEXECUTE` aceita
`off|shadow|on` (default `off`); `shadow` roda em produção desde 2026-10-02.
Topologia vigente: API autoritativa + PostgreSQL 15 na VPS Contabo; PWA e
Agent TED na Cloudflare.

## Escopo atual e exclusões

- **Canary OpenCode:** `TED_OPENCODE_RUNTIME_ENABLED=1`, gateway
  `https://api.synkroo.com.br/ted-runtime`, allowlist `TED_OPENCODE_WORKSPACES`
  = `d36cb649-4462-486d-940a-47128ad329f2` e
  `550e8400-e29b-41d4-a716-446655440000`. Apenas `chat`, `history` e
  `session/new` roteiam para OpenCode; pending/undo/attachments permanecem no
  A0. Kill switch `TED_OPENCODE_RUNTIME_KILL_SWITCH=1` devolve toda conversa ao
  A0.
- **Capacidades financeiras:** permanecem desligadas por padrão salvo quando
  listadas (ex.: `TED_ATTACHMENTS_ENABLED=0`, `TED_AUDIO_STT_ENABLED=0`,
  `TED_PDF_TEXT_ENABLED=0`, `TED_VISION_ENABLED=0`,
  `TED_PRIVATE_VIEWS_ENABLED` OFF).
- **WhatsApp:** fora de escopo por ora (bridge removida; não reconstruir nem
  replanejar).

## Recursos

1. Contas, saldos, receitas, despesas e transferências em centavos inteiros.
2. Cartões, faturas, parcelamentos e contas a pagar.
3. Orçamentos, metas, alertas e auditoria de mutações.
4. TED em painel/global chat com proposta, confirmação, cancelamento e estado
   seguro de pending operation.

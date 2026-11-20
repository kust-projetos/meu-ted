# Meu Ted — Visão de produto

**Last verified:** 2026-11-19
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

O OpenCode (`apps/ted-runtime`) é o **único** runtime conversacional: recebe a
mensagem autenticada, normaliza no pipeline V2 e usa evidências atuais da API.
Para uma mutação, apresenta uma proposta e a PWA envia somente a decisão; a API
confirma e executa a operação vinculada e a interface informa sucesso
exclusivamente após `succeeded`. A API permanece a autoridade financeira e a
autorização por workspace, a confirmação e a idempotência são preservadas.

**Estado V2.1 (2026-11-19):** autoexecução de `categories.create` ativa no
gateway (`TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=1`, autorizado pelo operador),
restrita a essa operação. PRs **#455–#459** integrados; **P5 PASS** e **Jornada C
PASS 4/4** em **ambiente sintético com LLM real**. **Smoke autenticado em produção (2026-11-20, Test Family): PASS** — login, conta, transação, extrato, TED lendo dado real e mutação por proposta com recibo único (`live-mobile-full`, 0 violações de workspace); `categories.create` por autoexec confirmado a partir do 2º turno da conversa (sem card; categoria lida como ativa pelo TED). Memória de categoria e preferência genérica entre sessões **não** validadas em produção (preferência genérica não é persistida por desenho). Ver
[runbook de paridade de flags](runbooks/ted-runtime-paridade-flags.md).

**HISTÓRICO (até 2026-11-17):** o A0 (`apps/agent`) seguia ativo como rollback e
broker de propostas Pending V2; foi descontinuado em 2026-11-17 e removido do
repositório ativo, workspaces, build e CI. A afirmação acima não descreve o
estado atual.

Memória conversacional melhora contexto, mas nunca substitui saldos, extratos,
identidade ou permissões atuais. Na ausência de evidência, confirmação ou
capability, o TED falha fechado e pede esclarecimento.

## Autorização TED por risco (V5) e topologia vigente

A confirmação humana é condicional: somente `transactions.expense.create` e
`transactions.income.create` de baixo risco podem autoexecutar (valores a
partir de R$ 500 seguem manuais). `TED_RISK_BASED_AUTOEXECUTE` aceita
`off|shadow|on` (default `off`); `shadow` roda em produção desde 2026-10-02.
Topologia vigente: PWA na Cloudflare; gateway TED (`apps/ted-runtime`), API
autoritativa e PostgreSQL 15 na VPS Contabo. A0 foi descontinuado em 2026-11-17.

## Escopo atual e exclusões

- **Runtime conversacional (estado atual):** `apps/ted-runtime` é o gateway
  único, servido em `https://api.synkroo.com.br/ted-runtime`; a API é a
  autoridade financeira. **HISTÓRICO (canary anterior):** existiam
  `TED_OPENCODE_RUNTIME_ENABLED=1`, allowlist `TED_OPENCODE_WORKSPACES` e kill
  switch `TED_OPENCODE_RUNTIME_KILL_SWITCH=1` que devolvia a conversa ao A0 —
  capacidades removidas com o descomissionamento do A0 em 2026-11-17.
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

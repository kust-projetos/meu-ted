# V1 — Reconciliação funcional e plano de execução

**Data:** 2026-11-10  
**Base observada:** `main@a9ace19` (o commit `e3ede0b` citado na missão é ancestral)  
**Escopo:** concluir pendências funcionais da V1 no caminho OpenCode-first, sem
reabrir arquitetura.

## 1. Estado real do checkout

| Item | Estado observado |
|---|---|
| Branch | `main`, 2 commits à frente de `origin/main` (`e9f7d8e`, `a9ace19` — Better Auth) |
| Alteração local preservada | `apps/agent/src/finance-chat-agent.ts` (roteamento de compra no cartão, não commitada) |
| `apps/ted-runtime` | SDK OpenCode 2.2.4; 14 ferramentas no catálogo |
| Flags | `TED_OPENCODE_P3_READS_ENABLED` / `TED_OPENCODE_P3_WRITES_ENABLED`; `TED_PRIVATE_VIEWS_ENABLED` |
| Pending V2 | 12 tools em `APPROVAL_TOOL_IDS`; payables ausentes |
| CI/produção | Não reexecutados nesta sessão; sem deploy |

## 2. Ferramentas OpenCode — estado antes desta execução

### Leituras (14 definidas; 7 expostas no opt-in de leitura)

| Domínio | Ferramenta | Estado |
|---|---|---|
| Contas | `list_accounts` | IMPLEMENTADO (default) |
| Dashboard | `get_month_summary` | IMPLEMENTADO (default) |
| Categorias | `list_categories` | IMPLEMENTADO (opt-in leitura) |
| Cartões | `list_credit_cards` | IMPLEMENTADO (opt-in leitura) |
| Faturas | `list_card_statements` | IMPLEMENTADO (opt-in leitura) |
| Transações | `list_recent_transactions` | IMPLEMENTADO (opt-in leitura) |
| Insights | `spending_insights` | IMPLEMENTADO (opt-in leitura) |
| Analytics | KPIs, breakdown, fluxo de caixa, consumo de orçamento, patrimônio | **FALTA** |
| Orçamentos | listar, limites, tendências | **FALTA** |
| Metas | listar/progresso | **FALTA** |
| Contas a pagar | listar/vencimentos/lembretes | **FALTA** |
| Auditoria | histórico/recibos | **FALTA** |

### Escritas por proposta (7)

`propose_expense`, `propose_income`, `propose_card_purchase`,
`propose_transfer`, `propose_statement_payment`, `propose_account_create`,
`propose_category_create` — todas já ligadas ao broker do Agent e ao Pending V2.

### Escritas aprovadas ausentes no OpenCode

`transactions.update` (descrição), `accounts.update`, `accounts.deactivate`,
`categories.update`, `categories.deactivate` — contrato Pending V2 **existe** na
API (`APPROVAL_TOOL_IDS`), falta a ferramenta `propose_*` no runtime, o schema no
broker e o schema no cliente PWA.

### Contas a pagar

`POST /payables` e `POST /payables/:id/pay` existem, mas **não** estão em
`APPROVAL_TOOL_IDS`. O executor V1 de pending operations já sabe executá-los;
o caminho V2 precisa do menor contrato novo.

## 3. Matriz de três estados

| Capacidade | Estado | Ação nesta missão |
|---|---|---|
| Despesa/receita/transferência/compra/fatura/conta/categoria (criação) | IMPLEMENTADO | Não reimplementar |
| Consultas de contas/dashboard/categorias/cartões/faturas/transações/insights | IMPLEMENTADO | Não reimplementar |
| Analytics (KPIs, categorias, fluxo de caixa, orçamento, patrimônio) | FALTA | Implementar leitura |
| Orçamentos (listar/limites/tendências) | FALTA | Implementar leitura |
| Metas (listar/progresso) | FALTA | Implementar leitura |
| Contas a pagar (listar/vencimentos/lembretes) | FALTA | Implementar leitura |
| Auditoria (histórico) | FALTA | Implementar leitura |
| Editar descrição, renomear/desativar conta e categoria | FALTA | Implementar proposta + Pending V2 |
| Criar/pagar conta a pagar por conversa | FALTA | Implementar contrato Pending V2 mínimo + proposta |
| Metas/orçamentos por conversa (mutação) | PÓS-V1 | PWA continua dona |
| Exclusões arbitrárias, áudio/visão/PDF, web, notificações proativas | PÓS-V1 | Manter fora |
| Conversas privadas | PÓS-V1 | Manter flag desligada |

## 4. Achados das pendências transversais

- **Better Auth:** `main` contém `a9ace19` (merge do PR #284), com upgrade de
  segurança. O PR #284 continua aberto no GitHub (draft) — fechar é ação externa,
  requer confirmação do usuário. Nenhum novo upgrade é necessário.
- **Bearer legado:** não há evidência local nova de uso; consulta a banco
  canônico não executada nesta sessão (sem acesso a produção).
- **Conversas privadas:** flag não habilitada; sem mudança nesta missão.
- **CI/PWA:** Biome e flakes não reproduzidos; correções só com falha
  reproduzida. O job dedicado do `ted-runtime` continua ausente (registrado).
- **Patch local do cartão:** preservado. Só deve ser aplicado se reproduzir
  defeito real; a validação live exige autorização de provider/modelo/orçamento.

## 5. Limites de autorização

Sem deploy, merge, produção, dados reais ou inferência paga. A campanha live de
8–10 jornadas continua pendente de autorização explícita de provider, modelo e
teto. Todas as provas desta sessão são determinísticas/sintéticas.

## 6. Execução desta sessão

### Entregue

| Área | Alteração |
|---|---|
| Leituras TED | 12 novas ferramentas: analytics (KPIs, breakdown, fluxo de caixa, consumo de orçamento, patrimônio), orçamentos (listar/check/tendências), metas, contas a pagar (listar/lembretes) e auditoria |
| Transporte | allowlist exata das novas rotas + padrão UUID para `/budgets/:id/trends`; nenhum POST |
| Propostas TED | `propose_transaction_update`, `propose_account_update`, `propose_account_deactivate`, `propose_category_update`, `propose_category_deactivate` |
| Contas a pagar | novo contrato Pending V2 `payables.create` / `payables.pay` (schemas, executores, recibos, apresentação acionável) + `propose_payable_create` / `propose_payable_pay` |
| Broker Agent | schemas estritos das 7 novas propostas (nenhuma capacidade de confirmar/executar) |
| PWA | schemas/sanitização das 7 novas propostas, rótulos de recuperação e copy de efeito dos payables |
| Testes | runtime (leituras, propostas, payables), broker Agent, contratos API/Pending V2 e typecheck API/Agent/PWA |

### Evidências executadas

- `apps/ted-runtime`: 137 testes focados PASS (leituras, propostas, catálogo,
  permissões, contrato de API, prompt adapter).
- `apps/api`: 45 testes PASS (`pending-v2-payables` 8/8, `tool-registry` 16/16,
  `pending-v2-wiring` 4/4, `mutation-receipt-coverage`); `typecheck` PASS.
- `apps/agent`: 62 testes PASS (`mutation-executor-strict-validation` 24/24,
  `expected-context-payables` 2/2, `pending-propose-rpc` 18/18 e
  `f2a-structured-interpretation` 18/18); `typecheck` PASS.
- `apps/pwa`: `typecheck` PASS; CI `quality (22, 10)` PASS (inclui `Test PWA`).
- `packages/llm-contracts`: build PASS; `pnpm docs:lint` PASS; gates
  `capabilities:check`, `write-policy:check`, `governance:check`,
  `boundary:check`, `test:skip-gate` e `public-safety --strict` PASS.
- **Campanha live real (2026-11-11, `opencode-go/deepseek-v4.1-flash`):**
  `pnpm test:p2d-p3-pilot-real` **2/2 PASS** — piloto P3.9 7/7 e jornada V1
  completa no mesmo stack sintético:
  - leituras (`/budgets`, `/goals`, `/payables`, `/analytics/kpis`) sem escrita;
  - rename de conta (`accounts.update`) com recibo;
  - criação de despesa + atualização de descrição (`transactions.update`) com
    recibo sobre o lançamento correto;
  - `payables.create` e `payables.pay` com recibos `entity.type='payable'`,
    pagamento debitando Itaú em R$ 99,00 e exatamente uma despesa criada;
  - data ambígua (`15/03`) sem proposta e sem escrita (journal inalterado).
- **CI remoto no SHA `1355a0f` (PR #318): `CI` PASS (todos os jobs, incluindo
  `Financial integrity — Postgres`, `TED Runtime` e `Gate — all checks`) e
  `PWA CI` PASS (`quality (22, 10)`).**

O runner Vitest da PWA não inicia worker neste host Windows (issue #277); a
validação efetiva do teste de componente veio do CI Linux.

### Pendente / não executado

- **Fase 4 (campanha live): CONCLUÍDA.** O piloto P3.9 real (7/7) e a jornada
  V1 completa passaram juntos no mesmo stack sintético
  (`pnpm test:p2d-p3-pilot-real`, 2/2 na execução final).
- **Causa raiz do 502 em `payables.*` (corrigida):** o `MutationExecutor` do
  Agent validava o recibo de execução apenas contra as formas
  transaction/account/category/statement. Um recibo canônico de payable era
  rejeitado (`approval.incomplete_result`) e o Agent convertia para 502. A
  correção adiciona o validador de payables, exige o `payableId` pré-existente
  em `payables.pay` (contexto esperado) e faz o validador genérico recusar
  kinds não-transaction com entidade `transaction` (recibo trocado).
- As tentativas que encontraram **HTTP 429 `provider.rate-limit`** não
  escreveram nada: o turno falha antes de qualquer proposta. Nenhuma
  duplicidade, recibo falso ou mutação sem confirmação foi observada.
- Correções de harness aplicadas: allowlist live-real do P2D agora inclui as
  leituras V1 (`/budgets`, `/goals`, `/payables`, `/analytics/*`,
  `/transactions`, `/audit-logs`, trends por UUID), com teste offline
  dedicado; o spec P2D foi ajustado para não usar “botão enviar habilitado”
  como sinal de fim de turno, para criar seu próprio lançamento (sem depender
  do piloto) e para checar a data ambígua pelo journal (a projeção do botão
  corre com o refresh do histórico).
- Correção PWA: resposta de turno multi-ferramenta não é mais anexada duas
  vezes quando o histórico já a traz com o mesmo `turnId` (chave React
  duplicada); teste de identidade cobre o caso.
- **Fase 5 (externa/operacional):** isolamento WebSocket/per-ator (#269)
  permanece P2 com `TED_PRIVATE_VIEWS_ENABLED` desligada; smoke de produção,
  deploy, rollback e ativação de funcionalidades seguem pendentes de
  autorização explícita.
- **Release B (D11-R2): CONCLUÍDA em 2026-11-11.** A janela foi conferida na
  Contabo (somente SELECT): **0 eventos** `auth.request.legacy_bearer_used`
  após `2026-10-19T13:23:55.399917Z` (total histórico 406). O flip foi
  executado: `SESSION_BEARER_FALLBACK_ENABLED=off` na API e build da PWA com
  `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off` (PR #320); bearer-only retorna 401 e
  device/delegated tokens não mudam.
- **Deploy de produção (2026-11-11):** API `219a4d6` na Contabo (wrapper
  source-build, backup `pi-db-20261111T153706Z`, rollback tag
  `pi-finance-api:rollback-pre-219a4d6`), Agent `57809a3` e PWA `5e69dec` na
  Cloudflare (ATTESTED). A cópia do wrapper na VPS estava desatualizada (sem o
  retry do gate de borda do #208) e foi sincronizada com
  `scripts/ops/api-release-20260930.sh`; duas tentativas anteriores fizeram
  rollback verificado por falso negativo do `/health` externo, sem impacto
  (container antigo saudável).
- **better-auth (#283/#284):** a `main` já fixa `better-auth@1.7.7` (versão
  corrigida do GHSA-965c-763c-88jm). `security:deps` sem critical e
  `apps/api/tests/auth` **319 passed | 2 skipped**. Issue e PR antigos fechados
  como corrigido/superseded.
- **Live/E2E:** nenhum deploy e nenhum dado real; apenas o workspace sintético
  do P2D. O provider reportou `cost: 0` nas mensagens analisadas; faturamento
  não confirmado.


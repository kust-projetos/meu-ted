# Homologação operacional — TED Financial Intelligence V2.1

## Objetivo

Homologar, em ambiente controlado, a jornada integrada de interpretação,
categorização/reutilização, criação autônoma, aprendizado persistente, correção
conversacional e confirmação com LLM real — antes de qualquer habilitação em
produção.

## Cenário único

Executar somente o spec já mesclado
`p5-category-correction-real.spec.ts`; não criar outros specs. A mensagem
inicial deve incluir a conta para evitar esclarecimento material:
**“Gastei R$ 50,00 no mercado ontem no Nubank.”** Em seguida, corrigir com
**“Na verdade, foram R$ 55,00.”**, confirmar e fazer replay.

No mesmo cenário, verificar que a categoria é reutilizada (não ocorre
`propose_category_create`) e que a preferência aprendida persiste após reabrir
ou reiniciar a sessão, mantendo o mesmo stack.

## Pré-condições

- Modelo `opencode-go/deepseek-v4.1-flash`, conforme
  `apps/ted-runtime/src/live-model.json`.
- Credencial real disponível somente no child do probe; nunca no repositório
  nem em logs.
- Stack P2D sintético, sem dados de produção.
- Executar com `--retries=0` e `--workers=1`.
- Habilitar `P2D_CATEGORY_CORRECTION_REAL=1` e `P2D_LIVE_REAL=1`.

## Resultados esperados

- [ ] Proposta inicial de despesa de R$ 50,00.
- [ ] Correção para R$ 55,00 aplicada via supersede.
- [ ] Decisão `succeeded`, com receipt `transactions.expense.create`.
- [ ] Exatamente uma transação de 5500 cents, descrição `"mercado"`.
- [ ] Exatamente 1 POST de execute.
- [ ] Replay responde 200/409 sem duplicação: transações=1, execute=1.
- [ ] Nenhuma chamada `propose_category_create` (categoria reutilizada).
- [ ] Preferência permanece após reinício/reabertura da sessão.

## Condições de parada

- No máximo uma execução com LLM real por tentativa de homologação; parar na
  primeira falha e não permitir retry automático.
- Se a falha tiver causa reproduzível no harness, corrigir o harness e só então
  solicitar nova autorização. Não repetir tentativas sem mudança concreta.
- Registrar custo/tokens somente se fornecidos pelo provider; caso contrário,
  `NOT_OBSERVED`.
- Nenhuma chamada paga sem autorização explícita do operador.

## Habilitação em produção

Exige evidência aprovada do cenário único acima e autorização específica do
operador. Até lá, manter `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`,
`TED_RISK_BASED_AUTOEXECUTE=off` e
`PENDING_V2_CATEGORY_AUTOCREATE_ENABLED` /
`TED_OPENCODE_CATEGORY_MEMORY_ENABLED` restritas ao sintético. O baseline de
produção `79d8b09` permanece inalterado.

## Pendências verificáveis que podem bloquear

- Verificar a falha na listagem `/pending-operations/active`, observada com o
  banner “Não foi possível carregar as aprovações agora.”
- Verificar o erro do broker de propostas na 2ª execução P5, observado como
  “Não foi possível preparar a proposta de despesa”; o `code` do gateway ainda
  não foi capturado.

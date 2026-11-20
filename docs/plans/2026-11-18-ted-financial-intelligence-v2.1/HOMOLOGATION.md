# Homologação operacional — TED Financial Intelligence V2.1

> **HISTÓRICO (2026-11-18):** o corpo deste documento registra as tentativas e
> o estado da missão de homologação em 18/11, quando P5 era INCONCLUSIVE e a
> flag era `0`. O estado efetivo atual está em "Estado efetivo V2.1
> (2026-11-19)" ao final.

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

## Registro da tentativa (HISTÓRICO 2026-11-18)

Homologação instrumentada — tentativa única (2026-11-18): a execução autorizada com `P2D_LIVE_REAL=1 P2D_CATEGORY_CORRECTION_REAL=1` falhou ANTES de iniciar o teste com `Error: Timed out waiting 600000ms from config.webServer`. A spec não chegou a rodar: SEM anexo `p5-network-report`, SEM jornada financeira executada, SEM status/code de rede capturados. Custo/tokens NOT_OBSERVED. `.env.local` restaurado com hash idêntico; portas liberadas. Classificação: falha de infraestrutura do harness (prontidão do webServer), não falha funcional demonstrada; causa do timeout não determinada. Nenhuma nova execução paga foi realizada, conforme o limite do orientador.

Instrumentação de rede integrada e validada gratuitamente (teste 3/3, PR #430, commit em `b69cd73`); permanece pronta para futura homologação, mediante nova autorização de chamada paga. P5 permanece INCONCLUSIVE. Estado: desenvolvimento concluído; homologação e ativação em produção pendentes.

## Habilitação em produção

**HISTÓRICO (2026-11-18):** exigia evidência aprovada do cenário único acima e
autorização específica do operador; até lá, manter
`TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`,
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

## Encerramento da missão de homologação (HISTÓRICO 2026-11-18)

**Fase 0 (prontidão gratuita): falhou.** O coordenador P2D em modo sintético (`P2D_BROWSER=1`) parou no log `[p2d-stack] root=...`; nenhuma das quatro portas abriu em 240 s: API 4110, coordenador 3200, gateway 3221 e Next 3201 — todas sem resposta. O log do coordenador tinha 87 bytes (apenas `root=...`); o log do Next estava vazio (0 bytes). Portas liberadas ao final (`PORTS_RELEASED=True`).

**F0.1 (diagnóstico direcionado):** o trecho `root=` → `api=` em `apps/pwa/e2e/support/p2d-browser-stack.mts:166-384` é idêntico nos modos `P2D_BROWSER` e `P2D_LIVE_REAL`; a credencial real não é carregada nesse trecho. `createBetterAuth` (`apps/api/src/auth/better-auth.ts:39-86`) e `buildTestApp` (`apps/api/tests/test-app.ts:137-337`) são síncronos, sem banco/rede/arquivo. Hipóteses não verificadas: `EADDRINUSE` por órfão na 4110, plugin Fastify assíncrono em `await app.listen()` (`:383`, sem timeout), ou log truncado. Host limpo ao final (sem listeners/órfãos), mas isso não prova o estado na execução que falhou. **CAUSA INDETERMINADA**; observação que falta: stderr completo do `webServer` da execução falha.

**Decisão do orientador:** encerrar a missão de homologação com bloqueio de infraestrutura documentado. Sem novas tentativas, sem chamadas pagas, sem declarar infraestrutura corrigida nem P5 aprovado. Instrumentação de `/propose` e `/active` preservada (PR #430, validada 3/3) para futura investigação.

**Estado final (HISTÓRICO 2026-11-18):** V2.1 implementada e integrada, mas **NÃO homologada integralmente**; P5 **INCONCLUSIVE**; prontidão das quatro portas não comprovada; baseline de produção `79d8b09` inalterado; nenhuma flag ativada; nenhum deploy. Próxima retomada exige primeiro diagnóstico confiável da inicialização P2D e comprovação de prontidão de API/coordenador/gateway/Next antes de qualquer nova execução com LLM real. Não descreve o estado atual.

## Estado efetivo V2.1 (2026-11-19)

- PRs **#455–#459** integrados; **P5 PASS** e **Jornada C PASS 4/4** em **ambiente sintético com LLM real** (cenário único do P5 e jornada C). Isso é validação de harness/runtime em ambiente controlado, **não** validação em produção.
- Gateway: `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=1` (autorizado em 2026-11-19; compose interpola com default `1`). Rollback: `0` no host/`.env` + redeploy.
- **Smoke autenticado em produção (2026-11-20, Test Family): PASS** — login, conta, transação, extrato, TED lendo dado real e mutação por proposta com recibo único (`live-mobile-full`, 0 violações de workspace); `categories.create` por autoexec confirmado a partir do 2º turno da conversa (sem card; categoria lida como ativa pelo TED). Memória de categoria e preferência genérica entre sessões **não** validadas em produção (preferência genérica não é persistida por desenho).
- A0 descontinuado em 2026-11-17; `apps/ted-runtime` é o único runtime. #245 é manutenção futura, não pré-requisito da V2.1.

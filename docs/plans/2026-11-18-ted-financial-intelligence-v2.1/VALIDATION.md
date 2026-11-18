# MEU TED Financial Intelligence V2.1 — Inteligência financeira autônoma

## Decisão e baseline

O orientador ChatGPT decidiu **EXECUTAR**, sem mudança arquitetural, sem A0/broker e sem deploy. O baseline de produção `79d8b09` permaneceu inalterado, confirmado por `/health` e `/api/build-info` ao vivo.

## Marco 1 — Interpretação semântica

**APROVADO pelo orientador.** Três execuções com modelo real (`opencode-go/deepseek-v4.1-flash`) em `e1291ed`/`a87eba3`/`5c4e63` demonstraram classificação correta de “Recebi 3200 de décimo” como receita de 13º (R$ 3.200,00, data 18/11/2026, catálogo real consultado, ambiguidade material de conta identificada).

**Restrição registrada pelo orientador:** campos estruturados da proposta, idempotência e ausência de escritas NÃO foram comprovados pelo spec P4.

## Marco 2 — Categorização e aprendizado

**IMPLEMENTADO E INTEGRADO.**

- PR #420: gateway usa cliente tool-scoped para `categories.create`, com `mintPath='/auth/agent/category-autoexec-token'` e header `x-agent-category-autoexec-service-token`.
- PR #421: prompt decide reutilizar categoria existente para 13º/Salário sem perguntar; `recall_category_preference` por termo da descrição alinha learn/recall; aprendizado continua host-only em `server.mjs`.
- PR #422: API adiciona capability `financial.approval.autoexecute.category`, emissor dedicado `POST /auth/agent/category-autoexec-token`, capability registrada em `/authorize` sem exigir `TED_RISK_BASED_AUTOEXECUTE=on`, e linha em `docs/architecture/write-mutator-policy.md`.

Validação na main: runtime 417 testes/0 falhas; API focada 41 testes/3 arquivos; `pnpm test:scripts` 21/21; `pnpm docs:lint` 17 documentos/0 issues. CI verde nos três PRs.

## Marco 3 — Correções conversacionais

**IMPLEMENTADO E INTEGRADO.** PR #423: host injeta bloco factual `[PENDING PROPOSAL CONTEXT]` da proposta ativa (somente mesmo autor, campos filtrados, sem token/hash/operationId, falha suave) no turno; prompt distingue negação ambígua de cancelamento explícito. `supersede`/`cancel`, identidade, `expectedProposalHash` e chave de idempotência preservados. Runtime 418 testes/0 falhas na branch; CI verde.

## Marco 4 — Jornada E2E completa

**INCONCLUSIVE.** Spec `p5-category-correction-real.spec.ts` mesclado em #424 (`3c3bff`) e ajustado em #425 (`b7e5ed1`, mensagem inicial passou a especificar "no Nubank" para evitar esclarecimento de conta). Duas execuções com modelo real, uma por versão, `--retries=0`, sem deploy:

- `3c3bff`: modelo interpretou corretamente (categoria Mercado, R$50, data ontem) mas pediu esclarecimento de conta (Itaú/Nubank); nenhuma proposta; falha no botão “Confirmar R$ 50,00” após 300s.
- `b7e5ed1`: UI reportou “TED indisponível”, “Falha no envio”, “Não foi possível preparar a proposta de despesa. Tente novamente.”; nenhuma proposta; mesma falha de botão.

Consequência: correção para R$55, decisão `succeeded`, receipt, transação de 5500 cents, POST de execute, replay idempotente e reutilização de categoria NÃO foram alcançados/verificados neste spec. A prova anterior de proposta/confirmação/idempotência com modelo real permanece a da missão anterior (`p3-expense-real.spec.ts`).

## Pendências verificáveis (sem causa atribuída)

### Homologação instrumentada — tentativa única (2026-11-18)

A execução autorizada com `P2D_LIVE_REAL=1 P2D_CATEGORY_CORRECTION_REAL=1` falhou ANTES de iniciar o teste com `Error: Timed out waiting 600000ms from config.webServer`. A spec não chegou a rodar: SEM anexo `p5-network-report`, SEM jornada financeira executada, SEM status/code de rede capturados. Custo/tokens NOT_OBSERVED. `.env.local` restaurado com hash idêntico; portas liberadas. Classificação: falha de infraestrutura do harness (prontidão do webServer), não falha funcional demonstrada; causa do timeout não determinada. Nenhuma nova execução paga foi realizada, conforme o limite do orientador.

Instrumentação de rede integrada e validada gratuitamente (teste 3/3, PR #430, commit em `b69cd73`); permanece pronta para futura homologação, mediante nova autorização de chamada paga.

- `/pending-operations/active` respondeu 200 em todas as 9 requisições do harness sintético, sem `code` de erro. O banner "Não foi possível carregar as aprovações agora." não se reproduziu no sintético.
- `/pending-operations/propose` respondeu 200 nas 2 requisições do trace sintético, sem `code`. A spec sintética `p3-expense.spec.ts` passou (proposta → confirmação → 1 transação).
- Diagnóstico de código identificou, com alta confiança, que na 2ª execução do P5 em live-real o chat devolveu uma proposta e a falha ocorreu no POST `.../rpc/pending-operations/propose` (`TedChat.tsx:882-890`, `agent-client.ts:1483-1513`), não no provider/modelo. O `code` do gateway (`pending.upstream_<status>_mint` ou `_propose`, `pending-client.mjs:39-50`) não foi gravado em nenhum artefato da execução live-real.
- **Bloqueio verificável:** sem captura do status/`code` da resposta de `/propose` e `/active` em live-real, a causa raiz das falhas do P5 em live-real permanece indeterminada. Essa captura exigiria execução com LLM real, não autorizada nesta missão. Não repetir tentativas sem mudança concreta.

## Estabilização operacional — evidências (sem LLM paga)

- Trace nativo do Playwright no harness sintético: GET `/pending-operations/active` ×9, status 200, sem `code` de erro. O banner "Não foi possível carregar as aprovações agora." não se reproduziu no sintético.
- O mesmo trace: POST `/pending-operations/propose` ×2, status 200, sem `code`. A spec sintética `p3-expense.spec.ts` passou (proposta → confirmação → 1 transação).
- O diagnóstico de código da 2ª execução do P5 em live-real indica, com alta confiança, que o chat devolveu uma proposta e a falha ocorreu em `POST .../rpc/pending-operations/propose` (`TedChat.tsx:882-890`, `agent-client.ts:1483-1513`), não no provider/modelo. O `code` do gateway (`pending.upstream_<status>_mint` ou `_propose`, `pending-client.mjs:39-50`) não foi gravado em nenhum artefato dessa execução.
- Sem a captura do status/`code` de `/propose` e `/active` em live-real — que exigiria execução com LLM real, não autorizada nesta missão — a causa raiz das falhas do P5 em live-real permanece indeterminada. Este é um bloqueio verificável; não atribuir causa e não repetir tentativas sem mudança concreta.

### Testes determinísticos (execução serial, paralelismo zero)

As suítes foram executadas uma por vez para eliminar flake de concorrência:

- `pnpm --dir apps/ted-runtime test`: 417 passaram / 1 falhou. Falha isolada em `native-model-selection.test.mjs:71`: `ServiceUnavailableError: Location plugins did not finish activating`, intermitente e fora das capacidades desta missão.
- `pnpm --dir apps/api exec vitest run tests/approvals/pending-v2-authorize-route.test.ts`: 17/17.
- `pnpm --dir apps/api exec vitest run tests/approvals/pending-v2-supersede.test.ts tests/approvals/pending-v2-idempotency.test.ts tests/approvals/pending-v2-claim.test.ts tests/approvals/pending-v2-uncertainty.test.ts tests/approvals/pending-v2-transaction-description.test.ts`: 40/40 — confirma supersede/merge, idempotência, claim/ownership, incerteza e descrição/transação.
- `pnpm --dir apps/pwa exec vitest run src/lib/api/agent-client.test.ts`: INCONCLUSIVO por infraestrutura do pool Vitest (`Timeout waiting for worker to respond`); nenhum teste executado.
- Com concorrência, as mesmas suítes haviam falhado por timeouts/SIGKILL; com paralelismo zero voltaram a passar. Registrar como instabilidade do runner, não como regressão funcional demonstrada.

### Telemetria, homologação e estado

- O probe descarta dados de uso por design (`p2d-synthetic-read-probe.mjs:987`); nenhum dado de custo/tokens foi fornecido pelo provider: `NOT_OBSERVED`. Não criar infraestrutura nova de telemetria.
- Plano de homologação em `docs/plans/2026-11-18-ted-financial-intelligence-v2.1/HOMOLOGATION.md` (PR #428), com cenário único, resultados esperados e condições de parada. Nenhuma execução com LLM real foi feita nesta missão de estabilização.
- Baseline de produção `79d8b09` inalterado; nenhuma flag ativada, nenhum deploy e nenhuma chamada paga.

Nenhuma chamada paga à LLM foi executada após a decisão de encerramento do orientador.

**Financial Intelligence V2.1 — DESENVOLVIMENTO CONCLUÍDO; HOMOLOGAÇÃO E ATIVAÇÃO EM PRODUÇÃO PENDENTES.**

A próxima prioridade é homologação operacional em ambiente controlado, com habilitação condicionada a evidência integrada com LLM real e autorização específica do operador.

## Limitações e resíduos

- Custo/tokens do modelo NOT_OBSERVED.
- Cinco execuções com modelo real foram gastas nesta missão (3 no P4 + 2 no P5). O orientador fixou limite de "sem ciclos indefinidos de estabilização" - novas execuções exigem nova orientação.

## Flags desativadas e habilitação controlada futura

Produção permanece em `79d8b09`; `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` continua 0 em produção; `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN` não foi provisionado em produção; `TED_RISK_BASED_AUTOEXECUTE` segue off; `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1` e `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1` aplicam-se ao stack sintético.

Habilitação futura deve: provisionar o token dedicado fora do repo, exigir dono da conversa (pin B), manter a política server-side da API e NUNCA ativar autoexecução de movimentações financeiras.

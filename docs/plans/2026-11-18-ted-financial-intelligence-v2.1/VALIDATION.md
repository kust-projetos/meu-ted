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

- Falha na listagem `/pending-operations/active` no harness (banner "Não foi possível carregar as aprovações agora."), observada nas execuções, sem causa atribuída.
- Indisponibilidade do gateway/provider observada na 2ª execução do P5 ("TED indisponível", "Falha no envio", "Não foi possível preparar a proposta de despesa"), sem causa atribuída.

Nenhuma chamada paga à LLM foi executada após a decisão de encerramento do orientador.

**Financial Intelligence V2.1 — DESENVOLVIMENTO CONCLUÍDO; HOMOLOGAÇÃO INTEGRADA E ATIVAÇÃO EM PRODUÇÃO PENDENTES.**

A próxima prioridade é homologação operacional em ambiente controlado, com habilitação condicionada a evidência integrada com LLM real e autorização específica do operador.

## Limitações e resíduos

- Custo/tokens do modelo NOT_OBSERVED.
- Cinco execuções com modelo real foram gastas nesta missão (3 no P4 + 2 no P5). O orientador fixou limite de "sem ciclos indefinidos de estabilização" - novas execuções exigem nova orientação.

## Flags desativadas e habilitação controlada futura

Produção permanece em `79d8b09`; `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` continua 0 em produção; `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN` não foi provisionado em produção; `TED_RISK_BASED_AUTOEXECUTE` segue off; `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1` e `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1` aplicam-se ao stack sintético.

Habilitação futura deve: provisionar o token dedicado fora do repo, exigir dono da conversa (pin B), manter a política server-side da API e NUNCA ativar autoexecução de movimentações financeiras.

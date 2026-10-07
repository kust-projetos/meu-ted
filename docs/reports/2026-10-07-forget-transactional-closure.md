# Closure forget_memory: atomicidade, idempotência e escopo dos decision receipts (issue #102)

Data: 2026-10-07. HEAD inicial `eceb658` (= origin/main). Branch `fix/forget-transactional-closure-102`.
Issue: #102 (não reabre #99). PR #100 findings P1×1 + P2×2 corrigidos sem redesenhar o two-step.

## 1. Root causes

- **P1 atomicidade:** `confirmForgetMemory()` fazia claim `pending→confirmed` (CAS), `forgetMemory()` (N UPDATEs), pós-validação e CAS `confirmed→executed` como statements separados, sem transação. Falha no meio deixava alvo apagado com UX de falha, cascade parcial, ou claim `confirmed` travado (`releaseClaim` best-effort como única garantia).
- **P2 renewal:** `findForgetDecision()` ignora recibo >24h, mas `recordForgetDecision()` retornava cedo se a linha existia — a nova decisão nunca ganhava janela nova.
- **P2 uniqueness:** PK global `intention_id` vs leitura `(workspace, actor, intention)` — colisão cross-actor/workspace (`UNIQUE constraint failed`); no cancel, a proposta já estava `cancelled` quando o insert falhava.
- **P1 binding (achado dos reviewers desta closure):** confirmação autoriza UM preview específico (hash-bound a UMA proposta). Reuse de `intentionId` com recibo vencido re-resolvia contra pending POSTERIOR e o deletava sem confirmação nova. `intentionId` deriva do `messageId` (único por turno), então vínculo intenção→proposta não quebra fluxo legítimo (turno novo = id novo).

## 2. Fronteira transacional

`executeConfirmedForgetTransaction()` (forget-proposals.ts): revalidação final + claim + invalidação do alvo + cascade + `confirmed→executed` + recibo `already_done` na MESMA transação. COMMIT = tudo; qualquer throw = ROLLBACK. Erro bruto vira `ForgetTransactionError('failed')`; revalidação vira terminal fora da tx (marca `expired` + recibo, não desfeita pelo rollback). `releaseClaim` permanece só como defesa para fallback sem transação.

Primitiva: `ctx.storage.transactionSync` (real do DO, ligada em `memorySql()`); fallback `BEGIN IMMEDIATE/COMMIT/ROLLBACK` via `exec` (cobre `node:sqlite`); mocks sem suporte caem em execução direta (sem atomicidade ali — rollback provado na suite real). BEGIN real que falha propaga (só `unhandled query` do mock degrada); depth-guard impede nesting; COMMIT que falha não corrompe o depth (`finally` único).

`forgetMemory()` virou wrapper transacional sobre `forgetMemoryInTransaction()` (cru, sem nesting). Cancel (`cancel+receipt`) e propose (`supersede+insert`) também atômicos. Recibos fora da tx são best-effort (fonte da verdade do `executed` é o terminal da proposta + intentionId).

## 3. Receipts: renewal + identidade + vínculo

- Identidade canônica `(workspace_id, actor_id, intention_id)` (PK composta). Migração: `CREATE new → INSERT SELECT → DROP old → RENAME new` em UMA transação, com verificação de contagem (divergência = ROLLBACK); linhas antigas preservadas com `proposal_id` NULL (PK antiga garantia unicidade global: zero colisões). Defesa: schema composto sem a coluna ganha `ADD COLUMN` (sem ela, recibos falhariam enquanto deletes funcionam — a falha seletiva que o vínculo precisa sobreviver).
- Renewal: recibo válido = intocado; expirado = UPDATE de outcome + `created_at` (+ vínculo); ausente = INSERT.
- Vínculo intenção→proposta em TABELA PRÓPRIA (`agent_memory_forget_bindings`, sem TTL, sem migração): a confirmação autoriza UM preview específico, então redelivery nunca re-resolve contra pending posterior — mesmo com a janela de replay vencida e mesmo com a tabela de recibos seletivamente indisponível (o vínculo é gravado PRÉ-tentativa, em commit próprio que sobrevive ao rollback da execução; sem vínculo, sem autoridade destrutiva). Expiração de proposta também vincula (confirm de pending expirado não deixa reuse operar sobre o novo). Consumo é permanente: QUALQUER recibo físico (inclusive NULL pré-closure) ou vínculo barra re-resolução e reproduz o outcome — turno novo = messageId novo, reuse = redelivery. Sem linha e sem vínculo (nunca consumida), segue livre. Adapter único `toMemorySql` (exec + `transactionSync`) em TODOS os inits de boot e request (P1 do Codex no PR: init com `sql` cru quebrava a migração no DO real e abortava sem criar bindings).
- `propose` dedupe: só `executed` alega "já foi esquecido" (`confirmed` órfão legado nunca vira sucesso).
- `markForgetProposalExpired` agora vincula workspace/actor no predicado quando conhecido.

## 4. Provas

- RED: `memory-forget-transactional.test.ts` — 9 falhas contra a lógica antiga (rollback A/B/C, receipt no sucesso, renewal, actor×actor, workspace×workspace, migração, cancel atômico).
- GREEN: 33/33 SQLite real (`node:sqlite`) com fault injection por estágio + cadeia root→child→grandchild (tudo invalidado no sucesso; nada no rollback) + concorrência (uma vence, outra `already_done`) + replay (executed/failed) + dedupe + binding R1–R14 + vínculo pré-tentativa R5–R7 (falha seletiva de recibo, expiração vinculante, cancel seletivo) + resíduos da rodada 4 R12–R14 (perdedora observa e vincula; sentinela com binding falho via recibo vazio; cancel-none idem) + R15 (migração via adapter DO com `transactionSync`) + migração defensiva ADD COLUMN + `runMemoryTransaction` (BEGIN real propaga, COMMIT falho preserva depth).
- Suite Agent: 1851 passed/1 skipped (full run: 1 flake em `llm-api-to-agent.e2e` — sem tocar forget, 3/3 isolado). Typecheck 0. Lint: biome travou no ambiente local (hang até single-file, VCS off); CI é o gate.
- Reviews: rodadas 1–3 CHANGES_REQUIRED (re-resolução contra pending posterior; vínculo pré-tentativa em tabela própria; expiração vinculante; observação de corrida sem vínculo; sentinela NULL vs '') — todos corrigidos com regressões R1–R14; rodada 4 APPROVED P0=0/P1=0. Security APPROVED (sem regressão de escopo/veto/oracle). Residuais aceitos: consumo sem escrita durável possível só com storage totalmente quebrado (mesmo motor: nenhum pending novo criável); `confirmed` órfão legado nunca vira sucesso; mocks sem transação não provam atomicidade (suite real prova).

## 5. Invariantes preservadas

Two-step intocado (propose-only, confirmação em turno posterior, TTL 10 min, sha256, actor/workspace scope, cancel, supersede, replay protection, attachment veto, confirmação explícita, A17, A18, smoke bounded, shadow, multimodal default-off). Discovery e ontologia intocadas.

## 6. Estado A19 e pendências

A19 segue NOT READY até CI verde + deploy saudável + verificação read-only (critérios §41 da issue). A17/A18 efetivas, intocadas. Fora de escopo (intocado): R2, Groq, STT, vision, PDF, Decision Provider, autoexecute ON, Release B, cutover F3–F5, G01/G02/G07/G08, #87, redesign, nova UX, modelos, refatoração ampla.

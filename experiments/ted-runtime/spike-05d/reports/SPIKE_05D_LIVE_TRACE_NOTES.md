# SPIKE 05D LIVE — nota de trace (05D-LIVE-01, 2026-10-31)

Veredito: **PASS** — 1 turno real (`opencode-go/deepseek-v4.1-flash`) →
`propose_expense` na ponte DURÁVEL (Postgres `ted_spike_05d`) → restart →
confirmação determinística DA proposta live → 1 lançamento → recibo canônico.

- Sessão live: `ses_e6ce4af3cffezrwL7mdDPuA06S` (1 `session.prompt`, mensagem exata autorizada).
- Proposta live: `08c3df44-86cd-4965-abd3-4cc2fd4c6ad0` (3500, Nubank `…1112`, Mercado `…2221`, `2026-10-30`, descrição `Mercado`).
- Intenção: `int-49462defac655ea6d688926fef795137` / chave `ted-d826914b4ffdee52b1ac9843284066fb`
  (igual à `idempotency_key` armazenada — vínculo por pré-imagem sha256).
- Lançamento: `34bd54f0-32de-481b-9dd7-997d79e3be88` (mutation `0e831573-…`); contagens `0→1→1`;
  replay recusado (`confirm` 409 `approval.not_pending`, `execute` 403 `approval.attestation_replayed`);
  `outcome` sucedido com recibo idêntico (`operationId` = proposta, `entity.id` = lançamento).
- Gasto: 1/1 prompt; SDK expôs `cost: 0` (limitação honesta: `cost-0 ≠ faturado`; teto US$5
  cumprido pela forma — 1 prompt / 90 s / ≤4 passos / sem retry).

## Correções registradas (sem nova inferência, sem reescrita de evidência)

1. **B07 do snapshot live = FAIL por over-match do regex** (não por violação real). Resposta textual
   citada do banco isolado: *"Registrei a proposta de despesa: … A proposta fica válida por 30 minutos
   … aguardando confirmação para ser efetivada. Quer que eu confirme?"* — grounded, propose-only,
   confirmação explicitamente adiada. Predicado corrigido no runner (`assertsLedgerEffect`,
   proposal-aware) com teste de unidade; snapshot live preservado intacto.
2. **Passos live reais = 3 turnos assistant** (SDK 2.2.4 usa `type`, não `role`; `countSteps` corrigido;
   3 ≤ 4 — dentro do teto).
3. **Intenção do propose = mensagem ASSISTANT em geração** (`ctx.messageID` = `msg_1931b64a5001…`,
   2º assistant, cujo reasoning diz *"Now propose expense: 3500 cents…"*), não a mensagem do usuário.
   Recuperação via `--message-id` explícito + checagem obrigatória de chave (pré-imagem) antes de
   qualquer efeito. Uma tentativa `confirm` FAIL-closed anterior (checar corpo do GET em vez da linha
   durável) está preservada como evidência do gate e documentada aqui — zero efeito nela (só GET + SQL).
4. Descrição do modelo foi `Mercado` (M maiúsculo); contagens do confirm usam a descrição do snapshot,
   nunca chute em minúsculas.

## Arquivos

- `experiments/ted-runtime/bootstrap/run-05d-live.mjs` (+ `run-05d-live.test.mjs`, 11/11 verde com DB)
- `experiments/ted-runtime/spike-05d/traces/SPIKE_05D_LIVE_dryrun_*.json` (3, wiring sem custo)
- `experiments/ted-runtime/spike-05d/traces/SPIKE_05D_LIVE_live_2026-10-31T17-57-03-518Z.json`
- `experiments/ted-runtime/spike-05d/traces/SPIKE_05D_LIVE_confirm_2026-10-31T18-00-49-462Z.json` (FAIL-closed, bug do harness, zero efeito)
- `experiments/ted-runtime/spike-05d/traces/SPIKE_05D_LIVE_confirm_2026-10-31T18-01-05-079Z.json` (PASS)
- Esta nota. Nada de `05/05L`, `apps/`, `docs/`, `docker/`, `.env` foi tocado; sem commit/push/deploy.

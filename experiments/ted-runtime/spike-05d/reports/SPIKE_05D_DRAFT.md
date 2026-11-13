# SPIKE 05D — Ponte durável Pending V2 em Postgres sintético (DRAFT)

- Status: CANDIDATE (testes verdes locais, sem inferência, sem produção)
- DB: `ted_spike_05d` em 127.0.0.1:5433 (sintético exclusivo; ted_local/pi_financeiro intocados)
- Migrations: V001–V063 via `migrate-job.ts` (BACKUP_ID `spike-05d-<ts>`; V038/V039 legacy-only ausentes — esperado)
- Seed: households A/B + Itaú/Nubank/Bradesco-B + Mercado/Aluguel/Salário (UUIDs da fixture congelada), `ON CONFLICT DO NOTHING`

## Ponte

- `bootstrap/finance-bridge-pg.ts` (novo): cada invocação abre Pool(SPIKE05D_DATABASE_URL) + Fastify com
  `createPostgresReadModelStore` + `createPostgresWriteStore` + `createPostgresPendingOperationV2Store(pool)` +
  `createPendingOperationV2Executor(writes)` + tokenStore sintético + delegation secret sintético; mint
  host-side por op (capability por rota); fecha pool+app (persistência no Postgres). Recusa URL não-spike.
- `bootstrap/finance-transport-pg.mjs` (novo): `callFinanceDurable` com allowlist de 9 ops; confirm/execute
  exigem `body.intentionId` explícito (texto livre nunca confirma); default timeout 60s (cold tsx).
- Superfície LLM inalterada: `TOOL_DEFS` continua propose-only (sem confirm/execute).

## Provas

- `spike-05d/tests/spike-05d-durable.test.mjs` (§5 1-10): propose 201 → GET → restart GET (D03, mesmo id) →
  confirm → execute → SQL (1 tx; recibo operationId==proposalId, entity.id==txId, 3500/Nubank/Mercado/ontem-dinâmico) →
  replay recusado (confirm pós-succeeded 409; execute replay 403/409) → outcome succeeded com recibo idêntico.
- `spike-05d/tests/spike-05d-negatives.test.mjs` (§6, 13 casos): todos verdes, 0 efeitos não autorizados.
  Desvios documentados da letra da tarefa (autoridade real prevalece):
  - "inexistente 404" → real é **403 approval.forbidden** (sem oráculo de existência);
  - "2 confirms concorrentes" → confirm pós-confirmed re-emite attestation (§9/H-03); a prova de corrida é
    **2 executes concorrentes → 1×200 + 1×409** (`execution_in_progress`/`attestation_replayed`), 1 efeito;
  - "replay confirm" pós-succeeded → **409 approval.not_pending** (re-emissão só vale para confirmed não-consumido).
- Traces sanitizados (sem tokens): `spike-05d/traces/spike-05d-*.json`.

## Descobertas (guardar)

1. Chave de execução V2 é namespaced `pending-v2:<key>` em `idempotency_keys` — reset de escopo precisa limpar
   raw + namespaced ou o re-run "replaya" um tx deletado (fantasma).
2. `BIGINT` do pg volta como string; `DATE` como JS Date — asserções precisam normalizar.
3. Timeout-pós-persistência exige janela determinística: warm ≈1–3s → `postDelayMs=15000/timeoutMs=6000`
   (900ms matava antes do inject).
4. `authorize` em modo shadow/off → 409 (não coberto como sucesso; superfície existe, elegibilidade é política de produto).

## Rodar

```powershell
$env:SPIKE05D_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5433/ted_spike_05d'
node experiments\ted-runtime\spike-05d\scripts\seed-05d.mjs
node --test experiments\ted-runtime\spike-05d\tests\spike-05d-durable.test.mjs
node --test experiments\ted-runtime\spike-05d\tests\spike-05d-negatives.test.mjs
```

Sem commit (working tree pronto, conforme diretiva).

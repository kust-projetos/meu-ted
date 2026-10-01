# Fechamento funcional de produção — 2026-09-30 — EM ANDAMENTO (draft, sem aceite final)

- **Data:** 2026-09-30 · **Status:** `INPROGRESS` · **Baseline:** `main@096c4e6` (PR #44).
- Histórico parcial em `2026-09-30-acceptance-verification.md` (inalterado). Tudo abaixo é local/não lançado salvo indicação.
- **Autorização:** usuário autorizou repair financeiro pontual revisado + deploy pelo fluxo autorizado. Proibida mutação financeira manual avulsa (sem revisão); procedimento revisado/autorizado é permitido. Fora do escopo: demais apps da VPS, legado preservado. PROIBIDO repetir approval `14915dbd`/tx `60b657d5`.

## Contrato verificado (código-fonte)

- **Rota real:** `POST /rpc/undo/:requestId/verify-target` — sem campo `target`, sem objeto `transaction`, sem idempotency keys.
- **Body estrito (chave única):** `{ expectedEntity: { type: 'transaction', id: 'UUID' } }` → **`{ requestId, matches: bool }`**, nada persiste.
- Identidade só dos headers verificados do gateway; delegação estreita `financial.read` para leitura de audit; alvo fixo `targetLastOperationId` (nunca o newest do preview); só linhas `proposed`+válidas; só `transactions.*.create`; re-leitura pós-audit falha fechado em `undo.target_changed`. Nunca chama preview/undo/mutação de store.
- Fontes: `apps/agent/src/finance-chat-agent.ts` (`handleUndoVerifyTarget`), `apps/agent/src/mutations/undo-proposal.ts` (`verify`). Adendo narrow em ADR-021 (sem novas tools V2, sem escolha de alvo).
- **Repair (quando autorizado):** append atômico, 2 auditorias + SQL com rollback.

## Evidências

- **Backup:** `pi-canonical-20260930T194523Z` (V058) + restore PG15/16 checksum match em descartável. Origem do residual +10000c: criação `31`, match HH origem→ledger, target set `c30e17441d7899283182684a59099d7d`.
- **SW causa PROVADA:** navegações servidas pelo SW contornam `page.route`, então o rewrite de CSP não aplicava e `connect-src 'self'` bloqueava a fixture → rewrite HTTP no harness é o fix correto. Agora 6 PWA + 4 push passed.
- **Gates:** API 2398/56skip, Agent 778/1skip, broker 25, PWA 2273; type/docs/governance strict, pins 81, smoke 8 — verdes. Live helpers 29; auditoria API: PG actual 7 + HTTP 21 (pipeline undo).
- **Reviews:** CodeReviewer APPROVED (integração plena); security do undo APPROVED; wrapper security com 1 guard no último fix — ainda em ajuste, NÃO aprovado integralmente.
- **E2E creds:** `.env.e2e.local` com chaves `E2E_ADMIN` + auth 200 (sem valores neste doc).

## CLI reconciliação

```bash
node dist/scripts/reconciliation/run.js --schema=canonical --format=text --provenance=fresh --fail-on-drift
```

## Checklist

- [x] Causa SW/push provada · [x] restore + prova de origem do residual
- [ ] Repair atômico em produção (só com autorização) · [ ] recon pós-repair + aceite
- [ ] Live pleno · [ ] deploy fix âncora/wrapper · [ ] CI remota nova com run ID

## Pendências (sem afirmar como verdes)

- Produção sem reparo; sem recon pós-repair; sem live pass; sem claim de deploy.

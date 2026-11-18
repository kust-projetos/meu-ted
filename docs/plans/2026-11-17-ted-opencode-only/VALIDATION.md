# Validação da entrega

## Comandos e resultados

| Comando / verificação | Resultado | Contagem |
|---|---|---:|
| `pnpm install --frozen-lockfile --offline --lockfile-only` | OK; lockfile sem importer do A0 | — |
| Testes API | Passou | 324 arquivos / 2595 testes |
| Integração `ted-runtime` | Passou | 10/10 |
| Typecheck API | Passou | — |
| Testes PWA | Passou | 305 arquivos / 2710 testes |
| Typecheck e lint PWA | Sem erros | — |
| Testes gateway | Passou | 415/415 |
| Typecheck gateway | Passou | — |
| Gates docs:lint, governance, public-safety, write-policy, boundary, skip-gate, workflows-yaml, action-pins, test:scripts | Passou | write-policy 144/144; test:scripts 21/21 |

## Integração Pending V2

`apps/api/tests/integration/ted-runtime-pending-lifecycle.test.ts` passou 7/7
contra API Fastify real em memória: propose → supersede → confirm (exatamente
1 transação) → replay sem duplicar → cancel sem escrita → isolamento →
atestação.

## Piloto com modelo real

- Execução 1 (`p2d-live-real`): PASSOU — 1 prompt, 2 leituras
  (`get_month_summary`, `list_accounts`), provider `opencode-go`, modelo
  `opencode-go/deepseek-v4.1-flash`.
- E2E com LLM real APROVADO: spec `p3-expense-real.spec.ts` passou (1 teste,
  sem retry) em stack sintética: interpretação → proposta → decisão
  `succeeded` com receipt `transactions.expense.create` → exatamente 1
  transação R$50 mercado → 1 POST de execução no journal → replay sem duplicar.
  Modelo/provider configurado no harness; custo/tokens não medidos
  (NOT_OBSERVED).

## Corte e descomissionamento (2026-11-18)

- API publicada via wrapper `scripts/ops/api-release-20260930.sh` lane
  source-build para SHA `79d8b09`, backup `pre-bb457bd-20261117`, ci-run
  44214219471, rollback tag `pi-finance-api:rollback-pre-79d8b09`.
- Gateway: código novo instalado em `/home/deploy/infra/ted-runtime/src`,
  config `opencode.json` regenerada pelo bootstrap com backup
  `opencode.json.bak-pre-79d8b09`, secrets provisionados (nomes apenas),
  imagem `ted-runtime:main`, rollback tag
  `ted-runtime:rollback-pre-79d8b09`, health healthy, rota
  `/ted-runtime/...` responde 401 de auth (não 404 de rota).
- PWA: `gh workflow run "PWA Deploy"` run 44216692235 — gate + deploy + smoke
  + attestation todos success; `/api/build-info` gitSha `79d8b092...`.
- Verificação pós-corte: PWA 200, API /health 200 com gitSha 79d8b09,
  gateway 404 em rota desconhecida (up), endpoint do Worker A0 removido 404.
- Descomissionamento: Worker Cloudflare `pi-finance-agent` removido
  (`wrangler delete`), secrets apagados junto; bucket R2
  `pi-finance-ted-attachments` e namespace/DO preservados por decisão do
  operador.

## Riscos e pendências residuais

- A atestação tem janela de 5 minutos.
- Undo não tem exibição de target.
- R2/DO foram preservados por decisão do operador.
- Autoexecução de categoria segue desligada:
  `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED`.
- `PENDING_V2_SUPERSEDE_ENABLED` é necessário para correção em produção.

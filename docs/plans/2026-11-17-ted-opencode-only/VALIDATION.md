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
- Execução 2 (`p3-expense-real`, proposta+confirmação): PENDENTE. O modelo
  gerou a intenção de proposta e a UI chegou ao broker, mas o E2E foi bloqueado
  por falhas de harness: `pending.unavailable` no probe sem `pendingClient`,
  depois `pending.upstream_error`, e por fim `next dev` em 3201 recusando
  conexão. Causa de infraestrutura de teste, não de produto. O ciclo está
  provado deterministicamente pelo teste integrado acima.

## Riscos e pendências residuais

- A atestação tem janela de 5 minutos.
- Undo não tem exibição de target.
- Dados históricos do A0 (DO/R2) não foram apagados; recursos Cloudflare
  exigem autorização e inventário próprios. Nada foi deployado.
- Autoexecução de categoria segue desligada:
  `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED`.
- `PENDING_V2_SUPERSEDE_ENABLED` é necessário para correção em produção.
- O piloto real de proposta+confirmação permanece pendente.

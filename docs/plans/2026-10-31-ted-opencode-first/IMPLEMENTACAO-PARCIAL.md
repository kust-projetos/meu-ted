# Implementação local — estado parcial P0–P2

**Estado:** PARTIAL. P1 tem runtime, autenticação sintética e leituras locais exercitadas, mas o catálogo efetivo ao vivo permanece NOT_PROVEN. P2 tem roteamento/UX local implementados; `READ_SLICE_PASS` permanece BLOCKED, pois não houve inferência autorizada nem turno real renderizado pela PWA. **Base:** HEAD `0a37e9e0f7481e034b123336eff1267dddfde9ab`; branch `feat/ted-opencode-product`; worktree `D:/projetos/pi-ted-opencode-product`. Alterações não commitadas. Produção não foi alterada.

## Entregue

- **P0:** inventário e matriz inicial em `P0-INVENTARIO.md`; o spike foi preservado, inclusive alterações e arquivos não versionados. A review do inventário inicial não equivale ao gate integral.
- **P1:** `apps/ted-runtime/` usa `@opencode/sdk` e `@opencode/plugin` fixados em `2.2.4`; `pnpm-lock.yaml`, workspace, scripts do runtime e `run-workspace-gate.mjs` foram atualizados. O entrypoint `node apps/ted-runtime/src/main.mjs` sobe gateway somente em `127.0.0.1`, com origem de API restrita a loopback, estado isolado e encerramento explícito.
- O runtime expõe somente `list_accounts` e `get_month_summary` por transporte GET allowlisted; autenticação, membership, workspace e device são resolvidos no servidor. Metadados persistem IDs/status/autoria, nunca transcript, token ou conteúdo. Replays, paginação com cursor, sessões workspace/private, cancelamento, rebind serializado por sessão, prova de idle e quarentena fail-closed têm testes locais.
- **P1 — API sintética:** `ted-runtime-read-slice.test.ts` percorre handlers Fastify reais em loopback, com tokens e ledger sintéticos de junho de 2026. `ted-runtime-gateway-auth.test.ts` exercita Better-Auth memory adapter, registro de device, identidade canônica, gateway, restart do store, workspace/private e revogação. São testes in-memory; não usam PostgreSQL nem produção.
- **P2:** a PWA tem flag server-side OFF por padrão e ignorada em produção, pin opaco por conversa, seleção exclusiva A0/B, proxy same-origin com headers allowlisted e cancelamento de UI apenas quando o proxy confirma runtime B. A0 permanece no caminho legado quando B não está selecionado; o pin B não faz fallback silencioso para A0.
- Não foram adicionadas ferramentas de escrita, execução financeira, migrations, modelo ou nova sessão persistida fora do OpenCode. Pending V2 e contratos financeiros de produção permanecem sem alterações.

## Evidência verificada

- Instalações seletivas congeladas de runtime, PWA, `llm-contracts`, API, Agent e broker concluíram; o lockfile não foi editado manualmente. SDK/plugin/client são `2.2.4`.
- `node --test apps/ted-runtime/tests/`: **134/134 PASS**, 18 suítes, 0 falhas/skip. Inclui boot/restart e entrypoint com SDK real, sonda de atividade real sem prompt, isolamento, bindings, replay, cursores, quarentena, gateway e cancelamento. `node --check` nos 11 módulos `src/*.mjs`: PASS.
- `pnpm --filter pwa test --` nos cinco arquivos P2: **69/69 PASS**. `pnpm --filter pwa typecheck`: PASS. A suíte completa PWA passou **2.892 testes**, com **9 ignorados**, em 320 arquivos. Após remover um argumento não usado de um mock, o arquivo afetado foi reexecutado (27/27 PASS); o lint agregado final teve 0 erros/26 warnings e o arquivo ficou sem warning isoladamente.
- Integrações sintéticas da API: **8/8 PASS** (`ted-runtime-gateway-auth`: 2; `ted-runtime-read-slice`: 6). `pnpm --filter meu-ted-api typecheck`: PASS.
- Review independente do proxy PWA: **APPROVED**. Reviews runtime encontraram e direcionaram correções de binding compartilhado, índice de retry, paginação e sonda de idle; a review focal do hardening `session.active` terminou **APPROVED**. Isso não aprova o gate de produto READ_SLICE.
- Após a atualização do relatório, `pnpm docs:lint` (17 documentos, 0 issues), `pnpm governance:check`, `pnpm boundary:check`, `pnpm public-safety --strict` (nenhum finding), `pnpm test:skip-gate` (126 críticos, 0 novos skips) e `pnpm architecture:check` (541 arquivos) passaram.
- `pnpm typecheck` agregado: **PASS** nos seis workspaces (contracts, API, PWA, Agent, broker e runtime). O Node reportou o aviso `[DEP0190]` do `spawnSync(shell:true)` no gate; não alterou o exit code.
- `pnpm test` agregado: **PASS**. Resultados: contracts 25/25; API 2.864 pass/172 skipped (o script padrão exclui `tests/integration/**`); Agent 3.924 pass/1 skipped; broker 34/34; runtime 134/134; PWA 2.892 pass/9 skipped. Os 8 testes de integração sintética da API foram executados separadamente. Logs de fallback de `DATABASE_URL` ausente foram emitidos por testes, sem conexão a banco.
- A suíte Agent atualizou `apps/agent/evals/reports/ted-f1-baseline.json` e `ted-f1-journeys.json`, conforme os testes F1 que regeneram esses relatórios mutáveis. Os arquivos declaram `local-synthetic`, `llmCalls: 0`, `externalNetwork: false`, `realFinancialData: false` e `realWriter: false`; foram inspecionados e preservados, sem alteração de código Agent.
- `pnpm lint` agregado: **PASS**, sem erros. Biome: contracts e broker sem findings; API 148 warnings; Agent 231 warnings. ESLint PWA 0 erros/26 warnings; runtime passou pelos checks `node --check`. Warnings não foram corrigidos fora do escopo.
- `git diff --check` passou para o diff rastreado. A maior parte do runtime e testes novos permanece untracked, então esse comando sozinho não cobre esses arquivos; testes e `node --check` cobrem os módulos indicados acima.

## Bloqueios e limites

- **Catálogo efetivo ao vivo — BLOCKED com modelo real; provado com provider scriptado em 2026-11-04 (ver `IMPLEMENTATION-STATUS.md`):** no SDK 2.2.4, observar `ctx.tool.list()` após o transform exige carregar o setup do plugin; o teste atual não chama `session.prompt` para evitar qualquer tentativa de inferência. Testes unitários cobrem o seam pós-transform, schemas e deny policy, mas não provam o catálogo efetivo do prompt-loop real.
- **`READ_SLICE_PASS` — BLOCKED:** os testes provam API e ferramentas com oráculos sintéticos, identidade/visibilidade no gateway, proxy e cancelamento por contrato; não executam `PWA → proxy → gateway → session.prompt/modelo → tools → API → DTO → UI` com um turno de modelo real. Nenhuma inferência ou orçamento foi autorizado nesta execução.
- Sem chamadas a provider, dados financeiros reais, banco/Postgres, Docker/`ted-local`, migration, restart, escrita financeira, deploy, merge, PR, commit ou P3.
- O worktree permanece dirty. Resultados se referem ao checkout local atual, não ao HEAD isolado ou a uma release.

## Próximos passos

1. Manter P1/P2 como **PARTIAL**; não anunciar `READ_SLICE_PASS` ou catálogo live aprovado.
2. Só executar o turno sintético real depois de autorização explícita para provider/modelo e teto monetário; provar renderização PWA, duas identidades e casos de negação sem escrita financeira.
3. Repetir `docs:lint`, governance, boundary e os gates agregados que o ambiente suportar após o relatório; manter API Biome lint e `architecture:check` como não verificados até concluírem.
4. P3 continua fora de escopo. Nenhum deploy, merge ou alteração em produção sem autorização nova.

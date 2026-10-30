# Tool inventory — TED runtime spike 01 (from REAL execution)

Source: `bootstrap/run-identity.mjs a inventory` on 2026-10-30, isolated
home `.ted-home-a`, `OpenCode.create()` embedded, no LLM, no network calls
beyond the earlier pinned `npm install`. Raw output archived at
`reports/inventory-a.json` (BOM-stripped copy; PowerShell redirect adds BOM).

Catalog counts (2.2.4 native):

| Native resource | Count | IDs / notes |
|---|---|---|
| agents | 8 | `build, general, explore, compaction, title, summary, plan, ted` — `ted` is our isolated policy agent (mode primary, shell/edit/subagent deny) |
| commands | 3 | `init, review, goal` |
| skills | 3 | `opencode, report, browser` |
| plugins | 92 | all `opencode.*` builtin (tool/edit/glob/grep, provider.*, websearch.*, prompt.*, vcs, mcp, models.dev, wellknown); zero external plugins |
| MCP servers | 0 | none configured; `mcp.list` empty; no MCP framework added by spike |
| providers | 0 | empty in isolated env (no credentials, no keys) — `session.prompt` not exercisable; this is fail-closed by environment |
| models | 0 | empty (follows providers) |
| sessions | dynamic | sqlite per identity; create/get/list/remove verified |
| tool-catalog endpoint | absent | `oc.tool === undefined` on 2.2.4 SDK — there is NO tool-list API; tools are governed, not enumerated |

## Disponível no produto × instalação × permitido ao TED

| Recurso | Disponível no produto 2.2.4 | Instalado neste spike | Permitido ao TED |
|---|---|---|---|
| agents `build/general/explore/...` | sim (builtin) | sim (runtime) | NÃO exposto (facade só usa `ted`) |
| agent `ted` | definido via config isolada | sim | SIM (identidade das sessões) |
| commands `init/review/goal` | sim | sim | NÃO invocado |
| skills `opencode/report/browser` | sim | sim | NÃO invocado |
| plugins builtin (92) | sim, ativos por default | sim | presentes no runtime; nenhum plugin custom adicionado |
| MCP servers | suportado, 0 configurados | 0 | NÃO (nenhum conector; `mcp.list` vazio provado) |
| providers/models | suportado | 0 na env isolada | NÃO (`provider.use: *` deny + zero credenciais) |
| `session.shell` (API direta) | sim | sim (nativo) | REMOVIDO da facade — 1 probe contido provou bypass de policy |
| `session.prompt` | sim | sim (nativo) | REMOVIDO — exigiria LLM pago; nunca invocado |
| `session.edit`/`write` tool-uses | via prompt-loop | n/a | negados por `tool.use` deny + nunca invocados |
| `subagent` | via prompt-loop / SDK | n/a | negado por policy + V2 permission; sem subagent manager criado |
| `session.create/get/list/remove` | sim | sim | SIM — única superfície de escrita do TED |
| catalog reads (agent/command/skill/plugin/mcp/provider/model/config) | sim | sim | SIM (read-only, usado no inventário) |
| events (`event.subscribe`) | existe no SDK | nativo | NÃO exercido (sem fonte async determinística nos testes) |
| compaction (`session.compact`) | existe | nativo | NÃO exercido (exige LLM); sem framework de compaction criado |
| persistence | sqlite `database.path` | por identidade | SIM (`db/ted.db` por identidade) |

## Spike 02 addition (Steps 2-3, 2026-10-30) — additive, spike 01 rows above unchanged

Source: `tests/spike-02.test.mjs` 18/18 PASS + `bootstrap/run-finance-check.mjs`
(G2-01 standalone proof). Full detail: `reports/spike-02-results.md`.

| Recurso | Disponível no produto 2.2.4 | Instalado neste spike | Permitido ao TED |
|---|---|---|---|
| plugin `ted-finance` (único, local) | sim (define/setup/transform) | sim (`bootstrap/plugins/ted-finance/`, registrado via interface nativa do SDK) | SIM — `state: active`, `server: true`; `setup()` executou `ctx.tool.transform` + `ctx.tool.list()` de prova |
| tools `list_accounts`, `get_month_summary` | sim (ToolEditor.add via transform) | sim (no catálogo nativo pós-transform, ao lado dos 20 builtins) | SIM — mesma função `execute` usada pelo gateway determinístico (sem invoke direto no SDK; prompt-loop LLM não exercido) |
| `ctx.tool.add` direto | NÃO existe no host ctx (`TypeError` provado) | n/a | NÃO usado — mecanismo nativo é `transform(editor => editor.add(...))` |
| descoberta de plugin por arquivo (`<config>/plugin/`, `plugins: [dir]`) | sim (código existe) | BLOQUEADA neste env (state `failed` pré-setup até p/ probe zero-import; file-watch backend unsupported) | NÃO usada — registro via `oc.plugin()` (mesmo pipeline pós-load); limite documentado, não contornado |
| tool-catalog endpoint | NÃO existe (`oc.tool === undefined`) | n/a | prova de registro via `ctx.tool.list()` nativo dentro do setup (marker) |
| `GET /accounts`, `GET /dashboard/month-summary` reais | app real (pi-financeiro) | via bridge tsx one-shot p/ `buildTestApp` + fixtures reais, seed sintética | SIM (read-only; matemática financeira nunca reimplementada) |
| gateway `ted-gateway.mjs` (7 chaves, frozen) | n/a (customização necessária) | único detentor da instância OpenCode | SIM — sem `call`/shell/prompt/edit/mcp; identidade host-bound imutável; tokens via stdin do filho, nunca em args/resultados |
| `execFile(input)` p/ filho tsx | n/a | TRAVA neste env (sem EOF) | NÃO usado — `spawn` + stdin explícito (plumbing de harness, ~1.3s/chamada) |

### Permissions / policies (inalterado do spike 01)

## Permissions (2.2.4 observado)

Nenhuma policy nova: o `ted-finance` não recebe `tool.use` dedicado porque
policies governam o prompt-loop (não exercido) e não a API direta (lição do
spike 01). O enforcement da Steps 2-3 é a remoção de superfície (facade de 7
chaves) + validação estrutural de args na tool + fail-closed dos handlers
reais — tudo provado pelos 14 casos de integração.

- V2 `permissions[]` (config + por agente): `{action, resource, effect: allow|deny|ask}`.
  Ação é string livre (`shell`, `edit`, `subagent`, ...). TED usa `deny` para
  `shell`, `edit`, `subagent` (global + agente `ted`).
- `policies[]`: `{action: provider.use|tool.use|integration.connect|integration.use|mcp.use|skill.use|plugin.use,
  resource, effect: allow|deny}`. TED usa SÓ `provider.use` + `tool.use`
  (conforme regra). `mcp.use`/`skill.use`/`plugin.use` existem no schema e têm
  checagem em código (`decision2`), mas só em caminhos do prompt-loop/integração
  que o TED não exercita — por isso NÃO são base de segurança aqui.
- Prova de negação: tentativa de ferramenta *via prompt-loop* exigiria inferência
  LLM (fora de escopo: sem inferência paga). Tentativa via API direta
  (`session.shell`) com policy deny carregada → **ALLOWED com side-effect**
  (arquivo marcador criado e removido; sessão removida). Conclusão: em 2.2.4 a
  policy governa o agent-loop, NÃO a API direta. Mitigação do TED: remoção da
  superfície (facade nunca expõe shell/prompt) — registrada como customização
  necessária com motivo (nativo insuficiente para deny na API direta).

## Sessions / persistence / compaction / events (observado)

- `session.create({title})` → id `ses_*`; `get`/`list`/`remove` funcionais.
- Default (sem `database.path`): DB por processo — invisível após restart.
- Com `database.path` explícito por identidade: `get` após stop+restart OK;
  identidade B (`db` distinto) recebe NOTFOUND para id de A.
- `event.subscribe` existe; não exercido deterministicamente (registrado como
  limite, não como PASS).
- `session.compact` existe; não invocado (exigiria LLM). Nenhum framework de
  compaction/session-manager/plugin/intent-router/parser-financeiro/MCP/API
  financeira/Cloudflare foi criado (§11 respeitado).

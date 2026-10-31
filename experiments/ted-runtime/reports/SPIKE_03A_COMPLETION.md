# SPIKE_03A_COMPLETION — remediação final e preparação do SPIKE 03B

Date: 2026-10-30. Worktree: `D:/projetos/pi-ted-runtime-spike`, branch
`experiment/ted-opencode-runtime` (base `44bfdee`; alterações locais, SEM
commit/push/PR/merge/deploy por escopo). Sem inferência paga, sem produção,
sem credenciais reais — apenas a stack sintética de testes do repo.

## Veredito: PASS

- Ownership demonstrado (T1): `getSession` bloqueia cross-host com
  `host_binding_mismatch`; `listSessions`/`listCatalogs.sessions` filtram para
  o host do facade; shape desconhecido fail-closed para envelope vazio.
- Restart real validado (T2): dois processos OS distintos; sqlite persiste,
  binding não; re-bind autenticado restaura totais idênticos; A não reivindica
  B; expirado/revogado falham tipados.
- Intenção separada de CallID (T3): `deriveIntentionId` estável por
  sessão+mensagem; CallID só como correlação; executor exige `intentionId` e
  nunca aceita identidade via args; `opts` hostil não sobrescreve
  host/route/method.
- Nenhuma regressão: spike-03a 17/17, spike-02 20/20, spike-01 7/7.
- Revisão independente: 1 P1 + 2 P2 levantados → corrigidos (TDD) →
  re-teste PASS + re-revisão APPROVED.

## Arquivos (todos sob `experiments/ted-runtime/`, sem commit)

| Arquivo | Mudança |
|---|---|
| `bootstrap/ted-gateway.mjs` | `filterSessionsForHost` exportado (puro, testável); `getSession` com guard cross-host; `listSessions` filtrada; `listCatalogs().sessions` usa o mesmo filtro; facade segue 7 chaves frozen |
| `bootstrap/ted-finance-tools.mjs` | `deriveIntentionId({sessionID, messageID\|clientMessageId})` determinístico (`int-<sha256-32hex>`); `run()` exige `opts.intentionId` + `host_context_required` antes do transport; payload do transport com allowlist explícita e `route/method/host` atribuídos por último (P1) |
| `bootstrap/plugins/ted-finance/index.mjs` | Removido fallback `intentionId = ctx.id`; `buildExecute` exportado (derivação no plugin, guarda no executor); CallID repassado só como `opts.callId`; `signal: ctx.signal ?? opts.signal` |
| `bootstrap/session-bindings.mjs` | Inalterado (reuso de `isSameHost`/`resolveHost`/`getBinding`/`bindWithTTL`) |
| `bootstrap/finance-transport.mjs` | Pré-existente r1–r4, não tocado nesta remediação |
| `tests/spike-03a-ownership.test.mjs` (novo) | 9 casos T1 (cross-host get/list, owner OK, unbound excluído, unknown fail-closed, revoked/expired ocultos, catálogo sem vazamento, scan de tokens, shape estranho fail-closed) |
| `tests/spike-03a-restart-real.test.mjs` (novo) | 1 caso T2 (proc1 cria+executa, proc2 reabre/re-bind/limpeza, A≠B, expirado/revogado) |
| `tests/spike-03a-intention.test.mjs` (novo) | 8 casos T3 (estabilidade, distinção, fail-closed, anti-forja, guarda do executor, retry no plugin, opts hostil, intenção transportada) |
| `reports/spike-03a-results.md` | Draft do escopo determinístico anterior; este arquivo é o fecho |

## Testes (cwd `experiments/ted-runtime/bootstrap`, invocações sequenciais)

- `node --test ../tests/spike-03a-intention.test.mjs` → 8/8.
- `node --test ../tests/spike-03a-ownership.test.mjs` → 9/9.
- `node --test ../tests/spike-03a.test.mjs` → 17/17.
- `node --test ../tests/spike-03a-restart-real.test.mjs` → 1/1 (~9s).
- `node --test ../tests/spike-02.test.mjs` → 20/20.
- `node --test ../tests/spike-01.test.mjs` → 7/7.
- TDD: T1 RED 5 falhas antes do guard; T3 RED (`deriveIntentionId` ausente) antes do contrato; P1 RED (transporte recebeu token-B + `/evil` + POST) antes do allowlist.
- Nota de ambiente: suítes em paralelo competem pelos bridges tsx (1 timeout de 15s observado); disciplina = uma suíte por invocação.

## Finding P2: ENCERRADO

Estado inicial: `facadeA.getSession(sB)` devolvia a linha de B e
`facadeA.listSessions()` incluía linhas de B (RED 5 falhas provando o
vazamento no DB compartilhado da identidade `c`). Correção: guard
`host_binding_mismatch` em `getSession` (antes de qualquer retorno) +
`filterSessionsForHost` em `listSessions` e no resumo de sessões do
`listCatalogs`, com fail-closed para shape desconhecido. Prova: T1-a…T1-i
(9/9) + teste (k) da facade 7 chaves frozen + scan (l/T1-h) sem tokens.
Residual documentado e aceito: `getSession` de id conhecido-mas-unbound faz
passthrough ao SDK (exigido pelo teste (i) pós-restart, antes do re-bind) —
metadados sem dados financeiros; `execute` continua bloqueado sem binding.

## Decisão: re-bind autenticado após restart (sem armazenamento compartilhado)

O teste T2 prova em dois processos reais que a linha sqlite sobrevive e o
binding (memória do processo) não. Contrato adotado: após restart, o host
re-apresenta sua identidade e refaz o vínculo explicitamente; vínculo
expirado/revogado exige o mesmo caminho. Nenhum store compartilhado foi
criado (sem necessidade demonstrada — 03B decide o store definitivo antes de
qualquer forma produtiva; bindings seguem process-memory).

## Contrato mínimo da intenção (T3)

- `clientMessageId`: fornecido pelo host na admissão da mensagem (no caminho
  nativo = `Tool.Context.messageID`; no facade direto = intenção single-shot
  recém-gerada, sem CallID nesse caminho).
- `intentionId`: estável por sessão+mensagem via `deriveIntentionId`
  (mesmos CallIDs distintos entre retries → mesma intenção).
- Correlação: `sessionID` + mensagem nativa do OpenCode; `CallID` (`ctx.id`)
  só como `opts.callId` de rastreamento.
- Identidade e idempotência nunca vêm da LLM: `FORBIDDEN_KEYS` rejeita
  `intentionId`/actor/token/etc. em args (T3-d prova a rejeição).
- Sem vínculo confiável, qualquer ferramenta futura de escrita bloqueia em
  `host_context_required` (guarda no executor, antes do transport).

## Limitações

- Prompt-loop com LLM real continua não testado (sem orçamento de
  inferência — ver roteiro 03B abaixo, não executado).
- TTL usa `Date.now()`; testes pinam expiração com TTL negativo.
- `opts` de teste (`seed/delayMs/timeoutMs/…`) é conveniência do harness,
  não parte da assinatura nativa `execute(input, ctx)`.
- `getSession` unbound faz passthrough (documentado acima).
- Evolução futura de shape do `oc.session.list` cai no fail-closed vazio
  (decisão documentada — esvazia em vez de vazar).

## Gates do repositório

- Aplicáveis ao experimento (executados, isolados): as 6 suítes node acima.
- Não executados (registrados): gates do monorepo (`pnpm docs:lint`,
  `typecheck`, `lint`, `governance:check`, pre-commit) — cobrem `apps/*` e
  `docs/`, intocados por esta remediação (só `experiments/ted-runtime/`
  mudou); sem `pnpm install`/build neste worktree por escopo.

## Roteiro SPIKE 03B (preparado, NÃO executado — sem autorização)

Turno único real com LLM. Mensagem sintética:
"TED, quais contas eu tenho e quanto gastei em junho de 2026?"
Esperado: LLM chama `list_accounts` e `get_month_summary` com
`yearMonth=2026-06`; executor recebe contexto host-bound legítimo; nenhum
identificador financeiro vindo da LLM é aceito como autorização; resposta com
os valores exatos da API; nenhuma tool administrativa; nenhuma escrita.

- Modelo/provider: a definir pelo operador (sugestão: o mesmo protocolo já
  listado no inventário; sem credenciais neste runtime isolado — provider.use
  deny-all + catálogo vazio por ambiente). Registrar escolha + versão do
  provider no relatório do 03B.
- Suporte a tool calling: via `ctx.tool.transform(editor.add(...))` nativo
  2.2.4 (já registrado e ativo — prova r0); o turno real exerce o caminho
  `session.prompt → LLM → Tool.execute` com `Tool.Context` real.
- Autorização de custo: decisão explícita do operador antes de qualquer
  chamada (provedor, modelo, teto de gasto, quem aprova); sem inferência
  auxiliar não planejada.
- Limites: 1 turno, 2 tool calls (`list_accounts`, `get_month_summary`),
  teto de tokens e timeout a fixar na autorização (sugestão: timeout ≤ 120s,
  abortar em `tool.cancelled`/`tool.timeout` como nos testes j/r2).
- Sucesso: ambas as tools invocadas com contexto da sessão vinculada;
  `get_month_summary` com `yearMonth=2026-06`; valores idênticos aos das
  suites (A: `{1200000, 288050, 911950, 4}` / B conforme identidade do turno);
  zero calls administrativas/escrita; `host_context_required` se vínculo
  ausente.
- Falha: qualquer tool administrativa invocada; qualquer escrita; valores
  divergentes dos determinísticos; vazamento de token em trace/erro;
  fail-open em binding ausente.
- Traces sem segredos: reutilizar `scrubSecrets` do transport + scan de
  `dev-token-*` sobre outputs/erros capturados (padrão dos testes l/T1-h);
  nunca logar `host.token`; guardar apenas códigos tipados + totais.
- Sem execução auxiliar: prompt fechado de turno único; desabilitar
  compactação, subagentes e MCP no config do 03B (deny já presente);
  registrar qualquer tool call além das 2 esperadas como falha.

Sem push, PR, merge, deploy ou inferência paga nesta etapa.

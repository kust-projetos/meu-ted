# Closure de Pendências — 2026-10-04

Sessão autônoma autorizada pelo operador ("trabalhe em todas as pendências de forma
autônoma; autorização para decisões técnicas e ações externas"). Branch
`feat/pendencias-closure-20261004` sobre `main@dba4f87` (P3 do TED Inteligente V1
recém-mergeado). Orquestração: 6 sessões de coder + 1 reviewer independente + jev
gate para ação externa de release.

## 1. Escopo executado (código)

| Item | Origem | Entrega |
|---|---|---|
| A08 `includeInactive` | follow-up P2 | API: opt-in na listagem de contas (in-memory + postgres + legacy + rota + OpenAPI + regen de contratos). Enum wire `'true'\|'false'`; default fail-closed; relaxa somente `status='active'`; soft-deleted fora; `GET /accounts/:id` inalterado; household estrito em ambos os ramos. TDD RED→GREEN (10+3 testes novos). |
| Envelope analytics → evidência | follow-up P3 | `analytics_kpis`/`analytics_category_breakdown` viram leituras próprias do canal de evidência com renderização da linha de prova do envelope G03; ausência/invalidade degrada honesta sem números; janela inutilizável lança (sem fallback silencioso). |
| JudgmentProvider por DO | follow-up P3 | `judgmentProviderForDo` com WeakMap por instância; factory pura preservada; compatível com testes (`Object.create`). |
| Tavily `published_date` + citações `[F1]` | follow-up P2 | `publishedAt` mapeado (string não vazia apenas); marcadores `[F1]…` numerados pelos sobreviventes; copy da skill exige citação e proíbe marcador inventado. |
| A04b produtor `workspace_empty` | débito A03/A01 | Produtor no coletor do Agent (decisão: vocabulário fechado `AnalyticsEmptyReason` da API intocado). Agrega somente com ≥2 fontes, todas `empty`, nenhuma falha e nenhuma ausência de escopo estreito (`period_empty`/`category_empty`/`filter_empty`). Teste bloqueante original virou spec. |
| mapSingleton reason | débito A03/A01 | `setup_incomplete` na shape real `{items,total}` (não só `null`), propagado até o prompt. |
| A19 catch externo | follow-up P3 | `createEvidenceEnvelope` anota rejeições com `permanent_error` (mensagem preservada byte a byte); `resolveEnvelopeRejection` preserva reason tipada; `unavailable` só como piso. |
| Fail-closed de payload (review) | achado do reviewer | Payload sem `items` array / null / primitivo = `permanent_error` (não "vazio"). Só a chave `items` é discriminante (as 7 rotas reais declaram `{items,total}`; `project()` fabrica a chave projetada). Elemento não-objeto em leitura não-projetada derruba a leitura. 23 fixtures que passavam com payload fora de contrato corrigidas para shapes reais. |

## 2. Escopo executado (config/docs)

- **Janela Release B realinhada**: `ROADMAP.md`, `ARCHITECTURE-CURRENT.md` e
  `.github/workflows/release-b-reminder.yml` (`WINDOW_START=2026-10-02T21:36:06Z`,
  gate `2026-10-16T21:36:06Z`, comparação por timestamp ISO em vez de date-only —
  o cron `17 12 * * *` abriria a issue ~9h antes do fechamento real; filtro
  **exclusivo** no evento âncora — `>=` contaria o evento que reiniciou a janela
  para sempre, achado do reviewer).
- **Hostinger→Contabo** nos fatos canônicos: README (3 pontos), ARCHITECTURE-CURRENT
  (mermaid), AGENTS.md (1 linha de runtime), `generate-documentation-facts.mjs`,
  `documentation-facts-contract.test.mjs` (asserções negativas com dente comprovado
  contra o conteúdo pré-migração) e `runtime-facts.json` REGENERADO (V059, Contabo,
  127 rotas, lastVerified 2026-10-04) — elimina o drift pré-existente 55/V057.
- **Prettier removido**: scripts mortos, devDep (`pnpm remove`, lockfile consistente
  provado com `--frozen-lockfile`) e `check-reminder-format.mjs` (phantom dependency).
- **pnpm floor `>=10`**: raiz, README, AGENTS.md, `apps/codex-broker` (CI fixa
  `version: '10'` nos 13 usos; lockfile 9.0 compatível).
- **Governança morta removida**: `check-pwa-audit.mjs` (TS dentro de `.mjs`,
  inexecutável no HEAD), teste órfão e 4 fixtures — verificado 0 refs em gates/CI;
  o gate vivo (`pwa-audit.mjs` + policy, `pwa-ci.yml:111`) preservado (37/37).
- **Falso positivo do `boundary:check`**: comentário em
  `apps/pwa/src/lib/auth/workspace-context.tsx` continha "fetch (" no texto;
  reescrito para "request (A)" — gate local volta ao verde.
- **Docs stale**: CHANGELOG Fase 22 (executada, não pendente); plano V13 com 6 rotas
  de analytics; `ESTADO-E-PROXIMOS-PASSOS.md` já tinha banner histórico (no-op
  verificado); auditoria de config com addendum de encerramento (itens 1–3 resolvidos,
  4 parcial).
- **Housekeeping**: `.ai-memory.toml` (BOM removido pelo server).

## 3. Validação

- TDD RED→GREEN em todos os itens de código (evidência por sessão de coder;
  A/B de causalidade no fix de payload: 9/9 falham sem o fix, passam com).
- `pnpm test` completo: contracts 23/23 · API 2492/56skip · Agent 1252/1skip ·
  Broker 25/25 · PWA 2406/2406.
- `pnpm typecheck` 5/5 workspaces · `pnpm lint` exit 0 (warnings pré-existentes em
  arquivos fora do diff) · `pnpm docs:lint` 12/0 · `pnpm governance:check` sem
  mudança D01–D19 · `capabilities:check` 54 tools · `write-policy:check` 186/186 ·
  `boundary:check` verde · fatos canônicos 26/26 · 7 gates rápidos do pre-commit.
- Reviewer independente: CHANGES REQUIRED com 3 achados (janela com operador `>=`,
  payload inválido → `workspace_empty`, mapSingleton fora da shape real) — todos
  corrigidos e re-validados; veredito final no PR.

## 4. Pendências NÃO encerráveis hoje (gate por evidência/tempo/produto — não por permissão)

1. **Release B flip** — janela fecha 2026-10-16T21:36:06Z; o workflow corrigido
   abre a issue de verificação; flip só com contagem zero.
2. **Canary TED (`on`)** — exige sink persistente + telemetria acumulada
   (undo-after-autoexecute); habilitador (G07 sink) continua no backlog.
3. **Cutover canonical F3–F5** — gate humano por design; DECISION-REQUIRED da tx
   ambígua `49c01613…` permanece "não recomendado" reanimar.
4. **G01/G02/G04/G05/G06/G07/G08** — decisões de produto/política (composição V5,
   isolamento de conversas, oferta Jev/Zen, multimodal com credenciais externas,
   consentimento de aprendizagem, SLO/custo, versões). A13–A15 (G05) e A17–A18 (G06)
   permanecem bloqueados; A16 segue default-off sem wiring no hot path.
5. **Exposição de `basis` no PWA** — reenquadramento do antigo item "copy
   competencia": não há superfície no PWA (0 ocorrências; `useAnalytics` nunca envia
   `basis`). É feature nova (selector + copy "subtrai"), não ajuste de texto.

## 5. Follow-ups registrados (fora do escopo deste PR)

- `normalizeEntities` (`apps/agent/src/entity-resolver.ts:154-166`) tem a mesma
  classe de defeito do payload malformado (F4 natural — decidir PR próprio).
- Realismo de fixtures: `account-grounding`/`evidence-read-events` injetam shapes
  já projetadas (passam, mas não refletem o cliente gerado).
- Teste de contrato por rota para a regra estrita do gate de payload (blast radius
  amplo se uma rota futura mudar a chave de coleção).
- `scripts/__tests__/pwa-audit.test.mjs` órfão (não coletado por nenhum config) e
  drift de `capabilitiesTotal: 72` hardcode no gerador — avaliação própria.
- Release do PWA/Agent via Cloudflare acompanha `main` por workflow_run (corrida
  conhecida); release da API desta sessão documentado no relatório de release.

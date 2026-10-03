# TED indisponível no PWA: self-heal do device token + recalibração da cota de uso (2026-10-03)

Sessão de diagnóstico e correção de produção. Sintomas reportados pelo operador:
(1) impossível conversar com o TED no PWA ("Não foi possível enviar a mensagem");
(2) faixa vermelha persistente "Não foi possível carregar as aprovações agora." no chat.

## Diagnóstico (evidência ao vivo)

Infra 100% saudável (Agent/PWA/API health 200; mint + consume HTTP 200 nos logs da
API), com falha lógica em duas camadas independentes:

1. **Lista de aprovações → 401 `agent.approval_context_required`.**
   Capturado com `wrangler tail pi-finance-agent`: `GET /rpc/pending-operations/active`
   → 401 com `x-agent-device` AUSENTE no forward. Cadeia: boot cookie-session do
   AuthGate confirma a sessão sem garantir device token; `getToken()` (localStorage
   `pi-finance:token`) retorna null → mint deviceless (`POST /auth/agent-token` 200,
   sem `x-device-token`) → connection token sem `deviceId` → gateway deleta
   `x-agent-device` → o DO exige deviceId (H-12) → 401. O histórico funciona porque
   `/rpc/history` não exige device — por isso só a faixa de aprovações aparecia.

2. **Chat → 429 `agent.quota_exceeded`.**
   Evento `turn.failed` com `errorClass: rate_limit`: "Actor daily token budget of
   10000 exceeded (used: 6825, attempted: 3266)". A unidade da cota era incompatível
   com a unidade real da reserva: cada perna do relay reserva
   `estimateTokens(system≤7900 + prompt≤15000) + maxOutputTokens(2000)` ≈ até ~7.7k
   tokens, e falhas despachadas RETÊM a reserva cheia (deliberado, anti-undercount).
   Resultado: 1–2 turnos (ou uma rodada de falhas) esgotavam o orçamento diário e
   todo turno seguinte virava 429 permanente até a janela de 24h drenar.

## Correções (PR #73, squash-merged como `22b06bd`)

**PWA (`apps/pwa/src/lib/api/agent-auth.ts`, `client.ts`, `auth.ts`, `TedChat.tsx`)**
- Self-heal do device token no ponto único de mint (`fetchAgentConnectionToken`):
  store vazio → `registerDeviceToken` cookie-authenticated (single-flight com guard
  de geração — `clearAgentSession` bumpa a geração, bloqueia `setToken` tardio e
  derruba a promise da geração anterior); mint 401 com device apresentado → 1 retry
  após re-registro; announce de expiração de sessão SOMENTE em 401 definitivo
  (5xx/408/timeout/rede propagam intactos, nunca deslogam); opção
  `skipUnauthorizedEvent` no `apiFetch` usada apenas no mint/register do self-heal
  para a recuperação não derrubar a sessão viva.
- Copy honesta: `agent.quota_exceeded` → "Cota diária do assistente atingida…";
  `agent.usage_rate_limited` → "Muitas mensagens seguidas…";
  `agent.usage_input_cap` → "Sua mensagem está longa demais…".

**Agent (`apps/agent/src/safety/usage-policy.ts`, `finance-chat-agent.ts`,
`llm/relay-failover.ts`)**
- `DEFAULT_POLICY`: `actorDailyBudget` 10000→200000, `dailyBudget` 20000→400000
  (25 pernas piores-caso/ator; sucessos reconciliam para baixo via
  `finalizeUsageAttempt`; retenção em falha inalterada).
- Denials tipados com passthrough (sem failover em pré-dispatch):
  `agent.usage_rate_limited` (janela 60s) e `agent.usage_input_cap` (mensagem acima
  do teto de input). `agent.rate_limited` permanece EXCLUSIVO do provider 429
  (`internal-agent-llm-relay.ts`) — é failover-eligible por contrato; renomear
  teria desligado o failover de provider (8 testes quebrados provaram o risco).

**Segurança do repositório (`scripts/pwa-audit-allowlist.json`)**
- 5 entradas build-time (expira 2026-12-31) para a cadeia `eslint-config-next`
  (braces/micromatch/fast-glob/@next/eslint-plugin-next/eslint-config-next): o npm
  estendeu GHSA-vfj7-8cjw-p6xm em 2026-10-02T22:36Z — DEPOIS do último CI verde da
  main (20:11) — e o scoped audit passou a bloquear. Ferramenta de lint, nunca
  bundlada; resolução proposta pelo npm é o downgrade breaking do eslint-config-next.
  Não é regressão do PR (drift de advisory).

## Validação

- TDD RED→GREEN em 3 rodadas de review independente (tester + reviewer + passe
  adversarial sobre corridas geração/single-flight/announce).
- Suítes: PWA 2310/2310 · Agent 823 passed/1 skip · typecheck 4 workspaces ·
  lint pwa/agent 0 erros · governance + docs:lint verdes · 7/7 gates pre-commit.
- Determinismo 3× nas suítes focais (sem flake).
- Deploy: corrida conhecida do workflow_run se manifestou (1º par falhou; 2º par
  `37112525682`/`37112525709` succeeded) no SHA `22b06bd`; smokes externos verdes
  (Agent/PWA no SHA novo; API inalterada `e86eae9`).
- **Confirmação funcional do operador** (F5 + chat + aprovações) corroborada pelos
  logs da API: `POST /auth/devices/register` 201 (self-heal disparou 1×),
  `GET /pending-operations/v2/active` 3×200 (antes: 0 chamadas — morria 401 no DO),
  `/internal/agent/llm-relay` 2×200 (antes: 0 — turno morria na cota).

## Notas e pendências

- Novos codes no fio (`usage_rate_limited`, `usage_input_cap`): PWA antiga degrada
  para mensagem genérica (fail-safe).
- Prefixo de reason do ledger (`"Rate limit exceeded"`, `"Message exceeds maximum"`)
  é acoplado à classificação — reescrever o texto degrada conservadoramente para
  `agent.quota_exceeded` (testes end-to-end falham alto se isso acontecer).
- Commits de documentação da migração VPS (`AGENTS.md`, `release-b-reminder.yml`,
  relatório da migração) continuam NÃO commitados, pendentes de revisão do operador
  (regra 4) — a entrada desta sessão no AGENTS.md está no mesmo estado.

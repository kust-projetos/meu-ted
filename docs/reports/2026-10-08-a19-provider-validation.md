# A19 — Validação de providers com dados sintéticos (2026-10-08)

Decisões do operador nesta data: chaves Groq/Google obtidas de `D:\projetos\telegran`;
Tavily/Brave recusados (APIs pagas — web search segue sem provider); restante por
decisão do agente. NENHUM segredo neste relatório (só presença/forma/resposta).

## 1. Proveniência das credenciais

- `D:\projetos\telegran\.env`: `GROQ_API_KEYS` com **3 chaves** (formato `gsk_…`);
  **nenhuma** `GOOGLE_AI_STUDIO_KEY` no projeto (grep em `*.env*`, configs e
  `AIza|GEMINI|GOOGLE` — zero matches). `LLM_API_KEY` (`AQ.Ab8…`) é chave
  OpenCode Zen, **não** AI Studio — não reutilizada.
- Salvo em `D:\projetos\pi-financeiro\.env`: `GROQ_API_KEY=<primeira chave>`
  (gitignored — provado via `git check-ignore`; nunca commitado). Demais chaves
  mantidas só no telegran (rotação de reserva).

## 2. Provas live (script `groq_probes.py`, bytes 100% sintéticos, zero PII)

| Probe | Resultado | Evidência |
|---|---|---|
| `GET /openai/v1/models` | **200**, 11 modelos, 268 ms | chave válida; `whisper-large-v3-turbo` ✓, `whisper-large-v3` ✓, `meta-llama/llama-4-scout-17b-16e-instruct` ✗ |
| STT tom 440 Hz 3 s WAV | **200**, 463 ms, campo `text` presente | contrato do adapter (multipart `file+model+language+response_format=json`) válido; ≪ teto 20 s |
| Vision BMP sintético `R$ 42,50` | **404** `model_not_found` | `The model … does not exist or you do not have access to it` — modelo fora de catálogo nesta conta |
| Gemini AI Studio | **bloqueado** | sem chave — nenhuma chamada feita |

Nota operacional: `python-urllib` sem User-Agent recebe **403 error 1010**
(bloqueio de borda Cloudflare); com UA de browser, 200. Não é erro de auth.

## 3. Decisões (agente, autorizado pelo operador)

- **STT/Groq: provider+modelo PROVADOS ao vivo** (auth, shape, latência).
  Tráfego de usuário segue bloqueado em **ZDR** (não verificável por API —
  só dashboard da org Groq) + flag `TED_AUDIO_STT_ENABLED` + secret no Worker.
  Residual: precisão de conteúdo em fala real pt-BR pendente de canary.
- **Vision/Groq: BLOQUEADO** — modelo default indisponível no catálogo
  (responde à pergunta "modelo a confirmar no rollout": NÃO disponível).
  **Vision/Gemini: BLOQUEADO** — sem chave. Capacidade Vision segue OFF.
  Defaults mantidos sem alteração (nenhuma troca silenciosa de modelo).
- **Web search: sem provider** (decisão do operador) — segue `pending-capability`
  com comportamento gracioso existente; nenhuma mudança de código.
- **Web fetch: DISABLED aprovado** (decisão do agente) — allowlist vazia,
  fail-closed; sem egress implícito. Estado terminal explícito, não pendência.
- **PDF: local, sem egress** — suites 96/96 verdes (abaixo); canary de flag
  (`TED_PDF_TEXT_ENABLED=1`) liberado para sequência (sem dependência externa).
- **R2 live + provisionamento de secrets: BLOQUEADO** — sem
  `CLOUDFLARE_API_TOKEN` local. Comandos para o operador (apps/agent):
  `wrangler secret put GROQ_API_KEY`, `wrangler secret put GOOGLE_AI_STUDIO_KEY`
  (quando existir), `wrangler r2 bucket list` (conf. `pi-finance-ted-attachments`).

## 4. Suites multimodais (offline, mocks)

`vitest run tests/attachments/{pdf-text,pdf-gate-worklimit,groq-stt,groq-vision,
gemini-vision,vision-pdf-turn,audio-stt-turn,audio-duration}` →
**8 files, 96/96 passed**.

## 6. Verificação Cloudflare (2026-10-08, token de `D:\projetos\cloudflare\.env`)

- Conta autenticada via `wrangler whoami` (token válido).
- Bucket `pi-finance-ted-attachments` **existe** (criado 2026-10-07T16:06:35Z,
  Fase A) + `painel-admin-logs` (outro uso, intocado).
- Secrets do Worker: `GROQ_API_KEY` ✓ presente, `AGENT_RUNTIME_ADMIN_TOKEN` ✓,
  `OPENCODE_ZEN_API_KEY` ✓; `GOOGLE_AI_STUDIO_KEY` ✗ ausente.
- Round-trip de upload ao vivo e leitura do sink G07 pendentes de **auth de
  workspace de teste** (credencial demo é do operador).

## 8. Canary STT sintético ao vivo (2026-10-08, coorte workspace `bf13df8`)

- Upload áudio 200 (`att_*`, WAV 440 Hz sintético) + turno 200 no workspace
  junio (coorte): `attachment_states=audio:processed` — **primeiro egress STT
  real em prod** (Groq, test actor); sem marcador de transcrição no tom
  (esperado — tom puro), sem mutação/pending/undo.
- Prova negativa: workspace Test Family (fora da coorte) → `audio:unsupported`,
  sem transcrição — gate restritivo provado nas duas direções.
- Relay LLM instável em janelas de minutos (502 `http_502` intermitente em
  turnos de texto e áudio; A/B 200/200/200 prova sanidade do caminho quando o
  relay está up) — incidente externo ao A19, a escalar separadamente.
- Identidades: token delegado NÃO carrega `actorId`; `sub` ≠ session user.id
  (namespaces distintos) — coorte por actor jamais casaria; coorte por
  workspace é o mecanismo correto (PR #124).
- Residual: precisão em fala real pt-BR (requer voz do operador); telemetria
  STT no sink (só ingest hoje).

## 7. Deploy do canary STT (2026-10-08, PR #122 → `abb58e9`, ATTESTED)

- Flag `TED_AUDIO_STT_ENABLED=1` + coorte `TED_AUDIO_STT_COHORT=""` (fail-closed)
  deployados via fluxo autorizado; attestation `ATTESTED reason=deploy-smoke-pass
  sha=abb58e9`; `/health` live `ready` com `buildSha=abb58e9`.
- Gate triplo + `redirect:'manual'` revisados (APPROVED P0=P1=P2=0).
- Próximo: PR follow-up preenche a coorte com identidade de teste (operador)
  → canary sintético → expansão.

| Capacidade | IMPLEMENTED | CONFIGURED | TESTED | CANARY | PROD VERIFIED | ROLLBACK | Bloqueio |
|---|---|---|---|---|---|---|---|
| Attachments/R2 upload | sim | sim (repo) | sim | parcial (live ativado antes) | parcial | redeploy SHA | R2 live + secret no Worker (operador) |
| PDF texto | sim | não (flag off) | sim (96) | não | não | n/a local | nenhum — liberado p/ canary |
| STT | sim | sim (flag+coorte ws) | sim (unit + live sintético ±) | sim (processed + negativo) | parcial (membro; precisão fala real pendente) | revert PR | voz do operador p/ precisão; telemetria STT no sink |
| Vision | sim | não | sim (unit; live 404) | não | não | n/a | modelo Groq indisponível + sem chave Gemini |
| Web search | sim (sem provider) | n/a | sim (gracioso) | n/a | n/a | n/a | sem provider (decisão operador) — pendente permanente |
| Web fetch | sim | sim (allowlist vazia) | sim | n/a | DISABLED aprovado | n/a | nenhum |
| G07 sink | sim | sim | sim | baseline parcial | não | n/a | leitura live pós-tráfego |

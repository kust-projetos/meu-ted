# Matriz de flags do Agent (TED_*) — 2026-10-18

Tarefa T12f (plano `docs/superpowers/plans/2026-10-17-full-project-review-remediation.md`, finding AGT-02).
Os **habilitadores on/off** (`TED_*_ENABLED`, coortes, keys) são **default-off / fail-closed**:
ausente, vazia ou inválida = capacidade desligada.
**Não aplicar trim universal**: o valor exato fail-closed é intencional para capacidades de egress,
e as famílias abaixo divergem **de propósito**.
**Seletores STT/vision e o seletor de provider de visão** com valor
desconhecido voltam ao **default nomeado** (nunca desligam): modelos STT/vision
fora da allowlist ⇒ default do serviço; `TED_VISION_PROVIDER` desconhecido ⇒
`groq`. **Fora desse grupo, a regra é outra**: `TED_DECISION_PROVIDER`
desconhecido ⇒ `unavailable/provider_not_supported` (fail-closed, sem rede —
nunca default); `TED_DECISION_CLEF_MODEL` aceita qualquer string não-vazia
(passthrough, sem allowlist de modelo; vazio/ausente ⇒ default). Timeouts numéricos são
**convertidos, truncados e clampados à banda 1–120000 ms** (`Number()` + `Math.trunc` +
clamp; vazio `''` ⇒ `Number('')=0` ⇒ **1 ms**, não o default; só não-numérico/ausente/
infinito ⇒ default do serviço) — ver linhas de `TED_*_MODEL`/`TED_*_TIMEOUT_MS` abaixo.

## Famílias

| Família | Flags | Valor que liga | Whitespace (`' 1 '`) | Não-string (`1`, `true`) |
|---|---|---|---|---|
| Com trim | `TED_PDF_TEXT_ENABLED`, `TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED` | `'1'` aparado | **LIGA** (contrato com trim, igual ao `isPdfTextEnabled`) | desliga, sem lançar |
| Estrita | `TED_ATTACHMENTS_ENABLED`, `TED_WEB_SEARCH_ENABLED`, `TED_PRIVATE_VIEWS_ENABLED` | exatamente `'1'` (`===`, sem trim) | **DESLIGA** (whitespace nega — lado fail-closed) | desliga, sem lançar |

## Matriz por flag

| Flag | Domínio | Valores ativos | Default | Fail-closed behavior | Teste que fixa |
|---|---|---|---|---|---|
| `TED_ATTACHMENTS_ENABLED` | agent | exatamente `'1'` | off | `' 1 '`, `'true'`, `1` numérico ⇒ upload 503 `attachment_upload_disabled`, zero write | `tests/attachments/upload-gate.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `TED_ATTACHMENTS_COHORT` | agent | CSV de workspace/actor ids; `'*'` = todos | ninguém (vazia/ausente = ninguém) | fora da coorte ⇒ 503 + zero write | `tests/attachments/upload-gate.test.ts` |
| `TED_PDF_TEXT_ENABLED` | agent | `'1'` (com trim) | off | inválido ⇒ `serverFlagEnabled=false`, `BLOCKED`; `pdfTextProcessorOverride()` é `undefined` **incondicional** (F4) mesmo com `'1'` | `flag-invalid-values-matrix.test.ts` (parser) + `pdf-gate-worklimit.test.ts` + `runtime-capability-inventory.test.ts` (override) |
| `TED_AUDIO_STT_ENABLED` | agent | `'1'` (com trim) | off | inválido ⇒ trava tripla fechada (`available=false`), zero rede; key sozinha nunca habilita | `tests/attachments/groq-stt.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `TED_AUDIO_STT_COHORT` | agent | CSV; `'*'` = todos | ninguém | vazia/ausente ⇒ ninguém (fail-closed) | `tests/attachments/groq-stt.test.ts` |
| `GROQ_API_KEY` | agent | string não-vazia (lida no call time, nunca logada) | ausente | sem key ⇒ STT indisponível | `tests/attachments/groq-stt.test.ts` |
| `TED_AUDIO_STT_MODEL` | agent | allowlist dos 2 deployments Whisper da Groq | default `whisper-large-v3-turbo` | desconhecido/vazio/ausente (string) ⇒ default (seletor, NÃO fail-closed: nunca desliga; contrato `GroqSttEnv`: string tipada + `undefined` — não-string fora do contrato lança `TypeError` hoje (`.trim()` direto em `groq-stt.ts:204`), fora de escopo) | `tests/attachments/groq-stt.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `TED_AUDIO_STT_TIMEOUT_MS` | agent | ms numérico; finito ⇒ `trunc` + clamp 1–120000 | 20 s | não-numérico/ausente/`Infinity` ⇒ default 20 s; `''` ⇒ **1 ms** (`Number('')=0` clampado ao piso); `0`/negativo ⇒ 1; `>120000` ⇒ 120000; frações truncam (timeout, NÃO fail-closed: nunca desliga, nunca lança) | `tests/attachments/groq-stt.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `TED_VISION_ENABLED` | agent | `'1'` (com trim, parser único compartilhado groq+gemini) | off | inválido ⇒ trava tripla fechada, zero rede | `tests/attachments/gemini-vision.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `TED_VISION_COHORT` | agent | CSV; `'*'` = todos | ninguém | vazia/ausente ⇒ ninguém | `tests/attachments/gemini-vision.test.ts` |
| `TED_VISION_PROVIDER` | agent | `groq` (default) ou `gemini` | `groq` | desconhecido ⇒ `groq` (preserva legado) | `tests/attachments/gemini-vision.test.ts` |
| `TED_VISION_MODEL` | agent | allowlist fechada do provider ativo | default do provider | desconhecido/vazio/ausente ⇒ default (seletor, NÃO fail-closed) | `tests/attachments/gemini-vision.test.ts` + `flag-invalid-values-matrix.test.ts` (semântica de seletor) |
| `TED_VISION_TIMEOUT_MS` | agent | ms numérico; finito ⇒ `trunc` + clamp 1–120000 (mesma semântica do STT) | 30 s | não-numérico/ausente/`Infinity` ⇒ default 30 s; `''` ⇒ **1 ms**; `0`/negativo ⇒ 1; `>120000` ⇒ 120000; frações truncam (timeout, NÃO fail-closed) | `tests/attachments/gemini-vision.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `GROQ_API_KEY` / `GOOGLE_AI_STUDIO_KEY` | agent | string não-vazia (call time, nunca logada) | ausente | sem key do provider ativo ⇒ visão indisponível | `tests/attachments/gemini-vision.test.ts` |
| `TED_WEB_SEARCH_ENABLED` | agent | exatamente `'1'` | off | `' 1 '` com key ⇒ `disabled`, provider nunca alcançado; key sozinha nunca habilita | `tests/cognitive-web.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `TED_WEB_FETCH_ALLOWED_HOSTS` | agent | CSV de hosts exatos | vazio (= `web_fetch` indisponível) | ausente/vazio ⇒ bloqueado; host fora da lista recusado antes de rede | `tests/cognitive-web.test.ts` |
| `TED_PRIVATE_VIEWS_ENABLED` | agent | exatamente `'1'` | off (0) | `' 1 '`/`'1 '` ⇒ off; off nunca converte conversas existentes, só bloqueia novas privadas | `tests/conversation-visibility.test.ts` + `flag-invalid-values-matrix.test.ts` |
| `TED_DECISION_PROVIDER` | agent | `jev` \| `clef` \| `strands`; ausente/vazio/`none` ⇒ default-off | off | desconhecido ⇒ `unavailable/provider_not_supported` (fail-closed, sem rede) | `tests/decision-provider.test.ts` |
| `TED_DECISION_MIN_CONFIDENCE` | agent | número em `[0,1]` | `0.7` | ausente/não-numérico/fora de `[0,1]` ⇒ default, nunca "aceitar tudo" | `tests/decision-provider.test.ts` |
| `TED_DECISION_CLEF_MODEL` | agent | qualquer string não-vazia (passthrough, sem allowlist) | default `@cf/cloudflare/clef` | vazio/ausente ⇒ default; desconhecido NÃO volta a nada — qualquer valor não-vazio é usado como-is (só lido com provider `clef` + binding `AI`) | `tests/decision-provider.test.ts` |
| `TED_DECISION_STRANDS_URL` | agent | URL completa do operador | ausente | sem URL ⇒ `strands` indisponível | `tests/decision-provider.test.ts` |
| `TED_JUDGMENT_ENDPOINT` / `TED_JUDGMENT_ALLOWED_MODELS` | agent | reutilizados pelo adapter `jev` | ausente | sem endpoint ⇒ indisponível | `tests/decision-provider.test.ts` |

## Notas

- A divergência trim × estrito é **intencional e documentada no código**
  (`upload-gate.ts`, `web.ts`, `conversation-visibility.ts` vs `pdf-text.ts`,
  `groq-stt.ts`, `groq-vision.ts`). Padronizar para um lado só mudaria
  semântica de egress em produção — fora do escopo desta fatia.
- `wrangler.jsonc` declara `TED_AUDIO_STT_ENABLED: "0"` e
  `TED_PDF_TEXT_ENABLED: "0"` (intocado por esta fatia).
- Detalhe operacional de cada capacidade (trava tripla, tetos, rollout) vive
  em `apps/agent/AGENTS.md`; esta página é só a matriz de valores/defaults.

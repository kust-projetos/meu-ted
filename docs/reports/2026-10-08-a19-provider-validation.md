# A19 — Validação de providers e canaries live (2026-10-08)

Decisões do operador nesta data: chaves Groq/Google obtidas de `D:\projetos\telegran`;
Tavily/Brave recusados (APIs pagas — web search segue sem provider); ZDR ativo;
STT ligado; modelo Vision `gemini-2.5-flash`; credenciais de teste; nova chave
OpenCode para o relay; restante por decisão do agente.
NENHUM segredo neste relatório (só presença/forma/resposta).

## 1. Proveniência das credenciais

- `D:\projetos\telegran\.env`: `GROQ_API_KEYS` com **3 chaves** (formato `gsk_…`).
- Chave Google AI Studio fornecida pelo operador (válida: 50 modelos listados).
- Salvas em `D:\projetos\pi-financeiro\.env` (gitignored — provado via
  `git check-ignore`; nunca commitado): `GROQ_API_KEY` (1ª), `GOOGLE_AI_STUDIO_KEY`,
  `TEST_USER_EMAIL/PASSWORD/WORKSPACE_NAME`, `OPENCODE_CANDIDATE_KEY`.

## 2. Provas live de provider (bytes 100% sintéticos, zero PII)

| Probe | Resultado | Evidência |
|---|---|---|
| Groq `GET /models` | **200**, 11 modelos | chave válida; `whisper-large-v3-turbo` ✓ + `whisper-large-v3` ✓; `llama-4-scout` ✗ (fora do catálogo) |
| STT tom 440 Hz 3 s WAV | **200**, 463 ms, `text` presente | contrato do adapter válido; ≪ teto 20 s |
| Vision BMP `R$ 42,50` (Groq) | **404** `model_not_found` | modelo indisponível nesta conta |
| Gemini `models` + `generateContent` | **200**; `2.5-flash` extrai exato (valor 42.50, moeda R$, nulls honestos) | `3.8-flash` em 503-demanda persistente; `2.5-flash` aprovado pelo operador |

Nota operacional: `python-urllib` sem User-Agent recebe **403 error 1010**
(bloqueio de borda); com UA de browser, 200. Não é erro de auth.

## 3. Decisões (agente, autorizado pelo operador)

- **STT/Groq: provider+modelo PROVADOS ao vivo**; ZDR ativo (operador).
  Residual: precisão em fala real pt-BR (requer voz do operador).
- **Vision/Groq: BLOQUEADO** (modelo fora do catálogo).
  **Vision/Gemini `2.5-flash`: APROVADO** (decisão do operador) — flag+coorte
  deployados; extração exata provada off-box; turno com conteúdo pendente
  (cota diária, abaixo).
- **Web search: sem provider** — `pending-capability` permanente, gracioso.
- **Web fetch: DISABLED aprovado** — allowlist vazia, fail-closed.
- **PDF: local, sem egress** — canary aceito (seção 10).

## 4. Suites multimodais (offline, mocks)

`vitest run tests/attachments/{pdf-text,pdf-gate-worklimit,groq-stt,groq-vision,
gemini-vision,vision-pdf-turn,audio-stt-turn,audio-duration}` →
**8 files, 96/96 passed**.

## 5. Matriz A19 pós-canaries

| Capacidade | IMPLEMENTED | CONFIGURED | TESTED | CANARY | PROD VERIFIED | ROLLBACK | Bloqueio |
|---|---|---|---|---|---|---|---|
| Attachments/R2 upload | sim | sim | sim | sim (200 + sink) | sim | redeploy SHA | nenhum |
| PDF texto | sim | sim (flag) | sim (96 + local exato) | sim (citação §10) | sim | revert PR | nenhum |
| STT | sim | sim (flag+coorte ws) | sim | sim (processed + negativo; utilidade pendente) | parcial | revert PR | voz do operador p/ precisão; telemetria STT no sink |
| Vision/Gemini 2.5 | sim | sim (flag+coorte ws) | sim | parcial (upload 200; turno pendente) | não | revert PR | cota diária p/ turno; relay (resolvido §10) |
| Web search | sim (sem provider) | n/a | sim (gracioso) | n/a | n/a | n/a | sem provider — pendente permanente |
| Web fetch | sim | sim (allowlist vazia) | sim | n/a | DISABLED aprovado | n/a | nenhum |
| G07 sink | sim | sim | sim | sim (ingest real) | parcial | n/a | telemetria STT/transcrição no sink |

## 6. Verificação Cloudflare (token de `D:\projetos\cloudflare\.env`)

- Conta autenticada via `wrangler whoami` (token válido).
- Bucket `pi-finance-ted-attachments` **existe** (criado 2026-10-07).
- Secrets do Worker: `GROQ_API_KEY` ✓, `GOOGLE_AI_STUDIO_KEY` ✓ (provisionado
  nesta sessão), `AGENT_RUNTIME_ADMIN_TOKEN` ✓, `OPENCODE_ZEN_API_KEY` ✓.
- Round-trip de upload ao vivo provado (200 + `att_*` + sink `successRate=1`).

## 7. Deploy do canary STT (PR #122 → `abb58e9`, ATTESTED)

- Flag `TED_AUDIO_STT_ENABLED=1` + coorte `""` (fail-closed) deployados;
  attestation `ATTESTED reason=deploy-smoke-pass`; `/health` `ready`.
- Gate triplo + `redirect:'manual'` revisados (APPROVED P0=P1=P2=0).
- Coorte preenchida com test workspace junio via PRs #123/#124 (JWT provou
  que coorte por actor jamais casaria: token delegado sem `actorId`).

## 8. Canary STT sintético ao vivo (coorte workspace)

- Upload áudio 200 + turno 200: `attachment_states=audio:processed` —
  **primeiro egress STT real em prod** (Groq); sem mutação/pending/undo.
- Prova negativa: workspace Test Family → `audio:unsupported` — gate
  restritivo nas duas direções.
- Identidades: token delegado sem `actorId`; `sub` ≠ session user.id.

## 9. Incidente do relay LLM — CAUSA ENCONTRADA E CORRIGIDA

- **Sintoma:** todo turno generativo 502 `http_502` ~2.6 s; determinísticos 200.
  Split limpo e 100% consistente (teoria de "flapping" refutada por A/B).
- **Causa:** `OPENCODE_GO_API_KEY` antiga devolvia 403
  `An active OpenCode Go subscription is required` no upstream
  `opencode.ai/zen/go` (DeepSeek API operacional — status oficial verde).
- **Correção:** nova chave do operador (válida em zen+go) rotacionada no
  `.env` da API na Contabo (backup `.env.bak-pre-gokey-rotate-20261008`) +
  recreate só do container api (DB intocado) → turnos generativos 200.
- **Gap de processo:** smoke pós-deploy nunca exercita turno generativo —
  recomendo gate com turno `conversation` sintético.

## 10. Citação de PDF ao vivo (cadeia completa provada)

- Turno com PDF fatura → `pdf:processed` → bypass (#127) → precedência (#126)
  → grounding admite bloco (#129) → resposta cita **R$ 42,50** com
  proveniência ("bloco do anexo… não fatura registrada"), sem mutação.
- Mudanças necessárias no caminho: bypass do render determinístico,
  precedência DATA-sobre-tools, grounding com evidência de anexo,
  hardening de formatos (reais/unidades) — todas revisadas e deployadas.
- **Cota de uso provada ao vivo:** turnos com imagem retornaram 429
  `agent.quota_exceeded` (ator 200k, consumido pelo dia de canary); governor
  nega com erro tipado. Canary de imagem com conteúdo pendente da janela.

## 11. Retificação pós-review — egress, PDF e grounding (2026-10-09)

Esta seção complementa o registro histórico acima. A prova da seção 10 continua
válida como evidência de que um turno PDF percorreu o caminho completo; a
classificação anterior de privacidade (“PDF local, sem egress”) estava
incompleta e está **substituída** pelo fluxo abaixo:

```text
PDF recebido → objeto em R2 privado (TTL de 24 h)
             → extração local da camada de texto pelo unpdf
             → texto extraído composto no contexto do turno
             → contexto enviado pelo LLM relay ao provider configurado
             → validação de grounding → resposta ao usuário
```

- **Processamento local:** só a leitura do PDF é local. O timeout de 10 s é de
  evento e não cancela CPU síncrona. `getTextContent()` materializa todos os
  itens de uma página antes dos limites de caracteres; por isso o parser foi
  desabilitado no branch de hardening até existir limite efetivo/isolation.
- **Armazenamento e retenção local:** bytes e metadata ficam no bucket privado
  `pi-finance-ted-attachments`; o contrato `ATTACHMENT_TTL_MS` é 24 h e o sweep
  de cleanup é bounded/resumível. Não há prova de execução do cleanup live nesta
  validação, portanto TTL configurado não é alegado como exclusão já observada.
- **Tráfego externo:** texto extraído pode integrar o prompt/contexto do turno e
  sair pelo relay. O provider/modelo é o configurado para a resposta do Agent;
  nenhuma alegação de ZDR, não retenção ou exclusão após processamento é feita
  aqui. Política e endpoint aplicáveis precisam ser confirmados pelo operador.
- **Logs e observabilidade:** eventos de upload/cleanup e grounding guardam
  estados, contagens/tipos, latência e classes de erro sanitizados; não devem
  incluir bytes, texto extraído, conteúdo financeiro bruto, prompt ou segredo.
  Métricas existentes não provam política de retenção do provider.
- **Gate:** a decisão anterior de aceitar o canary PDF com base em “sem egress”
  deve ser reapresentada ao operador como gate de privacidade. Este branch
  configura a flag `0` e ignora qualquer override `1`, preservando upload/R2;
  **nenhuma flag live foi alterada** nesta execução.

O review também confirmou que o grounding anterior permitia colisões entre
dinheiro, unidades, percentuais, contagens e moedas; o branch
`fix/v1-attachment-grounding-hardening` adiciona testes regressivos e correções.
Isso não encerra A19 nem Golden Workflows (#105/#107), não habilita capacidade e
não é aceite final da v1. Ver `docs/reports/2026-10-09-v1-attachment-grounding-hardening.md`
para evidências locais e estado da produção.

# Resolução formal dos gates G04, G05 e G06 — plano TED agente inteligente V1

**Status:** gates formalmente resolvidos **com condições**; habilitação em produção de cada fatia continua sob o rollout próprio (A19) com flags default-off.
**Data:** 2026-10-04 · **Baseline:** `main@e847888` (árvore limpa).
**Autorização:** pedido explícito do operador nesta sessão — "resolução formal dos gates G04, G05 e G06 e depois execute as fatias desbloqueadas A13–A18" — em linha com a precedência da sessão autônoma de 2026-10-04 (decisões técnicas delegadas; ações de produção continuam gateadas).
**Método:** evidência de código no checkout + docs oficiais consultados hoje + parecer consultivo do MCP Jev (`jev_decide`, modelo `jev-1.13-free`). O parecer é **consultivo**; a decisão formal é este documento. Inspeção não é teste verde: cada condição abaixo será provada por teste nas fatias correspondentes (TDD obrigatório, regra 1 do AGENTS.md).

---

## 1. G04 — Jev/Zen/MCP: **resolvido = default-off com wiring completo**

**Questão (SPEC §11):** validar oferta/modelo, training/retention, transporte remoto e custo. Se incompatível, Jev permanece desligado; não substituir provedor por conta própria.

**Evidência:**

- `apps/agent/src/judgment/provider.ts` — fronteira R15 já existe: 1 método (`evaluate`), abstinência tipada (`unavailable|abstained|decision`), saída `advisory: true` (`:101`), `JUDGMENT_TIMEOUT_MS = 2000` (`:38`), `JUDGMENT_MAX_CALLS_PER_TURN = 1` (`:40`), breaker 2 falhas → aberto, cooldown 300 s, half-open (`:42,44`), allowlist de operações (`:34`), envs `TED_JUDGMENT_ENDPOINT`/`TED_JUDGMENT_ALLOWED_MODELS` ambos default-off (`:51,52,159`), `resolveWithJudgment` com o determinístico autoritativo em todos os caminhos (`:412`). Instância única por DO (`:398`).
- MCP Jev neste ambiente: ferramentas de julgamento locais (`jev_check/jev_decide/jev_gate/jev_score`), **sem recursos expostos** (`list_mcp_resources(server:"jev")` → 0). Harness local/stdio **não é deploy no Worker** e não valida transporte remoto, modelo, preço ou política de dados do provider.
- **Nenhuma fonte acessível nesta sessão prova** oferta, modelo, training/retention e custo de um endpoint remoto de Jev.

**Decisão (condições incluídas):**

1. **Jev permanece DESLIGADO em produção.** O gate prevê exatamente este desfecho quando a oferta não é validada ("Se incompatível, Jev permanece desligado"). Não há substituição de provedor.
2. A fatia **A16 é liberada para completar o wiring** no hot path: consumo do `JudgmentProvider` por um ponto de decisão delimitado, com o valor determinístico autoritativo, breaker e tetos já existentes, **default-off** (envs ausentes ⇒ `unavailable`, zero rede). AC25 (timeout/401/malformado/escolha inexistente → fallback determinístico, sem conceder permissão/sucesso) é verificado com stubs de provider.
3. **Habilitação futura em produção exige:** (a) documento de validação do provider remoto (oferta/modelo/transporte/credencial); (b) confirmação de training/retention; (c) aprovação de custo (G07); (d) revalidação do transporte no SDK real. Enquanto isso, o código roda `unavailable` e o comportamento do agente é idêntico ao atual.
4. Nada de estado financeiro vai ao judge (já garantido pela fronteira; mantido como invariante testada).

## 2. G05 — Groq/vision/OCR/storage: **resolvido = seleção registrada, flags default-off**

**Questão (SPEC §11):** Groq STT é intenção da origem; selecionar modelo, storage e providers restantes após spike e aprovação de dados/retention.

**Evidência (docs Groq consultados via Context7 em 2026-10-04):**

- STT: `whisper-large-v3-turbo` (multilíngue, **100 MB** máx. por arquivo, otimizado 216×) e `whisper-large-v3`; endpoint `POST /openai/v1/audio/transcriptions`; formatos flac/mp3/mp4/mpeg/mpga/m4a/ogg/wav/webm; `language` ISO-639-1; `response_format json|text|verbose_json`.
- Dados: "Customer data: not retained by default" para inferência (incl. transcriptions); retenção residual **até 30 dias** para confiabilidade/abuso; **não usa dados do cliente para treino** (Services Agreement §8.2); **ZDR elegível** (Zero Data Retention opcional por organização).

**Decisão (condições incluídas):**

1. **STT (A14): Groq `whisper-large-v3-turbo`**, `language=pt`, `response_format=json` — atende à regra "sem fallback para modelo que treine com dados financeiros". **Condições de habilitação:** `GROQ_API_KEY` provisionada como secret (não no código), teto server-side de tamanho/duração mais restrito que o do provider, timeout próprio com estado de falha explícito, e **ZDR ativado na organização antes de produção** (ação de console do operador, registrada no rollout da fatia). Áudio nunca vira autoexecução.
2. **Storage binário (A13): Cloudflare R2 privado** via binding opcional (`TED_ATTACHMENTS_BUCKET`): referência opaca server-side, leitura mediada pelo Worker, **sem URL pública, sem base64 no DLP, sem caminho local**; expiração/cleanup idempotente (hard TTL). Sem binding no ambiente ⇒ pipeline de bytes **indisponível** (fail-closed) — `wrangler.jsonc` NÃO é alterado nesta entrega; a criação do bucket/binding é passo documentado do rollout (A19). Parecer consultivo registrou R2 74% vs DO-SQLite 25% (pressão de memória/tamanho no DO) e API-Postgres 1% (não fazer da API autoritativa um media store).
3. **Imagem/PDF (A15):** adapters novos em `apps/agent/src/multimodal/`, default-off, **condicionados a spike bounded** (viabilidade CPU/dependência em Workers) antes de dependência nova: extração de camada de texto de PDF permitida se o spike provar teto de tamanho/CPU; **PDF escaneado (OCR/vision) é subfatia própria** — sem provider validado, resolve fail-closed como `unsupported` explícito (nunca como vazio). Comprovante monta candidato/draft com confirmação manual; múltiplos itens nunca viram bulk write. Capability por tipo reflete o backend (P3): `image`/`pdf`/`audio` com flags separadas; enforcement no servidor; tipo indisponível não é anunciado pela PWA.
4. Ingestão (A13) mantém: tetos de pixels/dimensões/tamanho descompactado/CPU de parser (limite de bruto não impede decompression bomb), MIME real (não declarado), expiração, reprocessamento idempotente, raw fora de log/telemetria/memória, e **bytes nunca atravessam `scrubAttachments`** (DLP continua metadata-only).

## 3. G06 — Consentimento e aprendizagem: **resolvido = consentimento explícito para regra durável**

**Questão (SPEC §11):** preferências explícitas primeiro; inferência e compartilhamento/global dependem de consentimento, exclusão e política aprovados.

**Evidência (baseline V14–V16, confirmada no checkout):** `source`/`confidence`/`salience`/`expires_at` e decay 180 d existem (`store.ts:60-68,316`); opt-out `agent_prefs` ON por default (`:81-135`); recall inclui compartilhadas de workspace (`actor=''`) por default (`:300,309`); estado financeiro atual já filtrado (`:266,318`); job de aprendizado a cada 5 turnos, máx. 2/turno, dedup 0.6 (`learn.ts:16-18`).

**Decisão (política formal para A17/A18):**

1. **Regra durável exige consentimento explícito do usuário** (pedido e confirmação registrados). Correção repetida persiste como memória **derivada** (fonte `learning`), nunca como regra permanente nem alias auto-promovido.
2. **Inferência comportamental permanece candidata** (advisory): alimenta sugestões, não vira skill/regra sem o fluxo de promoção da A18 (replay offline somente-leitura + fixtures + evals congeladas + aprovação humana).
3. **Esquecimento é cascata:** esquecer a origem invalida derivados e o job de aprendizado não ressuscita (AC26).
4. **Escopo explícito no contrato** de toda leitura/escrita nova, incluindo a camada compartilhada (`actor=''`): compartilhamento só para entradas explicitamente criadas como compartilhadas e revogável; nenhuma regra nova amplia o default de recall.
5. User skills (A18): regras declarativas restritas (alias merchant→categoria **existente** no workspace); schema rejeita tool/SQL/fetch/política; core e capabilities intactos; candidate que falha safety não é promovido; rollback restaura versão anterior.
6. ai-memory (engenharia) não é banco de usuários — permanece fora do produto.

## 4. Registro do parecer consultivo Jev (não vinculante)

`jev_decide` (2026-10-04, modelo `jev-1.13-free`) respondeu: G04 `keep_default_off_wiring_ready` (conf. 1.00); G05 STT `groq_whisper_v3_turbo` (0.95); G05 storage `r2_private_binding` (0.61, R2 0.74 vs DO-SQLite 0.25 vs API-PG 0.01); G06 `explicit_consent_only_durable` (0.99). Alinhado às decisões acima; registrado como trilha de auditoria, não como autoridade.

## 5. O que esta resolução NÃO autoriza

- Nenhum deploy, release, migration ou mudança de `TED_RISK_BASED_AUTOEXECUTE`/Release B/cutover (INV-12).
- Nenhuma credencial nova provisionada (`GROQ_API_KEY` etc.) — permanece passo de rollout.
- Nenhuma flag nova em `on` em produção: todas nascem default-off; habilitação = A19 da fatia, com gates repo completos e revisão.
- G01, G02, G07, G08 **permanecem abertos** (A07.2 segue bloqueada por G02; SLO/custo por G07; versões/migrations por G08).

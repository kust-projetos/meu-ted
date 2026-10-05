# Plano TED agente inteligente V1 — lote P5: A13, A14 e A15 (multimodal default-off)

**Status:** implementado, revisado (adversarial na fatia 🔴), corrigido e validado. Nada deployado; nenhum flag em produção.
**Data:** 2026-10-05 · **Branch:** `feat/ted-agent-inteligente-v1-p4-gates-a13-a18` (base `main@e847888`; contém também o lote P4 e a resolução dos gates G04/G05/G06).
**Autorização:** pedido explícito do operador ("resolução formal dos gates G04, G05 e G06 e depois execute as fatias desbloqueadas A13–A18") + resolução de gates em [2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md](2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md).

## 1. Entregas

### A13 — Ingestão binária com identidade (R11 🔴)
Módulos `apps/agent/src/attachments/{types,storage,ingest,processors}.ts` + rota `POST /rpc/attachments` no gateway (mesma auth das rotas rpc) + resolução de `ref` no `/rpc/chat` (shape nova `{type, ref, name?}` ao lado do legado `{type,url,name}`, intacto). Referência opaca (HMAC-SHA256 com domínio `ted-attachments-v1`, compare timing-safe), storage R2 privado via binding **opcional** `TED_ATTACHMENTS_BUCKET` (ausente ⇒ 503 `attachment_storage_unavailable`, fail-closed), MIME real por magic bytes (13 formatos, sniffing manual, zero dependência), tetos por tipo (image 10 MB/25 MP/side 8192, pdf 15 MB, áudio 10 MB + duração exata WAV ≤ 120 s), sha256 do conteúdo, upload idempotente por (workspace, actor, sha256), cleanup TTL idempotente com `include:['customMetadata']` + paginação por cursor, bytes nunca em log/telemetria/DLP. PWA: capability **por tipo** (`NEXT_PUBLIC_TED_ATTACHMENT_IMAGE/PDF/AUDIO`, default off; flag antiga como mestre legado), `uploadAttachment` real, estados por anexo (uploading/ready/failed) com envio bloqueado enquanto há upload em voo; blob do microfone entra no mesmo pipeline. Relatório detalhado: [2026-10-05-a13-ingestao-binaria-identidade-r11.md](2026-10-05-a13-ingestao-binaria-identidade-r11.md).

### A14 — Áudio via Groq (R12)
`apps/agent/src/multimodal/groq-stt.ts`: trava dupla (`GROQ_API_KEY` + `TED_AUDIO_STT_ENABLED=1`, default off; off ⇒ `unsupported`, zero rede), modelo allowlist (`TED_AUDIO_STT_MODEL`, default `whisper-large-v3-turbo`), `language=pt`, multipart **sem `prompt` e sem nome de arquivo** (minimização), timeout próprio (20 s), estados tipados (`stt_unauthorized`/`stt_rate_limited`/`stt_provider_error`/`stt_bad_response`), 1 transcrição por turno (excedentes `skipped_budget`), teto de bytes checado antes da rede. Transcrição entra no turno como **dado marcado com proveniência**, estruturalmente imune a autoexecução (cliente elevado nem é construído quando há transcrição).

### A15 — Imagem e PDF (R13)
`apps/agent/src/multimodal/groq-vision.ts` (mesmo padrão da A14: trava dupla + `TED_VISION_ENABLED`, modelo default `meta-llama/llama-4-scout-17b-16e-instruct` **marcado para confirmação no rollout**, system prompt fixo sem interpolação, extração estruturada com `unknown`/`ambiguous` e proveniência por campo) e `apps/agent/src/multimodal/pdf-text.ts` (spike aprovado: `unpdf@1.8.1` — zero deps transitivas, 0,48 MB gzip, CPU ≤ 26 ms nos fixtures; camada de texto apenas, early-exit nos tetos 10 páginas/20k chars, `pdf_encrypted`/`pdf_no_text_layer` fail-closed). **PDF fica atrás de `TED_PDF_TEXT_ENABLED` (default off — plano §8)**; PDF escaneado (OCR/vision) permanece subfatia aberta e resolve `pdf_no_text_layer`, nunca texto fabricado. Conteúdo extraído é dado delimitado imune a autoexecução; múltiplos itens nunca viram bulk write.

## 2. Revisão adversarial (fatia 🔴) e correções

Reviewer independente: **1 BLOCKER + 9 MAJOR**; tester independente: 20/20 PASS pré-fix + sondas pós-fix. Todos corrigidos com TDD (RED→GREEN por achado) e re-sondados por tester com **33 probes independentes (6/6 PASS)**:

| # | Achado | Correção (evidência) |
| --- | --- | --- |
| F1 | **BLOCKER**: conteúdo de anexo ("sim confirmo") podia confirmar operação pendente via `routeIntent(text)` | Decisão segregada: `routeIntent(text, decisionText)` — decisão vem SOMENTE do texto digitado (`decisionText` é server-side; cliente não forja); dados de anexo podem completar proposta, nunca decisão/undo/retry. Guarda de contrato de estrutura impede novo canal sem a propagação (`tests/attachments/channel-invariant.test.ts`, provado por 3 mutações). `decision-routing-isolation.test.ts` |
| F2 | Memo de processors por (turnId, ref) servia resultado cross-actor e pós-expiração | Chave `(workspace, actor, turnId, ref)` + hit revalida posse/TTL por leitura mediada; `processors-identity.test.ts` |
| F3 | Cleanup não funcionava no R2 real (sem `include` de metadata, sem paginação) | `include:['customMetadata']` + cursor com teto de páginas; fake fiel à API R2; `storage-cleanup-pagination.test.ts` |
| F4 | PDF sem flag (violava plano §8) e deadline sem efeito sobre CPU | Gate `TED_PDF_TEXT_ENABLED` default-off + early-exit nos tetos + docs honestas sobre deadline de evento; `pdf-gate-worklimit.test.ts` |
| F5 | Sem single-flight: 2 chamadas de provider no mesmo (anexo, turno) | Promise em voo reservada antes do 1º await; `Promise.all` ⇒ 1 chamada |
| F6 | Enviar durante upload perdia o anexo silenciosamente | Estados por anexo; envio bloqueado (botão e Enter) enquanto `uploading`; falha visível; `TedChat.attachment-state.test.tsx` |
| F7 | Gravação de microfone nunca era upada | Blob segue o pipeline de upload com áudio ON; sem capability ⇒ recusa explícita, sem anexo fantasma |
| F8 | Múltiplos anexos processados e descartados (só o 1º entrava) | Composição de todos os outcomes aceitos / `skipped_budget` ANTES de processar; `multi-attachment-turn.test.ts` |
| F9 | `kind` do cliente não validado na leitura; proveniência do claim | `expectedKind` no `resolveAttachmentRef`; estado/proveniência do record do servidor; `skipped_budget` sem record ⇒ `kind:"unknown"` |
| F10 | Sem teto de duração de áudio | Duração exata p/ WAV (dataSize/byteRate) ≤ 120 s; byte ceiling reduzido p/ 10 MB; residual documentado (duração exata só WAV) |
| F11 | HMAC sem domínio no caminho com segredo; compare não timing-safe | Domínio `ted-attachments-v1` sempre na entrada + `constantTimeEquals`; `ref-derivation.test.ts`, `storage.test.ts` |
| F12 | Byte NUL literal em regex no source | Escaneio de bytes: 0×0x00 em 33 arquivos; escape `\x00` |

## 3. Validação

- Agent: **1588 passed | 1 skipped** (149 arquivos) — inclui 17 arquivos/179 testes de attachments e o teste de integração P4.
- PWA: **1144 passed** (123 arquivos, escopo ted+lib).
- `pnpm typecheck` raiz exit 0 (5 workspaces); tsc/lint agent e PWA 0 erros; `pnpm docs:lint` 0 issues; 7 gates rápidos verdes.
- `pnpm-lock.yaml`: única dependência nova `unpdf@1.8.1` (spike com evidência; pin exato).
- Sondas adversariais pós-fix: 33/33 (incl. sensibilidade provada — a forma pré-fix do F1 explorava de fato).

## 4. Rollout (A19 — passos do operador, NÃO executados aqui)

1. Criar bucket R2 privado + binding `TED_ATTACHMENTS_BUCKET` no Worker (+ ajuste do teto de corpo do gateway/proxy para >2 MB se uploads maiores forem desejados) e registrar a rota em `worker.ts` — a fatia é inerte sem isso, por design.
2. Provisionar `GROQ_API_KEY` como secret; **ativar ZDR na organização Groq antes de qualquer tráfego real** (condição da resolução G05; retenção padrão do provider ≤ 30 dias).
3. Ligar flags por ambiente, nesta ordem: `NEXT_PUBLIC_TED_ATTACHMENT_*` (PWA, por tipo) → `TED_AUDIO_STT_ENABLED=1` → `TED_VISION_ENABLED=1` → `TED_PDF_TEXT_ENABLED=1`; confirmar o modelo de visão default antes de produção.
4. Smoke com `wrangler dev` exercitando o parse de PDF dentro do runtime Workers (risco nº 1 documentado do rollout — unpdf validado em Node + bundle, não em `workerd` real).
5. `TED_RISK_BASED_AUTOEXECUTE`, Release B e cutover: intocados (INV-12).

## 5. Follow-ups honestos

- E2E de navegador do fluxo upload→ref→send (hoje: unit/componente com happy-dom).
- Estado `expired` dedicado no contrato RPC (hoje replay pós-TTL devolve `unavailable`; invariante crítico — nunca servir resultado em cache — está coberto).
- Breaker/circuit para providers STT/vision (hoje fail-closed por turno); teto de duração para formatos comprimidos (hoje só WAV exato).
- Concorrência no upload idempotente (get-then-put não atômico; race é lost-update benigno no mesmo key).
- Canal novo sem `resolveTurnAttachmentRefs` exigiria teste comportamental de não-confirmação junto (o guarda cobre a estrutura atual).
- Superfície no PWA para `attachmentStates` (usuário ainda não vê "anexo ainda não processado").

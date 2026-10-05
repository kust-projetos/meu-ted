# A13 — Ingestão binária com identidade (R11) 🔴

**Data:** 2026-10-05
**Branch:** `feat/ted-agent-inteligente-v1-p4-gates-a13-a18` (working tree pronto, **não commitado** — regra 4)
**Aceite:** AC21 (+ AC29 parcialmente — ver follow-ups honestos)
**Gate G05:** resolvido como storage R2 privado via binding **OPCIONAL**
(`docs/reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md` §2).

---

## 1. Resumo executivo

A fatia entrega a ingestão binária com identidade: upload real por tipo, referência
opaca server-side, leitura sempre mediada, validação fail-closed por magic bytes e
registry de processors desacoplado. **Tudo default-off**: sem o binding
`TED_ATTACHMENTS_BUCKET` o pipeline de bytes é INDISPONÍVEL e o comportamento
anterior não muda.

Três invariantes carregam o desenho:

1. **Referência opaca.** O upload devolve exatamente `{ref, kind, name, size,
   expiresAt}`. Sem URL pública, sem base64, sem caminho local. `ref` é derivada
   por HMAC sobre `(workspace, actor, sha256)` — estável para a tríade (idempotência)
   e imprivergível entre tenants.
2. **Bytes fora do DLP.** `scrubAttachments` continua metadata-only e ganhou apenas
   o campo opcional `ref` (validado por formato). Nenhum byte atravessa o funil.
3. **Nada é fingido.** Os processors V1 são `unsupported` explícito; o estado de
   processamento entra no turno como evidência — nunca como vazio.

---

## 2. Evidências RED por bloco (TDD)

| # | Bloco | RED (antes do GREEN) | GREEN |
|---|-------|----------------------|-------|
| 1 | `types` + `storage` + `ingest` (AC21) | `Error: Cannot find module '../../src/attachments/storage.js'` — 2 arquivos de teste falhando na importação | 30/30 |
| 2 | `processors` (item 7) | `Error: Cannot find module '../../src/attachments/processors.js'` | 38/38 (após correção do memo, item 6) |
| 3 | Wiring no gateway + DLP | 14/14 falhando em `rpc-attachments.test.ts` (rota inexistente ⇒ 404; refs não resolvidos) | 52/52 |
| 4 | PWA capabilities por tipo | 5 falhas: `expected 'process.env.NEXT_PUBLIC_TED_ATTACHMENT_IMAGE' to be contained` + `image: false` para flag ligada | 19/19 |
| 5 | PWA `uploadAttachment` real | 4/4 falhando (`uploadAttachment` não exportado) | 4/4 |
| 6 | PWA TedChat por tipo + ref | 3 falhas: `expected "vi.fn()" to be called` (upload nunca invocado) | 13/13 |

### Falhas reais encontradas pelos testes (não só "faltava código")

Três defeitos **do meu próprio código de produção** foram expostos pelos testes e
corrigidos — registro porque são exatamente o tipo de coisa que a revisão deve
conferir:

- **Memo de processamento como global de módulo** vazava estado entre instâncias
  (e entre workspaces, em princípio). Virou instância por DO
  (`createAttachmentProcessingMemo()`), com getter lazy para funcionar também em
  instâncias construídas sem constructor.
- **Guard de escopo do upload no PWA** comparava a **URL do preview** contra o
  **workspace id** — o `ref` nunca era anexado e a falha nunca aparecia. Corrigido
  para comparar `activeWorkspaceIdRef.current !== workspaceId` (AC07).
- **Ref malformado sumia em silêncio** (o DLP o descartava por não ser opaco). O
  gateway agora lê os itens crus para detectar a presença de `ref` e emite estado
  explícito `unavailable` — o contrato exige estado de falha explícito, não drop.

---

## 3. Arquivos e linhas

### Agent — novos (`apps/agent/src/attachments/`)

| Arquivo | Linhas | Conteúdo |
|---------|--------|----------|
| `types.ts` | 143 | Allowlist `image\|pdf\|audio`, tetos (10/15/20 MB, 25 MP, side 8192), TTL 24 h, padrão do ref, `AttachmentError` + `attachmentStatusFor`, `AttachmentRecord`, `AttachmentUploadResult` |
| `storage.ts` | 183 | `AttachmentStorage {put/get/delete/list-by-expiry}`, adapter R2 (`R2BucketLike` local, sem `workers-types`), adapter memória, `getAttachmentStorage(env)` (binding ausente ⇒ `null`) |
| `ingest.ts` | 431 | Sniffing manual (PNG/JPEG/PDF/WEBM/OGG/WAV/FLAC/MP3/MPGA/MP4/MPEG/AVI), `readImageDimensions` (PNG IHDR + varredura de segmentos JPEG), `sha256Hex` (WebCrypto), derivação HMAC do ref, `ingestAttachment`, `resolveAttachmentRef`, `cleanupExpiredAttachments` |
| `processors.ts` | 172 | Registry por kind (entradas V1 `unsupported`), `processAttachmentOnce` com guarda `(attachmentId, turnId)` por instância, memo limitado a 500 |

### Agent — editados

| Arquivo | Linhas | Mudança |
|---------|--------|---------|
| `src/finance-chat-agent.ts` | 67–87 | imports do módulo de attachments |
| | 131 | `Env.TED_ATTACHMENTS_BUCKET?: unknown` (binding opcional) |
| | 149–156 | headers `x-ted-attachment-kind` / `x-ted-attachment-name`, cap de eco do ref, `TurnAttachmentState` |
| | 1599–1604 | memo por instância (`attachmentProcessingMemo` lazy) |
| | 1610–1687 | `handleAttachmentUpload` — 401 → 503 (sem binding) → 400 (kind) → ingestão tipada |
| | 1690–1758 | `resolveTurnAttachmentRefs` — resolve `ref` ANTES do turno, posse+expiração+kind |
| | 2322 | dispatch da rota `/rpc/attachments` (mesmo bloco `/rpc/*` do binding check) |
| | 2423 | resolução antes de `runTurn` |
| | 2466 | `attachmentStates` na resposta (evidência explícita) |
| `src/privacy/dlp.ts` | 18–27 | doc: bytes nunca atravessam o funil |
| | 143–190 | `ScrubbedAttachment.ref?: string` + validação de formato opaco |

### PWA — editados

| Arquivo | Mudança |
|---------|---------|
| `src/lib/capabilities.ts` | capability **por tipo** (`_IMAGE`/`_PDF`/`_AUDIO`, default-off) + flag antiga como **mestre legado** (união, não interseção) |
| `src/lib/api/agent-client.ts` | `uploadAttachment` real (POST binário na rota do Agent, resposta validada por `uploadedAttachmentSchema`, falha tipada), `OutgoingAttachment` (`ref` opcional), alvos de `composeChatSend`/`sendAgentMessage` |
| `src/features/ted/TedChat.tsx` | `TedAttachment.ref`, `uploadSelected` (upload por tipo no select, guard de escopo AC07), envio carrega `{type, ref, name}`, anexo sem ref não entra no envio, `draftPreviewUrlsRef` preserva o revoke INV-08 dos object URLs locais |

### Testes

`apps/agent/tests/attachments/`: `fixtures.ts` (133), `helpers.ts` (150), `ingest.test.ts` (401), `storage.test.ts` (127), `processors.test.ts` (145), `rpc-attachments.test.ts` (299).
`apps/pwa`: `capabilities.test.ts` (+5), `capabilities-static.test.ts` (+2), `__tests__/agent-client.attachments.test.ts` (novo, 4), `__tests__/TedChat.attachments.test.tsx` (+4 e mock de upload corrigido), `__tests__/TedChat.optimistic.test.tsx` (contrato do wire atualizado para `ref`).

---

## 4. Mapa AC21 → testes

| Requisito AC21 | Teste | Evidência |
|---|---|---|
| Upload cruzado rejeitado | `rpc-attachments.test.ts` (9) + `ingest.test.ts` "outro workspace NÃO consegue ler" | `attachment_not_found` para workspace E ator diferentes — sem oráculo de existência |
| MIME falso rejeitado | `ingest.test.ts` "declarado ≠ real" (2 casos) + `rpc-attachments.test.ts` (3) | PDF como imagem, PNG como áudio, script como imagem ⇒ `attachment_mime_mismatch`; nada gravado |
| Oversized rejeitado | `ingest.test.ts` "oversized" + `rpc-attachments.test.ts` (3) | `attachment_too_large` / HTTP 413, storage vazio |
| Expirado rejeitado | `ingest.test.ts` "ref expirado" + `rpc-attachments.test.ts` (10) | `attachment_expired` na resolução; no turno vira estado `unavailable`, **não 500** |
| Reprocessar mesmo anexo/turno não executa 2× | `processors.test.ts` (3 casos) | processor fake chamado **1×** no mesmo `(anexo, turno)`; turno diferente reprocessa (2×) |
| Bomba de descompressão | `ingest.test.ts` "PNG minúsculo com dimensões absurdas" + JPEG equivalente | PNG 30 000×30 000 (33 bytes) e JPEG 50 000×50 000 ⇒ `attachment_dimensions_exceeded` lido **do header**, sem decodificar |
| Sem execução de script | `ingest.test.ts` "script com kind 'image'" + `rpc-attachments.test.ts` (3) | `#!/bin/sh` rejeitado por sniffing; sem decoder, sem `eval`, sem rede |
| Sem bytes em log/DLP | `rpc-attachments.test.ts` (6) e (14) | nome com PAN redigido e ausente dos logs; `data:`/base64 nunca persistido |
| Isolamento por tipo (P3) | `capabilities.test.ts` (+5), `TedChat.attachments.test.tsx` (2) | tipo indisponível **não é anunciado** (botão/file input ausentes) |
| Idempotência de upload | `ingest.test.ts` (2 casos) + `rpc-attachments.test.ts` (5) | mesmo `(ws, ator, sha256)` ⇒ mesmo `ref`, **1 objeto**; ator/workspace/conteúdo distintos nunca colidem |
| Cleanup idempotente | `ingest.test.ts` (2 casos) | varre só expirados, 2ª chamada `{scanned:0}`, falha de storage vira `{failed:true}` (nunca lança) |
| Default-off | `storage.test.ts` (1) + `rpc-attachments.test.ts` (4) e (12) | sem binding ⇒ upload 503 `attachment_storage_unavailable`, nada gravado, ref no chat = `unavailable` |

---

## 5. Validações (saídas reais)

```
> pnpm --filter pi-finance-agent exec vitest run
 Test Files  136 passed | 1 skipped (137)
      Tests  1461 passed | 1 skipped (1462)

> pnpm --filter pwa exec vitest run src/features/ted src/lib
 Test Files  122 passed (122)
      Tests  1140 passed (1140)

> pnpm typecheck            (raiz: llm-contracts, api, pwa, agent, codex-broker) → OK
> pnpm --filter pi-finance-agent lint   → 0 errors (4 warnings pré-existentes em noExplicitAny)
> pnpm --filter pwa lint                → 0 errors (26 warnings pré-existentes)
> pnpm docs:lint                        → OK (ver §8)
```

---

## 6. Passos de rollout / A19 (documentados, NÃO executados nesta fatia)

Nada disto foi aplicado. `wrangler.jsonc` e `package.json` estão **intactos**.

1. **Criar o bucket R2 privado** (sem URL pública):
   `wrangler r2 bucket create pi-finance-attachments`
2. **Adicionar o binding** em `apps/agent/wrangler.jsonc`:
   `{ "name": "TED_ATTACHMENTS_BUCKET", "r2_buckets": [{ "binding": "TED_ATTACHMENTS_BUCKET", "bucket_name": "pi-finance-attachments" }] }`
3. **Liberar a rota no gateway** (`apps/agent/src/worker.ts`): incluir
   `/rpc/attachments` na lista `isRestRpc` e **elevar o teto de corpo** para essa
   rota. Hoje `MAX_RPC_BODY_BYTES = 2 MB` no Worker e `MAX_BODY_BYTES = 2 MB` no
   proxy Next limitam o upload efetivo a 2 MB por tipo, bem abaixo dos tetos de
   ingestão (10/15/20 MB). É um limite **mais estrito** (fail-closed), não um
   buraco: subir isso é decisão consciente de rollout, não efeito colateral.
4. **Liberar a capability por tipo na PWA** (build), uma flag por tipo:
   `NEXT_PUBLIC_TED_ATTACHMENT_IMAGE=1`, `..._PDF=1`, `..._AUDIO=1`
   (a flag antiga `NEXT_PUBLIC_TED_ATTACHMENT_INGESTION=1` continua ligando os três).
5. **Ordem sugerida**: bucket → binding → gateway (rota + teto) → **uma** flag de
   tipo em canário. Nunca as três de uma vez; cada tipo é um gate próprio.
6. **Verificar em produção**: upload real por tipo, `attachmentStates` no turno,
   ref cruzada (outro workspace) rejeitada, e expiry/cleanup após 24 h.

---

## 7. Decisões de projeto que valem revisão

1. **Ref derivada por HMAC com `AGENT_CONNECTION_TOKEN_SECRET`.** Dá idempotência
   sem índice separado e opacidade entre tenants. Custo: reuso de chave com outro
   propósito (mitigado por separador de domínio `ted-attachment-ref`). Alternativa
   seria um segredo dedicado — não criado aqui para não ampliar a superfície de
   config nesta fatia.
2. **Ref lida a partir dos itens crus do body**, não da saída do DLP. Necessário
   para que uma ref malformada vire estado explícito em vez de sumir. O eco do ref
   é sanitizado (`[^\w.:-]`) e limitado a 80 chars.
3. **`attachmentStates` na resposta do `/rpc/chat`.** Campo novo e aditivo: é a
   forma mínima de o turno carregar o estado de processamento por referência. Não
   é renderizado pela UI ainda (ver follow-up).
4. **Upload no select, não no send.** Dá o estado de falha de upload cedo e
   explícito. O custo é um anexo sem referência enquanto o upload está em voo —
   esse anexo simplesmente não é enviado.
5. **Memo por instância, limitado a 500.** Reprocessamento é memoizado por
   `(anexo, turno)`; em produção isso vive na memória da instância do DO, que
   hiberna. Recomeçar uma instância reprocessa o mesmo par — seguro, porque os
   processors V1 são `unsupported` (sem efeito). Quando A14/A15 entrarem, o
   processor deve ser idempotente por conta própria.
6. **`resolveAttachmentRef` antes de `runTurn`.** O gateway valida antes do
   processamento, como decidido. O DLP segue Metadata-only e não resolve nada.

---

## 8. Follow-ups honestos

1. **Rota ainda inalcançável pelo gateway.** `worker.ts` não foi editado (fora do
   escopo listado e com impacto de segurança). Sem o passo 3 do rollout, o
   `/rpc/attachments` responde 404 no edge. O código está pronto e testado no DO.
2. **Teto de transporte (2 MB) < tetos de ingestão.** Documentado em §6.3.
3. **Processors V1 não processam nada.** É o comportamento fail-closed correto,
   mas significa que o `ref` ainda não melhora a resposta do TED. A14 (áudio) e
   A15 (imagem/PDF) são o próximo passo; o registry já é o ponto de extensão.
4. **`attachmentStates` não é renderizado na PWA.** O usuário vê a resposta do
   modelo, mas não um aviso "anexo ainda não é processado". Falta um cartão/aviso.
5. **Prévia local em histórico após reload.** O histórico guarda metadata sem URL
   de render; `TedMessage` renderiza por `url`. Para anexos por referência não há
   URL pública por decisão de projeto — a renderização pós-reload fica para o
   desenho do card de anexo (provavelmente preview derived server-side).
6. **Ref exposta em logs de auditoria.** Não é logada em nenhum ponto por esta
   fatia, mas quando houver log de auditoria de anexo, avaliar hash do ref em vez
   do valor.
7. **AC29 (retenção/consentimento de anexo)** não é fechado aqui: o TTL de 24 h e
   o cleanup existem, mas a política de retenção aprovada e a sinalização ao
   usuário sobre expiração ainda não existem.
8. **Sem teste de contrato por rota do gateway** para `/rpc/attachments`
   (existe para `/rpc/history`), porque a rota ainda não está na allowlist.

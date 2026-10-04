# TED Inteligente V1 — implementação P2 (A11, A12) e spike A09

**Data:** 2026-10-04 · **Branch:** `feat/ted-agent-inteligente-v1-a11-web-security` · **Base:** `main@1ebe68b` (merge do PR #75)
**Commits:** `dcc7dc3` (A11) · A12 (feat) · A09-spike (docs/fixture) — ver `git log` da branch
**Artefatos:** [SPEC](../MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md) · [PLAN](../MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md) · [Relatório P1](2026-10-03-ted-inteligente-v1-p1-a10-a06-a08.md) · [Spike A09](2026-10-04-ted-inteligente-v1-a09-spike.md)
**Autorização:** operador autorizou merge do PR #75 e continuação da implementação. Mesma orquestração: Planner + jev + subagents com ciclo TDD→tester→reviewer (adversarial na 🔴).

## Resultado

| Fatia | Requisito | Entrega | Suíte Agent |
| --- | --- | --- | --- |
| A11 (🔴) | R14 pré-requisito (AC24 parcial, AC30) | **Egress por construção**: `web_fetch` restrito a allowlist do operador (`TED_WEB_FETCH_ALLOWED_HOSTS`, CSV de hosts exatos, default-off = ferramenta graciosamente indisponível); **teto de bytes em stream** (`maxBytes` + cancel, decodificação incremental — fecha o V8); redirects (manual + revalidação por hop) e headers (fixos, sem cookies) verificados conformes e intocados | 1031 → 1058 |
| A12 | R14 (AC24) | `web-evidence.ts`: query externa **minimizada antes do egress** (redaction base + padrões contextuais de conta/agência e valor+moeda textual), envelope com proveniência datada (claim→fonte, máx 3 fontes, ≤1000 chars, AVISO reservado no orçamento), filtragem dos `results` expostos ao modelo (mesma validação do envelope + neutralização de marcadores forjados), indisponibilidade honesta como envelope | 1058 → 1090 |
| A09-spike | R09 (evidência p/ G03) | **Sem código de produção**: relatório com matriz pergunta×read model (6 rotas reais, não 4), fixtures de semântica financeira (12 casos) e 3 lacunas nomeadas provadas — G-A (dupla contagem compra+pagamento de fatura), G-B (`totalCents` acima de 2^53), G-C (envelope sem `transactionCount`/`asOf`/`basis`). Nenhuma rota aberta; decisão é gate humano G03 | — |

Ciclos de review: A11 (tester PASS 5/5 com 31 sondas adversariais; reviewer 2 rodadas — cancelamento no orçamento exato e amplificação de memória corrigidos com decode incremental); A12 (reviewer 5 findings — vazamento contextual no egress, `results` brutos expostos, AVISO cortado, envelope de indisponibilidade ausente, corte de emoji — todos corrigidos com RED→GREEN; reviewer do round 1 reproduziu cada contraexemplo em JS isolado).

## Evidência final

| Gate | Resultado |
| --- | --- |
| Suíte completa do Agent | **1090 passed / 1 skipped** (+32 vs. main; +159 no total da sessão) |
| `pnpm --filter pi-finance-agent typecheck` | verde |
| `pnpm --filter pi-finance-agent lint` | 0 errors (4 warnings pré-existentes em arquivo não tocado) |
| Biome escopado (arquivos da fatia) | limpo |
| `pnpm docs:lint` + lint sob demanda (relatórios/fixture) | 0 issues; fixture JSON validada com parser |
| Pré-commit husky (7 gates) | PASS em todos os commits |

## Decisões e desvios documentados

1. **Pinning de DNS deliberadamente NÃO tentado** (A11): `resolveOverride` é zone-scoped e ignorado silenciosamente no Workers; `cloudflare:sockets` não separa IP de SNI. A garantia de egress é por construção (nenhum hostname fora da allowlist alcança o fetch), rota explicitamente autorizada pelo plano.
2. **Allowlist default-off**: sem env, `web_fetch` responde mensagem graciosa e **zero rede acontece** — verificável por teste na rota de produção real (sem resolver/fetch injetados), o gap que o plano apontava.
3. **Residual de minimização aceito e documentado** (A12): sufixo "final NNNN" de cartão não é redactado (PAN completo é; adicionar o rótulo "final" causaria over-redaction de "final 2026"). Direção segura.
4. **`truncateSafely` em `dlp/redaction.ts`** (desvio de escopo justificado): mesmo funil de corte nomeado pelo reviewer, corrige surrogate órfão no egress da A12 sem duplicar regra.
5. **V13 do plano desatualizado** (spike): 6 rotas de analytics, não 4; `from`/`to` são silenciosamente ignorados sem `period=custom` — armadilha registrada para o normalizador futuro.
6. **Nenhuma rota nova de analytics**: o spike prova que reuso (`period=custom`) cobre 5 de 7 perguntas e que 3 lacunas (G-A/G-B/G-C) exigem patch de SPEC antes de qualquer API — bloqueado em G03 (humano).

## Estado do plano após esta leva

- Concluídas: A00–A06, A08, A10, A11, A12, A09-spike.
- Bloqueadas por gates humanos (nenhuma iniciada): A07 (G01/G02), A09-integração (G03), A13–A15 (G05), A16 (G04), A17–A18 (G06).
- Follow-ups nomeados: slice de API `includeInactive` (A08), sink durável de telemetria (G07), mapear `published_date` do Tavily (A12), skill `web-search` citando `[F1]` (A12).

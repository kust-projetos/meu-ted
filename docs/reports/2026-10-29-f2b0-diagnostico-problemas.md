# Diagnóstico F2-B0 — problemas observados na campanha 2026-10-29T13-25-07-295Z-6180

**Data do relatório:** 2026-10-29
**Escopo:** somente diagnóstico. Nenhum arquivo existente foi modificado para este relatório. Sem commit/push.
**Branch no momento da leitura:** `test/ted-f2b0-no-retry-controlled`
**HEAD observado:** `d289535` (`test(agent): guard authorized F2B0 retry`)

## 1. Campanha avaliada

- **Run da campanha:** `2026-10-29T13-25-07-295Z-6180` (`campaign: remaining22`)
- **Smoke de origem incluído na avaliação composta (sem reexecução):** `2026-10-29T12-26-34-600Z-4324` (caso `F1-B005`)
- **Modelo/provider registrados no manifesto:** `opencode-go/deepseek-v4.1-flash`
- **URL nativa registrada:** `https://opencode.ai/inference/go/openai/v1/chat/completions`
- **Casos na campanha:** 22 IDs novos + 1 smoke histórico = **23 casos avaliados**
- **Requisições novas nesta campanha:** 22, todas com HTTP 200 observado nos ganchos; sem retry observado
- **B1:** não incluído (`b1Included: false` na attestation)

Evidências lidas:

- `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-29T13-25-07-295Z-6180/evaluation.json`
- `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-29T13-25-07-295Z-6180/manifest.json`
- `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-29T13-25-07-295Z-6180/remaining22-attestation.json`
- `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-29T13-25-07-295Z-6180/catalog-preflight.json`
- `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-29T13-25-07-295Z-6180/plugin-hooks.ndjson`
- `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-29T13-25-07-295Z-6180/cases/` (22 arquivos; o 23.º caso vem do smoke anterior, não repetido)
- `docs/reports/TED-F2B0-DEEPSEEK-V41-FLASH.md`
- `docs/reports/2026-10-21-sessao-testes-correcoes-ted.md` (tracking vivo)

Todas as referências acima existiam no checkout no momento da leitura. Conteúdos privados (`private-*`, `work/`) não foram abertos nem transcritos.

## 2. Resultado agregado (dado do `evaluation.json`, sem reclassificação)

- **Denominador:** 23
- **Completude:** `complete: true`, `actualAttemptCount: 23`
- **Veredito global do oráculo:** `FAIL`
- **PASS:** 2 (`F1-B005`, `F1-B010`)
- **FAIL:** 21 (11 cenários + 10 turnos de jornada)
- **JSON válido:** 23/23 (nenhum caso sem candidato JSON; os 6 com `schemaError` são JSON válido que o parser recusou)
- **Schema válido (parser):** 17/23
- **Schema inválido:** 6/23
- **Turnos de jornada:** 10/10 FAIL (`J01:T1/T2`, `J02:T1/T2`, `J03:T1/T2`, `J05:T1/T2`, `J09:T1/T2`)
- **Conclusão financeira (`financialCompletion`):** `unobservable` em todos os 23 (o harness não executa nem observa escrita financeira)
- **Classificação F1 original:** preservada nos `reasons` (`original-f1-classification-preserved`); a avaliação composta não reescreve o histórico F1

Contagem verificada por leitura direta do JSON: 13 cenários (2 PASS / 11 FAIL) + 10 turnos (0 PASS / 10 FAIL) = 23 casos; 6 entradas com `schemaError`; 17 sem `schemaError`.

## 3. Seis falhas de schema: descritor do prompt vs. parser

As 6 entradas com `schema-invalid:agent.invalid_structured_interpretation` são:

1. `F1-B012` (`Crie um orçamento de alimentação de 500 reais`)
2. `F2A1-B008-concept` (`O que é cartão de crédito?`)
3. `J03:T1` (`Crie conta chamada Reserva`)
4. `J03:T2` (`banco com saldo 100`)
5. `J05:T1` (`Renomeie conta Aurora para Reserva`)
6. `J05:T2` (`a primeira conta Aurora`)

Diagnóstico offline posterior (registrado no tracking, sem nova inferência) reproduziu formas presentes no descritor do prompt então usado, mas incompatíveis com o parser vigente, em três pontos:

- `contextProvenance.origin`
- `entities`
- `requestedAction`

O que foi feito depois (sem alterar evidência histórica):

- O descritor em `apps/agent/tests/poc-structured/f2b0-adapter.ts` foi alinhado ao contrato atual do parser (diff local **não commitado**; ver seção 8).
- Regressões locais do alinhamento foram reportadas no tracking como RED→GREEN com revisão independente APPROVED.
- Parser e evidências históricas foram preservados; a campanha anterior usou o prompt anterior e mantém FAIL.

O prompt corrigido **não foi validado ao vivo**: nenhuma inferência nova foi executada após a correção do descritor. Não se afirma que a correção resolveria os 6 casos em modelo real.

## 4. Quatro divergências de argumentos/entidades/esclarecimento (caracterização offline)

Quatro testes de caracterização offline (reproduções inline das respostas, sem alterar oráculo ou evidência; revisão independente APPROVED segundo o tracking; suíte estruturada 177/177 PASS segundo o tracking, sem nova inferência) registram:

1. **F1-B017** (`Quanto gastei em 2020?`): resposta difere das clarificações esperadas. `suppliedValues: {year: 2020}`; oráculo marca `args-mismatch` (`period`), `clarification-missing`, needles `mês`/`período` ausentes.
2. **F1-B058** (`Gastei R$ 20 em 2020`): resposta difere do esperado. `suppliedValues: {amountCents: 2000, year: 2020}`; oráculo marca `args-mismatch` (`amountCents`), `entities-mismatch`, `ambiguities-mismatch`. Agulha `data` casou; demais dimensões não.
3. **J09:T2** (`E no mês passado?`): resposta retornou `period` onde o oráculo espera `yearMonth` (+ `period` em `argsMismatchedKeys`). Contexto: `suppliedValues` com `currentYearMonth: 2026-10` e `previousYearMonth: 2026-09`. O tracking anota que a API de resumo mensal exige `yearMonth`; este relatório apenas registra a divergência observada, sem prescrever mapeamento.
4. **F2A1-B013-catalog** (`Registre uma despesa de R$ 25,00 no mercado`): descrição `Mercado` (resposta) versus `mercado` (esperado) — divergência de caixa. O tracking anota que não há regra equivalente demonstrada na API para equivalência de caixa; este relatório apenas registra o fato, sem prescrever normalização.

A caracterização não reclassifica o B0 nem prova efeito do prompt corrigido.

## 5. Proveniência de datas: oráculo espera `utterance`, valor vem de `suppliedValues` (lacuna documentada, sem regra nova)

Investigação offline de proveniência temporal (5 testes de caracterização da lacuna + variantes sintéticas isoladas; revisão independente APPROVED segundo o tracking; suíte estruturada 182/182 PASS segundo o tracking; nenhuma inferência nova; B0 permanece FAIL) registra:

- Em `F1-B036` (`Me diga o total das despesas do mês atual`) e `J09:T1/T2` (`Quanto gastei neste mês?` / `E no mês passado?`), o mês normalizado deriva de `suppliedValues` (`currentYearMonth` / `previousYearMonth`), mas o oráculo espera entidade com `provenance: utterance`.
- O binder não verifica literalmente entidades com essa proveniência nesses casos.
- A semântica do rótulo `utterance` para valores derivados (oráculo sintético) versus texto literal do turno não está definida de forma geral.

Nada foi alterado no oráculo. Nenhuma regra nova é proposta ou prescrita neste relatório; a lacuna segue aberta e apenas caracterizada.

## 6. Limitações da POC (o que estes números não provam)

- Casos sintéticos, sem ledger, sem catálogo real de contas/categorias, sem execução financeira.
- `capabilityAvailability: unknown` e `requestedAction: not-comparable` em todos os 23.
- `financialCompletion: unobservable` em todos os 23; `comparison.verdict: INCONCLUSIVE` nas 5 jornadas avaliadas (`J01`, `J02`, `J03`, `J05`, `J09`) com motivo `financial-completion-unobservable`.
- 5 jornadas retidas sem avaliação (`J04`, `J06`, `J07`, `J08`, `J10`, motivo `journey-retained-not-evaluated`).
- Oráculo usa comparações estritas de dimensões observáveis (`intent`/`operation`/`args`/`clarification`/needles/entidades/proveniência); divergência semântica aqui não equivale a erro financeiro em produção, nem PASS aqui equivaleria a correção em produção.
- As extensões `B013-catalog`, `B015-colloquial`, `B027-approx`, `B006-reference`, `B016-homonyms`, `B021-correction`, `B008-concept`, `J02-category` e demais listadas em `evaluation.json/extensions` declaram limitações próprias (sem I/O de catálogo, sem autoridade de histórico/ledger, sem vocabulário de aproximação, sem avaliação de narração de produto). Ler o bloco `extensions` do JSON antes de citar qualquer caso F2A1/J.

## 7. Custo, quota e B1

- **Quota:** fonte `operator-attestation`; readback automático `unavailable` (`go-usage-unavailable` no preflight). Quota foi atestada pelo operador, não medida pelo runner.
- **Extra Usage:** `operator-attested-disabled`; sem verificação automática.
- **Custo:** a API reportou custo 0 nos 23; a attestation registra que custo 0 reportado pela API **não** é prova de valor faturado. Nenhum montante de faturamento foi confirmado de forma independente.
- **Preço de catálogo local** (`catalog-preflight.json`): DeepSeek V4.1 Flash no Go com `input 0.15 / output 0.6` por milhão de tokens (mais `cache.read 0.003`), `catalogPriceAllowed: true`, `billingMode: opencode-go-subscription`. Preço de tabela, não evidência de saldo/quota desta conta.
- **Veredito para B1:** **NO-GO**. O gate semântico do B0 é FAIL (2/23 PASS) e a conclusão financeira é inobservável; não há base nesta campanha para avançar a B1.

## 8. Estado do código: mudanças não commitadas + prompt corrigido não validado ao vivo

No momento da leitura, `git status --short` mostrava ~20 caminhos modificados e arquivos novos não rastreados, incluindo (lista parcial observada):

- Modificados: `apps/agent/tests/poc-structured/f2b0-adapter.ts`, `f2b0-runtime/real-runner.ts`, `real-guard.mjs`, `real-runner.stdin.test.mjs`, `real-storage.mjs`, `f2b0-adapter.test.ts`, `src/mutations/semantic-interpretation.ts`, `src/orchestration/intent-router.ts`, `src/orchestration/conversation-orchestrator.ts`, `src/mutations/account-creation.ts`, `channel-evidence.ts`, testes B005/B010/B012/B036/S7-S8/follow-up, `docs/reports/2026-10-21-sessao-testes-correcoes-ted.md`, `docs/reports/TED-F2B0-DEEPSEEK-V41-FLASH.md`, `apps/agent/evals/reports/ted-f1-baseline.json`, `ted-f1-journeys.json`.
- Novos (não rastreados): testes `issue-b058-*.test.ts`, `issue-draft-followup-date.test.ts`, `issue-f1-b*.test.ts`, `f2a1-supplied-yearmonth-characterization.test.ts`, `f2b0-b0-divergences-characterization.test.ts`, `real-consumed-smoke.test.mjs`, `real-remaining22.test.mjs`.

Em particular, o diff local em `f2b0-adapter.ts` (descritor alinhado ao parser + `Hard bounds`) existe só no working tree; o último commit da branch (`d289535`) não o contém. Consequência: qualquer validação futura do prompt corrigido exige commit/PR e nova campanha; a evidência atual reflete o prompt anterior.

Os JSONs F1 (`ted-f1-baseline.json`, `ted-f1-journeys.json`) aparecem modificados no working tree. O tracking registra regeneração incidental por suíte ampla e restauração parcial; os bytes exatos pré/pós não foram verificados nesta sessão de diagnóstico. Não se declara aqui que os relatórios F1 estejam íntegros ou validados.

## 9. Testes históricos citados (termos verificáveis)

Os números abaixo são **registros do tracking e do relatório V41**, não reexecuções desta sessão de diagnóstico. Nenhum teste foi executado para produzir este relatório.

- Harness mock F2B0: 9/9 cenários (429, 500, 503, timeout, reset, refused, proxy-refused, stream parcial, válida) — run `2026-10-27T15-01-06-299Z-19020` (registro V41).
- Focados `f2b0-runtime`: 38/38 PASS (registro V41, 27/10); 46/46 PASS offline em 4 arquivos (registro do tracking, 29/10) — não provam carregamento nativo nem auth externa.
- Antes da campanha 29/10: revisão independente do harness APPROVED + 103 testes focados e typecheck do Agent PASS (registro do tracking).
- Pós-campanha offline: 173 testes estruturados PASS (alinhamento do descritor); 177/177 PASS (4 divergências); 182/182 PASS (proveniência temporal) — todos segundo o tracking, sem nova inferência.
- Lint amplo do Agent: inconclusivo por timeout (registros reiterados no tracking); não declarado PASS.
- Suíte global do Agent: número varia entre registros (3504/1, 3613+flakes, 3682/1); execuções amplas regeneram relatórios F1 e estão proibidas neste checkout até preservação/restauração dos bytes. Nenhum agregado global é declarado verde neste relatório.

## 10. Riscos e limites deste diagnóstico

- Este relatório descreve apenas a campanha e os diffs observados; não autoriza nova inferência, retry, fallback, B1, merge, deploy ou gasto.
- Nenhuma credencial, header de autorização, saldo, quota medida ou valor de faturamento é afirmado aqui; segredos não foram lidos nem transcritos.
- A correção do descritor e as caracterizações offline são hipóteses testadas localmente com mocks/suítes focadas, não provas de comportamento do modelo em produção.
- Lacunas abertas seguem abertas: proveniência `utterance` para valores derivados; caixa em `B013`; mapeamento `period`/`yearMonth` em `J09:T2`; clarificações `B017`/`B058`; cobertura exaustiva de expressões temporais em português.

## 11. Recomendação

1. Manter **B1 NO-GO** até que (a) o prompt corrigido seja validado em nova campanha controlada com gate semântico revisto, e (b) a conclusão financeira deixe de ser inobservável ou o limite da POC seja explicitamente aceito pelo operador.
2. Não reexecutar a campanha por inferência a partir deste relatório; qualquer retomada exige autorização explícita nova, quota/Extra Usage reatestados e preservação das reservas/attestations existentes.
3. Antes de qualquer PR: decidir o destino dos ~20 caminhos sujos (em especial os JSONs F1 regenerados) com diff byte a byte; não restaurar nem descartar por inferência.
4. Registrar a semântica de `provenance: utterance` para valores de `suppliedValues` como decisão de produto/oráculo **antes** de alterar binder ou oráculo — este relatório não propõe a regra.

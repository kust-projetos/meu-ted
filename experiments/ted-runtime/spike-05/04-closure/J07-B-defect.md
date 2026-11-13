# SPIKE 05 — 04-closure: J07-B como defeito comportamental não bloqueante

Data: 2026-10-31. Fontes: `SPIKE_04_TRACE_J07BL.json`,
`SPIKE_04_TRACE_J07BLR.json` (cópias exatas em
`spike-05/traces/originals/`), `SPIKE_04L_RESULTS.md` §5/§8.

## 1. Fato observado (sem inferência nova)

Sessão nova `ses_e6e08a47dffe2JLwgxvzgh7v1i`, 1 turno, texto "E em maio?",
sem expects anexados. O modelo notou a falta de contexto (reasoning:
"follow-up to some previous context that I don't have") mas **assumiu
2026-05 sem pedir esclarecimento antes**, apresentou os zeros verdadeiros do
oráculo 2026-05 (0/0/0/0) e acrescentou hedge **a posteriori** ("se você quis
dizer maio de outro ano (ex.: 2025)…"). Vereditos: U pass (read-only) /
E incomplete / R incomplete — inalterados entre J07BL e J07BLR.

## 2. Por que é defeito comportamental (não estrutural)

- Oráculo J07-B (04R §5): sem contexto anterior e sem default de produto
  estabelecido, o correto é **pedir esclarecimento**; nenhuma tool financeira
  verifica "maio" avulso. O modelo não demonstrou a clarificação prévia.
- Sem fabricação de valores (zeros são os valores verdadeiros do mês
  assumido) e sem violação de fronteira (só `get_month_summary`, read-only,
  sessão/host próprios, abort nunca precisou disparar). É decisão de
  diálogo, não quebra do runtime.

## 3. Por que é NÃO bloqueante para operação sintética

- Caminho de escrita inexiste no path (J05-04 já provara recusa; nenhuma tool
  de mutação registrada); o pior efeito do default é uma leitura do mês
  errado, reversível e auditável (args `yearMonth` observados no fio).
- Para operação sintética (oráculos determinísticos + `expects` explícitos por
  turno + `checkAllCallsArgs` com `yearMonth` exato), mês assumido sem
  clarificação é detectável por mecanismo, não por julgamento: `2026-04` como
  "maio" = FAIL explícito; mês all-zero sem marcador = `incomplete` honesto.
- Nenhum retry semântico foi aplicado (registrado como observado, 04L §8).

## 4. Follow-up (não executado; requer campanha live própria)

Re-testar J07-B com modelo quando houver autorização + orçamento próprios:
o modelo esclarece antes de chamar a tool? Segue pendente junto com o
restart-com-modelo (`restart-pending-proof.md`).

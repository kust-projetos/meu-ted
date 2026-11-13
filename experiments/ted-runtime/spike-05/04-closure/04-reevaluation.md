# SPIKE 05 — 04-closure: nota factual de reavaliação (sem inferência nova)

Data: 2026-10-31. Branch: `experiment/ted-opencode-runtime`. Base: `1567dae`.
Escopo desta nota: registrar o que o extrator corrigido (04L) já extraiu dos
traces históricos, por comparação direta original × regrade. **Nenhuma
inferência foi executada aqui** (0 turns, custo 0, sem `TED_04_LIVE`, sem
containers, sem modelo). Regrades `*LR` são arquivos preexistentes do 04L;
esta nota só os confronta linha a linha.

## 1. Extrator corrigido: qual módulo foi usado (não o candidato da task)

O extrator corrigido é o par 04L já embutido no harness, coberto por
`tests/spike-04l-extract.test.mjs` (7/7). Nenhum código novo foi escrito aqui.

- `bootstrap/run-03b-turn.mjs` — `lastAssistantText` (linhas 619–658):
  ordenação cronológica por `time.created` (estável; sem timestamp → após
  timestampadas) + pular linhas de prompt do usuário (`role:'user'` ou
  `type:'user'`); sem lógica de frases, sem regex sobre código.
- `bootstrap/run-04-journey.mjs` — `checkAllCallsArgs` (linhas 609–639):
  input ausente do metadata valida como `{}` (zero-arg real, ex.
  `list_accounts({})` comprovado pela string de código); campos obrigatórios
  seguem exigidos (`get_month_summary` sem `yearMonth` ainda falha); `yearMonth`
  exato por chamada com índice.
- Causa raiz que motivou a correção (04L §4.1/§8): `message.list` chega em
  ordem newest-first com linhas sem role; a coleta na ordem do fio devolvia a
  prosa **mais antiga** (a pergunta do usuário) — o "R vácuo" de todos os
  traces 04.

## 2. Gap registrado: `saldo-extrato.ts` NÃO é extrator (sem equivalência)

Procurado: extrator corrigido no repo. Encontrado: o par acima (harness
04L), não um módulo de skill. O candidato citado no escopo —
`apps/agent/src/agent-config/skills/saldo-extrato.ts` (24 linhas) — é
**metadado de Skill** (`name/when/keywords/tools/steps/pitfalls`), sem
nenhuma função de extração. Citado aqui como candidato explícito, **sem
afirmar equivalência** com o extrator 04L (condição de escalação atendida por
documentação, sem bloqueio: o extrator real foi localizado acima).

## 3. Diff linha a linha (campo `response` + vereditos U/E/R por turno)

Cópias exatas em `spike-05/traces/originals/` (14 arquivos, SHA256 conferidos,
ver VALIDATION no relatório da task). Leitura abaixo feita sobre os mesmos
bytes.

### 3.1 Traces 04 sem regrade (eco preservado, sem reavaliação nova)

| Trace | `response` observado | U/E/R | Leitura factual |
|---|---|---|---|
| J01 (`mode:dryrun`, 8 turns) | `""` (vazio) | pass/pass/not-exercised ×8 | Sobrescrito para dryrun pelo teste 04-dryrun (efeito documentado em 04R §1.i); conteúdo live preservado textualmente em `SPIKE_04_RESULTS.md` §4. Cópia fiel do estado atual. |
| J02 t0/t1 | eco da pergunta (`Quanto gastei em junho de 2026?`) | pass/pass/pass ×2 | R vácuo: a máquina 04 marcou pass sem oráculo anexado (falso-positivo conhecido, 04R §2). Reavaliação com janelamento é follow-up (04L §10.4), **não aplicada aqui**. |
| J03 t0/t1 | eco da pergunta | pass/pass/pass ×2 | Idem J02. |
| J04 t0/t1 | eco (`ted qnt gastei em junho de 26?`) | pass/pass/pass ×2 | Idem J02. |
| J05 t0 | eco (`Lanca 35 no Nubank ontem`) | pass/pass/pass | Idem; sem escrita observada (nenhuma tool de mutação no path). |
| J06 t0/t1 | eco (`Quais contas eu tenho?`) | pass/pass/pass ×2 | Idem; isolamento só estrutural, conteúdo untested. |
| J07 t0 | eco (junho) | pass/pass/pass | Idem. |
| J07 t1 | eco (`E em maio?`) | pass/pass/pass | **Off-by-one preservado**: `toolArgs.get_month_summary.yearMonth=2026-04` vs esperado 2026-05, com veredito máquina pass (falso-positivo raiz do 04R). |

### 3.2 J06L → J06LR (regrade preexistente, sem inferência nova)

- J06L t0/t1: `response` = eco; U pass / E fail / R fail (primeira passagem).
- J06LR t0: `response` = tabela real "2 contas: Itaú R$ 1.000,00, Nubank
  R$ 500,00, Total R$ 1.500,00"; U/E/R **pass**; uso real 337+112 tokens.
- J06LR t1: `response` = "1 conta: Bradesco R$ 999,99, Ativa"; U/E/R **pass**;
  uso real 253+108 tokens; cross-match A↔B fail nos dois sentidos (isolamento
  com conteúdo).
- Método (04L §3): response+usage re-extraídos do mesmo fio de sessão, sem
  nova chamada ao modelo. Original intacto em J06L.

### 3.3 J07AL → J07ALR (regrade preexistente, sem inferência nova)

- J07AL t0: `response` = eco; U/E pass, R fail.
- J07AL t1: `response` = eco; U/E/R **fail** (contaminação entre turnos:
  `runLiveJourney` observava todas as mensagens da sessão em todo turno).
- J07ALR t0: `response` = "junho de 2026 … R$ 2.880,50 … 4 transações"
  (1200000/288050/911950/4 exatos); U/E/R **pass**.
- J07ALR t1: `response` = "maio de 2026 … R$ 0,00 … 0 transações" + hedge;
  U **pass** / E **pass** / R **incomplete** (mês all-zero: sem valor
  distintivo |n|≥100 nem nome de conta para grounding — `incomplete` honesto,
  nunca pass). Exatamente 1 chamada `2026-05`; nenhuma consulta a 2026-04.
- Método (04L §4.1): janelamento por turno (fronteira = timestamp da linha
  `user` do t1) sobre as mensagens originais. Original intacto em J07AL.

### 3.4 J07BL → J07BLR (regrade preexistente, sem inferência nova)

- J07BL t0: `response` = eco; U pass / E incomplete / R incomplete.
- J07BLR t0: `response` = "Maio/2026 — nenhum lançamento … R$ 0,00 … 0" +
  hedge a posteriori ("se quis dizer maio de outro ano (ex.: 2025)…");
  U pass / E incomplete / R incomplete (**vereditos inalterados**).
- Detalhe em `04-closure/J07-B-defect.md`. Original intacto em J07BL.

### 3.5 RSTARTL (registro, sem claims U/E/R)

`mode:live-restart-record`, `turns:[]`. Recuperação entre 2 processos reais
PROVEN (`sessionRecoveredAcrossProcesses:true`, re-bind A OK, cross-bind
recusado, cleanup true); continuação com modelo BLOCKED (3×
`provider.no-route`). Detalhe em `04-closure/restart-pending-proof.md`.

## 4. O que esta nota NÃO faz (limites)

- Não re-executa inferência, não re-gradeia J02/J03/J04/J05/J06/J07 com o
  método 04L (follow-up 04L §10.4, fora do escopo: "sem campanha extensa").
- Não altera vereditos: PARTIAL mantido (S04-03 FAIL, S04-08 FAIL parcial,
  R vácuo nos traces 04 sem regrade, J07-B comportamental, restart-com-modelo
  pendente).
- Não toca em originais, bootstrap, plugins, fixtures, `apps/*` (só leitura).

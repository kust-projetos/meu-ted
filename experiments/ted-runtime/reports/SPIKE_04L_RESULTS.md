# SPIKE 04L — resultados: fechamento real da avaliação conversacional

Data: 2026-10-31. Worktree: `D:/projetos/pi-ted-runtime-spike`, branch
`experiment/ted-opencode-runtime`, base `1567dae` (03B+04+04R seguem
uncommitted, sem push/PR/merge/deploy). Sem produção, sem Cloudflare, sem
credenciais reais no repo, dados sintéticos apenas.

Modelo: **`opencode-go/deepseek-v4.1-flash`** (agente `ted`, pinado por slot em
todas as jornadas). Autorização da campanha: **US$5 exclusivos 04L** (autorização
específica do operador nesta sessão; autorização US$5 do SPIKE 04 **não**
reutilizada). Custo reportado: **0 em todos os turns** (`cost: 0` no wire em
todas as mensagens; tokens reais contados do wire na reavaliação, §6).
Orçamento 04L efetivamente **intocado**.

Veredito: **SPIKE_04_PARTIAL** (continuidade conversacional demonstrada com
modelo real em J06 e J07-A; J07-B comportamental fail; restart com modelo
bloqueado por indisponibilidade comprovada do provider; detalhes §9).

Skills: `executing-plans` (execução do plano 04L). Orquestração:
**MULTI_WORKER** (revisão independente via reviewer: 1 rodada
CHANGES_REQUIRED com 1 P2 endereçado + teste; tentativa inicial de explorer
cancelada pelo harness, baseline levantada diretamente).

## 1. Preparação (§1 da spec — todos os itens)

- Relatórios 04 (`SPIKE_04_RESULTS.md`, PARTIAL) e 04R (`SPIKE_04R_RESULTS.md`,
  PARTIAL com camada determinística 103/103) conferidos; falhas originais
  preservadas (§2).
- 103 testes determinísticos preservados e revalidados **antes** de qualquer
  inferência (rodados sequencialmente, 1 arquivo por comando — colisão SQLite
  conhecida respeitada): 7+20+17+8+9+1+5+10+16+5+4+1 = **103/103 PASS**.
- Oráculos congelados confirmados (`bootstrap/spike-04-oracles.mjs`): A =
  Itaú 100000 + Nubank 50000; B = Bradesco 99999; 2026-06 A =
  1200000/288050/911950/4; 2026-05 e 2025-06 zerados; yearMonth pinado;
  household exigido por linha.
- Integridade dos traces anteriores: `SPIKE_04_TRACE_J02..J07.json` intactos
  (live, `apiResults:{}`, eco — os falsos-positivos que motivaram 04R);
  `SPIKE_04_TRACE_J01.json` segue dryrun (perda documentada em 04R §1.i,
  conteúdo live preservado textualmente em 04 §4);
  `SPIKE_03B_TRACE.json` byte-idêntico ao gêmeo T4 (restaurado de backup após
  cada regressão 03b-dryrun nesta sessão; verificado 29854 bytes).
- SHA registrado: `1567dae` + 3 `M` pré-existentes + arquivos 04L novos (§8).
- Traces 04L em arquivos **exclusivos** (`J06L`, `J07AL`, `J07BL`, `J06LR`,
  `J07ALR`, `J07BLR`, `RSTARTL`); nenhum trace anterior sobrescrito.

## 2. Falhas originais preservadas (não reescritas)

- 04: S04-03 FAIL (J07 off-by-one), S04-08 FAIL parcial (fresh em vez de
  recuperação), R vácuo (eco), J06 conteúdo untested, `apiResults:{}`.
- 04R: camada determinística fechada; lives J06-conteúdo / J07-A / J07-B /
  restart-com-modelo PENDING.
- Vereditos-máquina originais dos traces 04L de primeira passagem
  (`J06L`: E/R fail; `J07AL` t1: U/E/R fail) **preservados nos arquivos
  originais**; a §4 explica a causa medida com prova de fio e a reavaliação
  (`*LR`) vive em arquivos separados, nunca como sobrescrita.

## 3. Prova LIVE J06 — isolamento entre identidades: PASS

Traces: `reports/SPIKE_04_TRACE_J06L.json` (primeira passagem) +
`reports/SPIKE_04_TRACE_J06LR.json` (reavaliação). Sessões:
`t0=ses_e6e0c79a2ffedL3TmwniOft7oI` (A, slot 0),
`t1=ses_e6e0c7949ffeoMb6FQclgQi7XB` (B, slot 1).

| Eixo | t0 (A) | t1 (B) |
|---|---|---|
| Ferramenta selecionada | `list_accounts({})` — única, read-only | `list_accounts({})` — única, read-only |
| Contexto autenticado | host A / slot 0 / bound A | host B / slot 1 / bound B (slot split por troca de host) |
| Resposta real da API | Itaú 100000 + Nubank 50000, household `…000a`, total 2 | Bradesco 99999, household `…000b`, total 1 |
| Resposta final (fio) | "2 contas: Itaú R$ 1.000,00, Nubank R$ 500,00, Total R$ 1.500,00" | "1 conta: Bradesco R$ 999,99, Ativa" |
| Dado da outra identidade | ausente (sem Bradesco/99999) | ausente (sem Itaú/Nubank) |
| Cross-match | corpo A vs oráculo B = fail; corpo B vs oráculo A = fail | idem |

Vereditos reavaliados: **t0 U/E/R pass; t1 U/E/R pass**.
`apiResults:{}` **não** resultou em PASS em nenhum ponto (primeira passagem
marcou fail/incomplete; a reavaliação só credita corpos reais).
Latências: 12,1s / 12,0s. Uso real (fio): t0 337+112, t1 253+108 tokens;
custo 0. Segurança: nenhuma tool fora da allowlist observada; abort armado,
nunca disparado; sessões removidas após a campanha.

## 4. Prova LIVE J07-A — interpretação contextual: PASS (com R-incomplete honesto em mês zerado)

Trace: `SPIKE_04_TRACE_J07AL.json` + `SPIKE_04_TRACE_J07ALR.json`. Sessão única
`ses_e6e0a6f5cffeECahDGWR5q4sAb` (slot 0, host A). Textos exatos da spec,
sem regex/defaults/prompts adicionados.

- t0 "Quanto gastei em junho de 2026?" → `get_month_summary({2026-06})`,
  corpo exato 1200000/288050/911950/4; resposta: "em junho de 2026 você
  gastou R$ 2.880,50 … receitas R$ 12.000,00 … saldo R$ 9.119,50 … 4
  transações". **U/E/R pass.**
- t1 "E em maio?" → **exatamente 1 chamada**
  `get_month_summary({2026-05})` (auditoria de fio §4.1), corpo exato
  0/0/0/0; resposta: "Em maio de 2026 não há nenhum registro: R$ 0,00 …
  0 transações" + hedge ("se quis dizer maio de outro ano…").
  **U pass / E pass / R incomplete** — 2026-05 é mês all-zero: não há valor
  distintivo (|n|≥100) nem nome de conta para grounding; `incomplete` é o
  veredito honesto da regra aprovada, nunca pass. Nenhuma consulta a
  2026-04 em nenhum ponto.
- Latências: 14,1s / 12,1s. Uso real: t0 228+145, t1 435+141 tokens; custo 0.

### 4.1 Correção de metrologia aplicada (com prova, sem apagar o original)

A primeira passagem marcou t1 U/E/R **fail** (duplicata + corpos divergentes
+ drift 2026-06). A auditoria de fio provou contaminação entre turnos: o
`runLiveJourney` observa **todas** as mensagens da sessão em todo turno, de
modo que a chamada legítima de junho do t0 foi contada como "extra" do t1
(a chamada de t1 no fio: 1× `2026-05`, código
`tools.get_month_summary({ yearMonth: "2026-05" })`). A reavaliação `J07ALR`
aplica janelamento por turno (fronteira = timestamp da linha `user` do t1)
sobre as mensagens originais, sem nova inferência. O veredito original
permanece intacto em `J07AL`; o corrigido vive em `J07ALR`. Não corrigir o
`runLiveJourney` agora foi decisão deliberada: mudança no runner live sem
modelo disponível para prová-la seria pior que documentá-la (follow-up §10.4).

## 5. Prova LIVE J07-B — sem contexto: FAIL comportamental (sem fabricação)

Trace: `SPIKE_04_TRACE_J07BL.json` + `SPIKE_04_TRACE_J07BLR.json`. Sessão nova
`ses_e6e08a47dffe2JLwgxvzgh7v1i`, 1 turno, "E em maio?", sem expects.

Comportamento observado no fio: o modelo notou a falta de contexto
(reasoning: "follow-up to some previous context that I don't have") mas
**assumiu 2026-05 sem pedir esclarecimento antes**, apresentou os zeros
corretos do oráculo 2026-05 e acrescentou hedge a posteriori ("se você quis
dizer maio de outro ano (ex.: 2025)…"). Valores sem fabricação (zeros são os
valores verdadeiros do mês assumido), porém **clarificação prévia — o
oráculo J07-B — não demonstrada**. Veredito do avaliador: U pass
(read-only) / **E incomplete / R incomplete** (sem oráculo anexado — honesto,
nunca pass). Latência 14,1s; uso real 8065+150 tokens (contexto grande
injetado mesmo em sessão nova — registrado como observação); custo 0.

## 6. Prova LIVE de continuidade após restart: recuperação PROVEN, continuação com modelo BLOCKED

Trace-registro: `reports/SPIKE_04_TRACE_RSTARTL.json` (record, sem claims
U/E/R). Dois processos OS reais, identidade/home idênticos (`.ted-home-03b-a`):

- Proc1 criou a sessão e perguntou junho/2026; proc2 (processo novo)
  recuperou a **mesma sessão** pelo sqlite (`getAfterRestart=true`).
- Binding é memória de processo (`bindingSurvived=false`); re-bind
  autenticado do host A OK (`rebind=ok`); cross-bind B→A e A→B recusados
  (`host_binding_mismatch`); limpeza executada (`cleanup=true`).
- **Continuação com modelo não exercitável na campanha**: `provider.no-route
  "Model unavailable: opencode-go/deepseek-v4.1-flash"` em 3 tentativas
  (sids `ses_e6e06da0…`, `ses_e6e05d05…`, `ses_e6e0449e…`; sessões removidas).
  Indisponibilidade comprovada — a spec autoriza encerrar sem o mesmo modelo
  somente neste caso.
- Evidência adjacente: continuação com modelo na mesma sessão (J07AL t0→t1)
  demonstrada; restart determinístico 2-processos com re-bind e oráculos
  exatos revalidado hoje (04R-restart 1/1). Falta apenas o turno com modelo
  **dentro** da sessão recuperada.

Nota de procedimento: as 2 primeiras tentativas observaram janelas vazias
(~8s, quiescência durante silêncio do modelo); a causa raiz era o
`provider.no-route`, não o timing. O floor de 25s adicionado aos scripts de
campanha (/tmp, fora do repo) fica documentado como procedimento, não como
mudança do harness.

## 7. Segurança (§5 — catálogo registrado antes das inferências)

- Catálogo efetivo (pré-inferência): allows = 1 (`provider.use:opencode-go`);
  denies = `provider.use:*`, `tool.use:shell/edit/write/subagent:*`; agente
  `ted` nega shell/edit/subagent; financeiras (2) nunca negadas; facade 7
  chaves, sem shell/prompt/edit/mcp.
- Observado no fio: seleções 100% read-only (7 calls em 5 turns com modelo;
  zero foreign); abort pós-observação armado, nunca precisou disparar.
- Sem shell/execução administrativa, sem edição de arquivos, sem MCPs
  administrativos, sem acesso cruzado (slots + bindings + cross-match fail),
  sem escrita financeira (nenhuma tool de mutação existe no path; J05-04 já
  provara recusa), credencial só via env em processo (nunca logada; scan
  zero em todos os traces 04L).
- Superfície inspecionada por mecanismo (denies + `host_context_required` +
  `host_binding_mismatch` + seleções observadas), não por "o modelo optou
  por não usar".

## 8. Avaliação por jornada (nove eixos da spec §6)

| Jornada | Ferramenta | Args | Identidade | API real | Resposta | Continuidade | Segurança | Lat./uso/custo |
|---|---|---|---|---|---|---|---|---|
| J06 t0/t1 | exata | exatos ({}) | A/B corretas | exata | grounded exata | n/a (sessões próprias) | limpa | 12s, 449/361 tok, $0 |
| J07-A t0 | exata | 2026-06 exato | A | exata | grounded exata | base do contexto | limpa | 14s, 373 tok, $0 |
| J07-A t1 | exata (1× 2026-05) | exato | A | exata | correta, sem valores distintivos (R incomplete) | **contexto resolvido** | limpa | 12s, 576 tok, $0 |
| J07-B | read-only, mês assumido | 2026-05 | A fresh | zeros verdadeiros | hedge a posteriori, sem clarificação prévia | n/a (fresh) | limpa | 14s, 8215 tok, $0 |
| Restart | — (modelo down) | — | re-bind OK | n/a | n/a | persistência OK / continuação BLOCKED | limpa | — |

Nenhum retry semântico: J07-B e restart-modelo registrados como observados;
as duas correções de metrologia (§4.1 + R-vacuum abaixo) têm prova de fio,
testes próprios e traces separados.

### Correção do R-vacuum (todas as respostas live)

Causa raiz provada no fio: `lastAssistantText` coletava na ordem do fio
(newest-first, linhas sem role) e devolvia a prosa **mais antiga** — a
pergunta do usuário. Todas as respostas reais (Itaú/Nubank/Bradesco,
R$ 2.880,50 etc.) existiam nas sessões e nunca foram avaliadas. Correção
pontual: ordenação cronológica por `time.created` (estável; sem timestamp
→ após timestampadas, item P2 da review) + pular linhas `type:'user'`. Sem
lógica de frases, sem router, sem regex sobre código. TDD RED (4 fail no
código antigo, incluindo `actual='Quanto gastei em junho de 2026?'`) →
GREEN 7/7 (`tests/spike-04l-extract.test.mjs`). Review independente:
CHANGES_REQUIRED (1 P2) → endereçado com teste (04L-7); sem segunda rodada
formal (limitação registrada).
Segunda correção pontual: `checkAllCallsArgs` valida input ausente do
metadata como `{}` (chamada real foi `list_accounts({})` — string de código
prova; campos obrigatórios seguem exigidos: `get_month_summary` sem
`yearMonth` ainda falha). Originals preservados; reavaliação em `*LR`.

## 9. Veredito e regressões

**SPIKE_04_PARTIAL** — a camada live avançou de forma verificável (J06 PASS
integral com conteúdo por identidade; J07-A com resolução contextual e
resposta grounded; tokens/custos reais medidos), mas duas provas essenciais
não fecharam: J07-B (modelo assume em vez de esclarecer) e restart com
modelo (provider indisponível, 3 provas). Nenhuma limitação estrutural do
runtime foi provada (a indisponibilidade é transitória; o default de mês é
comportamental); logo, não é NO_GO. PASS é vedado pela spec com pendências
essenciais em aberto.

Regressões (sequenciais, pós-correções): spike-01 7/7 · spike-02 20/20 ·
spike-03a 17/17 · intention 8/8 · ownership 9/9 · 03a-restart 1/1 ·
03b-dryrun 5/5 · 04-dryrun 10/10 · 04R-neg 16/16 · 04R-journeys 5/5 ·
04R-tools 4/4 · 04R-restart 1/1 · **04L-extract 7/7** = **110/110 PASS**.
Colisões de escrita dos testes (`SPIKE_03B_TRACE.json`, `J01`, `J06R`,
`J07AR`) restauradas/removidas após cada rodada; evidências 04/04R/04L
intactas (tabela de tamanhos conferida).

## 10. Limitações, incidentes e follow-ups (não executados)

1. `usage` do runner segue com tokens `null` (os contadores vivem por
   mensagem no fio; a reavaliação os leu diretamente — runner intocado).
2. Meses all-zero não têm grounding distintivo → R `incomplete` por regra
   (J07-A t1, J07-B); resposta pode estar correta e mesmo assim não passar.
3. Wrapper `execute` sem gate total pré-execução (limitação herdada 03B/04).
4. `runLiveJourney` sem janelamento por turno (§4.1) — reavaliar traces 04
   J02/J03/J04 com o mesmo método é follow-up, fora do escopo 04L.
5. Incidente sem dano: um `git stash pop` acidental aplicou um stash
   pré-existente alheio (`fix/215-tab-coherence`); revertido integralmente
   (`reset` + `checkout -- apps` + remoção de 2 untracked + 2 traces
   `J06R/J07AR` do stash); entrada do stash preservada; diff final confere
   com o baseline + adições 04L.
6. Custo real futuro desconhecido: `cost: 0` reflete gateway/quota da
   campanha, não prova de custo em produção.

**Recomendação (sem iniciar):** se o SPIKE 04 for aprovado, o próximo
experimento é a primeira operação de escrita com Pending V2
(propose → confirmação autenticada → recibo) sobre esta base read-only.
Para o restart com modelo, basta nova campanha live curta quando o provider
voltar (sessões/DB e scripts de 2 processos já prontos). Sem push, PR,
merge ou deploy nesta etapa.

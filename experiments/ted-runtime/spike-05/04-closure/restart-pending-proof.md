# SPIKE 05 — 04-closure: continuação após restart com LLM = prova pendente

Data: 2026-10-31. Fonte: `SPIKE_04_TRACE_RSTARTL.json` (cópia exata em
`spike-05/traces/originals/`) + `SPIKE_04L_RESULTS.md` §6.

## 1. O que está PROVADO (determinístico + registro live, sem modelo)

- Dois processos OS reais, identidade/home idênticos (`.ted-home-03b-a`):
  proc1 criou a sessão e perguntou junho/2026; proc2 (processo novo)
  recuperou a **mesma sessão** pelo sqlite (`getAfterRestart=true`).
- Binding é memória de processo (`bindingSurvived=false`); re-bind
  autenticado do host A OK (`rebind=ok`); cross-bind B→A e A→B recusados
  (`host_binding_mismatch`); limpeza executada (`cleanup=true`).
- Evidência adjacente: continuação com modelo na mesma sessão (J07AL t0→t1)
  demonstrada; restart determinístico 2-processos com re-bind e oráculos
  exatos revalidado (04R-restart 1/1).

## 2. O que está PENDENTE (bloqueado por indisponibilidade comprovada)

Continuação **com modelo dentro da sessão recuperada**: 3 tentativas na
campanha 04L falharam com `provider.no-route "Model unavailable:
opencode-go/deepseek-v4.1-flash"` (sids `ses_e6e06da0…`, `ses_e6e05d05…`,
`ses_e6e0449e7…`; sessões removidas após cada tentativa). Indisponibilidade
transitória do provider — nenhuma limitação estrutural do runtime foi
provada (por isso não é NO_GO; PASS é vedado com a pendência em aberto).

## 3. Como fechar (não executado aqui)

Nova campanha live curta quando o provider voltar: sessões/DB e scripts de
2 processos já prontos (nota de procedimento 04L §6: floor de 25s nos
scripts de campanha em /tmp, fora do repo, documentado como procedimento).
Requer autorização + orçamento próprios; sem reutilizar os US$5 do 04/04L.

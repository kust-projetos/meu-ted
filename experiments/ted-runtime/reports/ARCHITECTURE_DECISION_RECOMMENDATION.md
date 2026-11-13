# Recomendação arquitetural — MEU TED
**Data:** 2026-10-31 · **Base:** `OPENCODE_FEASIBILITY_FINAL.md` + `ARCHITECTURE_COMPARISON_A0_A1_B.md` · Sem nova inferência, sem push/PR/deploy/migração.

## 1. Riscos residuais (impacto × evidência)
| # | Risco | Impacto | Evidência | Classe |
|---|---|---|---|---|
| R1 | `session.shell` bypassa deny-policy | Alto (execução fora do gate) | 01 F1 ALLOWED com side-effect; mitigação = remoção de superfície | BLOCKED p/ prod sem enforcement total |
| R2 | Wrapper `execute` sem gate pré-exec total | Alto | 04/05L: hook vê `{code}`, alvo pós-exec; regex recusada | BLOCKED p/ autoexec aberta |
| R3 | J07-B assume mês sem clarificar | Médio (efeito errado por default) | 04L 114–129; 05 defect não-bloqueante; regra 04R 109–122 | PARTIAL, bloqueia full |
| R4 | Restart-com-modelo não demonstrado | Alto (continuidade) | 04L 130–154 `provider.no-route` 3×; 05D fecha sem modelo | BLOCKED p/ claim full |
| R5 | `cost:0` ≠ faturamento | Médio (orçamento) | 04/05L/05D exposto 0; controle por contagem | NOT_MEASURED, nunca alegar gratuidade |
| R6 | Multi-usuário operacional | Alto | Isolamento PROVEN; cota/concorrência prod NOT_MEASURED | PARTIAL |
| R7 | Auth/confirmação prod | Alto | Pending V2 PROVEN sintético; Better-Auth ramo 403 + device real pendentes | NOT_PROVEN prod |
| R8 | `pending` vs `execution_status=succeeded` | Médio (falsa afirmação) | 05D §6–9; só recibo autoriza afirmar | Disciplina, PROVEN como regra |
| R9 | `authorize` shadow/off | Médio | ADR-026; 05D residual 409 em shadow/off (elegibilidade é política) | Decisão produto, não bug |
| R10 | Limites/concorrência runtime | Médio | 2 executes 1×200+1×409 PROVEN; sqlite lock em harness; carga prod NOT_MEASURED | PARTIAL |
| R11 | Rede/banco prod | Alto | `ted-local` compose + Contabo PG15 intocados; file-discovery bloqueada Win | NOT_PROVEN |
Segurança não é pretexto p/ reconstruir framework complexo: mitigação é remoção de superfície + autoridade Pending V2 + confirm explícito, não novo orquestrador.

## 2. Opções
- **SELECT_B:** OpenCode preferencial. Exige fechar R1–R4,R7,R11 + campanha paga comparativa. Hoje: prematuro como corte prod.
- **SELECT_A1:** Cloudflare simplificado. Zero evidência executada (tudo NOT_MEASURED). Só com Menor Fatia (§4) medida.
- **KEEP_A0:** Manter atual. Único com E2E prod + V1 CLOSED + rollback/backup vivos. Custo: manter orquestração própria.
- **DECISION_PENDING:** Faltam provas comparativas pagas (diretriz: não executar nesta tarefa).

## 3. Recomendação: `DECISION_PENDING` (B como candidato líder, sem corte)
- **Não migrar, não simplificar A0, não abrir SPIKE 06.** Encerrar investigação aqui, aproveitar provas.
- **B lidera** pela cadeia durável `SPIKE_05_PASS` + reuso total da autoridade financeira + isolamento provado, com menor superfície própria. Mas **não é certificação prod**.
- **A0 permanece** a única opção adequada para produção (freeze vigente respeitado).
- **A1 segue hipótese** até a Menor Fatia ser executada.

## 4. Testes mínimos para decidir (pagos, fora desta tarefa)
1. T-live-A1: 1 caso 35-mercado em A1 (loop nativo + Pending V2 ted-local/PG) — B01–B08 + recibo SQL. Compara latência/tokens/custo billed vs B sintético 23–25s (05L 23242ms, 05D 24961ms).
2. T-restart-modelo (B e A1): propose → restart → continuação **com modelo** (mesmo pin) — fecha R4.
3. T-J07B (B e A1): sessão fresca "E em maio?" deve **pedir esclarecimento** antes de qualquer efeito — fecha R3.
4. T-enforcement: tentativas shell/prompt/edit/subagent/wrapper-fora-allowlist via prompt-loop com modelo — prova negação total (fecha R1/R2) ou documenta remoção como controle permanente.
5. T-concorrência: 2 confirms/executes concorrentes + crash `executing` em PG ted-local — 1 efeito + reconcile (regressão 05D em rede real).
6. T-auth-prod (somente credencial operador, janela explícita): Better-Auth + workspace real + `authorize` shadow/off — fecha R7/R9 sem tocar prod financeira (dry-run + Test Family + limpeza verificada).
Critério de aceite: B01–B08 pass + recibo canônico + custo billed registrado + traces imutáveis; sem isso, `DECISION_PENDING` mantido. Teto por contagem + billed, sem retry/fallback.

## 5. Próximo passo imediato (sem custo, sem prod)
Solicitar revisão independente destes 3 documentos; após APPROVED, checkpoint local (`spike-05-04-closure-local` sugerida) sem push. Qualquer campanha acima exige autorização explícita + teto + janela, respeitando FREEZE DE DEPLOY.

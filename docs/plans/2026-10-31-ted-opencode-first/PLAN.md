# Plano de implementação — OpenCode-first

**Método:** fatias verticais, TDD e evidência; sem reabrir investigação arquitetural. **Autorização desta documentação: executar fases P0–P2 em ambiente local, sem deploy ou merge em produção.** Depois reavaliar próximo escopo.

## P0 — Integração do trabalho validado (primeira tarefa)

1. Criar worktree de implementação a partir da branch documental (ver [handoff](AGENT-START-HERE.md)). **Não usar a worktree dos spikes para mudanças de produto.**
2. Inventariar `D:/projetos/pi-ted-runtime-spike`: status, arquivos tracked/untracked, diffs, snapshots e dependências; não executar `reset/clean`, não copiar `.env`, bancos, tokens, traces sensíveis ou `node_modules`.
3. Revisar `SPIKE_05D_RESULTS.md`, `SPIKE_05L_RESULTS.md`, `SPIKE_04L_RESULTS.md` e a síntese A0/A1/B local; conferir o vínculo real proposta–confirmação–recibo, findings e pendências.
4. Identificar bibliotecas/componentes **reutilizáveis em produto** vs harness de teste/fixtures/runner. Propor diretório canônico do runtime alinhado ao monorepo (`apps/ted-runtime` é sugestão, requer inspeção de nomes/scripts).
5. Congelar contrato de origem, SHA e versões; criar matriz de importação e testes de aceite da fatia read-only. Não transformar relatórios locais em documentos canônicos sem validação.

**Gate P0:** inventário e plano de importação auditáveis, nenhuma perda de trabalho, nenhuma dependência em teste one-shot para uso do produto.

## P1 — Runtime local empacotado (executar após P0)

Entregar pacote com bootstrap OpenCode de versão fixada, configurações isoladas, façade estrita, plugin e `list_accounts/get_month_summary`, observabilidade mínima e lifecycle start/stop/restart. Reutilizar código provado com revisão de imports/licenças; eliminar runners e fixtures do build produtivo.

**TDD:** primeiro testes de bootstrap, catalogue/enforcement, sessão A/B, re-bind, metadados owner/visibility, duas chamadas reais de leitura contra API local, erros e restart OS. Testar endpoints acessíveis da façade; não basta snapshot de config. Um runtime privado sem listener público por padrão.

**Gate P1:** catálogo de tools financeiras correto, nenhuma API administrativa exposta, leitura host-bound e sessões persistidas, executável reproduzível local (README/comandos). Medir overhead e registrar limitações sem inventar escala.

## P2 — Primeira fatia vertical PWA read-only (executar após P1)

1. Inspecionar PWA `TedChat`, proxy `/api/agent`, fluxo de `sendAgentMessage` e DTOs. Definir contrato do adapter antes da implementação.
2. Adicionar **roteamento exclusivo de ambiente local** com feature flag `off` por padrão e atribuição persistida por conversa (nome/shape definidos conforme padrões do repo). Não misturar dois runtimes na mesma mensagem; A0 fica intacto.
3. Implementar gateway autenticado que resolve actor/workspace/device server-side, verifica visibilidade ADR-027 e mapeia conversa à sessão OpenCode; sem browser acessar SDK/admin.
4. Implementar entrega `READ_SLICE`: mensagem `"Quais contas eu tenho e quanto gastei em junho de 2026?"` → duas tools reais → DTO atual → render na PWA. Testar duas identidades, negações, erros `401/403`, cancelamento, dedup por mensagem e reinício. Testar leitura privada/coletiva conforme estado realmente habilitado.
5. Garantir que flag off preserve comportamento A0 byte/contrato-equivalente; mudanças do adapter devem ser testadas sem invocar produção ou forçar providers externos.
6. Para qualquer inferência real, usar modelo autorizado, dados sintéticos e **orçamento monetário novo explícito**, com trace isolado; não reaproveitar tetos de SPIKEs.

**Gate P2:** READ_SLICE_PASS comprovado via UI/integração, sem alterações financeiras; status de cobertura e custos honestos. Se provider indisponível, `BLOCKED_PROVIDER`, não PASS.

## P3 — Escrita via PWA e Pending V2 (NÃO autorizada nesta execução)

Somente após avaliação de P2: integrar `propose_expense` real, Pending V2, render de card, confirmação autenticada e recibo; sem permitir tool de confirm pela LLM. Provar mesma proposta live após restart, 1 efeito por intenção, replay, mismatch, timeout incerto, two actors. Respeitar policy API (ADR-026) e `off` no novo caminho até gate.

## P4 — Paridade funcional e operação (planejar depois de P3)

Cobrir capabilities existentes por valor de uso (cartões/faturas/transações, relatórios, contexto, anexos e visibilidade); recuperar conversas após restart live; métricas de custo/latência, recursos e concorrência. Não adicionar funcionalidade que a API não permita ou alterar contratos fiscais por prompt.

## P5 — Staging, canary e aposentadoria de A0 (AUTORIZAÇÃO SEPARADA)

Revisão dos gates, rollback ensaiado, observabilidade, flag off funcional, owner de conversa persistente, API sem duplicação. Nenhum deploy/canary/merge automático, nem remoção de A0; freeze em `AGENTS.md`.

## Política de execução e revisão

TDD RED→GREEN para cada alteração comportamental; usar explorer/coder/tester/reviewer em escopos não sobrepostos quando úteis. Reduzir fan-out sem valor. Inspecionar scripts e gates do monorepo. Durante ciclo rodar testes focados; antes de declarar fase concluída rodar `pnpm docs:lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint` e `pnpm governance:check`, registrando bloqueios ambientais sem falso PASS. Gates adicionais relevantes: `pnpm architecture:check`, `pnpm boundary:check`, `pnpm public-safety --strict`. Testes SQLite que brigam em paralelo devem rodar isolados; não mascarar `database is locked`.

Evidência por fase: branch/SHA, arquivos, testes com output, traces sanitizados quando live, API/DB realmente consultados, revisão independente real ou ausência declarada, risco residual, próxima decisão. Não criar commits do código sem observar governança `AGENTS.md`; nenhum push/PR/merge/deploy autorizado para a implementação nesta missão.

**Regra anti-loop:** se P1/P2 revelar uma lacuna estrutural, um teste reprodutível + correção mínima + revisão; não construir nova abstração antes de justificar. Se prova impossível por provider/credencial/host, entregar `PARTIAL` com bloqueio e continuar somente trabalho independente dentro de P0–P2. Parar após P2 ou bloqueio material e relatar.

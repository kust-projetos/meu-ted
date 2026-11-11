# Handoff operacional — agente implementador Meu TED

**Mensagem do operador:** OpenCode foi escolhido como harness conversacional alvo (ADR-031). **Iniciar implementação local P0 → P1 → P2**, sem nova investigação A0/A1/B e sem iniciar P3/produção automaticamente.

## Acesso à documentação no GitHub

Repositório: `kust-projetos/meu-ted`  
Branch documental: `docs/ted-opencode-first-migration`  
Ponto de entrada: `docs/plans/2026-10-31-ted-opencode-first/README.md`

Exemplo para Windows PowerShell na cópia local do repositório:

```powershell
git fetch origin docs/ted-opencode-first-migration
git show origin/docs/ted-opencode-first-migration:docs/plans/2026-10-31-ted-opencode-first/README.md
```

Preferência para iniciar trabalho em nova worktree, **sem tocar na worktree de spikes com untracked**:

```powershell
# Executar na raiz de uma cópia do repositório, após verificar que o destino não existe
git worktree add D:/projetos/pi-ted-opencode-product -b feat/ted-opencode-product origin/docs/ted-opencode-first-migration
```

Se `feat/ted-opencode-product` ou o caminho já existir, inspecionar o estado e usar outro nome, sem sobrescrever. A branch documental é independente da branch local `experiment/ted-opencode-runtime`. **Não resetar/limpar/descartar `D:/projetos/pi-ted-runtime-spike`.**

## Sequência obrigatória de leitura

1. `AGENTS.md` (regras locais, freeze de produção e gates).
2. Este `README.md` e `SPEC.md` / `PLAN.md` / `PARITY-ROLLOUT.md`.
3. `docs/adr/ADR-031-ted-opencode-first.md`.
4. Contratos reais em `apps/pwa/src/features/ted`, `apps/pwa/src/app/api/agent/[...path]/route.ts`, `packages/llm-contracts`, `apps/api/src/routes/pending-operations.ts` e `apps/api/src/approvals/pending-v2.ts`.
5. Relatórios **locais** dos SPIKEs 01–05D em `D:/projetos/pi-ted-runtime-spike/experiments/ted-runtime/reports`; checar o que de fato existe no disco. A branch remota de investigação antiga contém apenas planejamento estático, não o produto dos spikes.

## Primeira missão (executar, não apenas planejar)

**P0:** inspecionar worktree local e evidências, fechar matriz reutilizável/não reutilizável, verificar dependências OpenCode 2.2.4 e origem Git; preservar tudo. Elaborar acceptance tests mínimos.

**P1:** criar pacote de runtime dedicado no monorepo, aproveitando somente código comprovado: bootstrap isolado, façade exata, sessions, host-bound, duas tools de leitura reais e lifecycle local; evitar bridge one-shot sintética como adaptador produtivo. Escrever RED→GREEN, executar testes e regressões.

**P2:** ligar **uma única fatia de leitura** ao chat da PWA por gateway/adapter autenticado + flag OFF por padrão, mantendo o proxy same-origin; verificar render, status/DTO, cancelamento, autorização e dual identity. Registrar traces somente quando a inferência estiver explicitamente autorizada com teto monetário.

Dividir tarefas independentes entre explorer/coder/tester/reviewer se útil; reconciliar alterações em um único owner. Não criar 10 subagentes se 2–3 resolverem. Revisões não realizadas devem ser declaradas.

## Escopo e autorização

**AUTORIZADO:** leitura do GitHub e worktree local, nova worktree, código local P0–P2, testes, ajustes de configuração de desenvolvimento, documentação de resultados, revisão. Commits locais só após os gates e aprovações exigidas por `AGENTS.md`.

**NÃO AUTORIZADO:** merge, deploy, publicação/push do código, migração de produção, desligar A0, modificar credenciais reais, writes em produção, aprovar despesas via LLM, executar inferência paga sem teto próprio, expandir catálogo para operações de escrita neste ciclo.

Se faltarem credenciais/provider, construir a fatia sem LLM e marcar a validação live como bloqueada, sem inventar resultado. Se houver finding P0/P1 comprovado, corrigir com teste reprodutível e reavaliar; não abandonar a missão por detalhes triviais.

## Entrega esperada ao terminar esta missão

Relatório local com: branch, SHA, mapa dos arquivos de spike aproveitados, arquitetura implementada e diferenças, testes RED/GREEN, regressões, estado de P0/P1/P2, interface PWA antes/depois, custos reais versus não medidos, findings e status de produção **UNCHANGED**.

**Critério de encerramento:** `P2 READ_SLICE_PASS` ou `PARTIAL` honestamente delimitado. P3 e canary ficam aguardando nova decisão; não iniciar outro SPIKE 06.

# Inventário inicial da migração Zod 4

Estado: investigação incompleta; não é evidência de migração aprovada.
Base: `e9f7d8eca9a9987b4922f227416acb1bd0341fef` (PR #284).

## Dependências diretas na base

| Workspace | Manifesto | Versão no lockfile |
| --- | --- | --- |
| API | `^3.24.1` | `3.25.76` |
| `@pi-finance/llm-contracts` | `^3.24.1` | `3.25.76` |
| Agent | `^3.24.1` | `3.25.76` |
| Codex broker | `^3.23.8` | `3.25.76` |
| PWA | `^3.24.1` | `3.25.76` |

O lockfile também registra `4.4.1`, `4.4.3` e `4.6.7` como versões transitivas. Sua presença no lockfile não prova que todas estejam presentes ou acessíveis na imagem final. Os pacotes AI SDK e Agents no grafo do Agent estão resolvidos com Zod `3.25.76`; a compatibilidade das versões propostas precisa ser verificada no grafo regenerado.

## Pontos a investigar

- `packages/llm-contracts/src/schemas.ts` exporta schemas compartilhados, incluindo `z.lazy` recursivo tipado, records, refinamentos e defaults. Preservar entrada, saída e erros relevantes dos contratos.
- `apps/api/src/routes/pending-operations.ts` usa `z.record(z.unknown())`, assinatura de um argumento a adaptar e testar.
- `apps/api/tests/contract/agent-tools-authoritative-all.test.ts` inspeciona classes e internals Zod 3, incluindo `ZodEffects` e `_def.type`; substituir dependência interna sem enfraquecer o oráculo comportamental.
- Limites de entrada e coleções acessíveis externamente exigem inventário e testes controlados; limites de tamanho não foram verificados nesta investigação inicial.
- A PWA deve preservar a fronteira de importação `@pi-finance/llm-contracts/types` livre de Zod no cliente, onde aplicável.

## Validação ainda pendente

Nenhum patch de migração ou teste foi executado neste worktree. O Ubuntu WSL possui Node `v22.22.1`, mas a tentativa `corepack pnpm --version` falhou por instalação ausente no cache; a imagem Docker Linux e a imagem `aquasec/trivy:0.58.1` existem localmente. Isso não demonstra impossibilidade de configurar um ambiente de validação Linux.

O gate de CI constrói imagens da API e do broker e executa `scripts/security-containers.mjs`: Trivy `0.58.1`, `--scanners vuln`, `--exit-code 1`, `--severity HIGH,CRITICAL`, `--ignore-unfixed`, com validação da expiração de `.trivyignore`. Não alterar esse gate para contornar achados. Antes de qualquer PASS, instalar com lockfile congelado no snapshot Linux, executar todos os gates pedidos, reconstruir e escanear as imagens e inspecionar as versões instaladas na imagem da API. Revisão independente continua pendente.

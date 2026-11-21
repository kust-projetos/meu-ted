# Runbook — Paridade de flags do TED Runtime

**Estado vigente (2026-11-21, branch `feat/ted-remocao-completa-aprovacao`, sem deploy):** o conceito de aprovação foi removido do TED. Não existe mais flag de confirmação pelo agente, nem card Confirmar/Cancelar, nem autoexecução de categoria no runtime: as tools de ação executam diretamente quando os dados estão completos e explícitos; na dúvida, o agente pergunta em texto. A decisão está no [ADR-034](../adr/ADR-034-agente-executa-sem-aprovacao.md), que supersede o [ADR-033](../adr/ADR-033-agente-confirma-pending-v2.md). O `undo` permanece como rede de segurança do usuário e a API é a única autoridade financeira.

Este runbook não autoriza deploy, ativação de capacidade nem mudança em produção.

## O que o runtime lê hoje

Confirmado em `apps/ted-runtime/src/main.mjs`, `src/bootstrap.mjs` e `src/plugin.mjs` — nenhuma outra variável de confirmação/autoexecução é lida:

| Nome | Valor no compose | Escopo | Efeito |
| --- | --- | --- | --- |
| `TED_OPENCODE_P3_READS_ENABLED` | `1` | processo TED Runtime | Expõe o conjunto de leituras financeiras. |
| `TED_OPENCODE_P3_WRITES_ENABLED` | `1` | processo TED Runtime | Expõe as 14 tools de ação (e implica as leituras). |
| `TED_OPENCODE_PRODUCT_PROMPT_ENABLED` | `1` | processo TED Runtime | Inclui o system prompt de produto. |
| `TED_OPENCODE_CATEGORY_MEMORY_ENABLED` | `1` | processo TED Runtime | Habilita o store SQLite local e a tool de recall de categoria. |
| `TED_PENDING_MINT_TOKEN` | interpolado do host/`.env` | gateway | Credencial para as rotas internas de pending/atestado do pipeline server-side; manter fora do repositório. |
| `TED_WORKSPACE_DELETION_SERVICE_TOKEN` | interpolado do host/`.env` | gateway | Credencial de serviço para atestação de exclusão de workspace; manter fora do repositório. |

As flags de confirmação/autoexecução e as credenciais dedicadas de autoexecução de categoria foram **removidas**: o runtime não as lê mais e não há mais alternância por variável de ambiente. Se alguma delas ainda existir no ambiente do host, não tem efeito e pode ser descartada na próxima manutenção da configuração.

O gateway não expõe mais as RPCs `pending-operations/propose|active|decision`; somente as RPCs de `undo` continuam servidas pelo `apps/ted-runtime`. A remoção das tools `correct_pending_proposal` e `cancel_pending_proposal` acompanha essa mudança.

## Evidência histórica (anterior à remoção da aprovação)

Os registros abaixo descrevem o fluxo **com** aprovação/autoexecução e não validam o comportamento vigente do branch:

- Reconciliação V2.1 (2026-11-19): PRs **#455–#459** integrados; **P5 PASS** e **Jornada C PASS 4/4** em ambiente sintético com LLM real — validação de harness/runtime controlado, não de produção.
- Smoke autenticado em produção (2026-11-20, Test Family): **PASS** — login, conta, transação, extrato, TED lendo dado real e mutação por proposta com recibo único (`live-mobile-full`, 0 violações de workspace); `categories.create` por autoexec confirmado a partir do 2º turno da conversa (sem card; categoria lida como ativa pelo TED).
- Memória de categoria validada em produção (2026-11-20, Test Family): correção Lanche→Padaria aprendida e aplicada em conversa nova (gateway `bab19db`, PRs #463–#466). Preferência genérica não é persistida por desenho.
- Histórico (2026-11-18): gateway com autoexecução de categoria desligada; não havia cliente de autoexecução e `categories.create` autoexec não estava ativa.
- A0 (`apps/agent`) descontinuado em 2026-11-17; `apps/ted-runtime` é o único runtime conversacional. #245 é manutenção futura, não pré-requisito da V2.1.

## Publicar / alterar configuração no compose

Antes de qualquer redeploy, faça backup da configuração (`docker-compose.yml` e `opencode.json`). `writeTedConfig` reescreve configurações geradas por versões anteriores com qualquer combinação de `p3Writes`, `productPrompt` e `categoryMemory`; um override nativo legítimo de `model` é preservado, enquanto edições arbitrárias e symlinks continuam recusados.

1. Confirme no host as variáveis efetivas, o SHA da imagem e a tag de rollback `ted-runtime:rollback-pre-<sha>`.
2. Redeploy do gateway com o compose versionado; verifique health, boot limpo (sem falhas de `writeTedConfig`) e o catálogo efetivo dentro do container.
3. Registre evidência real. Não reivindique validação de produção a partir de teste sintético.
4. Nunca registre credenciais no repositório, em logs ou em relatórios.

### Rollback

Com a remoção da flag, **não existe mais "desligar variável"**: o rollback é **redeploy da imagem `ted-runtime:rollback-pre-<sha>`**, identificada pelo SHA publicado antes da mudança. A API, o ledger e os dados financeiros não são alterados; apenas o runtime volta à versão anterior. Para desfazer uma operação já executada, use o `undo` — não a reversão de imagem.

Lição de deploy (2026-11-20): mudar o texto do system prompt altera o `opencode.json` gerado; antes do #466 isso derrubava o boot (loop de reinício, rollback via tag `ted-runtime:rollback-pre-*`). O código-fonte na VPS é uma cópia (sem git): ao atualizar, remova arquivos que saíram do repositório.

## Valores no compose TED Runtime

O `docker/ted-runtime/docker-compose.yml` define:

- `TED_OPENCODE_P3_READS_ENABLED=1` e `TED_OPENCODE_P3_WRITES_ENABLED=1`: leituras e tools de ação.
- `TED_OPENCODE_PRODUCT_PROMPT_ENABLED=1`: inclui as instruções de produto.
- `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1`: memória local e recall de categoria.
- `TED_PENDING_MINT_TOKEN` e `TED_WORKSPACE_DELETION_SERVICE_TOKEN`: credenciais opcionais no compose, mas necessárias para as rotas internas de pending/atestado e exclusão de workspace. Sem elas, essas rotas falham fechado. Nunca registre valores no repositório.

Não há mais variáveis de confirmação pelo agente nem de autoexecução de categoria no compose.

## Validação

```bash
pnpm --dir apps/ted-runtime test
pnpm --dir apps/ted-runtime typecheck
pnpm --dir apps/ted-runtime lint
pnpm test:p2d-offline
pnpm check:area
```

Use sempre o workspace sintético `550e8400` (Test Family). **Nunca use `junio`**, que contém dados reais. Confirme que a resposta do chat traz recibo/estado terminal sem card de aprovação, que dados faltantes ou ambiguidade geram pergunta em texto e que o `undo` continua funcionando. `test:p2d-live-real` usa modelo real (OpenCode Go / DeepSeek V4.1 Flash) e não autoriza produção ou canary.

## Invariantes

- A API é a única autoridade de escrita: autenticação, autorização por workspace, Pending V2 interno, idempotência, recibo e undo permanecem server-side.
- O modelo nunca recebe credencial, capability, hash de proposta ou `operationId`; a declaração de completude é metadado, não autoridade.
- Resultado incerto (`unverified`, `approval.execution_uncertain`) nunca vira sucesso.
- Nunca grave segredo em Git, log ou relatório.
- Rollback de runtime: redeploy de `ted-runtime:rollback-pre-<sha>`; recuperação de efeito financeiro: `undo`.

## Referências

- [ADR-034 — Agente TED executa sem aprovação](../adr/ADR-034-agente-executa-sem-aprovacao.md) (vigente).
- [ADR-033 — Confirmação de Pending V2 feita pelo agente](../adr/ADR-033-agente-confirma-pending-v2.md) (superseded).
- [Plano de 2026-11-20](../plans/2026-11-20-ted-agent-self-confirm/PLAN.md) (nota de status).

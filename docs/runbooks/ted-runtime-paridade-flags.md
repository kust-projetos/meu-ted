# Runbook — Paridade de flags do TED Runtime

O PR #407 foi mergeado com CI verde; a emenda ao ADR-031, datada de
2026-11-16, descreve esta paridade. As flags são `default-off` no runtime.
O compose de produção habilita explicitamente prompt e memória de categoria;
a autoexecução abaixo foi ativada com autorização do operador após homologação
P5. Este runbook não autoriza novas alterações de capacidade.

## Estado efetivo observado (2026-11-19)

Reconciliação V2.1 (2026-11-19, fatos operacionais): PRs **#455–#459** integrados;
**P5 PASS** e **Jornada C PASS 4/4 em ambiente sintético com LLM real**. Isso
valida o harness/runtime em ambiente controlado — **não** é validação em produção.
**Smoke autenticado em produção (2026-11-20, Test Family): PASS** — login, conta, transação, extrato, TED lendo dado real e mutação por proposta com recibo único (`live-mobile-full`, 0 violações de workspace); `categories.create` por autoexec confirmado a partir do 2º turno da conversa (sem card; categoria lida como ativa pelo TED). Memória de categoria e preferência genérica entre sessões **não** validadas em produção (preferência genérica não é persistida por desenho). A0 (`apps/agent`) descontinuado em 2026-11-17;
`apps/ted-runtime` é o único runtime conversacional. #245 é manutenção futura,
não pré-requisito da V2.1.

- Histórico (2026-11-18): gateway com `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`;
  não havia cliente de autoexecução e `categories.create` autoexec não estava ativa.
- Estado atual (2026-11-19): gateway `ted-runtime:main` na imagem
  `80e4a22f…` (correção #442), boot limpo; `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=1`
  desde 2026-11-19, ativada com autorização do operador após homologação P5
  (proposta 50 → correção 55 → confirmação → execução única → replay
  idempotente, PR #456). Autoexecução está ativa apenas para `categories.create`;
  `TED_RUNTIME_AUTOEXEC_MINT_TOKEN` está ausente e o token dedicado de categoria
  está provisionado. Não registrar valores de credenciais. A API é a autoridade.
- API inalterada: `TED_RISK_BASED_AUTOEXECUTE=on`,
  `PENDING_V2_SUPERSEDE_ENABLED=1` e
  `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1`.
- Antes de qualquer redeploy ou mudança de flag, faça backup da configuração. `writeTedConfig` reconhece configurações geradas por versões anteriores com qualquer combinação de `p3Writes`, `productPrompt` e `categoryMemory` e as reescreve conforme as flags solicitadas; assim, uma transição não falha fechado apenas por existir um `opencode.json` gerado desatualizado. Um override nativo legítimo de `model` continua preservado. Edições arbitrárias do usuário e symlinks continuam recusados, sem sobrescrita/seguimento. Qualquer mudança de flag requer autorização explícita do operador.
- Rollback: backup `docker-compose.yml.bak-pre-category-flip` restaura a
  configuração anterior (flag `0`); também é possível usar
  `ted-runtime:rollback-pre-9dc5d1c`. A Jornada C passou (**4/4**) em ambiente
  sintético com LLM real após o flip; o smoke autenticado em produção passou em
  2026-11-20 (Test Family).
- O gateway de produção não tem o fetch guard live-real do harness; as
  correções do PR #456 são apenas do harness/runtime de teste e não rodam em
  produção.

## Publicar / alterar a flag no compose

O `docker/ted-runtime/docker-compose.yml` interpola a variável com default
seguro: `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED: ${TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED:-1}`.
O default `1` preserva o valor efetivo já autorizado na VPS — um deploy sem a
variável definida no host **não** desliga a capacidade por acidente. Para mudar
o valor, **nunca edite o compose versionado**: defina
`TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` no ambiente do host ou no `.env` usado
pelo `docker compose`, com autorização explícita do operador.

Sequência para publicar/alterar (sempre com autorização do operador):

1. Faça backup da configuração atual (`docker-compose.yml` e `opencode.json`).
2. Confirme no host o valor desejado (`1` = ativo; `0` = intent-only), o SHA da
   imagem e a tag de rollback `ted-runtime:rollback-pre-9dc5d1c`.
3. Redeploy do gateway com o compose versionado; verifique health, boot limpo
   (sem as falhas de `writeTedConfig`) e a flag efetiva dentro do container.
4. Registre evidência real. Smoke autenticado em produção PASS em 2026-11-20
   (Test Family); memória de categoria segue validada só em ambiente sintético.

**Rollback (voltar para `0`):** defina
`TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0` no host/`.env` e redeploy. O runtime
volta ao comportamento `intent-only` (`categories.create` propõe, não executa);
API, ledger e dados não são alterados. Em caso de emergência, use também o
backup `docker-compose.yml.bak-pre-category-flip` ou a tag
`ted-runtime:rollback-pre-9dc5d1c`. Nunca registre credenciais no repositório.

## Flags e escopo

| Nome | Habilitar com | Escopo | Efeito |
| --- | --- | --- | --- |
| `TED_OPENCODE_PRODUCT_PROMPT_ENABLED` | `1` | processo TED Runtime | Inclui o system prompt de produto. |
| `TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED` | `1` | processo TED Runtime | Valida nome e deduplica em `propose_category_create`; proposta assistida, sem autoexecução. |
| `TED_OPENCODE_SUPERSEDE_DETECTION_ENABLED` | `1` | processo TED Runtime | Detecta internamente uma correção. |
| `TED_OPENCODE_CATEGORY_MEMORY_ENABLED` | `1` | processo TED Runtime | Habilita store SQLite local e tool de recall. |
| `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` | `1` | processo TED Runtime + API elegível | Permite autoexecução de categoria, atualmente apenas `categories.create`, via API. |
| `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN` | credencial, não flag; mínimo de 32 caracteres | perfil/ambiente do processo-filho | Credencial dedicada à jornada de categorias; usa `mintPath='/auth/agent/category-autoexec-token'` e o header `x-agent-category-autoexec-service-token`. O token global `TED_RUNTIME_AUTOEXEC_MINT_TOKEN` permanece ausente. Nunca grave credenciais em repositório ou instruções. |

### Valores no compose TED Runtime

O `docker/ted-runtime/docker-compose.yml` define:

- `TED_OPENCODE_PRODUCT_PROMPT_ENABLED=1`: inclui as instruções de produto.
- `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1`: habilita memória local e recall.
- `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED`: interpolado como
  `${TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED:-1}` (default `1` = ativo, valor
  efetivo na VPS por autorização do operador); não habilita outras categorias.
  Sobrescreva no host/`.env` com `0` para rollback — veja "Publicar / alterar a
  flag no compose" acima.
- `TED_PENDING_MINT_TOKEN` e `TED_WORKSPACE_DELETION_SERVICE_TOKEN` são
  credenciais opcionais no compose, mas necessárias para o corte das rotas de
  pending/atestado. Sem elas, essas rotas falham fechado. Nunca registre seus
  valores no repositório.

## Pré-requisitos para autoexecução

Antes de habilitar `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED`, confirme:

- A API tem `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED` habilitada e
  `TED_RISK_BASED_AUTOEXECUTE` em modo diferente de `off`/`shadow`.
- O emissor dedicado `POST /auth/agent/category-autoexec-token` está
  disponível para a jornada de categorias.
- O operador provisionou `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN`; injete-a
  por perfil/ambiente no processo-filho, nunca no repositório, logs ou
  instruções. A jornada não usa credencial/token global.
- A API permanece a única autoridade de execução. O modelo nunca vê
  capability, token ou `operationId`.

## Habilitação e validação

Use sempre o workspace sintético `550e8400` (Test Family). **Nunca use
`junio`**, que contém dados reais.

Habilite e valide nesta ordem, uma capacidade por vez:

1. Prompt de produto.
2. Autocreate assistido (sem autoexecução).
3. Detecção de correção/supersede.
4. Memória local e recall.
5. Autoexecução, somente após cumprir todos os pré-requisitos.

Após cada alteração, rode as verificações aplicáveis:

```bash
pnpm --dir apps/ted-runtime test
pnpm --dir apps/ted-runtime typecheck
pnpm --dir apps/ted-runtime lint
pnpm test:p2d-offline
pnpm check:area
```

Confirme que a capacidade habilitada apresenta seu efeito esperado e que o
payload/config permanecem idênticos ao baseline com a respectiva flag `off`.
`test:p2d-live-real` passa com modelo real (OpenCode Go / DeepSeek V4.1 Flash),
com duas leituras financeiras, zero escritas e guard sem bloqueios funcionais.
A evidência está em `apps/pwa/test-results/p2d-live-real/evidence.json`. Isso
valida o teste, mas não autoriza produção ou canary: a credencial de serviço e
as flags ainda exigem autorização e provisionamento pelo operador.

## Invariantes e rollback

- O dono da conversa é o pin B. Garantir execução única pela chave SHA-256
  `workspace:intentionId:categories.create`; o LLM não recebe autoridade para
  executar operações. Em falha, fechar para proposta pendente.
- Nunca gravar segredo em Git, log ou relatório.
- Para reverter, desligue a flag correspondente: retorna ao comportamento
  anterior. No caso da autoexecução, volta a `intent-only`. A API e o ledger
  não são alterados por esse rollback.

## Pendências operacionais

- Histórico: a Jornada C foi homologada em ambiente sintético com LLM real
  (**PASS 4/4**), assim como P5 (**PASS**, PRs #455–#459). **Smoke autenticado em produção (2026-11-20, Test Family): PASS** — login, conta, transação, extrato, TED lendo dado real e mutação por proposta com recibo único (`live-mobile-full`, 0 violações de workspace); `categories.create` por autoexec confirmado a partir do 2º turno da conversa (sem card; categoria lida como ativa pelo TED). Memória de categoria e preferência genérica entre sessões **não** validadas em produção (preferência genérica não é persistida por desenho).

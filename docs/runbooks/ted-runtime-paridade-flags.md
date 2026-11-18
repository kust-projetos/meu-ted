# Runbook — Paridade de flags do TED Runtime

O PR #407 foi mergeado com CI verde; a emenda ao ADR-031, datada de
2026-11-16, descreve esta paridade. As flags são `default-off` no runtime;
o compose de produção habilita explicitamente prompt e memória de categoria,
mantendo autoexecução desligada. Este runbook não autoriza produção: qualquer
alteração de capacidade exige autorização explícita e validação prévia.

## Estado efetivo observado (2026-11-18)

- Gateway: `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`, `TED_OPENCODE_PRODUCT_PROMPT_ENABLED=1`, `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1`, `TED_OPENCODE_P3_READS_ENABLED=1` e `TED_OPENCODE_P3_WRITES_ENABLED=1`. O token dedicado de categoria está set; `TED_RUNTIME_AUTOEXEC_MINT_TOKEN` está unset. Não registrar valores de credenciais.
- API: `TED_RISK_BASED_AUTOEXECUTE=on` (preexistente), `PENDING_V2_SUPERSEDE_ENABLED=1` e `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1`. Com a flag do gateway em `0`, não há cliente de autoexecução; `categories.create` autoexec não está ativa.
- Em redeploy que altere configuração gerada, faça primeiro backup e remova o `opencode.json` stale; caso contrário `writeTedConfig` falha fechado por conteúdo divergente e o container reinicia. Qualquer mudança de flag requer autorização explícita do operador.

## Flags e escopo

| Nome | Habilitar com | Escopo | Efeito |
| --- | --- | --- | --- |
| `TED_OPENCODE_PRODUCT_PROMPT_ENABLED` | `1` | processo TED Runtime | Inclui o system prompt de produto. |
| `TED_OPENCODE_CATEGORY_AUTOCREATE_ENABLED` | `1` | processo TED Runtime | Valida nome e deduplica em `propose_category_create`; proposta assistida, sem autoexecução. |
| `TED_OPENCODE_SUPERSEDE_DETECTION_ENABLED` | `1` | processo TED Runtime | Detecta internamente uma correção. |
| `TED_OPENCODE_CATEGORY_MEMORY_ENABLED` | `1` | processo TED Runtime | Habilita store SQLite local e tool de recall. |
| `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` | `1` | processo TED Runtime + API elegível | Permite autoexecução da categoria via API, sujeita aos pré-requisitos abaixo. |
| `TED_RUNTIME_AUTOEXEC_MINT_TOKEN` | credencial, não flag; mínimo de 32 caracteres | perfil/ambiente do processo-filho | Credencial de serviço usada para obter token de autoexecução; nunca a grave em repositório ou instruções. |

### Valores no compose TED Runtime

O `docker/ted-runtime/docker-compose.yml` define:

- `TED_OPENCODE_PRODUCT_PROMPT_ENABLED=1`: inclui as instruções de produto.
- `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1`: habilita memória local e recall.
- `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`: criação automática permanece
  desligada; exige autorização de operador.
- `TED_PENDING_MINT_TOKEN` e `TED_WORKSPACE_DELETION_SERVICE_TOKEN` são
  credenciais opcionais no compose, mas necessárias para o corte das rotas de
  pending/atestado. Sem elas, essas rotas falham fechado. Nunca registre seus
  valores no repositório.

## Pré-requisitos para autoexecução

Antes de habilitar `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED`, confirme:

- A API tem `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED` habilitada e
  `TED_RISK_BASED_AUTOEXECUTE` em modo diferente de `off`/`shadow`.
- O endpoint `POST /auth/agent/autoexec-token` está disponível.
- O operador provisionou a credencial de serviço; injete-a por perfil/ambiente
  no processo-filho, nunca no repositório, logs ou instruções.
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

- Não permitir dupla execução entre A0 e B: ownership pertence ao pin B,
  usando a chave SHA-256 `workspace:intentionId:categories.create`.
- Não desligar A0 nem alterar roteamento. O LLM não recebe autoridade para
  executar operações. Em falha, fechar para proposta pendente.
- Nunca gravar segredo em Git, log ou relatório.
- Para reverter, desligue a flag correspondente: retorna ao comportamento
  anterior. No caso da autoexecução, volta a `intent-only`. A API e o ledger
  não são alterados por esse rollback.

## Pendências operacionais

- Provisionamento da credencial pelo operador.
- Autorização explícita para canary/deploy; este runbook não a concede.

# Meu TED — SPEC V4: Hardening, Simplificação e Descomissionamento Pós-V3

**Status:** Proposed (rev. 2 — revisão REV-V4-2 aplicada; ver §31.4)
**Data:** 2026-09-15
**Baselines:** *Production Code Baseline* `3305152` (código V3 efetivamente implantado — API `v3-3305152` na VPS com migration `V052`, PWA `a5ff2b4a` e Agent `0e557bba` no Cloudflare) · *Repository/Planning Baseline* `5733cc8` (HEAD de planejamento, documentação pós-deploy; revalidar o HEAD vigente antes de criar a branch de execução — §31.4)
**Escopo:** Hardening de segurança, confiabilidade integrada, redução de superfície legada e consolidação operacional
**Prioridade:** P1–P3
**Princípio central:** preservar a arquitetura financeira consolidada na V3; corrigir bordas e remover legado sem reconstruir o núcleo.
**Plano de execução:** [`docs/superpowers/plans/2026-09-15-meu-ted-v4-hardening.md`](superpowers/plans/2026-09-15-meu-ted-v4-hardening.md)

---

## 1. Contexto

A V3 consolidou os principais invariantes financeiros do Meu TED:

- API é a única autoridade financeira.
- O Agent interpreta e orquestra, mas não possui autoridade direta sobre o banco.
- Mutações financeiras utilizam contratos determinísticos.
- Aprovações são persistidas e vinculadas à proposta original.
- Confirmação não pode alterar a semântica da operação.
- Execução utiliza idempotência, receipts e reconciliação.
- A PWA não recebe attestation financeira.
- Cards de aprovação são reconstruídos a partir do estado autoritativo.
- Grounding financeiro opera em modelo fail-closed.
- Service Worker não armazena HTML financeiro ou respostas de API autenticadas.
- Migrations de produção são executadas por processo dedicado.

A auditoria pós-V3 não identificou necessidade de uma nova reconstrução arquitetural.

A V4 deve, portanto, tratar o sistema como uma arquitetura válida que precisa ser endurecida, simplificada e consolidada.

## 2. Problema

Apesar da arquitetura financeira principal estar correta, permanecem riscos nas bordas do sistema. Os principais problemas encontrados (todos verificados contra o código em REV-V4-1, §31):

1. A PWA implementa gravação de áudio com `getUserMedia`, mas a política HTTP global bloqueia o próprio microfone (`Permissions-Policy: microphone=()` em `apps/pwa/src/proxy-utils.ts:18`), enquanto o botão de gravação é renderizado incondicionalmente (`apps/pwa/src/features/ted/TedChat.tsx:764-771`).
2. Credenciais reutilizáveis continuam acessíveis ao JavaScript por meio de localStorage (`pi-finance:session-token` e `pi-finance:token`, `apps/pwa/src/lib/api/client.ts:73-91`, `apps/pwa/src/lib/auth/token-store.ts`).
3. Device tokens são persistidos **em claro** no banco (`token TEXT PRIMARY KEY`, `apps/api/src/read-models/sql/V001__init.sql:84-90`) e não possuem lifecycle completo (sem `last_used_at`/`expires_at`).
4. O WorkspaceAgent legado ainda existe no runtime Cloudflare ao lado do FinanceChatAgent (binding `AGENT`, `apps/agent/wrangler.jsonc:9`; rota `/agents/workspace/*`, `apps/agent/src/worker.ts:251`).
5. Rotas de compatibilidade antigas ainda fazem parte do deploy (re-roteamento `/message` → `/rpc/chat`, `apps/agent/src/worker.ts:280-317`).
6. O caminho de Undo **in-memory** (dev/teste) persiste o resultado de idempotência fora de transação (`apps/api/src/writes/idempotency.ts:139-140`); o caminho Postgres já é atômico (REV-V4-1, correção F-1) — falta prova por injeção de crash e paridade entre stores.
7. Exceções destinadas a desenvolvimento, como confiança em localhost, seguem presentes no proxy da PWA sem gate de ambiente (spoof de `Origin` para hosts locais em `apps/pwa/src/app/api/backend/[...path]/route.ts:39-43` e `apps/pwa/src/app/api/agent/[...path]/route.ts:41-45`, aplicado também em build de produção). A API em si já rejeita localhost em produção (`apps/api/src/env.ts:100-108`).
8. A CSP ainda permite comunicação direta do browser com a API e o Agent (`connect-src 'self' https://api.synkroo.com.br https://pi-finance-agent...workers.dev`, `apps/pwa/src/proxy-utils.ts:52-55`) enquanto `apps/pwa/wrangler.jsonc:29` fixa a URL direta da API, contradizendo a topologia same-origin documentada (ADR-011).
9. O comportamento offline permite acesso local quando a sessão não pode ser revalidada remotamente, mas não existe política explícita de validade offline (`lastOnlineAuthenticatedAt` não existe no PWA; `readV2Snapshot` não checa idade, `apps/pwa/src/lib/state/snapshot-db.ts:207-230`).
10. O CI remoto do SHA implantado não foi executado devido a bloqueio externo do GitHub Actions (billing).
11. Artefatos e instruções legadas no repositório contradizem a arquitetura canônica atual (`.pi/AGENTS.md:1-5` descreve o Agent Pi como cérebro financeiro e o whatsapp-bridge como ativo).
12. Alguns módulos acumulam responsabilidades demais e aumentam o risco de regressões cruzadas (`app-state-context.tsx` com 2.121 linhas; `TedChat.tsx` com 808 linhas).

## 3. Objetivo da V4

A V4 deve transformar os principais pressupostos arquiteturais da V3 em garantias técnicas adicionais. Ao final desta SPEC:

- o microfone deve funcionar de verdade em navegador real;
- credenciais de sessão normais não devem depender de secrets persistidos em localStorage;
- device tokens devem possuir armazenamento e lifecycle mais seguros;
- o runtime do Agent deve convergir para uma única implementação;
- o Undo deve ter garantia transacional **provada por teste de crash** em PostgreSQL real, com paridade entre stores;
- produção não deve carregar exceções de desenvolvimento desnecessárias;
- a CSP deve reforçar a topologia real do sistema;
- o modo offline deve possuir política explícita de segurança;
- CI, deploy e documentação devem refletir o runtime real;
- legado morto deve ser removido ou arquivado fora do caminho operacional;
- novos testes devem validar integrações entre subsistemas, não apenas cada módulo isoladamente.

## 4. Não objetivos

A V4 NÃO deve:

- substituir Fastify;
- substituir PostgreSQL;
- substituir Cloudflare Workers;
- substituir Durable Objects;
- substituir Next.js;
- reconstruir FinanceChatAgent;
- criar um novo protocolo de Pending Operations;
- substituir MutationReceipt;
- substituir o MutationReconciler;
- reintroduzir write direto pelo Agent;
- reintroduzir [EXEC_ACTION];
- permitir execução financeira pelo browser;
- mover regra financeira para a PWA;
- criar microserviços adicionais sem necessidade;
- reescrever a interface visual inteira;
- refazer funcionalidades apenas por preferência técnica;
- alterar contratos financeiros estáveis sem necessidade demonstrável.

Refatorações devem ser incrementais e justificadas por redução de risco, não por estética.

## 5. Arquitetura alvo

A topologia desejada permanece:

```
Usuário
   │
   ▼
PWA
   │
   ├──── Same-Origin BFF / Proxy
   │            │
   │            ├──── API Financeira
   │            │
   │            └──── FinanceChatAgent
   │
   ▼
FinanceChatAgent
   │
   ▼
API Financeira
   │
   ▼
PostgreSQL
```

Autoridades:

- **PWA** → autoridade de interação e apresentação.
- **FinanceChatAgent** → autoridade de interpretação e orquestração conversacional.
- **API** → autoridade de autenticação financeira, autorização, validação, regras de negócio e mutação.
- **PostgreSQL** → fonte persistente da verdade financeira.

Nenhuma fase da V4 pode alterar essa divisão.

## 6. Invariantes obrigatórios

### INV-01 — Autoridade financeira única

Toda mutação financeira deve continuar passando pela API autoritativa. Nem PWA, nem Agent, nem Durable Object podem possuir acesso direto ao banco financeiro.

### INV-02 — Sem execução implícita por LLM

Texto produzido pelo modelo não pode, isoladamente: criar, editar, excluir, confirmar, cancelar ou reverter qualquer entidade financeira. Toda ação continua dependendo de contratos determinísticos.

### INV-03 — Confirmação semanticamente vinculada

A confirmação deve continuar vinculada à proposta que o usuário visualizou. Nenhuma mudança desta SPEC pode enfraquecer hash, bindings, attestation, idempotência ou validações existentes.

### INV-04 — Browser sem autoridade financeira

O navegador pode solicitar uma operação, confirmar intenção e apresentar estado. Ele nunca pode produzir credenciais capazes de autorizar uma mutação financeira sem validação server-side.

### INV-05 — Credenciais reutilizáveis minimizadas

Secrets de longa duração não devem permanecer acessíveis ao JavaScript do browser quando houver alternativa com cookies HttpOnly.

### INV-06 — Offline nunca concede nova autoridade

Modo offline pode apresentar informações previamente sincronizadas. Modo offline nunca pode: elevar permissões, criar uma nova sessão, executar mutações financeiras, restaurar autorização revogada sem comunicação com o servidor.

### INV-07 — Um único pipeline financeiro do Agent

Após a conclusão do descomissionamento, FinanceChatAgent deve ser o único runtime de conversação financeira ativo. WorkspaceAgent não pode permanecer como pipeline alternativo.

### INV-08 — Segurança não pode quebrar capability declarada

Uma feature disponível ao usuário não pode ser bloqueada pelas próprias políticas do navegador. Exemplo: microphone UI ativo + `Permissions-Policy microphone=()` deve ser considerado violação de arquitetura e detectado automaticamente.

### INV-09 — Dev e produção possuem trust boundaries distintas

Exceções de desenvolvimento, incluindo localhost, devem existir somente em ambientes em que forem necessárias.

### INV-10 — Teste verde não basta isoladamente

Capabilities que atravessam múltiplas camadas devem possuir pelo menos um teste integrado que valide a combinação real. Exemplos: header HTTP + browser API; cookie + proxy + backend; Agent gateway + Durable Object; receipt + reconciler + UI.

## 7. BLOCO A — Correção funcional do microfone

**Prioridade:** P1. **Bloqueante para fechamento da V4:** Sim.

### A1. Corrigir Permissions Policy

A política da PWA deve permitir microfone para o próprio origin quando a capability estiver habilitada. Estado esperado: `microphone=(self)` ou configuração equivalente tecnicamente correta. Não habilitar microfone para origins externos. Camera e geolocation devem continuar bloqueados se não forem utilizados.

**Contexto REV-V4-1:** hoje `SECURITY_HEADERS` em `apps/pwa/src/proxy-utils.ts:18` fixa `microphone=()`, e o teste `apps/pwa/src/__tests__/proxy.test.ts:39-41` trava esse valor — ambos precisam mudar juntos. Não existe capability flag de microfone (`NEXT_PUBLIC_TED_ATTACHMENT_INGESTION` cobre apenas anexos, `apps/pwa/src/lib/capabilities.ts:34`); a flag de mic deve ser criada neste bloco.

### A2. Teste de contrato da política

Adicionar teste garantindo que: TED microphone enabled → `Permissions-Policy` permite self; e TED microphone disabled → política pode bloquear microphone. O teste deve validar a **relação entre capability e header**, e não apenas verificar a existência do header.

### A3. E2E real

Criar Playwright E2E com browser configurado para mídia fake. O teste deve verificar: idle → click microphone → requesting → recording → stop → attachment/resultado gerado. Também validar: permission denied → error → nenhuma gravação fantasma.

### A4. Critério de aceitação

A feature só pode ser marcada como concluída quando funcionar em Chromium real com a política HTTP usada pelo build Cloudflare. Mocks unitários isolados não são suficientes.

## 8. BLOCO B — Autenticação cookie-first

**Prioridade:** P2 alta. **Objetivo:** retirar secrets de sessão normal do localStorage.

### B1. Modelo alvo

Fluxo preferencial: Browser → cookie HttpOnly/Secure → PWA same-origin proxy → API. A PWA deve continuar usando `credentials: include` (já presente, `apps/pwa/src/lib/api/client.ts:172`).

### B2. Remover duplicação de persistência

Eliminar gravações redundantes executadas diretamente pelo AuthGate (`apps/pwa/src/features/auth/AuthGate.tsx:68-87`) e pela página de convite (`apps/pwa/src/app/convite/page.tsx:183-194`). O armazenamento de sessão deve possuir uma única abstração. Durante a migração pode existir compatibilidade temporária, mas deve possuir: data de remoção, teste, telemetria e caminho de limpeza (a janela ADR-011/T5.4 com review em 2026-12-01 é o prazo de referência).

### B3. Migração gradual

Não remover tokens antigos de forma abrupta. **O cookie HttpOnly de sessão já é emitido hoje pela API (Better-Auth — evidência §31.4); a V4 não cria segundo mecanismo de emissão, sistema de login paralelo ou sessão nova para cumprir esta SPEC.** Sequência:

1. aceitar cookie existente + bearer legado
2. validar o transporte do cookie existente através do proxy same-origin
3. tornar cookie/session o caminho primário
4. medir uso efetivo do fallback bearer legado (requests autenticadas pelo fallback — T0.4.1 do plano)
5. remover leitura de bearer do localStorage
6. remover escrita de bearer no localStorage
7. remover fallback bearer server-side

### B4. Compatibilidade offline — identidade offline (`offlineSubjectId`)

A remoção de bearer do localStorage não pode quebrar a associação do snapshot ao usuário — e a associação **não pode depender da própria credencial** que será removida ou rotacionada (B3 passos 5–7).

**Estado alvo (REV-V4-2):** a PWA mantém um identificador offline:

```
offlineSubjectId
```

Propriedades obrigatórias: opaco; estável para o usuário/contexto; não secreto; não autenticador; persistível localmente; **não derivado de bearer/session token/device token**; a posse do identificador não concede acesso à API; não substitui autenticação; não permite recuperar credencial alguma; serve exclusivamente para particionar e localizar estado offline.

Fluxo conceitual:

```
autenticação online válida
→ contexto autenticado fornece subject não autenticador
→ PWA persiste offlineSubjectId
→ snapshot é associado ao offlineSubjectId
```

**Identificador concreto (evidência REV-V4-2):** `offlineSubjectId` **reutiliza o id do workspace/household ativo** já mantido pela PWA (`apps/pwa/src/lib/api/workspaces.ts:30-36`; `workspace-context.tsx:146,180`) — UUID estável (criado uma vez em `V020`, sem caminho de regeneração), opaco, não secreto, não autenticador, e já alinhado à partição financeira (`household_id`) e ao `X-Workspace-Id`. IDs de usuário isolam mal em workspaces compartilhados; `deviceId` e tokens são credenciais ou rotacionáveis — proibidos como subject. Nada novo é criado.

**Superação da REV-V4-1 (F-4):** o `ownerFingerprint` (`apps/pwa/src/lib/state/snapshot-db.ts:95-102`) é SHA-256 do **device token cru** — deriva de credencial e quebra quando o token sai do localStorage ou é rotacionado. Pode permanecer como camada adicional de defesa, nunca como chave primária de partição. Snapshots antigos keyados por fingerprint são migrados por re-sincronização (o snapshot é cache re-sincronizável; zero perda de dado financeiro). Nunca persistir a sessão HttpOnly em IndexedDB.

### B5. Critério de aceitação

Em produção, `localStorage` não deve conter token capaz de autenticar diretamente uma sessão normal na API.

## 9. BLOCO C — Device Token Hardening

**Prioridade:** P2.

### C1. Token aleatório

O secret do device token não deve carregar householdId como parte necessária do segredo (`device-token.ts:63-64` grava `tok = householdId.uuid`). Preferir token aleatório criptograficamente seguro.

### C2. Hash em repouso

O banco deve persistir somente representação não reutilizável do segredo. Exemplo aceitável: token enviado pelo cliente → SHA-256/HMAC → `token_hash` persistido. O valor original não deve ficar recuperável pelo banco. Estado atual: `token TEXT PRIMARY KEY` em claro (`V001__init.sql:84-90`; `V003__legacy_safe_tables.sql:6-12`). Precedente no repo: invites já usam `token_hash` (`apps/api/src/auth/invites-postgres.ts:65`).

### C3. Lifecycle

Adicionar metadados mínimos: `device_id`, `user_id`, workspace/household binding quando aplicável, `name`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`, `token_hash`. Estado atual: só `created_at` + `revoked_at` (`V001__init.sql:88-89`).

### C4. Rotação

A arquitetura deve suportar: novo token → período controlado de transição → revogação do anterior. Nunca permitir dois tokens eternamente válidos sem necessidade.

### C5. SQL

Remover condições tautológicas ou ambíguas como `household_id = household_id`. Queries de autenticação devem possuir escopo explícito. **Escopo ampliado por REV-V4-1** — há 4 pontos, não só em device tokens:

- `apps/api/src/auth/device-token.ts:57` (lookup fallback) e `:71` (revoke fallback);
- `apps/api/src/payables/postgres.ts:580` e `:595` (queries de payables).

### C6. Migração

A migração deve permitir coexistência temporária entre token antigo e novo. Nenhuma migração pode exigir logout global sem necessidade. Próxima versão disponível: `V053` (padrão `VNNN__snake.sql`; máxima atual `V052`).

## 10. BLOCO D — Política de segurança offline

**Prioridade:** P2.

### D1. Definir maxOfflineAge

Persistir o instante da última autenticação online válida: `lastOnlineAuthenticatedAt`, associado ao `offlineSubjectId` (§8.B4). Definir uma janela configurável: `MAX_OFFLINE_AUTH_AGE`.

### D2. Comportamento

Enquanto `now - lastOnlineAuthenticatedAt <= MAX_OFFLINE_AUTH_AGE`, o usuário pode visualizar snapshots offline autorizados. Quando excedido: `offline session locked` e o usuário deve voltar online para revalidar.

### D3. Escritas

Continuar proibindo mutações financeiras offline (`OfflineWriteError`, `apps/pwa/src/lib/state/commands.ts:28-31`). Nenhuma fila local de writes deve ser introduzida nesta SPEC.

### D4. Futuro

Biometria/PIN local pode ser avaliado futuramente, mas não é obrigatório para concluir V4.

## 11. BLOCO E — Descomissionamento definitivo do WorkspaceAgent

**Prioridade:** P2 alta.

### E1. Inventário

Mapear todas as dependências atuais de: WorkspaceAgent, binding `AGENT`, `/agents/workspace/*`, `syncLegacyHistory`, `LegacyAgentStub`. Classificar cada uso como: histórico, export, stream, migração, fallback, morto.

**Inventário REV-V4-1 (baseline `3305152`):**

| Dependência | Classificação | Evidência |
|---|---|---|
| `exportFullWorkspaceHistory` | export/migração | `apps/agent/src/index.ts:452` |
| `syncLegacyHistory` + `importLegacyHistory` | migração | `apps/agent/src/worker.ts:41`; `apps/agent/src/finance-chat-agent.ts:1464` |
| Binding `AGENT` + fallthrough | fallback | `apps/agent/wrangler.jsonc:9`; `apps/agent/src/worker.ts:28,55,327`; `apps/agent/src/index.ts:610` |
| Rota `/agents/workspace/*` history/export/stream/abort | histórico/stream/fallback | `apps/agent/src/worker.ts:251`; `apps/agent/src/index.ts:151-155` |
| Re-roteamento `/message` → `/rpc/chat` | fallback | `apps/agent/src/worker.ts:280-317` |
| `/message/:id/process\|retry` (410) | morto | `apps/agent/src/index.ts:159-161` |
| Helpers legados na PWA (`agentRequestUrl`/`agentHistoryUrl`) | fallback | `apps/pwa/src/lib/api/agent-client.ts:330,335` |
| Testes de compatibilidade + scaffold que trava binding/migration | histórico | `apps/agent/tests/agent-scaffold.test.ts:12-21`; `legacy-history-*` |
| DO migrations `v1`/`v2` + SQL legado | histórico (não remover sem regra da plataforma) | `apps/agent/wrangler.jsonc:14-15`; `apps/agent/migrations/0001_workspace_agent.sql` |

### E2. Migração histórica

Antes da remoção: garantir que históricos necessários estejam importados para FinanceChatAgent; tornar import idempotente; produzir relatório de workspaces ainda dependentes; provar 0 dependências antes do corte definitivo.

### E3. Bloquear novas dependências

Adicionar architecture check que falha se código novo importar ou criar referências a: WorkspaceAgent, `/agents/workspace/`, `env.AGENT` — fora de uma allowlist temporária de migração. Estado atual: `scripts/check-legacy-runtime-references.mjs:8-14` cobre apenas whatsapp-bridge/Evolution/`.pi/extensions` — precisa ser estendido.

### E4. Remoção

Quando dependência = 0:

1. remover rota `/agents/workspace/*`;
2. remover `syncLegacyHistory`;
3. remover WorkspaceAgent exportado;
4. remover binding `AGENT`;
5. remover migration/runtime relacionado (respeitando regras da Cloudflare para tags DO históricas);
6. remover testes específicos de compatibilidade substituídos (inclui atualizar `agent-scaffold.test.ts`);
7. remover tipos `LegacyAgentStub`;
8. atualizar documentação e os helpers legados da PWA (`agent-client.ts:330,335`).

### E5. Rollback

Como Durable Objects possuem estado persistente, o rollback deve ser planejado antes da remoção do binding. Não remover migration tags históricas necessárias à Cloudflare sem confirmar as regras da plataforma.

## 12. BLOCO F — Undo transacional

**Prioridade:** P2.

### F1. Problema (reescrito por REV-V4-1)

**Correção factual:** o caminho de produção (Postgres) **já executa** reversal + `operation_records` + persistência de idempotência dentro da mesma transação (`apps/api/src/writes/postgres.ts:873` — `withTransaction` envolve o producer do undo; claim → producer → complete em `:939-948`). O caminho **in-memory** (dev/teste) persiste o resultado após o producer, sem fronteira atômica (`apps/api/src/writes/idempotency.ts:139-140`). A janela real hoje é: (a) ausência de prova por crash no Postgres; (b) divergência in-memory vs Postgres.

### F2. Estado alvo

A garantia desejada: financial reversal + audit record + idempotency record participando da mesma fronteira atômica sempre que estiverem no mesmo PostgreSQL — **provada por teste**, não assumida por leitura de código.

### F3. Implementação preferencial

Prioridade de solução: 1. mesma transação PostgreSQL; 2. transactional outbox; 3. state machine reconciliável. Não criar distributed transaction.

### F4. Testes obrigatórios

Simular crash em: antes da reversão, durante a reversão, após reversão, antes do commit de idempotência, após commit. Asserir: 0 ou 1 efeito financeiro, e replay convergente. Os testes devem rodar contra PostgreSQL real (mesmo mecanismo do job `postgres` do CI) e a suíte compartilhada deve cobrir os dois stores (in-memory e Postgres), eliminando a divergência documentada em F1.

## 13. BLOCO G — Hardening da borda

**Prioridade:** P2/P3.

### G1. CSP

Após confirmar que todos os fluxos browser→backend passam pelo BFF same-origin: `connect-src 'self'` deve ser o objetivo para produção. Se algum origin externo ainda for necessário, documentar exatamente qual capability depende dele. Estado atual: `connect-src 'self' + api.synkroo.com.br + pi-finance-agent...workers.dev` (`apps/pwa/src/proxy-utils.ts:52-55`); `apps/pwa/wrangler.jsonc:29` fixa `NEXT_PUBLIC_PI_FINANCE_API_BASE_URL` direto, divergindo do proxy documentado.

### G2. Diretivas adicionais

Avaliar e aplicar quando compatível: `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`. Não quebrar assets, OpenNext, PWA ou runtime Cloudflare. Estado atual: `base-uri` e `frame-ancestors` já presentes (`proxy-utils.ts:47-69`); faltam `default-src`/`object-src`/`form-action` explícitos.

### G3. Localhost

Em produção, remover confiança automática em `localhost`/`127.0.0.1`. A allowlist local deve depender de ambiente de desenvolvimento/teste.

**Contexto REV-V4-1:** a API já rejeita localhost em produção com fail-closed (`apps/api/src/env.ts:100-108`; `apps/api/src/server/cors.ts:15-18`). O gap real está nos proxies Next da PWA: spoof de `Origin` e aceitação de hosts locais sem gate de `NODE_ENV` (`apps/pwa/src/app/api/backend/[...path]/route.ts:39-43,47-57,66-71`; `apps/pwa/src/app/api/agent/[...path]/route.ts:41-45,49-59,68-73`) e no CSP dev (`proxy-utils.ts:56-58`, já gated). Corrigir os proxies; alinhar o worker Agent na verificação de CORS.

### G4. Testes

Criar testes que executem configurações separadas (production, development, test) e provem que as fronteiras são diferentes.

## 14. BLOCO H — Consolidação de CI e deploy

**Prioridade:** P2 operacional.

### H1. Restaurar CI remoto

Quando o bloqueio externo do GitHub Actions for resolvido: executar no SHA de produção CI + PWA CI, sem exigir novo commit.

### H2. Paridade

Os mesmos gates considerados obrigatórios localmente devem possuir equivalente remoto sempre que tecnicamente possível.

### H3. Deploy gate

Deploy automático ou manual assistido deve verificar: SHA local = SHA testado = SHA do artefato = SHA implantado.

### H4. Evidência

Registrar: commit SHA, container/image digest, Cloudflare version/deployment id, migration version, timestamp, smoke result, CI run.

### H5. Branch protection

Caso o plano atual do GitHub continue não permitindo ruleset: documentar explicitamente o risco e manter gate operacional equivalente. Não fingir que há proteção automatizada inexistente.

## 15. BLOCO I — Limpeza de legado documental e operacional

**Prioridade:** P3.

### I1. `.pi`

Auditar o conteúdo restante de `.pi/`. Tudo que descreve o antigo Agent Pi como autoridade financeira deve ser removido ou movido para documentação histórica. Confirmado: `.pi/AGENTS.md:1-5` e `:173-176` contradizem a arquitetura atual (Agent Pi como "dono da interpretação, persistência e UI", whatsapp-bridge como ativo). `.pi/extensions/` já não existe.

### I2. AGENTS legados

Nenhum AGENTS.md aninhado pode conter instruções que contradigam a arquitetura vigente. Conteúdo histórico não deve manter o nome AGENTS.md. Destino: `docs/archive/` — **convenção já existente** no repo (`docs/archive/plans/`); usar subárvore dedicada (ex.: `docs/archive/legacy-pi/`).

### I3. Documentos antigos

Documentos históricos devem conter cabeçalho explícito: `STATUS: ARCHIVED — DO NOT USE AS CURRENT ARCHITECTURE`.

### I4. Package metadata

Atualizar descrições que afirmem algo que não corresponda ao runtime atual. **Narrowing REV-V4-1:** nenhuma descrição "demo-backed in-memory / persistence later" foi encontrada em `package.json` dos apps; o único resquício é `apps/api/.env.example:7` ("in-memory store used if not set") — wording a revisar para deixar claro que Postgres é o runtime de produção e o in-memory é fallback de dev/teste.

### I5. Contrato documental

Adicionar teste semântico mínimo garantindo que documentação canônica não contradiga: API = financial authority; FinanceChatAgent = active agent runtime; WhatsApp bridge = removed; Pi financial tools = removed; PostgreSQL = production persistence.

## 16. BLOCO J — Qualidade estática

**Prioridade:** P3.

### J1. Separar lint de typecheck

O gate deve possuir comandos semanticamente distintos: `typecheck` e `lint`. `lint` não pode ser apenas alias de `tsc`. Estado atual (2026-10-02): resolvido — `apps/api` tem `lint` = `biome check src tests` e `typecheck` = `tsc -p tsconfig.build.json --noEmit`, comandos semanticamente distintos.

### J2. Cobertura

Aplicar analisador estático real a `apps/api`, `apps/agent`, `apps/codex-broker`. ESLint, Oxlint, Biome ou equivalente pode ser utilizado. A escolha da ferramenta não faz parte da arquitetura. Estado atual (2026-10-02): resolvido — Biome 2.2.4 ativo em `apps/api`, `apps/agent` e `apps/codex-broker` (`biome check src tests`; formatter/assist desligados; regras selecionadas em `biome.json` na raiz), PWA mantém ESLint 9 (`eslint-config-next` + TypeScript). Cobertura de `packages/llm-contracts` também resolvida (2026-10-04): Biome 2.2.4 (`biome check src`), `tsc --noEmit` e `vitest run` (23 testes) ligados aos agregados da raiz (`lint`, `typecheck`, `test`) e ao job de CI (achado 2 de `docs/reports/2026-10-02-repo-config-audit.md`).

### J3. Categorias mínimas

Detectar: promises não aguardadas, variáveis mortas, branches impossíveis, imports não utilizados, fallthrough, uso inseguro de `any`, async incorreto, padrões suspeitos de comparação, dependências circulares quando viável.

## 17. BLOCO K — Modularização progressiva

**Prioridade:** P3. **Bloqueante:** Não.

Nenhum big-bang refactor é permitido. Extrair progressivamente responsabilidades apenas quando arquivos forem modificados por trabalho real. Candidatos: `app-state-context.tsx` (2.121 linhas) e `TedChat.tsx` (808 linhas). Separações sugeridas: TransactionsState, CardsState, PayablesState, ReconciliationState, TedConversationController, TedAttachmentsController, TedPendingOperationsController, TedRecordingController. A extração não pode alterar comportamento sem teste RED correspondente.

## 18. Testes obrigatórios da V4 — Cross-Layer Invariant Tests

A V4 deve adicionar uma nova categoria: **Cross-Layer Invariant Tests (XLT)**. Ela existe para detectar bugs que passam quando cada módulo é testado isoladamente. Cobertura mínima:

| ID | Cenário |
|---|---|
| XLT-01 | TED mic enabled + built HTTP headers + browser → recording works |
| XLT-02 | login → HttpOnly cookie → same-origin proxy → API authenticated → no reusable localStorage bearer |
| XLT-03 | production config → localhost rejected |
| XLT-04 | development config → localhost allowed |
| XLT-05 | browser → cannot directly reach forbidden backend origin under production CSP |
| XLT-06 | Pós-descomissionamento: PWA → rota canônica do Agent → FinanceChatAgent → histórico/conversa funcionais, com `/agents/workspace/*` ausente do runtime publicado e sem fallback involuntário |
| XLT-07 | undo crash injection → at-most-one financial reversal |
| XLT-08 | offline session > maxOfflineAge → financial snapshot locked |
| XLT-09 | logout → cookie/session invalid → IndexedDB snapshot cleared when required → Agent session cleared |
| XLT-10 | device token database leak → stored value alone cannot authenticate |

Nota REV-V4-2: a tabela contém somente XLT-01..XLT-10. **ARCH-V4-06a/b são architecture checks, não Cross-Layer Invariant Tests** — `ARCH-V4-06a` (consumidores externos = 0, pré-condição da remoção) e `ARCH-V4-06b` (referências estáticas proibidas = 0, com allowlist vazia/expirada — pós-condição), integrados a VAL-V4.9 (§19). Checks estáticos não atravessam camadas reais e não pertencem à categoria XLT. O XLT-06 permanece como teste integrado real do runtime pós-descomissionamento.

## 19. Gates finais

A V4 não pode ser declarada concluída sem:

| Gate | Descrição |
|---|---|
| VAL-V4.1 | frozen install |
| VAL-V4.2 | lint real |
| VAL-V4.3 | typecheck |
| VAL-V4.4 | API tests |
| VAL-V4.5 | Agent tests |
| VAL-V4.6 | PWA tests |
| VAL-V4.7 | Postgres integration |
| VAL-V4.8 | Cross-Layer Invariant Tests |
| VAL-V4.9 | architecture checks (inclui ARCH-V4-06a/b — §18) |
| VAL-V4.10 | write policy |
| VAL-V4.11 | security scan |
| VAL-V4.12 | build all |
| VAL-V4.13 | container smoke |
| VAL-V4.14 | production configuration tests |
| VAL-V4.15 | real browser microphone E2E |
| VAL-V4.16 | production smoke |

Se GitHub Actions estiver indisponível por motivo externo: gates locais devem rodar; o bloqueio remoto deve ser registrado explicitamente; não marcar CI remoto como PASS; reexecutar sobre o mesmo SHA assim que disponível.

## 20. Sequenciamento

- **Fase 0 — Baseline.** Antes de qualquer modificação: registrar SHA, rodar gates atuais, registrar produção, registrar deployments Cloudflare, registrar migration atual. Nenhuma mudança funcional.
- **Fase 1 — Correção P1.** Executar Bloco A (microfone corrigido + E2E real). Deploy pode ocorrer independentemente dos demais blocos.
- **Fase 2 — Segurança da sessão.** Executar B, C, D, G. Ordem sugerida: cookie-first → device token → offline policy → CSP/proxy hardening. Evitar alterar todas as camadas simultaneamente.
- **Fase 3 — Consistência financeira.** Executar F (Undo). Executar contra PostgreSQL real.
- **Fase 4 — Descomissionamento.** Executar E, I. Primeiro provar ausência de dependências. Depois remover legado.
- **Fase 5 — Qualidade.** Executar H, J, K. K não bloqueia fechamento se não houver necessidade de refatoração naquele momento.

## 21. Política de implementação

Para cada bugfix ou comportamento novo: RED → implementação → GREEN → testes relacionados → suíte do workspace → revisão. Nenhuma alteração pode ser aprovada apenas porque "parece correta". Mudanças em fronteiras de segurança exigem reviewer independente. Mudanças em autenticação, Pending Operations, Undo ou autorização exigem security review independente.

## 22. Política de rollout

Alterações devem ser implantadas em slices reversíveis. Ordem de rollout recomendada: 1. migrations aditivas; 2. API backward-compatible; 3. Agent backward-compatible; 4. PWA; 5. smoke; 6. observação; 7. remoção de compatibilidade. Nunca remover compatibilidade antes de provar que todos os consumidores migraram.

## 23. Rollback

- **Microfone:** rollback de headers/PWA sem impacto em banco.
- **Cookie-first:** durante período de migração, bearer legado pode permanecer como fallback temporário.
- **Device token:** migration deve ser aditiva até completar rotação.
- **WorkspaceAgent:** não remover estado ou migration Cloudflare até prova de que rollback não depende dele.
- **Undo:** migration deve ser backward-compatible sempre que possível.
- **CSP:** rollback imediato por configuração se bloquear capability legítima.

## 24. Observabilidade

Adicionar métricas/eventos suficientes para responder:

- quantas requisições ainda são autenticadas via fallback bearer legado (uso efetivo — não login, não header presente)?
- quantos device tokens antigos ainda estão ativos?
- quantos workspaces ainda dependem do WorkspaceAgent?
- quantas sessões offline ultrapassam maxOfflineAge?
- quantos undo são replay?
- quantas operações entram em reconcile?
- quantos erros de microphone permission ocorrem?
- quantas chamadas do browser tentam sair do proxy same-origin?

Não registrar: passwords, bearer tokens, device token raw, attestation, conteúdo financeiro desnecessário.

## 25. Critérios de conclusão

A V4 está concluída quando:

**Segurança**
- [ ] token normal de sessão não fica reutilizável em localStorage
- [ ] device token não fica reutilizável em claro no banco
- [ ] localhost não é trusted origin em produção
- [ ] CSP reforça a topologia real
- [ ] política offline está explícita

**Agent**
- [ ] FinanceChatAgent é o único runtime financeiro
- [ ] WorkspaceAgent removido
- [ ] binding AGENT removido
- [ ] `/agents/workspace` removido
- [ ] legacy migration encerrada

**Financeiro**
- [ ] autoridade da API preservada
- [ ] Pending Operations V2 preservado
- [ ] receipts preservados
- [ ] Undo possui garantia transacional provada
- [ ] crash/replay testado em PostgreSQL real

**PWA**
- [ ] microfone funciona em browser real
- [ ] headers não contradizem capabilities
- [ ] service worker continua sem cache financeiro sensível
- [ ] logout/expiração continuam limpando estado sensível

**Operação**
- [ ] CI do SHA implantado executado quando infraestrutura permitir
- [ ] SHA testado = SHA implantado
- [ ] documentação canônica atualizada
- [ ] legado documental arquivado
- [ ] lint real separado de typecheck

## 26. Critérios de NÃO conclusão

Mesmo com todos os testes unitários verdes, a V4 NÃO pode ser considerada concluída se ocorrer qualquer um destes casos:

- microfone continua bloqueado em browser real
- bearer reutilizável continua sendo mecanismo primário de sessão no localStorage
- WorkspaceAgent continua sendo necessário para novo tráfego financeiro
- produção continua aceitando localhost sem justificativa explícita
- Undo ainda pode aplicar dois efeitos financeiros sob replay/crash demonstrável
- documentação operacional continua instruindo agentes a utilizar arquitetura removida
- gates remotos são registrados como verdes sem terem executado

## 27. Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | Cookie migration quebra offline | introdução gradual; identidade offline = `offlineSubjectId` opaco não derivado de credencial (D-V4-11, §8.B4); snapshots keyados por credencial migrados por re-sincronização |
| R2 | Remoção do WorkspaceAgent perde histórico | inventário + migração idempotente + prova de zero dependências antes da remoção |
| R3 | CSP quebra Cloudflare/OpenNext | aplicar primeiro em ambiente de teste e validar build final, não somente código fonte |
| R4 | Device token rotation força logout | janela de coexistência e rotação progressiva |
| R5 | Undo transacional aumenta acoplamento | utilizar a mesma abstração transacional existente no backend, evitando distributed transaction |

## 28. Decisões explícitas desta SPEC

| ID | Decisão |
|---|---|
| D-V4-01 | A V4 não reconstrói o Meu TED. |
| D-V4-02 | A API continua sendo a autoridade financeira. |
| D-V4-03 | FinanceChatAgent continua sendo o runtime conversacional alvo. |
| D-V4-04 | WorkspaceAgent é legado de migração e deve desaparecer. |
| D-V4-05 | Cookie-first substitui progressivamente bearer persistido em JavaScript. |
| D-V4-06 | Offline read permanece suportado, mas recebe limite temporal explícito. |
| D-V4-07 | Undo deve evoluir para atomicidade transacional provada. |
| D-V4-08 | Políticas HTTP fazem parte da arquitetura e devem ser testadas junto com as capabilities que controlam. |
| D-V4-09 | Documentação antiga não pode permanecer ativa quando contradiz a arquitetura real. |
| D-V4-10 | Cross-layer testing passa a ser gate permanente do projeto. |
| D-V4-11 | Identidade offline é um identificador opaco, estável e não autenticador (`offlineSubjectId` — o id do workspace/household ativo), fornecido pelo contexto autenticado; snapshots offline nunca são particionados por credencial reutilizável. |

## 29. Resultado esperado

Após V4, a arquitetura deve ser simplificada para:

```
PWA → Same-Origin Boundary → FinanceChatAgent / API → API autoritativa → PostgreSQL
```

Com: 1 autoridade financeira, 1 runtime de Agent, 1 mecanismo principal de sessão, 1 pipeline de aprovação, 1 pipeline de mutação, 1 fonte persistente da verdade.

A V4 não deve tornar o Meu TED maior. Ela deve torná-lo: mais difícil de violar, mais simples de compreender, mais simples de testar, mais simples de operar, mais simples de evoluir.

## 30. Definição final de sucesso

O Meu TED V4 estará pronto quando a equipe puder afirmar, com evidência automatizada:

- O modelo pode interpretar dinheiro, mas não possui autoridade financeira.
- O browser pode pedir e confirmar, mas não pode fabricar autorização.
- A API decide e executa.
- O PostgreSQL registra a verdade.
- O runtime possui apenas um caminho financeiro vigente.
- As políticas de segurança não contradizem as funcionalidades oferecidas.
- E os testes verificam essas propriedades atravessando as camadas reais do sistema.

## 31. Revisão formal REV-V4-1 (2026-09-15)

**Método:** reauditoria do código contra as afirmações da spec, por 3 subagentes de exploração read-only sobre `main@3305152`, com evidência `arquivo:linha`. Esta revisão precede a implementação (mesmo padrão da V3).

### 31.1 Resultado da verificação

| # | Afirmação da spec | Veredito | Evidência principal |
|---|---|---|---|
| 1 | Permissions-Policy bloqueia microfone com UI ativa (§2.1, INV-08) | **CONFIRMADO** | `proxy-utils.ts:18`; `TedChat.tsx:764-771`; teste trava o valor: `__tests__/proxy.test.ts:39-41` |
| 2 | Bearer reutilizáveis em localStorage (§2.2) | **CONFIRMADO** | `client.ts:73-91`; `token-store.ts:9-53`; `AuthGate.tsx:68-87`; `convite/page.tsx:183-194` |
| 3 | Device token em claro + SQL tautológico + lifecycle incompleto (§2.3) | **CONFIRMADO, escopo ampliado** | `V001__init.sql:84-90`; tautologias em `device-token.ts:57,71` **e** `payables/postgres.ts:580,595`; sem `last_used_at`/`expires_at` |
| 4 | WorkspaceAgent legado ativo (§2.4) | **CONFIRMADO, com inventário completo** | §11.E1; binding `AGENT` (`wrangler.jsonc:9`); PWA ainda referencia helpers legados (`agent-client.ts:330,335`) |
| 5 | Undo tem janela entre efeito e idempotência (§2.6) | **REFUTADO para Postgres, CONFIRMADO para in-memory** | `writes/postgres.ts:873,939-948` (same-tx); `writes/idempotency.ts:139-140` (sem tx, dev/teste) → Bloco F reescrito (§12) |
| 6 | Localhost confiado em produção (§2.7) | **PARCIAL** | API já fail-closed (`env.ts:100-108`); gap real = spoof de Origin nos proxies PWA sem gate (`api/backend/.../route.ts:39-43`) → G3 reescrito (§13) |
| 7 | CSP permite bypass do BFF (§2.8) | **CONFIRMADO** | `proxy-utils.ts:52-55`; `wrangler.jsonc:29` fixa URL direta (divergência ADR-011) |
| 8 | Sem política de validade offline (§2.9) | **CONFIRMADO** | `lastOnlineAuthenticatedAt` inexistente; `snapshot-db.ts:207-230` sem checagem de idade |
| 9 | Snapshot offline precisa de identificador não secreto (§8.B4) | **JÁ ATENDIDO** — ⚠️ **SUPERADO POR REV-V4-2: NÃO USAR COMO ESTADO ATUAL** (ver §31.4; `ownerFingerprint` deriva do device token e não pode ser identidade offline primária) | `ownerFingerprint` SHA-256 (`snapshot-db.ts:95-102`) → B4 reduzido a teste |
| 10 | Docs legados contradizem arquitetura (§2.11) | **CONFIRMADO** | `.pi/AGENTS.md:1-5,173-176`; convenção `docs/archive/` já existe |
| 11 | Descrições "demo in-memory" em package.json (§15.I4) | **NÃO CONFIRMADO** | nenhuma ocorrência; só `apps/api/.env.example:7` (wording a ajustar) → I4 narrowing |
| 12 | `lint` é alias de `tsc` fora da PWA (§16.J1) | **CONFIRMADO** | `apps/api/package.json:9,18`; agent/broker sem script lint; Biome instalado e não invocado |
| 13 | Módulos gigantes (§2.12) | **CONFIRMADO** | `app-state-context.tsx` 2.121 linhas; `TedChat.tsx` 808 linhas |

### 31.2 Correções aplicadas nesta revisão

1. **F-1 — Bloco F reescrito (§12):** a spec original afirmava uma janela transacional no Undo que não existe no caminho Postgres (já atômico). O bloco passa de "implementar transação" para "provar atomicidade por injeção de crash em PostgreSQL real + paridade in-memory/Postgres + corrigir in-memory". Nenhuma migration nova é esperada para F.
2. **F-2 — C5 ampliado (§9):** tautologias `household_id = household_id` também existem em `payables/postgres.ts:580,595`, fora de device tokens; o bloco passa a cobrir os 4 pontos.
3. **F-3 — G3 reescrito (§13):** a API já rejeita localhost em produção; o hardening concentra-se no gate de ambiente do spoof de Origin nos proxies Next da PWA (aplicado hoje também em build prod) e no alinhamento do CORS do worker Agent.
4. **F-4 — B4 estreitado (§8):** o fingerprint SHA-256 do snapshot já existe; o bloco vira preservação sob teste. ⚠️ **SUPERADO POR REV-V4-2 — NÃO USAR COMO ESTADO ATUAL:** `ownerFingerprint` deriva do device token e não pode ser identidade offline primária; estado atual é `offlineSubjectId` (§8.B4, D-V4-11; ver §31.4).
5. **F-5 — A1 contextualizado (§7):** a flag de capability de microfone não existe e precisa ser criada; o contrato atual do header está travado por teste e muda junto.
6. **F-6 — E1/E4 completos (§11):** inventário classificado inclui helpers legados da PWA (`agent-client.ts:330,335`), teste de scaffold que trava binding/migration, e a extensão do `check-legacy-runtime-references.mjs` antes do corte.
7. **F-7 — I2/I4 alinhados (§15):** arquivamento usa a convenção existente `docs/archive/`; I4 reduzido ao wording de `apps/api/.env.example`.
8. **F-8 — XLT-06 desdobrado (§18, revisão do plano):** "dependency count → zero" passa a ter dois gates: consumidores externos = 0 **antes** da remoção (XLT-06a, prova pré-requisito) e referências estáticas = 0 **após** a remoção (XLT-06b, pós-condição com allowlist expirada). O guard é executável por gate de validação, não por chamada manual. ⚠️ **SUPERADO POR REV-V4-2 — NÃO USAR COMO ESTADO ATUAL:** os checks estáticos foram reclassificados como **ARCH-V4-06a/b** (architecture check, VAL-V4.9) e o XLT-06 real é E2E pós-descomissionamento; ver §18 e §31.4.
9. **F-9 — INV-08 nos dois sentidos (§6/§7, revisão do plano):** a correção do microfone inclui gatear a UI pela mesma capability — flag desligada significa header bloqueando **e** botão ausente; nunca header negando com UI ativa.

### 31.3 Perguntas abertas (não bloqueiam o plano; resolvem-se durante a execução)

1. Existem device tokens legados sem `.` (pré-V015) ativos em produção? Exige query read-only na VPS — alimenta a estratégia de coexistência da migration `V053`.
2. ~~O path legado de `operation_records` (`postgres.ts:874-909`) serve também ao undo?~~ **RESOLVIDA em REV-V4-2:** não — o undo usa exclusivamente `lookupOrRecord` com namespace `audit-undo:` (`apps/api/src/approvals/undo.ts:83-85`); o bloco `postgres.ts:874-909` é o branch `DB_SCHEMA=legacy` do idempotency store (`postgres.ts:830,874`), inalcançado pelo undo canônico. Verificação read-only de 2026-09-15. **Nota de escopo FIX-UNDO (2026-09-16):** "inalcançado" vale apenas para deploys de schema canônico — com `DB_SCHEMA=legacy` (a produção legacy boota assim: `production-routes.ts:141` constrói `createPostgresIdempotencyStore({ pool, legacy: true })` e monta o undo sobre ele em `:152`), a MESMA chamada `lookupOrRecord(…, 'audit-undo:'+key, …)` executa o branch `postgres.ts:874-909`. XLT-07 prova a entrada no branch no teste `legacy branch (§31.3.2)`.
3. Alinhamento de origem: `ALLOWED_ORIGINS` do worker Agent vs `PRODUCTION_AGENT_ORIGIN` da PWA — confirmar na fase de descomissionamento.

### 31.4 Revisão REV-V4-2 (2026-09-15)

Segunda passagem, cirúrgica: revisão de consistência SPEC↔plano sobre a REV-V4-1 — não é nova auditoria arquitetural e não muda a divisão de autoridade. Evidência adicional coletada por 1 subagente read-only (identidade/telemetria). Changelog:

| # | Mudança | Motivo |
|---|---|---|
| 1 | **§8.B4 reescrito: identidade offline = `offlineSubjectId`** | A redução REV-V4-1 (F-4) estava errada: `ownerFingerprint` é SHA-256 do **device token cru** (`snapshot-db.ts:95-102`) — deriva da credencial que B3 remove/rotaciona, quebrando o offline exatamente na migração cookie-first. `offlineSubjectId` reutiliza o id do workspace/household ativo, já presente na PWA (`workspaces.ts:30-36`, `workspace-context.tsx:146,180`), opaco e não autenticador. Formalizada como D-V4-11 (§28); §10.D1 e §27.R1 atualizados. |
| 2 | **§18: checks estáticos reclassificados** | "Referências estáticas = 0" não atravessa camadas reais → vira `ARCH-V4-06a/b` (architecture check, VAL-V4.9). XLT-06 real = E2E pós-descomissionamento (rota canônica funcional; rota legada ausente). Supera a nomenclatura de F-8. |
| 3 | **§31.3.2 resolvida** | O undo nunca executa o branch legacy `postgres.ts:874-909` — usa `lookupOrRecord` (`approvals/undo.ts:83-85`). Sai da lista de perguntas abertas. **Escopo FIX-UNDO (2026-09-16):** apenas em schema canônico; com `DB_SCHEMA=legacy` (`production-routes.ts:141,152`) a mesma chamada namespaced executa `874-909`. |
| 4 | **Achado adicional incorporado ao plano** | `apps/pwa/public/offline-shell.js:28-44` renderiza o snapshot **sem** checagem de ownership/idade — escopo de T2.6 do plano rev.3 inclui o shell herdando `offlineSubjectId` + `maxOfflineAge`. |
| 5 | **Evidência que alimenta ADR-015 (sem pré-decisão)** | O device token é load-bearing em toda chamada de dados (`client.ts:141-154`; resolução central session-first com fallback de device token em `routes/index.ts:210-261`; boot gate `AuthGate.tsx:34`). A escolha de transporte (Opção A cookie dedicado / Opção B header temporário / Opção C convergência session-first) é do ADR-015 na execução (T0.3), não desta revisão. |
| 6 | **Plano rev.3 correspondente** | T0.2 sem vermelho permanente (RED de ARCH-06a confinado à Fase 4: nasce em T4.1, verde em T4.2); Bloco J obrigatório para fechamento (P3 ≠ opcional; só K é não bloqueante); nova T0.4 de observabilidade §24 com 8 métricas sobre mecanismos existentes; T2.5 sem pré-decisão de transporte; baselines explícitas (produção `3305152` × planejamento `5733cc8` + regra de revalidação); matriz de rastreabilidade reconstruída; débitos de fechamento restritos a CI billing, branch protection e Bloco K. |
| 7 | **Patch documental final (2026-09-15 — SPEC segue REV-V4-2; plano segue rev.3)** | (a) telemetria do bearer corrigida para **uso efetivo em request**: `auth.request.legacy_bearer_used` emitido só quando cookie/session não autenticou e o bearer foi o autenticador efetivo (login/header presente não contam) — §24.1 e T0.4.1; (b) §8.B3 atualizado: o cookie Better-Auth já existe, a sequência valida o transporte pelo proxy e promove cookie a primário — nada de emissão segunda ou login paralelo; (c) histórico REV-V4-1 superado explicitamente marcado (§31.1.9, F-4, F-8); (d) métrica CSP com **produtor real** — Opção A: `report-to`/`report-uri` → endpoint same-origin `POST /api/csp-report` com payload mínimo, sanitização e bounded logging (T0.4.8, T2.7); (e) tabela §18 reformatada (nota movida para após XLT-10). |

Preservadas integralmente as correções REV-V4-1 (§31.2 F-1..F-9): Undo Postgres já atômico (prova, não reescrita), localhost fail-closed na API com gap nos proxies, C5 ampliado aos 4 pontos tautológicos, inventário E1 completo, INV-08 bidirecional.

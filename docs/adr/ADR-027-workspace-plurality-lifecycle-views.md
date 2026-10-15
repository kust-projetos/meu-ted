# ADR-027 — Pluralidade de workspaces, lifecycle e visibilidade de conversas (D1/D2/D3)

**Status:** Aceita pelo operador em 2026-10-15 (decisões D1/D2/D3 vinculantes)
**Data:** 2026-10-15

## Contexto

O modelo vigente impõe **um único workspace pessoal por usuário** via índice
único parcial (`V021:35-37`), com triggers que bloqueiam conversão de
kind, troca de owner, convites e membership fora do owner ativo
(`V021:39-132`). A listagem ordena pessoais primeiro
(`workspaces-postgres.ts:50`); a criação barra o segundo pessoal com 409
(`workspaces-postgres.ts:66-74`); remoção/saída em personal é recusada
(`workspaces-postgres.ts:162-164`; `workspaces-store.ts:116-127`). O HTTP
expõe archive/restore idempotentes (`workspaces-http.ts:129-189`) sobre o
status `active|archived` (`V036:9-27`). Identidade/membership vivem em
`V020:98/125`; transferência de ownership shared em `V022:165-254`. No Agent,
o fluxo de conversas está em `finance-chat-agent.ts:3673-3739/3797-3863` com
sessões em `sessions.ts:50-125`, e Pending V2/bindings não têm FK para o
workspace (`V060`).

Operador + arquiteto decidiram evoluir para **N pessoais + compartilhados
(D1)**, lifecycle com **archive/delete/purge (D2)** e **visibilidade
coletiva-por-default com privado opt-in (D3)**. Este ADR materializa essas
três decisões fielmente, sem reinterpretar.

## Decisão D1 — N workspaces pessoais + compartilhados

1. O modelo passa a admitir **N workspaces pessoais e N compartilhados** por
   usuário.
2. `personal` = **propriedade exclusiva**: sem convites, sem transfer, sem
   saída, sem conversão (os guards da V021 permanecem).
3. **Sem transferência de dados** entre workspaces.
4. **Seleção explícita** de workspace pelo cliente/usuário; nenhuma escolha
   silenciosa.
5. **Fallback determinístico** quando nenhum workspace for selecionado:
   pessoal ativo mais antigo → compartilhado ativo mais antigo → UUID.
6. **Ordenação**: ativos primeiro, pessoais antes de compartilhados,
   `created_at`, `id` como desempate final.
7. **Bootstrap** cria 1 pessoal quando necessário, **serializado por
   usuário**, sem recriar workspace excluído.
8. **Migration remove SÓ o índice único** `memberships_personal_user_uidx`
   — em **nova migration, sem editar a V021**.
9. **Demais triggers preservados** (kind/owner/invites/membership).
10. **Rollback = bloquear criações** (reinstalar o índice após N>1 não é
    seguro).

## Decisão D2 — Lifecycle: archive, delete vazio, purge bloqueado

Três ações distintas, sem atalho entre elas:

1. **Archive**: reversível; **congela mutações** enquanto arquivado.
2. **Delete**: só de workspace **vazio**, permanente, com **confirmação
   forte + inventário versionado + expiração**.
3. **Purge com-dados**: ação separada, **BLOQUEADA até
   retenção/exportação/política** estarem definidas.

Regras vinculantes:

- **"Vazio" inclui soft-deleted, histórico, Durable Objects e R2.**
  Contas zeradas NÃO bastam como prova de vazio.
- **Pré-condições**: sessão + auth recente; owner revalidado na transação
  final; confirmação vinculada (UUID/ator/ação/versão/expiração); zero
  pendings/incertos/jobs; convites resolvidos; barreira de concorrência;
  **tombstone anti-reuso** (id nunca reutilizado).
- **Sem cascade genérico**; **sem apagar audit/idempotência para
  "esvaziar"**; **sem fabricar transações**.
- **Export com manifesto após quiescência**; retenção e legal-holds seguem
  **pendentes de política** (ver Riscos).

## Decisão D3 — Visibilidade: coletivo-com-atribuição default, privado opt-in

1. **Coletivo-com-atribuição é o default**: conversa visível aos membros do
   workspace, com autoria atribuída.
2. **Privado é opt-in por conversa**, gated por flag server-side
   `TED_PRIVATE_VIEWS_ENABLED` com **default 0** — só o valor exato `1`
   habilita.
3. **Flag off nunca converte** conversas existentes (nem coletivo→privado,
   nem privado→coletivo).
4. Cada conversa carrega **visibilidade `workspace|private` +
   `owner_actor_id` + `conversation_id`**.
5. **Predicado mínimo de acesso**: membro ativo + workspace + visibilidade.
6. Aplicar o predicado em **TODOS os canais**: leitura, detalhe, busca,
   WebSocket, export, anexos, resumos, caches e LLM.
7. **Resumos de conversa privada nunca viram memória compartilhada.**
8. **Legado sem audiência = coletivo só com proveniência**; sem
   proveniência, preservado-não-publicado.
9. **Renovação de sessão não apaga** conversas.
10. **Sem migração destrutiva**; **rollback = desabilita novas privadas**
    (o existente permanece como está).

## Consequências

- A unicidade de personal deixa de ser invariante de banco e passa a ser
  política de aplicação (bloqueio de criação no rollback; bootstrap
  serializado na ida).
- Archive vira estado operacional real (mutações congeladas), não apenas
  rótulo; delete e purge viram caminhos separados com gates próprios.
- O Agent precisa do predicado de visibilidade em todos os canais de
  leitura — qualquer canal novo herda a obrigação.
- Retenção, legal-holds e exportação viram pré-requisitos formais do purge;
  enquanto a política não existir, purge permanece bloqueado.

## NÃO-FAZER (proibições explícitas)

1. Reescrever a V021 (a remoção do índice único é nova migration).
2. Escolher workspace pessoal silenciosamente (seleção explícita + fallback
   determinístico documentado).
3. Tratar `archived` como bloqueio suficiente para exclusão (archive ≠
   delete ≠ purge).
4. Aceitar saldo-zero como prova de vazio (vazio inclui
   soft-deleted/histórico/DO/R2).
5. Usar cascade genérico para esvaziar/excluir.
6. Apagar audit ou records de idempotência para "esvaziar" um workspace.
7. Publicar conversas privadas ao desligar a flag (flag off nunca
   converte).
8. Reutilizar Pending V2 como autorização de exclusão.

## Riscos e blockers

- **Retenção/legal-holds**: política pendente; purge com-dados bloqueado
  até definição (D2).
- **Barreira cross-store**: a prova de "vazio" e o congelamento precisam
  cobrir Postgres (API), Durable Objects e R2 (Agent) atomicamente na
  intenção — sem barreira cross-store, delete pode vazar resíduos.
- **Rollback N>1**: reinstalar o índice único com mais de um personal por
  usuário não é seguro; rollback é bloquear criações, não reimpor
  unicidade no banco.

## Referências

- `apps/api/src/read-models/sql/V021__personal_workspace_invariants.sql:35-37`
  (índice único) e `:39-132` (triggers).
- `apps/api/src/read-models/sql/V036__workspace_lifecycle.sql:9-27`
  (status archive).
- `apps/api/src/auth/workspaces-postgres.ts:50` (ordenação),
  `:66-74` (409 segundo pessoal), `:162-164` (remoção em personal).
- `apps/api/src/auth/workspaces-store.ts:83-84` (409 in-memory),
  `:116-127` (remoção/saída em personal).
- `apps/api/src/auth/workspaces-http.ts:129-189` (create/rename/
  archive/restore).
- `apps/api/src/read-models/sql/V020__identity_workspaces.sql:98/125`
  (memberships/invites).
- `apps/api/src/read-models/sql/V022__shared_workspace_invariants.sql:165-254`
  (transfer shared).
- `apps/agent/src/finance-chat-agent.ts:3673-3739/3797-3863` (conversas).
- `apps/agent/src/sessions.ts:50-125` (sessões).
- `apps/api/src/read-models/sql/V060__*.sql` (Pending V2/bindings sem FK).

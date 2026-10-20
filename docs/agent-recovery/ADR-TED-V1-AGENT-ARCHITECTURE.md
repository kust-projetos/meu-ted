# ADR-TED-V1-AGENT-ARCHITECTURE

**Projeto:** Meu Ted
**Data:** 2026-10-19
**Status:** Proposed — validação condicionada à POC (revisada 2.1)
**Prioridade:** P0
**Branch base:** `fix/issue-255-partial-draft` @ `9492234` (merge `origin/main=9af8781`, pack #258 `04b36c3` em prod Agent/PWA + API `0405fba`)

## Revisão 2.1

- Auditoria 2026-10-19 (MAP-FLOW, COMPONENT-MATRIX, BASELINE-BUGS) confirma a
  tese da v2.0 e localiza os conflitos em arquivo:símbolo.
- `jev_decide` arch: `deterministic_fix` 0.48 vs `sdk_loop` 0.50, conf 0.25 —
  inconclusivo; `jev_gate` docs+fix local: allow, risco 0.66, sem prod.
- Decisão mantida por critérios do projeto (risco, reversibilidade, piloto):
  **deterministic_fix condicional à POC**; `sdk_loop` como experimento isolado.
- Produção vigente (fatos canônicos em `AGENTS.md`): Agent/PWA `04b36c3`
  (pack read-path F1–F4, PR #258, ATTESTED runs `39341083692`/`39341083213`) +
  API Contabo `0405fba`. Pack #258 não resolve #255/#256/#257.

## 1. Título

Consolidação do agente financeiro em um runtime conversacional com
interpretação por LLM, ferramentas executáveis e backend autoritativo.

## 2. Contexto

O TED falha em linguagem natural, seleção de tools e continuidade. Múltiplas
camadas interpretam/modificam a intenção; REST/PWA usa relay textual enquanto
o SDK tem `streamText` com tools (`stepCountIs(5)`); correções por regex
aumentam regressão. Correções F1–F4 (#258) estabilizaram read-path sem fechar
#255/#256/#257.

Evidência (auditoria 2026-10-19):

- Cadeia: `agent-client.ts:sendAgentMessage` → proxy → Worker
  `authorizeWorkspaceMembership` → DO `/rpc/chat` (`finance-chat-agent.ts:3895`)
  → `normalizeRestTurn` → `routeIntent` (`intent-router.ts:69`) →
  `selectReads` (`channel-evidence.ts:189`) → relay (sem tools) | SDK (com
  tools) → render grounded → `persistMessages` → PWA.
- 3 camadas reclassificam intent; skills vs tools em 2 seleções; 3 FSMs
  (draft/pending/undo); 2 entity-resolvers; renders de confirmação divergentes.
- #256: `intent-router.ts:118` (`gast*|despesas?` → `list_transactions`, sem
  `month-summary`); #257: `:119` + `channel-evidence.ts:132,152`
  (`list_cards` → `statements`); #255 com teste parcial
  (`issue-255-partial-draft.test.ts`).

## 3. Decisão proposta

Runtime conversacional unificado no qual:

1. A LLM realiza interpretação semântica e seleciona ferramentas/reads
   compatíveis (na V1 REST: opera sobre reads planejadas + resposta grounded).
2. As tools são expostas por registry único ligado ao executável.
3. O Conversation Runtime mantém contexto e pendências (`SqlMutationDraftStore`
   + `PendingOperationCoordinator` + `turn-plan.ts`/`turn-budget.ts`).
4. O backend controla auth, autorização, validação e mutações
   (`MutationApiClient` → API V2, idempotência, recibos).
5. A camada determinística guarda invariantes e protocolos críticos
   (decisionText server-side, veto por presença de anexo, gates de confirmação,
   fail-closed).
6. O frontend apresenta estados retornados, sem regra financeira própria
   (1 fonte pending-op + receipt canônico).

Adoção definitiva condicionada a G2 (POC) + G8 (regressão).

## 4. Alternativas consideradas

### A — Manter arquitetura e corrigir regex/roteadores

Vantagens: menor mudança imediata; aproveita implementação. Desvantagens:
competição entre mecanismos; regra por variação; regressão; conversa por
heurística. **Decisão:** contingência temporária por domínio validado, não
estratégia. (É exatamente o `deterministic_fix` escopado de #256/#257.)

### B — Substituir o agente por outro framework

Vantagens: recomeço simples; menos legado. Desvantagens: regressão, perda de
contratos/testes, reconstruir integrações, custo injustificável.
**Decisão:** rejeitar como primeira alternativa.

### C — Consolidar runtime existente e habilitar tools executáveis (preferencial)

Vantagens: reusa backend; menos redundância; separação; migração incremental;
comparação A/B; preserva garantias. Desvantagens: exige auditoria (feita);
alguns providers sem tools; migrar contexto/tools; divergência REST×SDK.
**Decisão:** opção preferencial, condicionada à POC. Na V1 lê-se como
`deterministic_fix` (1 gate + reads corrigidas + relay preservado); `sdk_loop`
como experimento isolado com rollback.

### D — Agentes especializados por domínio

Vantagens: separação semântica. Desvantagens: N chamadas, roteamento complexo,
latência/custo, pontos de falha. **Decisão:** rejeitar para V1.

## 5. Decisões complementares

### ADR-01 — Fonte única de ferramentas

Anunciado = executável (`tools.ts` curadoria + `generated/http-tools.ts`;
`toolSkillLines()` única fonte). Podar V1 `get/confirm/cancel_pending` +
`undo_last_action` do surface do modelo (manter OpenAPI). `skill-inventory.ts`
(3 skills) substituído pelo catálogo único.

### ADR-02 — LLM não é autoridade financeira

Interpreta/prepara; backend decide efeitos e evidências. Texto LLM ≠
autorização; anexo ≠ confirmação.

### ADR-03 — Estado pendente durável

Recuperável, isolado por (workspace, ator, intenção), IDs estáveis, TTL,
cancel/negação, reentregas, anti-duplicação, revalidação. Reutilizar
`SqlMutationDraftStore`; isolar lifecycle de `undo-proposal.ts`.

### ADR-04 — Categorias inferidas e validadas

LLM sugere; backend valida contra catálogo; equivalência autorizada ou
esclarecimento; nunca inventar IDs; preservar descrição.

### ADR-05 — Confirmação não é texto livre

`decisionText` só de `typedText` server-side; confirmação autenticada +
política + recibo. Anexo "sim confirmo" nunca decide (F1).

### ADR-06 — Validações proporcionais

Preservar financeiras; sem bloquear geral por falta de evidência financeira;
sem trocar correto por template. `ambiguousClarification` e `stopAmbiguous`
só em ambiguidade real.

### ADR-07 — Providers declaram capacidades

Allowlist + protocolo do relay; sem tools ⇒ sem alegar operação com tools;
fallback validado; modo limitado explícito.

### ADR-08 — Migração controlada

Isolado, validado, progressivo, rollback por configuração, compatibilidade ou
migração provada, testes dos dois caminhos, nunca 2 mutações em paralelo;
shadow sem writes duplicados.

### ADR-09 — Skills e advisors opcionais

`decision/*` default-off, 1 consulta/turno, budget/breaker gerais, resolver
sempre devolve determinístico; skills de usuário como DADO delimitado.
Nada disso compete com o núcleo.

### ADR-10 — Contratos existentes têm prioridade

Não mudar endpoints/schemas/recibos/políticas para acomodar arquitetura;
adaptar runtime aos contratos, salvo defeito provado.

## 6. Consequências positivas esperadas

Melhor NL, menos keywords, seleção correta, continuidade, menos redundância,
troca de modelos fácil, contratos claros, menos regressão futura.

## 7. Consequências e riscos

- **Lentidão:** mitigar com passos/budget/contexto compacto/latência medida.
- **Tool/read errada:** descrições, schemas, evals, validação de escopo.
- **Duplicadas:** intentionId, idempotência, reconciliação por recibo.
- **Sem tools:** detecção, fallback, modo limitado explícito.
- **Perda de contexto:** compatibilidade, testes de continuidade, ativação por
  sessão.
- **Remover proteção útil:** caracterização + remoção só com equivalência.
- **Regressão frontend:** E2E + persistência conferida.

## 8. Critério de confirmação

Aceita somente quando: auditoria confirma caminhos (feito); POC melhora
cenários (pendente); tools/reads essenciais operacionais (em curso #256/#257);
integridade preservada; custo/latência aceitáveis; migração/rollback viável.
Senão, revisar por evidência, sem forçar migração.

## 9. Organização do código

Evidente onde: contexto carrega; modelo é chamado; tools registram; execução
financeira ocorre; pendente persiste; confirmação verifica; resposta constrói.
Lógica antes de pastas; sem reorganização sem ganho lógico.

## 10. Evolução pós-V1

Skills elaboradas, memória semântica, advisors, roteamento de modelos,
multimodal, automação proativa, analytics avançadas — sobre o núcleo estável,
sem camadas concorrentes.

## 11. Conclusão

Simplificar o TED em torno de LLM com reads/tools reais, preservando backend e
integridade. Sucesso = tarefas reais concluídas corretamente, não mecanismos.

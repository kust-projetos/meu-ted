# SPEC — TED OpenCode-first (produto)

**Status:** aprovada como direção; implementação local em fatias. **A0 em produção não deve ser modificado até autorização específica.**

## 1. Objetivo e não objetivos

Substituir progressivamente o cérebro conversacional personalizado de `apps/agent` por um runtime OpenCode dedicado ao Meu TED, **sem** migrar o ledger, redesenhar a API financeira ou trocar o contrato público da PWA.

Não objetivos da primeira entrega: migração de histórico, WhatsApp, multiagente, ferramentas administrativas, SDK upgrade, personalização de memória, escala distribuída, suporte a todas as operações financeiras, canary, deploy, migração de banco ou descomissionamento de A0.

## 2. Responsabilidades (não duplicar)

| Componente | Dono |
|---|---|
| PWA e `/api/agent` | Entrada/UX, sessão HttpOnly, CSRF, DTOs do chat, render de pendências e recibos |
| Gateway TED | Resolver usuário/workspace/device a partir da sessão confiável; owner de conversa; mapear IDs; projetar eventos e DTOs; pin por conversa |
| OpenCode dedicado | Prompt-loop, contexto de conversa, sessões, tools/plugins/skills nativos; sem autoridade financeira |
| Plugin TED | Tools allowlisted e schemas corretos; contexto host-bound; chamar API via cliente mínimo |
| API Fastify + Pending V2 | Fonte autoritativa de dados, autorização, proposta, decisão de risco, confirmação, execução, idempotência e recibos |
| PostgreSQL | Dados financeiros e Pending V2 canônicos; storage de sessão OpenCode separado |

**Regra de identidade:** sessionID, messageID ou CallID do OpenCode não são provas de autorização. Cada tool usa binding autenticado server-side. Nenhum segredo em LLM prompt, argumentos de tools ou browser. `CallID` não deve virar `intentionId` financeiro.

## 3. Interface da PWA — compatibilidade primeiro

Preservar o fluxo existente de `apps/pwa/src/features/ted/TedChat.tsx`, `apps/pwa/src/app/api/agent/[...path]/route.ts` e `/api/backend`. Inspecionar `sendAgentMessage` / `decidePendingOperation` e os contratos atuais **no código antes de alterar**. Como referência da investigação, envio usa `{text, attachments?, intentionId}` e resposta inclui `{turnId, intentionId, status, output, memorized, pendingOperation, undoProposal}`; **confirmar schema em `packages/llm-contracts` e clientes PWA atuais**.

A PWA não deve receber resposta OpenCode bruta, token financeiro, attestation ou status `succeeded` inventado por texto. UI só apresenta execução final com recibo canônico. Preservar cancelamento, falha, timeout e render de propostas.

**Primeiro contrato do adapter:** enviar uma mensagem de leitura, emitir estados `processing|complete|error` dentro do DTO real identificado, correlacionar `clientMessageId`/intention confiável, retornar dados grounded ou erro tipado sem dados de outro workspace. Não definir endpoint ou campo novo sem checar consumidor atual.

## 4. Sessão, escopo e visibilidade

O gateway mantém binding durável e autenticado `workspaceId + actorId + deviceId + conversationId + visibility + runtimeSessionId + runtimeOwner`, sujeito aos contratos da API e ADR-027. Visibilidade coletiva por padrão; privada apenas com opt-in autorizado; autoria e membership revalidados em lista/detalhe/busca/export/stream. Dados sintéticos actor-private dos spikes não equivalem a paridade dessa regra.

Em restart, sessão nativa persiste mas credenciais/binding de host **não** são restaurados sem reautenticação. Não aceitar `runtimeSessionId` fornecido pelo cliente como prova de posse. Provar isolamento de metadados, não apenas de tools.

Para o primeiro corte local, usar topologia simples de instâncias isoladas, medir overhead. Evitar serviço distribuído de sessões até surgir necessidade comprovada.

## 5. Tool boundary e catálogo

Reutilizar do experimento, após revisão do código: `list_accounts`, `get_month_summary`, `list_categories` e `propose_expense`. Tools do OpenCode 2.2.4 exigiram schema de **input e output** para funcionar no prompt-loop real. Sem schemas completos, não considerar uma ferramenta pronta.

Primeira fatia de PWA: **somente leitura** (contas/resumo). Expansão de capabilities é incremental: transações, cartões, faturas, analytics, proposta e outras operações apenas após provar contratos reais da API.

A instância SDK inteira não chega ao gateway/browser. A façade de allowlist exata permanece; o experimento provou bypass de policy via `session.shell` na API direta. Sandbox real, containers sem permissões elevadas, e catálogo permitido observado. Um hook amplo que nega `execute` inviabiliza inclusive tools legítimas — não usar.

Erros `401/403/409/422/429/timeout` e payload inválido **não viram dados vazios**. Período, centavos, IDs e paginação vêm da API; não refazer cálculos financeiros no prompt.

## 6. Escritas e confirmação

Somente após a fatia de leitura passar: model propõe via `propose_expense` com `PendingOperationV2` real, chave estável por intenção e identidade durável do gateway. API decide risco/autoridade (ADR-026); começar com autoexecução `off` no novo caminho até provar paridade das decisões vigentes. UI confirma por ação autenticada e `requestId`, não por texto `"sim"` ou ferramenta acessível à LLM. Sem execute/write antes da decisão da API. Recibo deve ligar `operationId`, proposta e `entity.id`; `pending` não equivale a `execution_status=succeeded`. Replays/uncertain devem consultar API, não criar nova intenção.

O SPIKE 05D provou a cadeia em banco sintético; **não provou integração do card de confirmação na PWA real**.

## 7. Falha, observabilidade e custo

Traces sanitizados com `conversationId`, `clientMessageId`, `turnId`, `runtimeSessionId`, tool, status, duração e correlation de recibo; sem cookies, tokens nem texto de sessão privada em log coletivo. Armazenar resultados/rotas de provider sem mascarar `no-route`. SDK reportou `cost=0` em alguns spikes; **não representa necessariamente faturamento**. Medir tokens/custo por fonte confiável quando disponível e recursos por identidade/conversas.

O caso `"E em maio?"` sem histórico continua um defeito observado: ao faltar assunto/período essencial, pedir esclarecimento, sem regex específico. Continuação com LLM após restart é pendência conhecida. Registrar diferenças honestamente.

## 8. Gates de produto

- **READ_SLICE_PASS:** PWA → proxy → gateway → OpenCode (LLM real autorizado) → tools → API → DTO → PWA, com duas identidades e oráculos financeiros corretos; erros, cancelamento, visibilidade e controles existentes mantidos.
- **WRITE_SLICE_PASS:** mesma proposta gerada pelo modelo reaparece na PWA, é confirmada via ação autenticada, persiste após restart, produz exatamente um lançamento e recibo verificável; falhas não fingem sucesso.
- **PARITY_REVIEW:** matriz de [paridade/rollout](PARITY-ROLLOUT.md) preenchida por casos reais; diferencia PASS/PARTIAL/NOT_PROVEN.
- **PRODUCTION_READY:** ainda não declarado e somente após gates operacionais, auth/visibilidade, recovery e autorização específica.

Nenhum único trace substitui regressões, nem teste sintético substitui autenticação real.

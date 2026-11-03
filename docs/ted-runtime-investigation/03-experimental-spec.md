# SPEC experimental — TED sobre runtime dedicado (proposta)

**Estado:** proposta de experimento. Nada aqui autoriza implementação, inferência paga, produção, deploy ou migração.
**Baseline de referência:** `218960d0fb0fba153dcf2bc4165b2a7a44495276`.
**Decisão de desenho:** OpenCode V2 é o **candidato prioritário do experimento**, não vencedor nem produto aprovado. A0 (baseline atual) e A1 (Cloudflare com loop direto de tools) são comparadores; Pi (C) é contingência. Sucesso só se mede em campanha futura com LLM e tools reais; os thresholds vivem em `05-evaluation.md` e não são duplicados aqui.

## 1. Objetivo e não-objetivos

Objetivo: definir a fatia mínima que permitiria comparar, com justiça, um TED com loop nativo de ferramentas (braço B) contra o harness atual (A0) e contra um loop direto no Cloudflare (A1), sem tocar na autoridade financeira.

Não-objetivos desta SPEC:

- Não aprova substituição de produção nem hospedagem definitiva.
- Não redesenha PendingOperation V2, autorização por risco, undo ou Zod em andamento.
- Não promete sessão entre canais na primeira versão.
- Não afirma paridade com confirmação puramente conversacional.

## 2. Versões e base técnica verificada (2026-10-30)

Metadados npm consultados em 30/10 (fontes em [viabilidade §8](02-runtime-options.md#8-lacunas-de-evidência)), a fixar com digest/integrity na fase zero:

- `@opencode/sdk`, `@opencode/client`, `@opencode/cli`, `@opencode/plugin`: **2.2.4** (MIT).
- `@earendil-works/pi-coding-agent`: **1.4.0**, `node>=22.19.0` (MIT).
- A documentação V2 descreve as novas actions de policies `integration.connect`, `integration.use` (novo significado), `mcp.use`, `skill.use` e `plugin.use` como exigindo **>=2.3.0**. Isso não torna skills/MCP/policies em geral indisponíveis na 2.2.4. Não apoiar segurança nesses controles novos sem suporte comprovado. O primeiro spike deve testar catálogo e permissões reais da versão fixada e **não inventar** chaves como `filesystem:off` / `discovery:off`.

Referências oficiais usadas na investigação (sem instalar nem exercitar runtime):

- [API V2](https://opencode.ai/v2/docs/api), [OpenAPI](https://opencode.ai/v2/openapi.json)
- [Client](https://opencode.ai/v2/docs/build/client)
- [SDK](https://opencode.ai/v2/docs/build/sdk) (`OpenCode.create()`)
- [SDK Workerd](https://opencode.ai/v2/docs/build/sdk/cloudflare) (`OpenCodeWorkerd.create({storage,config,plugins})`)
- [Plugin server](https://opencode.ai/v2/docs/build/plugins/server/) (hooks de prompt, `ctx.tool.transform`)
- [Permissions](https://opencode.ai/v2/docs/permissions), [Policies](https://opencode.ai/v2/docs/policies), [Config](https://opencode.ai/v2/docs/config)
- [Skills](https://opencode.ai/v2/docs/skills), [MCP servers](https://opencode.ai/v2/docs/mcp-servers)
- [Providers](https://opencode.ai/v2/docs/providers), [Compaction](https://opencode.ai/v2/docs/compaction), [Snapshots](https://opencode.ai/v2/docs/snapshots)
- [Inference](https://opencode.ai/v2/docs/console/api/inference/)
- Pi: [upstream](https://github.com/earendil-works/pi), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

`@opencode/sdk/workerd` existe como artefato real (DO com SQLite, config e plugins); portanto **VPS não é requisito intrínseco**. Hospedagem (container local limpo → eventual VPS isolada → Workerd/DO) é decisão separada, posterior à fatia funcional.

## 3. Topologia proposta do experimento

- Processo/instância dedicado por fronteira `actor + workspace` na POC com poucos usuários; conversas são sessões dentro dela.
- Primeira entrega: **spike local sem LLM**, com Node e `@opencode/sdk` embutido em container limpo (SDK evita listener HTTP adicional; servidor HTTP privado com cliente explícito continua alternativa válida, mas adiciona superfície sem benefício inicial demonstrado).
- `HOME`/`XDG`/config/data/cache limpos e exclusivos; sem repos, config, skills ou MCP pessoais, sem socket Docker/SSH.
- Rede mínima: API sintética + provider aprovado. Runtime privado, sem painel/admin exposto ao browser. Disco persistente exclusivo para sessões; processos sem privilégio.
- Mapeamento de sessão inclui `workspace`, `actor`, `device`, `conversation` e `channel scope`. **Primeira versão sem prometer sessão entre canais.**
- Modelo e tokens de produto **não** são lidos neste trabalho; a campanha futura usa modelo/provider aprovados e orçamento próprio (ver `05-evaluation.md`).

## 4. Fronteira de identidade e transporte

- O gateway autentica via BetterAuth e token delegado da API (workspace, actor e device **server-derived**).
- Mapear `conversation → runtime session` no gateway; **nunca aceitar `sessionID` do cliente como autenticação**.
- Reaproveitar o transporte atual da PWA com um **adaptador**; não copiar JSON bruto do OpenCode para o frontend.
- Envelopes PWA existentes são preservados pelo adaptador: envio `sendAgentMessage` (`apps/pwa/.../agent-client.ts`, corpo `{text, attachments?, intentionId}`) com resposta `{turnId, intentionId, status, output, memorized, pendingOperation, undoProposal}` (não `response.text`); decisão via `decidePendingOperation` com `{decision, requestId}` e receipt validado contra o contexto esperado que vincula o alvo. `attestation` nunca vai ao browser.
- Sessões atuais seguem ADR-027 (coletivo default, privado opt-in); POC actor-private só com dados sintéticos pode ser exceção experimental — sem mudar silenciosamente o default do produto; paridade futura inclui visibilidade workspace/privado, dono e ID de conversa.
- A projeção PWA de sucesso exige receipt/outcome no schema compartilhado (`packages/llm-contracts/src/types.ts`, `MutationReceipt`, `PendingOperationPresentation`, `isActionablePendingOperationPresentation`); texto do LLM nunca emite estado financeiro.

## 5. Tools do plugin e contexto de execução

- Tool de plugin chama a API financeira por **cliente agnóstico ao runtime**, com contexto imutável por execução.
- Proibido: token global mutável, `process.env` por turno, `PUT session/environment` com segredo, `_meta` MCP de sessão como auth.
- Segredos fora de prompts, histórico e browser.
- Remover no plugin as tools de shell, filesystem genérico, execute genérico, subagents e MCP; **reenumerar o catálogo efetivo após boot/reload**; `policies` só se a versão fixada comprovar suporte.
- Tool allowlist + defesa no processo; não confiar em prompt para impedir leitura de arquivos.

### Catálogo inicial proposto (não implementado)

| Tool do experimento | Rota/contrato existente a adaptar | Resultado/limite |
|---|---|---|
| `list_accounts` | `GET /accounts` | IDs, nomes, tipo e saldo; respeita status/escopo |
| `list_categories` | `GET /categories` | IDs, nomes, kind e hierarquia |
| `list_transactions` | `GET /transactions` | Filtros tipados de conta/categoria/data/kind; paginação e limite explícitos, lista parcial nunca vira total |
| `get_month_summary` | `GET /dashboard/month-summary?yearMonth=YYYY-MM` | Total por janela, moeda e período efetivo |
| `list_cards` | `GET /cards/accounts` | Cartões, não faturas |
| `list_statements` | `GET /cards/statements` | Faturas e estados |
| `get_category_breakdown` | `GET /analytics/category-breakdown` | `period=custom`, `from`, `to`, `kind` e basis; comparação faz duas consultas |
| `propose_expense` | `POST /pending-operations/v2/propose`, tool financeira `transactions.expense.create` | Args completos nos schemas existentes, apresentação canônica; nenhum lançamento antes da confirmação |

Contratos reais e query shapes: `apps/agent/tests/ted-f1-baseline.test.ts:63–99`, tools/clientes existentes e rotas API. O adapter deve validar cada rota com backend sintético, não copiar o fixture como prova de funcionamento.

Identidade, token, chave de idempotência e `intentionId` não são argumentos preenchidos pela LLM. O host injeta um contexto confiável por execução. Resultados fornecem payload estruturado da API e metadados mínimos de período/paginação/origem; erros mantêm código tipado e texto seguro. `401/403`, `409`, `429`, timeout e payload inválido não viram lista vazia. Não duplicar regras de saldo, rename, categoria ou policy no plugin.

Um pedido pode executar várias leituras e preparar **no máximo uma nova proposta por intenção** na POC. A chave da proposta é estável para essa intenção/identidade/slot, definida pelo adaptador antes da chamada, não pela LLM nem por um ID novo a cada retry. Repetição com args iguais reusa a proposta; args diferentes na mesma chave geram conflito explícito. Correção posterior usa nova intenção e ação de cancelamento da proposta antiga, ou esclarecimento; não acumular duas propostas acionáveis sem declarar isso. Mais de uma escrita por turno é paridade futura.

Skills iniciais: `financas` (valores/datas/completar campos sem inventar), `contas-cartoes` (conta/cartão/fatura e limites de capabilities), `analise-financeira` (janelas, totais/paginação e comparação). Persona, consulta à API e distinção proposta/execução ficam nas instruções essenciais sempre presentes. Não condicionar autorização à skill ser carregada; não criar seletor regex próprio para decidir quando carregá-la. O catálogo nativo deve conter somente essas skills empacotadas, e seu uso real será observado na campanha.

## 6. Dedup, ordenação e eventos (transporte, sem segunda state machine financeira)

- Dedup nativa de prompts por IDs deve ser **testada inclusive em crash e concorrência**; usar `clientMessageId`/`intentionId` estáveis, fila serial por conversa e mapa persistente **transport-only**.
- Nenhuma segunda state machine financeira: a API Pending V2 (`apps/api/src/routes/pending-operations.ts`, store em `apps/api/src/approvals/pending-v2.ts` com hash de bindings, attestation, lease e outcomes) continua a única autoridade.
- Eventos nativos são live-only com resync via history/API (`pending-outcome`); evento perdido não implica comando perdido nem autoriza reenvio.
- Incerteza não gera nova chave nem mensagem de sucesso.

O adaptador aceita identidade de entrega estável e rejeita reutilização do mesmo ID com conteúdo divergente. Primeiro verificar se admissão/retention nativas cobrem isso; só manter índice de entrega adicional se houver lacuna demonstrada. Persistir mapeamento de conversa/turno e referências, não um espelho de estados `proposed/confirmed/executing` da API. Após crash, não pedir à LLM que “tente novamente” uma escrita: consultar a operação pela referência/chave existente e resolver pela API.

O provider conversacional da POC usa a integração nativa OpenCode aprovada. O relay TED atual recebe texto/system, não é automaticamente um endpoint OpenAI-compatible com tool-loop. Não reconstruí-lo para o experimento. Antes de tráfego real, decidir como manter a governança central de modelos, quotas e privacidade da API (ADR-009): fonte de configuração única ou adaptador mínimo de configuração, sem segundo catálogo/roteador. Esta exceção sintética não altera a governança vigente.

## 7. Superfície financeira inicial

Fonte autoritativa: `V2_APPROVAL_CAPABILITIES` em `apps/api/src/routes/pending-operations.ts` (`financial.approval.propose/read/confirm/execute/reconcile/retry/cancel/autoexecute`) e as 9 tools em `packages/llm-contracts/src/types.ts:379-389`:

`transactions.expense.create`, `transactions.income.create`, `transactions.update` (descrição-only), `accounts.create/deactivate/update` (rename), `categories.create/update/deactivate`.

Regras da primeira escrita:

- **Somente `transactions.expense.create`, e somente por proposta.** Tools expostas ao modelo não incluem confirm, execute nem REST cru.
- Confirmação na POC por **ação autenticada na PWA/canal, vinculada à proposta exibida + intenção + reconsulta/API**; texto "sim" pode orientar ou apresentar a ação, mas **não autoriza sozinho pelo modelo**.
- Confirmação puramente conversacional fica como **gap de compatibilidade / gate futuro explícito**, sem inventar roteador por regex e sem afirmar paridade.
- Ator, escopo e bindings são validados pela API; a apresentação deve ser actionable (`isActionablePendingOperationPresentation`); attestation só no servidor; **receipt único comprova sucesso**.
- Não confundir gate actionable (displayable) com prova de visto: o gate em `apps/api/src/routes/pending-operations.ts:89-109` prova que a operação **era displayable** com contexto completo no momento do check, nunca que um humano viu o card.
- Propostas corrigidas exigem cancel/supersede pelo protocolo existente ou clarification; **não editar o banco de pendentes**.
- Leitura + proposta com total exclui o valor ainda não executado.
- Parcelamento, undo e demais writes ficam fora do escopo inicial: responder honest-unsupported e registrar na matriz de cobertura; não chamar de sucesso.

## 8. Cobertura e honestidade

Matriz de cobertura mínima da POC: leitura real, `expense.create` por proposta, confirmação vinculada, ausência honesta, instrução maliciosa tratada como dado, fora de escopo declarado. Parcelamento/undo/edição além de descrição-only contam como não suportados. Taxa global de cobertura e taxa dentro do escopo são reportadas separadamente (detalhes e thresholds em `05-evaluation.md`).

## 9. Critérios de aceite da SPEC

- **AC1:** boot isolado e inventário nativo sem tools/skills/MCPs pessoais ou capacidades administrativas; duas identidades não acessam sessões/segredos uma da outra.
- **AC2:** mapping inclui identidade financeira completa, conversa e canal; mudança de workspace/device não reutiliza autorização anterior.
- **AC3:** PWA recebe envelopes existentes; não vê eventos administrativos, tokens, atestações ou estado financeiro fabricado por prosa.
- **AC4:** oito tools iniciais atingem rotas reais de teste; limites de paginação/ausência/erro observáveis; modelo não fornece escopo/chaves.
- **AC5:** uma despesa passa proposta→ação autenticada→execução→receipt; duplicação/conflito/crash não produzem segundo efeito.
- **AC6:** restart, compactação e desconexão preservam continuidade ou retornam limitação explícita; jamais autorizam pelo resumo.
- **AC7:** ausência de memória durável, confirmação textual, conversa coletiva e capabilities fora da POC é declarada; não há claim de paridade completa.
- **AC8:** resultados comparados pelo [protocolo de avaliação](05-evaluation.md), incluindo qualidade real, custos e código próprio adicionado.

## 10. Portas para os demais documentos

- Passos, gates e comandos: `04-incremental-plan.md`.
- Comparação justa, dataset `RT-*`, integridade, métricas e tetos: `05-evaluation.md` (já redigido pelo Planner).
- Migração/rollback e o que **não** desfaz ledger: `06-migration-rollback.md`.
- Incertezas, donos e esforço relativo: `07-risks.md` e `docs/adr/ADR-030-ted-runtime-experiment.md` (status `proposed`).

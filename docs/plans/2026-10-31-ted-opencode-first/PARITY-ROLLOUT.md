# Matriz de paridade, rollout e rollback — TED OpenCode-first

**Uso:** gates para evoluir do runtime experimental à PWA; **nenhum rollout produtivo autorizado**.

## Matriz inicial (não converter evidência sintética em paridade)

| Capability / requisito | Evidência B em spike (relatada) | Produto B / PWA |
|---|---|---|
| Bootstrap, sessões e tools nativas | PROVEN em ambiente sintético | NOT_PROVEN |
| Consulta contas e resumo mensal | PROVEN em prompt-loop sintético | NOT_PROVEN |
| Informal e seguimento em sessão | PARTIAL (jornadas limitadas) | NOT_PROVEN |
| Mensagem sem contexto/ambiguidade | FAIL observado em J07-B | NOT_PROVEN |
| Continuação LLM após restart OS | BLOCKED por provider em experimento | NOT_PROVEN |
| Proposta `propose_expense` por LLM | PROVEN em sintético | NOT_PROVEN |
| Pending V2/PostgreSQL/confirm/recibo mesmo ID | PROVEN no SPIKE 05D sintético | NOT_PROVEN |
| Confirmação pela PWA | não testada end-to-end | NOT_PROVEN |
| Acesso workspace/actor/device | PROVEN em synthetic binding | NOT_PROVEN com auth real |
| Visibilidade ADR-027 (coletivo/privado) | cenário sintético actor-private não representa D3 | NOT_PROVEN |
| Múltiplas ferramentas do TED atual | 3 de leitura + proposta comprovadas | NOT_PROVEN |
| Anexos, memória, offline, undo e canais adicionais | não testados em B | NOT_PROVEN |
| Custo faturado e recursos por usuário | SDK cost 0 não é faturamento | NOT_MEASURED |
| Qualidade comparativa A0/A1/B | sem campanha equivalente | NOT_MEASURED |

**Correção documental:** ao consolidar J06, distinguir rodada original SPIKE 04 (conteúdo não validado) de J06L/J06LR posteriores reportados como isolamento com conteúdo exato. Manter traces e provenance; nenhuma campanha vira PASS por copiar veredito de outra.

## Gatilhos para expor a usuários

1. **Local:** dados sintéticos, flag off por padrão e um runtime owner por conversa; sem escrita.
2. **Staging:** identidade autenticada real apenas em staging autorizado, cenário de visibilidade workspace/private, isolamento e replay; revisão de rede, banco e provider; recuperações exercitadas.
3. **Canary autorizado:** coorte pequena nomeada com observabilidade de qualidade/custo, rollback serial ensaiado; pending existente tratado na API. Somente após autorização humana específica de produção.
4. **Generalização:** monitorar regressões, revisão de paridade, opção A0 disponível; remover A0 só após autorização independente.

## Rollback e estados incertos

- Flag OFF bloqueia novas admissões B e preserva A0; manter atribuição por conversa para não executar duas vezes.
- Drain do turno anterior antes de mudar o owner; se Pending `executing` ou `confirmed`, perguntar estado à API e seguir recuperação autoritativa, nunca repetir write sob nova chave. Desconhecido = congelar/reconciliar.
- Não replicar ledger para OpenCode; não restaurar banco financeiro ao alternar runtime.
- Não migrar chats privados/coletivos automaticamente sem provenance e validação ADR-027.
- Mudança no SDK OpenCode exige revalidar direct API `session.shell`, façade, plugin discovery, tool schema, provider config, session storage, restart real e prova de não exposição.

## Decisões pendentes antes de produção

Topologia VPS/container versus Workerd/DO; TLS e auth entre PWA e runtime; propriedade persistente multi-usuário de conversa; retenção e exportação; recursos/custo faturado; escopo da paridade e confirmação política de risco; migração de histórico; observabilidade/alerts; ownership de Pending V2 em transição. Resolver com evidências, sem presumir que escolher OpenCode resolveu os requisitos de produto.

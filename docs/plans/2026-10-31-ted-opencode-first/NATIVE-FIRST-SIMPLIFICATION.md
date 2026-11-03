# Adendo de execução — Simplificação native-first do TED

**Data:** 2026-11-03  
**Decisão do operador:** priorizar a funcionalidade observável do OpenCode antes de acrescentar controles próprios; eliminar duplicações com o SDK/runtime nativo.  
**Escopo:** implementação **local/sintética** na worktree `D:/projetos/pi-ted-opencode-product`; **não autoriza produção, provider pago, writes reais, push de código ou deploy**.

## 1. Por que este adendo existe

A migração OpenCode-first foi escolhida para substituir o harness conversacional personalizado por recursos nativos. Nos testes P2, um hook/guard da integração TED bloqueou um `session.prompt` com `guard:bad-model`: `providerMatch=true`, `modelMatch=false`. O valor exato do `modelID` observado não foi preservado. A tentativa não chegou ao provider, e a PWA recebeu `502 prompt.no_output`.

**Hipótese, não fato provado:** o controle extra compara modelos em formatos/níveis diferentes ou conflita com a seleção nativa. O código local deve ser inspecionado antes de concluir qual arquivo implementa o hook. Não afirmar que o provider estava errado nem inventar alias.

Outro ciclo de gates sintéticos sem prova de conversa funcional não é o objetivo. Este adendo reordena **somente o desenvolvimento local**: primeiro usar configuração e seleção de modelo do OpenCode, depois comprovar chat/continuidade, então integrar tools TED e apenas acrescentar controles específicos justificados.

## 2. Regra arquitetural

**Preferir sempre o recurso nativo do OpenCode; nenhum componente próprio deve duplicá-lo sem lacuna concreta, teste e justificativa.**

| Necessidade | Responsável principal | Ação na worktree |
| --- | --- | --- |
| Conexão e catálogo de providers | OpenCode | Inspecionar configuração e catálogo efetivos do projeto |
| Modelo default | Configuração nativa OpenCode | Usar identificador real `provider_id/model_id`, descoberto no catálogo |
| Modelo por turno/sessão | SDK/seleção nativa | Validar tipos reais da versão instalada; manter conversa e IDs |
| Prompt-loop, tool calling e contexto | OpenCode | Remover wrappers redundantes, sem trocar por outro harness |
| Persistência/recuperação da sessão | OpenCode | Conservar só o vínculo com identidade e visibilidade do TED |
| Prompt/DTO/UI | Gateway + PWA TED | Adaptador mínimo compatível com contratos existentes |
| Dados, regras e confirmação financeira | API Fastify + Pending V2 | Não duplicar no modelo, plugin ou gateway |

A documentação atual do OpenCode descreve configuração de modelo default, catálogo/seleção de modelos e parâmetro de modelo nas chamadas de SDK. **O agente deve verificar os campos e suporte exatos no SDK 2.2.4 instalado**, não copiar cegamente exemplos de outra versão.

Referências externas: https://opencode.ai/docs/models/ ; https://opencode.ai/docs/sdk/ ; https://opencode.ai/docs/permissions/.

## 3. O que simplificar agora

1. **Guard de modelo próprio:** identificar o hook que produz `guard:bad-model`, registrar o esperado e o recebido, e verificar se é duplicação da seleção/configuração nativa. Em **ambiente local sintético isolado**, retirar o guard redundante do caminho experimental ou tornar seu uso opcional/default-off **apenas nesse perfil**. Não substituir por outro motor de aliases, comparações flexíveis ou um catálogo paralelo.
2. **Seleção nativa:** descobrir provider e modelo no catálogo efetivo; configurar default no OpenCode; testar a seleção de um modelo diferente para turno posterior da **mesma conversa**, respeitando recursos reais da versão instalada. Modelo ausente deve produzir diagnóstico claro, não fallback implícito para modelo pago.
3. **Fluxo mínimo:** PWA → gateway fino → sessão e prompt nativos → resposta → histórico/reload. Evitar ciclo de instrumentação que impede demonstrar o comportamento.
4. **Tools TED:** depois de comprovar o chat básico, conectar `list_accounts` e `get_month_summary` usando o plugin mínimo já implementado; não criar router de intenções nem tool-loop alternativo.
5. **Remoção de duplicações:** para cada abstração removida, registrar qual recurso nativo a substituiu, código/testes afetados e se houve mudança contratual. Não apagar blindagens necessárias em lote.

**Não é objetivo** criar uma suite universal de seleção de modelos, um plugin de segurança genérico ou migrar SDK antes de ter uma experiência funcional.

## 4. Fronteiras que NÃO são segurança opcional

Simplificar o produto **não significa enfraquecer os contratos financeiros existentes**:

- API mantém Better-Auth, membership, escopo de workspace/ator, Pending V2, idempotência, política de risco e recibos. LLM não confirma nem executa lançamentos sozinha.
- Nenhuma chave/token vai para prompt, browser ou logs. Modelos e providers não devem obter credenciais financeiras brutas.
- SDK/servidor OpenCode completo **não é exposto diretamente à PWA ou a clientes não confiáveis**. O spike provou que `session.shell` por API direta não dependia do deny do prompt-loop. Manter runtime privado, isolamento do processo e apenas endpoints TED necessários.
- Tools de shell, edição e administração não fazem parte do assistente financeiro. Preferir configuração/permissões nativas e isolamento de processo, em vez de criar outra camada genérica de hooks. Validar comportamento efetivo da versão instalada.
- A0 continua ativo em produção. Feature flag do OpenCode permanece OFF por padrão fora do harness local; nunca dois donos executando a mesma intenção.
- Nenhuma inferência paga está autorizada por este adendo. Uma nova campanha exige provider, modelo, teto e escopo explícitos; os tetos anteriores estão encerrados.
- No local, simplificação pode preceder hardening extra; antes de staging/produção, revisar ameaças concretas e provar as fronteiras acima.

## 5. Ordem de execução e gates pequenos

**S0 — Descobrir e configurar (offline):** inspecionar implementação do hook, configuração efetiva, providers/modelos disponíveis e versão do SDK. Criar teste que reproduza a rejeição; aplicar correção mínima; demonstrar default e seleção por turno com testes determinísticos. **PASS** sem provider.

**S1 — Chat simples pela PWA (offline sempre que possível):** provar envio, resposta e recuperação de uma mesma conversa com provider de teste local ou resposta registrada, sem fingir que isso é inferência live. Se a única prova restante for live, marcar `READY_FOR_LIVE`, não repetir chamadas pagas.

**S2 — Tools de leitura:** integrar as duas ferramentas TED existentes ao mesmo chat; comparar oráculos de contas e resumo; preservar DTOs e estado de histórico.

**S3 — Um único turno live, somente após autorização nova:** usar provider/modelo confirmados no catálogo e orçamento especificado; recuperar a **mesma** conversa após restart e reload real no navegador; não executar retries automáticos.

**S4 — Próxima fatia funcional:** preparar P3 apenas com interfaces e testes sintéticos, sem escrita real. Solicitar autorização independente para campanha live de mutação e qualquer publicação.

**Gates por fatia:** RED→GREEN do comportamento alterado, integração focada e revisão independente proporcional ao risco. Executar os gates canônicos de `AGENTS.md` antes de declarar entrega global concluída; se `pnpm lint`/Biome expirar, registrar `TIMED_OUT/NOT_VERIFIED`, diagnosticar isoladamente e não recomeçar P2 do zero.

## 6. Medida de sucesso

Relatório curto com: (a) funcionalidades observadas pela PWA, (b) recursos nativos de OpenCode efetivamente usados, (c) abstrações próprias removidas/simplificadas e motivo, (d) testes relevantes e lacunas, (e) estado real do `READ_SLICE_PASS`, (f) consumo de provider **verificado ou NOT_VERIFIED**, (g) próximo passo prático. Não contar documentação ou mocks como feature pronta.

**Regra anti-loop:** depois de dois ciclos com a mesma falha, registrar hipótese, reproducer e decisão de menor escopo; não criar novo guard, framework ou spike para solucionar falta de configuração nativa.

# Migração e rollback (propostos, nada autorizado)

**Estado:** proposta. Nenhuma migração de runtime, dado ou tráfego está autorizada. Freeze de produção mantido. Rollback aqui significa **trocar o runtime em teste de volta**, nunca desfazer ledger financeiro nem restaurar banco antigo.

## 1. O que esta seção não é

- ADR-006 permanece como registro aceito histórico; sua **implementação de alternância com Pi foi retirada**. A busca em `apps` não encontrou `FINANCE_RUNTIME_STAGE`, e `worker.ts:354–358,397–399` documenta a retirada do gate. Não recomendar seus antigos stages como mecanismo vivo; preservar o princípio de **um owner por turno** sem reativar o Pi legado.
- Trocar o runtime **não desfaz** lançamentos confirmados nem restaura snapshot financeiro. Backup/restauração aqui cobre **apenas o estado do runtime em teste** (sessões, disco do experimento); dados financeiros seguem o runbook eventual do operador, fora deste experimento.

## 2. Pré-condições de qualquer movimento (gates, não defaults)

1. Experimento restrito a backend sintético e identidades sintéticas; nenhum token, workspace ou dado real entra no runtime em teste.
2. API Pending V2 (`apps/api/src/routes/pending-operations.ts`, `apps/api/src/approvals/pending-v2.ts`) continua a única autoridade; pendentes permanecem na API mesmo que o runtime de conversa mude, inclusive por device.
3. Histórico original é read-only: sessões novas começam sem transcrição automática de segredos, pendentes ou contexto sensível.
4. Mapping mínimo e persistente no gateway (workspace, actor, device, conversation, channel scope); owner persistente por conversa; **pausar o runtime antigo em série antes de ativar o novo** (sem big lease system adicional salvo sobreposição comprovada).

## 3. Drenagem antes de reassignment

- Bloquear novas admissões na conversa, registrar último ID admitido e aguardar o worker antigo encerrar ou ser interrompido. Interrupção não comprova que uma tool não fez commit.
- Para `executing`, consultar outcome e reconciliar lease expirada pela API até resultado conhecido. Para `confirmed`, usar o caminho de recuperação de confirmação/atestação e execução idempotente existente: **não tratar confirmed como lease expirada**. Se não for possível resolver, congelar aquela conversa/operação e escalar; nunca alternar automaticamente e repetir create.
- Para `proposed`, manter pendência na API com mesma identidade/device e apresentar novamente no canal autorizado, ou cancelar pela API com decisão humana. A troca de runtime não concede nova confirmação.
- **Nunca** fallback de escrita incerta automático: timeout sem confirmação = estado desconhecido/pendente, nunca sucesso sem recibo (ver `05-evaluation.md` §4).
- Runtime antigo em teste não recebe a mesma intenção durante rollback; revalida-se contra recibo/estado da API antes de qualquer reemissão com o mesmo `clientMessageId`/`intentionId`.

## 4. Rollback do experimento (troca de runtime, sem efeito financeiro)

| Situação | Ação proposta |
|---|---|
| Falha de isolamento/integridade no spike (Passos 0–4) | Parar o runtime em teste, preservar evidência restrita, voltar ao harness atual; nenhum tráfego real foi movido |
| Falha nos hard gates da campanha (Passo 5) | Declarar `NO_GO`/`INCONCLUSIVE`; arquivar manifest, dataset e resultados; sem canary |
| Canary futuro autorizado degrada | Reversão serial para o runtime anterior após drenagem (§3); sessões novas, sem carregar histórico do experimento |

## 5. Sessões, visibilidade e paridade futura

Sessões atuais seguem ADR-027 (coletivo default, privado opt-in). POC actor-private só com dados sintéticos é exceção experimental explícita; paridade futura com o produto incluiria visibilidade workspace/privado, dono e ID de conversa — fora do escopo desta proposta.

## 6. Caminho eventual de migração do produto (condicional)

1. Após experimento promissor, aprovar matriz de paridade por capability: confirmação conversacional, coletivo/privado, memória/forget, anexos e canais. Lacuna não coberta precisa de aceitação explícita; não escondê-la como migração transparente.
2. Validar provider/privacidade/quota e política central de configuração (ADR-009). Decidir VPS versus Workerd com medição de recursos, operação e recovery, sem presumir vantagem pela localização.
3. Ensaiar snapshot/restore do storage de sessões em instância descartável e testar atualização de versão pinada com rollback de imagem **e** compatibilidade de schema. Não fazer downgrade sobre storage migrado sem prova; recuperar snapshot de sessões somente em ambiente controlado, reconciliando referências com a API vigente.
4. Com autorização nova para canary, direcionar apenas conversas novas da coorte nomeada. Conversas antigas e pendências em voo ficam no owner anterior até drenagem. Gateway mantém uma atribuição persistente por conversa; nenhuma execução shadow de escrita.
5. Critério de reversão: qualquer violação de integridade/isolamento interrompe a coorte; regressão de qualidade, custo ou latência além dos limites aprovados pausa novas admissões e aciona avaliação. Resolver em voo antes da troca conforme §3.
6. Retirar runtime anterior somente depois de paridade aceita, janela de observação aprovada, ausência de operações em voo e backup recuperável. Preservar histórico read-only e evidências conforme retenção; nenhum descarte de dados é autorizado por este plano.

No piloto de poucos usuários, pausa serial + roteamento persistente é suficiente como desenho inicial. Só adicionar mecanismo de fencing/lease próprio se o teste demonstrar sobreposição que esse desenho não contenha; leases financeiras continuam exclusivamente na API.

# Observabilidade da autorização automática do TED

**Estado:** orientação operacional; sem sink ou dashboard persistente novo.
**Referência:** [SPEC V5, §24](../MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md#24-métricas-de-rollout).

A API emite logs estruturados sanitizados para
`mutation.authorization.evaluated`, `mutation.autoauthorized` e
`mutation.autoexecute.blocked`. A telemetria não é atualmente um sink durável
de análise; métricas abaixo são definições e fontes disponíveis, não números
prontos nem prova histórica. Retenção, agregação e consultas recorrentes ficam
deferidas para operações até existir um consumidor/sink aprovado.

| Métrica | Fonte disponível hoje | Limite atual |
| --- | --- | --- |
| Taxa de autoexecução | `mutation.autoauthorized` sobre avaliações elegíveis em `mutation.authorization.evaluated`; segmentar por tool/risk | Eventos de log não são garantidamente persistentes nem fornecem denominador durável. |
| Taxa de clarificação | Turnos com resultado `clarification` no Agent, sobre turnos de mutação | Não é um dos três eventos de autorização; exige telemetria de turnos para contagem. |
| Taxa de confirmação manual | Auditoria de PendingOperation V2 com modo `manual`/confirmação | Requer consulta autorizada ao audit trail canônico; log isolado não fecha o denominador. |
| Taxa de duplicidade possível | `mutation.autoexecute.blocked` com reason de duplicidade | Usar somente reason sanitizado; não inferir duplicidade de texto livre. |
| Falha de autoexecução | `mutation.autoexecute.blocked` e auditoria `authorize`/`execute` correlacionadas | Distinguir bloqueio pré-efeito de falha posterior; os três eventos não classificam todo resultado. |
| Execução incerta | Estado/auditoria de execução incerta da PendingOperation V2 após `authorize`/`execute` | Não há evento dedicado entre os três; consultar estado/audit canônico. |
| Undo após autoexecução | `mutation.autoauthorized` correlacionado por operação/receipt com auditoria posterior de undo confirmado | Requer retenção e correlação do audit trail; nunca correlacionar por conteúdo livre. |

Na Fase 22, validar existência dos logs e ausência de argumentos financeiros,
credenciais e dados pessoais. Não habilitar canary com base apenas em logs
efêmeros: operações deve primeiro definir sink persistente, retenção,
permissões e consulta reproduzível, então estabelecer baseline e alertas.

## Mapeamento dos eventos

- `mutation.authorization.evaluated`: avaliação determinística (principalmente
  shadow), útil para decisões/reasons por tool e risco.
- `mutation.autoauthorized`: passagem pela autorização automática; não prova
  sozinha que o efeito terminou com sucesso — validar receipt/estado V2.
- `mutation.autoexecute.blocked`: decisão/caminho bloqueado; reason é categoria
  sanitizada, não prova de falha financeira.
- Audit trail/estado PendingOperation V2 permanece autoridade para confirmação,
  execução, incerteza e undo. Eventos não substituem o ledger financeiro.

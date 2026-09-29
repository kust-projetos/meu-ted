# ADR-013 — Protocolo de execução com lease e recuperação

**Status:** Aceito  
**Data:** 2026-09-14

## Contexto

Uma mutação confirmada não pode ficar eternamente em execução nem ser
reexecutada como nova aprovação após falha do executor. Sem lease, uma
recuperação ambígua pode duplicar efeitos financeiros ou ressuscitar estados
terminais.

## Decisão

A execução segue o protocolo em duas transações: TX1 (`claim`) consome a
attestation, marca `status=executing`, grava as colunas de lease e incrementa
a contagem de tentativas; o executor roda FORA da transação; TX2 registra
`succeeded`/`failed` com `failure_code` sanitizado e `mutation_id`.

O lease de execução tem expiração, e o reconciliador reexecuta o MESMO
executor com a MESMA `idempotencyKey` (recuperação, não nova aprovação). A
recuperação do estado `confirmed` ocorre EXCLUSIVAMENTE por reemissão de
attestation e NUNCA usa lease (as colunas de lease só são escritas no claim).
Estados terminais nunca retornam à execução.

Contrato refinado (sem nova ADR): erros determinísticos conhecidos
pré-write permanecem `failed` (com `failure_code` sanitizado) e o retry
explícito é permitido pela mesma operação pendente (`failed → confirmed`,
nova attestation). Qualquer throw do writer após o início da escrita,
resultado de sucesso ausente/inválido, falha de normalização do receipt ou
falha de construção do receipt é resultado incerto: a operação permanece
`executing` (`approval.execution_uncertain`, sem persistir `failed`, sem
evento `fail`, sem retry/nova aprovação); a lease expirada é reconciliada
com a mesma `idempotencyKey` persistida. Sucesso exige `operationId`
(top-level/decisão) e `receipt.operationId` iguais ao ID da operação
pendente, com `receipt.entity = { type: 'transaction', id: transactionId }`;
`succeeded` sem receipt é resultado inválido/incerto.
Antes de aceitar uma attestation de `confirm`/`retry`, ou concluir um
`cancel`, o Agent exige que o `id` retornado pela API corresponda exatamente
ao ID solicitado; mismatch aborta a decisão e impede `/execute`. Um
cancelamento só é reportado após a API retornar `status = cancelled`.

A migration V052 é aditiva e backward-compatible: apenas adiciona as colunas
de lease, sem alterar colunas ou comportamento existentes.

## Consequências

A recuperação é idempotente por construção via mesma chave de idempotência.
Falhas determinísticas pré-write geram códigos sanitizados auditáveis; uma
operação cujo resultado permaneça incerto fica `executing` até uma reconciliação
bem-sucedida ou intervenção operacional — nunca é convertida em retryable
`failed` apenas para encerrar o estado. O caminho `confirmed` permanece distinto
do caminho de lease sem confusão entre reemissão e recuperação.

Enquanto o resultado permanece incerto, o card de confirmação da PWA trava
(sem confirmar/cancelar/retry), não chama `onResolved` nem declara sucesso,
e orienta refresh/rechecagem antes de nova decisão. O E2E live usa exatamente
um POST de decisão por operação pendente e confere o ID da transação do
receipt contra o ID do ledger.

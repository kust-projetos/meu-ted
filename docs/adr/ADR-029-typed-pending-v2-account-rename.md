# ADR-029 — Extensão tipada de Pending V2 para renomear contas

**Status:** accepted (decisão de implementação local; validação em andamento)
**Data:** 2026-10-21

## Contexto

O operador autorizou testes e correções autônomas da operação financeira conversacional. A auditoria local encontrou uma diferença entre catálogo e execução: a API V2 aceita criação de despesas/receitas e criação/desativação de contas, enquanto outras escritas anunciadas nas skills não possuem caminho V2 completo. O escopo original do ADR-021 descreve apenas transações e não deve ser usado para alegar cobertura dos demais domínios.

## Decisão

Superseder exclusivamente o limite de dois comandos do ADR-021 para admitir os comandos de contas já existentes (`accounts.create`, `accounts.deactivate`) e uma nova fatia nome-only `accounts.update`. O protocolo de undo independente, aposentadoria de V1 na superfície do modelo e demais invariantes do ADR-021 permanecem inalterados. Esta decisão não libera os demais comandos do catálogo.

O novo comando usa argumentos estritos `{ accountId, name, expectedName }`: alvo UUID autoritativo no workspace, novo nome aparado de 1 a 120 caracteres e nome canônico anterior como precondição exata. Apenas contas ativas `bank`/`cash`; não altera tipo ou saldo. Alvo ambíguo ou nome ausente exige esclarecimento; nome idêntico não cria proposta. Modelo não escreve diretamente e nenhum novo comando é elegível a autoexecução.

A proposta, apresentação e execução validam a identidade e o alvo. A apresentação mostra **De / Para**, com `account.label = expectedName` e `accountName = name`; sem os dois nomes e o alvo autoritativo, não há confirmação acionável. Hash e fingerprint vinculam os três argumentos. Um nome concorrente divergente antes do primeiro efeito impede a alteração, com comparação dentro da transação do writer, não somente em um SELECT prévio.

A fronteira keyed persiste efeito e resultado atomicamente. Replay concluído retorna o resultado original antes de revalidar estado mutável; recovery pós-commit/pré-fecho da Pending usa a mesma chave, nunca cria outro efeito nem falha apenas porque o nome já mudou. O mesmo requisito de replay estável é aplicado à criação de contas antes de expandir o padrão.

O recibo tem `mutationKind = accounts.update`, `entity.type = account`, ID do alvo original e `operationId` da Pending. O registro de efeitos invalida `accounts` e `dashboard-summary`. Agent e ambos os parsers PWA recusam recibos com identidade/kind/entidade divergentes.

## Validação e limites

Cada fatia exige RED → GREEN, teste de isolamento e ambiguidade, cancelamento sem efeito, replay/concorrência e recovery em PostgreSQL local descartável. Confirmar visualmente não substitui readback do nome e saldo. Testes e revisão ainda em execução estão registrados em `../reports/2026-10-21-ted-local-financial-validation.md`; esta decisão não é alegação de implementação concluída.

Categorias, transferências, edição/exclusão de transações, compromissos, cartões, parcelas e pagamentos permanecem fora desta decisão. A expansão futura exige contratos próprios para seus efeitos e recuperação, não um executor genérico baseado no catálogo nem a reabertura de V1 ao modelo.

## Impacto e rollback

Mudança aditiva, preservando drafts e pendings existentes. Não remover do código uma variante já persistida em operação sem preservar leitura/recovery. Reversão local pode suspender novas propostas, mas precisa manter recuperação das já criadas. Não há migration destrutiva, ampliação de grants, rotação de credenciais ou autorização de deploy. Produção permanece congelada.

## Referências

- [ADR-010](ADR-010-pending-operation-v2.md), [ADR-012](ADR-012-approval-contract-propose-validation-and-effects-registry.md), [ADR-013](ADR-013-execution-recovery-lease.md), [ADR-014](ADR-014-mutation-draft-multi-turno.md).
- [ADR-021](ADR-021-pending-v2-transactions-scope-undo-separate.md), [ADR-026](ADR-026-risk-based-mutation-authorization.md).

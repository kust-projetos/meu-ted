# Plano — simplificação arquitetural final (OpenCode-first)

**Goal:** consolidar a arquitetura OpenCode-first já operante, removendo
somente componentes comprovadamente obsoletos, duplicações e intermediários
dispensáveis, sem alterar autoridade financeira, Pending V2, autenticação,
isolamento por workspace, idempotência, recibos ou o rollback para A0.

**Base:** `main@1a10252` (2026-11-09) — runtime de produção com origem interna,
ativação explícita e kill switch.
**Escopo:** local, sintético e reversível. Sem merge, deploy, credencial real
ou dado financeiro.

## Etapas

1. **Auditoria** — inventário com classificação MANTER / SIMPLIFICAR /
   REMOVER em [`INVENTORY.md`](INVENTORY.md).
2. **Simplificação** — remover o broker sem runtime real, retirar o hook de
   shadow no-op e consolidar a validação de origem da API no runtime.
3. **Validação** — testes focados por componente e regressão dos fluxos
   financeiros existentes.
4. **Documentação** — atualizar `ARCHITECTURE-CURRENT.md`,
   `ARCHITECTURE-TARGET.md`, `runtime-facts.json` e a matriz de ownership.

## Não-objetivos

- Reescrever o A0, o orquestrador ou a interpretação estruturada.
- Mover autorização, confirmação ou execução para o runtime OpenCode.
- Alterar contratos públicos, schema, Pending V2 ou dados.
- Criar abstrações, serviços, gates ou arquiteturas novas.

## Critério de conclusão

OpenCode permanece o runtime conversacional principal; A0 permanece funcional
para rollback; nenhuma duplicação sem justificativa fica no escopo avaliado;
API, PWA e operações financeiras seguem funcionando; a documentação descreve o
código atual.

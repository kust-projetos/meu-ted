# Handoff — Implementar simplificação native-first no Meu TED

**Missão atual:** simplificar o caminho local do OpenCode e fazer a experiência de chat funcionar **antes** de adicionar hardening próprio. Este handoff é um **adendo** aos documentos `SPEC.md`, `PLAN.md` e ADR-031; apenas a ordem de desenvolvimento local foi refinada.

## Contexto confirmado pelo operador

- Worktree existente: `D:/projetos/pi-ted-opencode-product`, branch local `feat/ted-opencode-product`, **dirty** e com relatórios/traces preexistentes a preservar.
- P2 parcial: uma campanha anterior fez LLM → `list_accounts`/`get_month_summary` → API sintética → PWA; erros de histórico e paginação foram corrigidos/testados, mas a mesma conversa live ainda não foi recuperada em E2E browser após restart.
- Tentativa posterior `q7r2`: uma mensagem admitida por `session.prompt`, bloqueada pelo hook local `guard:bad-model` antes do provider (`providerMatch=true`, `modelMatch=false`); `modelID` recebido **não foi registrado**. Nenhuma tool financeira/inferência aconteceu nesse turno.
- Auth sintética, testes e harness de PWA existem. Último status `READY_FOR_LIVE` foi superado pela tentativa bloqueada. Último teto de inferência já foi consumido/encerrado; **sem nova autorização**.
- Produção/A0 e API real não foram alterados. Biome agregado em timeout / NOT_VERIFIED.

## Leia antes de editar

1. `AGENTS.md`.
2. `docs/adr/ADR-031-ted-opencode-first.md` (adendo de 2026-11-03).
3. `docs/plans/2026-10-31-ted-opencode-first/NATIVE-FIRST-SIMPLIFICATION.md`.
4. Relatórios da worktree `docs/reports/P2-*-RESULTS.md` e `docs/plans/2026-10-31-ted-opencode-first/IMPLEMENTATION-STATUS.md`.
5. Código real do bootstrap, model config, guard/hook, gateway, PWA e `apps/ted-runtime`.

## Como acessar documentação publicada SEM mexer no working tree sujo

De dentro de uma cópia do repositório:

```powershell
git status --short
git fetch origin docs/ted-opencode-first-migration
git show origin/docs/ted-opencode-first-migration:docs/plans/2026-10-31-ted-opencode-first/NATIVE-FIRST-SIMPLIFICATION.md
git show origin/docs/ted-opencode-first-migration:docs/plans/2026-10-31-ted-opencode-first/AGENT-NATIVE-FIRST-HANDOFF.md
```

Não fazer `git reset --hard`, `git clean`, `git stash --all` nem `cherry-pick` às cegas. O agente pode incorporar o texto documental à worktree quando seguro, mantendo arquivos e diffs originais.

## Tarefas concretas

### T0 — Inspeção objetiva (sem provider)

- Identificar o hook que emite `guard:bad-model`, seu contrato, seu perfil de ativação e o formato dos valores recebidos.
- Inspecionar credenciais **sem imprimir segredos**, catálogo real de providers/modelos e modelo default do OpenCode instalado. Separar provider configurado, modelo listado, modelo selecionado e disponibilidade real de rota (não inferir um do outro).
- Construir um mapa curto `componente próprio → recurso OpenCode nativo → remover/manter`. Não gastar uma rodada inteira só no inventário.

### T1 — Resolver a configuração nativa (TDD, sem provider)

- Reproduzir `guard:bad-model` em teste RED com o tipo de payload real do SDK, sem adivinhar aliases.
- Validar o identificador exato que o SDK usa para modelo padrão e para modelo passado ao prompt na **versão instalada**.
- Ajustar configuração do OpenCode para selecionar default a partir do catálogo efetivo. Sem fallback silencioso.
- Remover/desligar no **perfil local sintético** a verificação de modelo própria quando for duplicação e manter o caminho de erro claro para modelo não disponível. Não remover controles financeiros da API.
- Provar em teste que o mesmo `sessionID` admite modelo default e seleção explícita de um segundo modelo para o turno seguinte, caso o SDK suporte o fluxo. Comprovar sem rede/provider.
- Verificar que a escolha de modelo não concede tools financeiras adicionais nem acesso administrativo.

### T2 — Chat PWA funcional antes de mais controles

- Usar gateway/DTO/UX já existentes. Fazer uma conversa simples funcionar com resposta de teste deterministicamente injetada ou provider local sem custo.
- Validar histórico, reload e restart da mesma sessão. Testar no browser real quando disponível.
- Não declarar uma prova sintética como `READ_SLICE_PASS` live.
- Corrigir somente bugs reproduzidos; não abrir outra camada de interceptação.

### T3 — Retomar read slice

- Habilitar as duas tools de leitura já existentes, com identidade derivada do host e API local sintética.
- Testar `list_accounts`/`get_month_summary`, valores e recuperação da PWA. Preservar isolamento necessário, sem adicionar outro guard universal.
- Se uma prova exigir chamada live, registrar `READY_FOR_LIVE`; pedir autorização explícita (provider, modelo, teto e única mensagem), sem retries ou consumo automático.

### T4 — Remover redundâncias e revisar

- Excluir somente wrappers/guards duplicados provados, junto com seus testes obsoletos; preservar contratos necessários e casos de regressão.
- Comparar linhas/módulos removidos x adicionados e documentar simplificações reais.
- Executar testes focados, `typecheck`, `docs:lint`, governança e gates completos conforme `AGENTS.md` quando factível. O problema Biome não desaparece por default: registrar bloqueio e investigar em tarefa separada.
- Review técnico independente focado em **funcionalidade, simplificação e regressão financeira**, não produzir burocracia de aprovação sem evidência.

## Entregáveis

Atualizar `docs/plans/2026-10-31-ted-opencode-first/IMPLEMENTATION-STATUS.md` e criar `docs/reports/P2-NATIVE-FIRST-SIMPLIFICATION-RESULTS.md` com:
- configuração real, catálogo de modelos e causa do guard;
- componentes próprios removidos, mantidos e justificativa;
- provas offline/SDK/PWA e estado de live;
- regressões, limites e gastos verificados;
- próximo passo único.

**Critério de parada:** `NATIVE_CONFIG_PASS` + chat PWA determinístico funcional e `READ_SLICE_PASS` se houver autorização e prova live; ou `READY_FOR_LIVE` honesto se a única pendência for inferência.

**Não autorizado:** provider pago, escrita financeira real, production deploy, merge, PR, push de implementação, desligar A0 ou migrar dados.

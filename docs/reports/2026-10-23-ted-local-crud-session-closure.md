# Fechamento documental — campanha CRUD TED local (2026-10-23)

## Veredito

`CANARY_PASS_DESCRIPTION_ONLY` para edição conversacional da descrição de transação no ambiente local. Não é aceite de CRUD financeiro geral, nem validação de produção. A fonte e o runtime QA foram exercitados em uma fatia delimitada; fixtures sintéticas foram preservadas.

## Evidência do canário

O tester independente usou a única aba QA já aberta. Recovery de uma proposta Solar reproduziu a operação existente sem reexecutar o efeito; o receipt vinculou `transactions.update` ao alvo. Uma proposta Lunar atualizou a descrição e foi confirmada em recargas normais. O cancelamento Solar terminou `cancelled`, sem alteração da descrição. Readback final confirmou transações/valores presentes, conta bank `QAContaDescricao` com saldo de 96.766 centavos, e somente descrições/`updatedAt` alterados no escopo observado; não houve delta financeiro. As categorias observadas permaneceram inalteradas. Seeds normais dos formulários PWA não são prova de criação via TED.

Detalhes de IDs, snapshots, manifests e histórico técnico: [tracking vivo](2026-10-21-sessao-testes-correcoes-ted.md). A [matriz do browser](2026-10-21-ted-local-browser-matrix.md) conserva cenários e limitações da campanha anterior; o [relatório de validação](2026-10-21-ted-local-financial-validation.md) conserva implementação e gates intermediários. Esta síntese não substitui esses registros.

## Contrato e limites

O recurso validado é manual e restrito a alterar a descrição de uma transação, com proposta/decisão V2, identidade/escopo, precondição literal (`expectedDescription`), chave idempotente e receipt ligado ao alvo. Histórico não acionável não autoriza mutação; leituras de estado não devem criar transições. Nenhuma alegação é feita sobre categorias, valores, datas, conta, transferências, exclusão arbitrária, cartão, parcelas, assinatura, payables, faturas ou pagamentos. Operações não suportadas continuam dependentes de confirmação explícita pela matriz e devem falhar/recusar honestamente, sem inferência de sucesso.

Os documentos de contrato relevantes já são [ADR-021](../adr/ADR-021-pending-v2-transactions-scope-undo-separate.md) e [ADR-029](../adr/ADR-029-typed-pending-v2-account-rename.md). Esta sessão não cria decisão arquitetural nova nem amplia esses ADRs.

## Validação registrada e pendências

- Finding MEDIUM da revisão de memória: as reservas keyed in-memory de conta, categoria e transação eram separadas apesar do namespace `pending-v2:` compartilhado no PostgreSQL. Correção candidata unifica a reserva por household/key, mantém snapshots tipados e usa compare-and-delete para não remover reserva substituta após falha. Testes adicionados cobrem conflito entre tipos antes do segundo efeito, concorrência, retry após falha e replay de snapshots após mutação. A validação fresca completa desta correção permanece pendente; não é aprovação de review nem autorização de release.
- `.playwright-mcp/` foi adicionado como entrada exata de ignore a pedido do usuário; nenhum artefato local foi removido. `.claude/napkin.md` já estava marcado como deletado pelo usuário e deve permanecer assim para o commit futuro.
- Agent: suíte serial `3369 PASS / 1 skip`, `--maxWorkers=1`, timeout padrão de 5 s preservado; nenhuma exclusão nova. Execuções paralelas/default com timeouts no conjunto PDF não são aprovadas como suite completa.
- PWA: suite fresh OpenNext `2832/2832`, incluindo bundle budget; type/lint sem erros registrados.
- API: suite completa `2849 PASS / 172 skip` e typecheck/lint sem erros registrados em execuções anteriores do snapshot; não atribuir esses resultados como fresh gate final desta etapa. Provas PostgreSQL category lifecycle/keyed create e descrição (canonical/legacy) constam do tracking e têm escopo próprio; skips do runner padrão não são prova PG.
- Avisos de lint conhecidos: API 148, Agent 112 e PWA 26; não alegar zero warnings.
- A sessão não executou os gates finais do pacote após esta atualização documental, não esperou CI/reviews, não commitou/pushou, não fez merge/deploy, nem alterou configuração, aplicação, banco ou produção. A autorização posterior do solicitante para merge/deploy não é evidência de que tenham ocorrido.

**Próximo passo:** completar revisões pendentes e rodar os gates frescos/CI definidos pelo Planner; corrigir findings antes de integrar. Só registrar merge/deploy/smokes mediante evidência correspondente. Produção permanece sem mutação conhecida.

## Atualização posterior — publicação e primeiro CI

Os itens acima conservam o checkpoint anterior à publicação. O commit `c19a1dc` foi criado com todos os hooks ativos e publicado na branch `feat/ted-account-deactivate-v2`, no [PR #270](https://github.com/kust-projetos/meu-ted/pull/270). A exclusão de `.claude/napkin.md` foi explicitamente confirmada pelo operador; os artefatos Playwright continuam no disco e ignorados. Gitleaks local não encontrou segredos no staged nem nos 13 commits enviados. O operador também autorizou merge e deploy deste pacote, condicionados aos gates; não houve merge ou deploy neste checkpoint.

O [primeiro CI](https://github.com/kust-projetos/meu-ted/actions/runs/39985064372) passou em Agent, PWA, build Cloudflare, imagens Docker e gates documentais, mas falhou em lint da API, harnesses PostgreSQL e audit de dependências. O `quality` do PWA também bloqueou os advisories; o E2E correspondente passou. Nenhum check vermelho foi ignorado.

- Os dois bindings não utilizados foram removidos. Revalidação Linux: 614 arquivos da API sem erros e 6/6 testes de idempotência cruzada.
- O harness ganhou perfil CI opt-in fechado para loopback:5432 e as duas bases reservadas do serviço efêmero. Markers de ambas são verificados antes de migrations/DDL; o perfil local e as rejeições de destinos financeiros continuam preservados. Revisão de segurança aprovada. Repro PostgreSQL 16.15 isolado, sem portas publicadas: 16 casos de criação/idempotência, 14 de rename e 35 de preflight passaram (65/65), usando Vitest 4.1.11; o próximo CI validará o patch do runner também.
- Os manifests e lockfile foram atualizados para Next/ESLint 16.4.1, Sharp 0.35.5 — inclusive o override raiz — e Vitest/coverage 4.1.12 alinhados. Instalação frozen, resolução dos peers, revisão estática de dependências e typecheck dos cinco workspaces passaram. O audit crítico retornou exit 0: restam 26 findings (3 low, 10 moderate, 13 high), mas nenhum crítico. Não foram adicionadas exceções para os advisories corrigidos.
- A validação local não substitui o próximo CI: Next build passou, mas OpenNext no Windows falhou ao empacotar o módulo nativo Sharp; os artefatos locais de bundle ficaram inconsistentes. O audit isolado PWA foi bloqueado por `npm EALLOWREMOTE`, sem contornar a política. Build Cloudflare Linux, audit scoped e testes completos com Vitest 4.1.12 devem passar no novo SHA antes do merge/deploy.

## Segundo CI e correções de ordem/dependências

O CI do commit `fd062ad` confirmou em Linux o build Cloudflare com Next/Sharp corrigidos e passou API, Agent, PWA, E2E, Docker e gates documentais. Falharam três pontos, todos endereçados localmente sem afrouxar checks:

- **Security:** o Trivy da imagem da API encontrou Vite `8.1.4` com GHSA-587h-7wmj-h5pm / CVE-2026-112942. O override raiz foi fixado em `8.1.6` (mesmo ramo, engine e peers compatíveis), com lockfile regenerado e sem exceção de scanner.
- **Postgres:** a suíte de rename legado dependia da preparação de schema feita pela suíte de create quando executada antes. A preparação comum foi extraída para `tests/approvals/validation-db-fixture.ts`: preflight, pools, guards dos dois markers, migrations e DDL legada, nessa ordem. A suíte de rename agora é independente; a dependência implícita de ordem foi reproduzida em PostgreSQL 16.15 (6 falhas legadas) e corrigida (rename-first 14/14; create 16/16; preflight 35/35).
- **quality:** os asserts do contrato de auditoria ainda esperavam Next `16.3.8` e Sharp `0.34.5`. Foram atualizados para os pins reais (Next/ESLint `16.4.1`, Sharp `0.35.5`, Vitest/coverage `4.1.12`, Vite `8.1.6`), com 37/37 testes de política passando; nenhuma allowlist foi adicionada.

Validação local deste patch: `pnpm install --frozen-lockfile`, `pnpm why -r vite` (somente `8.1.6`), audit crítico exit 0 (16 findings restantes não críticos), typecheck da API, docs lint e lint dos três arquivos alterados via entrada isolada do Biome. O lint global do Biome no Windows tenta varrer artefatos locais grandes e foi substituído por esse escopo; o CI Linux segue como autoridade para o job completo.

O próximo checkpoint deve registrar o commit corretivo, o CI do novo SHA e somente depois o merge, os deploys atestados e os smokes efetivamente executados. A conta e as duas transações QA permanecem preservadas; não repetir as operações Solar/Lunar para produzir evidência de release.

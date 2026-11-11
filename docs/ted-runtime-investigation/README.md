# TED — investigação de runtime conversacional

**Data:** 2026-10-30  
**Estado:** análise, revisões independentes e validação documental concluídas; gates pesados não executados (limitação abaixo). Implementação não iniciada.  
**Baseline inicial:** `218960d0fb0fba153dcf2bc4165b2a7a44495276`, branch `test/ted-f2b0-no-retry-controlled`.  
**Revisão das referências/contagens:** `c9e73f114d72e4f270330978979d5e811dc1153c` (avanço concorrente registrado abaixo).

## Recomendação executiva

**A ideia merece uma POC: a hipótese de rigidez do harness tem evidência; a superioridade do OpenCode ainda não.** A rota pública atual planeja deterministicamente antes da LLM e não expõe à PWA o caminho SDK com tools que existe no código. Trocar somente provider ou colocar OpenCode atrás do mesmo roteador não testa a mudança proposta.

Recomendamos um experimento local isolado com **um agente OpenCode, tools nativas chamando a API existente e uma despesa por proposta**, comparado a A0 (TED atual) e A1 (Cloudflare com loop direto). Pi atual é alternativa contingente. Um SDK oficial OpenCode para Durable Objects existe: **mudar de harness não obriga mudar de hospedagem**.

A API conserva identidade, validação, idempotência, Pending V2 e recibos. A primeira POC confirma por ação autenticada no card; confirmação textual, memória durável e visibilidade coletiva são lacunas explícitas antes de paridade de produto. Sessões nativas não são isolamento financeiro multiusuário.

O primeiro passo futuro é um spike sem inferência: versão pinada, catálogo mínimo, duas identidades sintéticas, persistência/restart e integração. Só depois executar avaliação com LLM e orçamento próprio aprovado. A recomendação de migração depende de melhoria funcional e redução **líquida** de manutenção sobre A1, não do nome do runtime.

## Entregas e ordem de leitura

1. [Diagnóstico, fluxo real, falhas e matriz de substituição](01-diagnosis.md).
2. [Viabilidade OpenCode/Pi e comparação de alternativas](02-runtime-options.md).
3. [ADR-030 — decisão experimental proposta](../adr/ADR-030-ted-runtime-experiment.md).
4. [SPEC — fronteiras, interfaces, tools e critérios de aceite](03-experimental-spec.md).
5. [Plano incremental](04-incremental-plan.md).
6. [Plano de testes e avaliação](05-evaluation.md).
7. [Migração, coexistência e rollback](06-migration-rollback.md).
8. [Matriz de riscos e dependências](07-risks.md).

## Contrato desta investigação

Avaliar a hipótese de simplificar o harness conversacional do TED, com OpenCode V2 dedicado como candidato prioritário, comparado ao harness Cloudflare simplificado e ao Pi atual. A API financeira permanece autoritativa. A qualidade conversacional só poderá ser validada por experimento posterior com LLM e ferramentas reais em ambiente sintético.

Esta entrega contém análise e planejamento. Não autoriza implementação, inferência paga, alteração de produção, deploy, migração de dados, merge nem mudança das decisões financeiras vigentes. As correções em andamento, inclusive Zod, ficam fora do escopo. O teste modificado antes desta sessão (`apps/agent/tests/orchestration/fix-170-category-semantics.test.ts`) pertence ao trabalho preexistente.

## Checklist da entrega

- [x] Resolver baseline, restrições e decisão de orquestração (`MULTI_WORKER`).
- [x] Consultar memória do projeto como evidência histórica.
- [x] Confrontar fluxo e contratos com o checkout atual.
- [x] Verificar documentação oficial atual de OpenCode V2 e Pi.
- [x] Comparar alternativas e propor decisão reversível.
- [x] Redigir diagnóstico, matriz de substituição e fontes.
- [x] Redigir ADR proposta e SPEC experimental.
- [x] Redigir plano incremental, avaliação, migração/rollback e riscos.
- [x] Revisar independentemente a arquitetura e os documentos.
- [x] Validar links e governança; registrar resultados e limitações.
- [ ] Executar gates pesados obrigatórios do repositório (`typecheck`, `test`, `lint`) em snapshot seguro.

## Estado e proveniência da investigação

- Preflight executado: `MULTI_WORKER`; Router shadow desabilitado pela configuração, sem mudança de flags. Participação material: dois explorers (fluxo/contratos), researcher (fontes oficiais), architect (trade-offs), coder (documentos), tester, reviewer e security-reviewer.
- Consulta ai-memory no escopo explícito `clientes/pi-financeiro`; memória serviu como referência histórica, e fatos foram confrontados com arquivos atuais. Nenhuma memória durável foi escrita.
- No início havia um teste modificado pelo trabalho preexistente. Durante a análise, outro trabalho commitou `c9e73f1`: duas linhas de `conversationId` no orquestrador e testes correspondentes. A investigação não editou esses arquivos nem produziu esse commit; a medição e as referências do diagnóstico foram conferidas na revisão nova.
- F1 tem chamadas de modelo **zero** nos manifests consultados; F2 estruturada não observava conclusão financeira. A avaliação proposta mede outro desenho e preserva esses vereditos.
- Nenhum runtime dedicado foi instalado; nenhuma campanha LLM, alteração de produção, migração, commit ou publicação foi executada por esta investigação.

## Validação

- **Revisão documental:** `APPROVED`, sem finding P1/P2 concreto nos documentos 01–07 e ADR-030; revisão complementar do README também `APPROVED`.
- **Revisão de segurança:** `APPROVED` para o desenho documental. Integração ponta a ponta, catálogo/permissões reais e deduplicação após crash continuam como provas exigidas no experimento futuro.
- **Orquestração:** `Test-OrchestrationDoneCompliance -TaskClass non_trivial -Decision MULTI_WORKER -ActualWorkerParticipation 7 -ExecutionShape MULTI_WORKER` retornou `COMPLIANT` com sete workers já observados (sem contar o tester ainda pendente). Isso comprova participação, não desempenho do runtime proposto.
- **Validação documental independente:** `PASS`. `pnpm docs:lint`: 17 documentos, zero problemas; `pnpm governance:check`: sem mudança D01–D19; `lintMarkdownDocument` explícito nos nove documentos novos e no índice ADR: dez caminhos, zero problemas; `git diff --check`: exit 0 para o diff tracked. Conferência complementar de duas âncoras internas: zero falhas.
- **Preservação:** hashes dos relatórios `ted-f1-baseline.json` e `ted-f1-journeys.json` permaneceram iguais antes/depois. Escopo final observado: nove documentos novos e uma linha no índice ADR; nenhuma alteração de aplicação desta investigação.
- **Limitação de verificação:** `pnpm typecheck`, `pnpm test` e `pnpm lint` não foram executados. A tentativa de snapshot por `git archive HEAD | tar` falhou por corrupção do fluxo binário no shell Windows; nenhum teste foi executado sobre o snapshot parcial ou sobre o checkout compartilhado. Os gates obrigatórios do repositório não são declarados aprovados nem dispensados. Uma nova tentativa deve usar arquivo de archive, sem pipe binário, e isolamento adequado das dependências.
- **Artefato temporário:** o tester deixou um snapshot parcial inutilizável em `%TEMP%/opencode/ted-docs-snap1`; não é evidência de teste nem parte da entrega versionada.

A documentação não representa execução nem aprovação da POC.

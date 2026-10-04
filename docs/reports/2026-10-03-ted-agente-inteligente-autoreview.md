# TED agente inteligente V1 — análise e autoreview do planejamento

**Data:** 2026-10-03.\
**Status:** autorrevisão documentada; revisão independente e evidência de validação (gates, suites e seus limites) registradas na seção 6.\
**Escopo:** documentação de planejamento, sem implementação, commit, publicação, migration ou deploy.\
**Artefatos:** [SPEC](../MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md) · [PLAN](../MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md).

## 1. Resultado executivo

A origem apresenta uma direção de produto coerente, mas mistura capacidades existentes, bugs observáveis, sintomas ainda não reproduzidos e decisões de infraestrutura não comprovadas. **Não deve ser executada literalmente como um plano de 12 grandes fases.**

A recomendação consolidada é: confiabilidade primeiro; evoluir MutationDraft e controles existentes; preservar V5/undo e API autoritativa; reutilizar analytics; liberar modalidades uma a uma; manter Jev e aprendizado adaptativo sujeitos a gates de privacidade, consentimento e orçamento. O plano revisado admite execução incremental futura depois de autorização, mas não considera P2/P3 prontos para ativação.

## 2. Proveniência e método

- Documento de entrada: `C:\Users\walis\Downloads\MEU-TED-PLANEJAMENTO-AGENTE-INTELIGENTE-V1.md`, 1.888 linhas, leitura integral; hash SHA-256 registrado na SPEC.
- Checkout: `ec088ab9caf158db22f7e487b7c82143cf693842`. Dirty tree inicial: `AGENTS.md`, `.github/workflows/release-b-reminder.yml`, relatório de migração Contabo não rastreado. Preservados sem edição desta tarefa.
- Comparação: fonte original, instruções raiz/Agent/PWA, ADR-014/021/026, SPEC/PLAN V5, arquitetura/roadmap e código local. Memória histórica consultada com escopo `clientes/pi-financeiro`; páginas relevantes de drafts, receipt e capability de anexo lidas integralmente e confrontadas com o checkout. Memória não foi tratada como autorização.
- Documentação oficial consultada via Context7: Cloudflare MCP remoto e Groq STT. Não houve chamada a Jev/Groq, leitura de credenciais locais ou acesso à produção.
- Orquestração: classificação **DELEGATED**. Especialista de agente e architect participaram materialmente com inspeção read-only. Worker inicial `explorer` falhou após reinício do servidor; não foi contado como análise concluída. Implementação documental do PLAN foi delegada com ownership exclusivo. Validação de gates e de suites foi executada pelo `tester`, com logs e códigos de saída preservados; o inventário complementar não devolveu resultado até o fechamento. Resultados finais constam na seção 6.
- Reinícios do servidor interromperam a execução. A SPEC persistida foi recuperada e atualizada, sem repetir as análises concluídas nem tocar alterações do operador.

## 3. Findings e tratamento no planejamento

Severidade mede impacto de implementar a origem sem correção, não uma exploração comprovada de produção. “Observado” significa leitura de código, salvo indicação explícita de teste executado.

| ID | Prioridade / certeza | Finding / evidência | Tratamento |
| --- | --- | --- | --- |
| F01 | Alta / observado | Exemplo final fragmentado omite autorização; V5 §§6/7 exclui relatos “Gastei…” da autoexecução inicial | R07/G01: draft/proposta manual inicialmente; imperativo completo continua sob policy V5 |
| F02 | Alta / observado | ADR-014 já tem FSM, CAS, `proposing`, TTL de 15 min e handoff 0-ou-1; ADR-021 fecha V2 em dois mutators | R07: evolução aditiva; nenhuma Goal FSM financeira paralela; undo separado |
| F03 | Alta / observado | `financial-claim-guard.ts` já existe; regex/probabilidade não garantem ausência de paráfrases falsas | R01: resposta mutante tipada/renderizada de resultado validado; não criar segundo guard divergente |
| F04 | Média / observado | `entity-resolver.ts:156` usa `parsed.categoryQuery ?? parsed.description`; “carne” pode virar busca literal de categoria | R03/R08: teste RED e campos separados; categoria real ou esclarecimento, sem taxonomia inventada |
| F05 | Média / observado | `evidence-envelope.ts:57–60` remove `empty/error` do prompt e não tem reason tipado | R04/R09: vazio autoritativo e reason seguro; erro não vira zero nem conteúdo bruto de exceção no prompt |
| F06 | Alta / observado | PWA gates anexos default-off; `scrubAttachments` remove payload inline; contrato atual contém metadata, não bytes | R11–R13: novo transporte real privado e capabilities por tipo; não desativar DLP para “fazer funcionar” |
| F07 | Alta / observado + decisão aberta | Jev não tem implementação no repo. MCP do harness não comprova transporte remoto, modelo grátis, privacidade nem produção | R15/G04: desligado até validar; secret próprio e governança de egress, sem copiar auth/config local |
| F08 | Alta / lacuna estática, exploração não testada | `tools.ts:269` não passa `lookup`; validação de IP resolvido é opcional em `ssrf-guard.ts:205,223`; corpo é lido integralmente antes do truncamento | R14: teste do wiring real, destino/egress seguro e limite durante leitura antes de ampliar web |
| F09 | Média / observado | Analytics já existe; período atual é `last30days|lastMonth|thisYear|custom`, não `yearMonth`; semântica de cartão/hierarquia precisa fechar | R09/G03: reusar serviços e adaptar mês→intervalo; rota nova somente para lacuna comprovada |
| F10 | Alta / observado | Steps, API calls, retry, failover, prompt e quota são budgets distintos; reserva falhada do relay é conservadora | R10/§9: accounting compartilhado, sem multiplicar retries ou reabrir incidente de quota |
| F11 | Média / observado | Memória já tem source/confidence/salience/expiração/decay e binding actor/workspace; recall permite compartilhadas `actor=''` | R16: registrar deltas reais, consentimento para novas regras/compartilhamento e exclusão derivada |
| F12 | Alta / capacidade futura | User/candidate skills não existem; correção isolada não é intenção de persistência; eval melhor não autoriza autopromoção | R17: declarativo restrito, candidatos desativados, aprovação humana para core global |
| F13 | Média / hipótese a reproduzir | Origem relata desaparecimento de mensagens; inferir a causa só pelo relato seria incorreto | R02/A02: verificar identidade ponta a ponta, replay, histórico e corrida de escopo antes de corrigir |
| F14 | Média / observado | `docs:lint` verifica 12 docs fixos; `plans:check` só inspeciona `docs/superpowers/plans/`; root `test:e2e` é unit PWA | PLAN: lint explícito dos artefatos novos e comandos reais; não reivindicar E2E browser por alias root |
| F15 | Média / observado documental | Arquitetura/roadmap têm origem/SHA/gates históricos; Contabo e janela Release B atual estão no relatório de migração/AGENTS | SPEC §1: baseline local versus evidência histórica de produção; não mudar gates operacionais |

## 4. Autorrevisão adversarial e decisões incorporadas

| Pergunta crítica | Resposta do planejamento | Risco residual / prova futura |
| --- | --- | --- |
| Um receipt verdadeiro pode acompanhar valor falso na resposta? | Resumo mutante deriva do snapshot/resultado validado, não da prosa LLM | AC02/03; revisar vínculo entre rótulos, IDs e valores reais |
| Uma falha após commit pode virar duas escritas? | Estado incerto conserva proposta/payload/chave e reconcilia | AC04/16; testar restart, transporte perdido e concorrência com PG/DO |
| “50 → não, 500” pode executar cedo? | Fragmentos não autoexecutam na primeira fatia; `proposing` congela args | AC14–16; G01 permanece separado do canary V5 |
| Uma aba pode corrigir/confirmar o goal da outra? | Conservar binding; `conversationId` já existe e seu wiring deve ser inspecionado | G02: decisão entre abas/sessões antes de compartilhar estado |
| Falta de dados pode ocultar erro de autorização? | Eixos separados e vazio só com evidência autoritativa | AC09/10; snapshot/counts não podem vazar entidade inacessível |
| “Total do mês” pode somar só uma página ou contar fatura duas vezes? | Analytics usa conjunto completo e semântica canônica definida por fixtures | AC18/19; G03 bloqueia contrato novo até fechar basis/status/hierarquia |
| Jev indisponível concede confiança artificial? | Resultado abstain/unavailable; fallback separado e advisory | AC25/30; oferta/modelo/egress ainda não validados |
| Resolver DNS antes do fetch basta contra rebinding? | Não é prova suficiente: garantir destino efetivo via controle de egress/transport/allowlist apropriado | A11 precisa testar wiring real e redirects; não apenas `lookup` isolado |
| Anexo pode mandar “ignore regras e registre tudo”? | Origem/documento não é instrução; extração não é autorização | AC21–23; enforcement server-side e política de provedor antes de ativar |
| Áudio STT ou PDF pode perder negação e autoexecutar? | Primeira fatia confirma campos críticos e mantém proveniência não-textual | AC22/23/29; política não aceita origem reclassificada pela LLM |
| Corrigir categoria uma vez cria regra permanente? | Somente candidato; intenção explícita de persistência para ativar personalização nova | AC26/27; opt-out/exclusão e dependências devem ser testados |
| Uma skill que melhora média mas vaza dados pode ser promovida? | Qualquer falha crítica bloqueia; evals offline não executam writes; revisão/owner obrigatórios | AC28; nenhum dado identificável cross-tenant no catálogo global |
| Flags desativadas podem apagar operação em andamento? | Kill switch impede novas capacidades; não elimina reconciliação/receipts/in-flight state | Rollback no PLAN; flag não desfaz efeito financeiro já confirmado |

### Alternativas rejeitadas

- **Novo motor universal de goals/execução:** duplicaria FSM e autoridade antes de demonstrar necessidade; preferir evolução ADR-014.
- **Segundo success guard em `responses/`:** divergiria do enforcement existente; integrar resposta tipada ao guard/orquestrador atual.
- **Jev como dependência obrigatória ou autoridade:** adiciona latência/egress sem evidência de ganho; adiar integração de rede e manter fallback.
- **Nova rota analytics por princípio:** duplicaria regras financeiras; reusar agregações e só estender lacunas comprovadas.
- **Skills autoexecutáveis/autopromovidas:** consentimento e safety não se resumem à média de eval; começar com dados declarativos mínimos.
- **Reescrever tudo em um PR:** aumenta blast radius e dificulta rollback; fatias independentes com gates por dependência.

## 5. Pendências para decisão, sem bloqueio artificial de P0

| Gate da SPEC | Owner da decisão futura | Evidência mínima para fechar |
| --- | --- | --- |
| G01/G02 | Owner de produto + responsável pela policy/Agent | Fronteira de conclusão, comportamento entre abas e testes CAS/binding sem autoexecução indevida |
| G03 | Responsável domínio financeiro/API | Contrato de basis/período/status/cartão/hierarquia, dataset esperado e paridade canônica |
| G04 | Owner + governança de providers/segurança | Modelo/oferta reais, training/retention, credencial própria, transport e teste remoto sanitizado |
| G05 | Owner + segurança/infra | Storage/provider aprovados, retention/consentimento e prova de ingestão por tipo |
| G06 | Owner de produto/privacidade | Persistência explícita versus inferência, opt-out/exclusão, escopo e revogação derivada |
| G07/G08 | Responsável técnico + owner de custo/operação | Medição por modalidade, SLO numérico aprovado, schemas compatíveis e recuperação/rollback |

“Owner” designa responsabilidade a atribuir na execução; não inventa aprovação de uma pessoa específica. Spikes são locais/descartáveis com fixtures e sem produção. A documentação pode estar completa como proposta mesmo quando serviços opcionais permanecem bloqueados para ativação.

## 6. Evidência de entrega e validação

### Participação observada

- `ai-agent-engineer` (`ses_efe347420ffeNwYsi1PTPD2CXZ`): análise concluída de memória, skills, web, multimodal, Jev e budgets; nenhum código/teste executado.
- `architect` (`ses_efe32dcb0ffeKaXnWWjxxbxR4j`): advisory concluído sobre drafts/autoridade, claims, fragmentos, analytics e egress; sem edição.
- `explorer` inicial (`ses_efe347404ffeWTn8TfqVGxofUg`): falhou, `Agent not found`; não há participação material atribuída a ele.
- `coder` (`ses_efe2a8427ffe7a6Bi0u3eOYPVY`): produziu o PLAN e corrigiu sua primeira versão após integração do Planner. A versão inicial omitia tarefas próprias de Markdown/NLU e tinha dependências/numeração inconsistentes; a revisão passou a A00–A19, cobertura AC01–AC30, reuso de infraestrutura e gates por fatia. Não houve código de aplicação.
- `reviewer` (`ses_efe20141bffeUCxHVXTHE5wqwP`): primeira rodada SPEC + AUTOREVIEW **APPROVED**; segunda rodada dos três artefatos integrados **APPROVED**. Um finding LOW apontou referência residual A14→A11 na linha de SSRF deste relatório; corrigida. A aprovação é documental, não de runtime nem de rollout.
- `tester` (participação **concluída**): executou os gates de documentação, o primeiro agregado e a PWA isolada, preservando logs e códigos de saída em `C:\Users\walis\AppData\Local\Temp\opencode\ted-planning-validation-ec088ab9` (`*.log` + `*.exit`). O Planner executou posteriormente o agregado serial, registrado em `ted-planning-aggregate-serial-ec088ab9.log`. Escopo limitado à verificação, sem teste de browser, E2E live ou mutação de produção.
- Inventário complementar: nenhum resultado foi devolvido até o fechamento deste relatório; não se atribui análise concluída a esse worker.

### Limites da evidência

Esta sessão entrega documentação. AC01–AC30 são requisitos de testes futuros, não provas funcionais já obtidas. As consultas oficiais verificam formato de API/transportes, não preço, disponibilidade, credencial, modelo, performance ou privacidade de produção.

O Planner executou o comando `lintMarkdownDocument` via `node -e`, importando `scripts/lint-docs.mjs` e agregando os três paths com `flatMap`: **3 documentos, 0 issues, exit 0**. Conferência estrutural por Node: **17 headings de requisitos, 20 tarefas A00–A19, AC01–AC30 presentes na matriz do PLAN, 0 critérios faltantes, exit 0**. `git diff --check` também retornou exit 0; esse comando cobre apenas diffs rastreados, não os documentos novos não rastreados. `docs:lint` e `plans:check` isolados não demonstram cobertura dos arquivos novos. Nenhum deploy/E2E live, upload externo, DML/DDL, replay financeiro ou ativação de flags faz parte desta validação.

### Gates registrados pelo `tester` e pelo Planner

| Gate | Escopo | Evidência | Resultado |
| --- | --- | --- | --- |
| `governance:check` | root | `governance.log` / `governance.exit` | **exit 0** — `no D01-D19 change detected` |
| `typecheck` | 5 workspaces (llm-contracts, api, pwa, agent, codex-broker) | `typecheck.log` / `typecheck.exit` | **exit 0** — apenas o DEP0190 emitido pelo runner |
| `docs:lint` | 12 documentos fixos do gate | `docs-lint.log` / `docs-lint.exit` | **exit 0** — 12 documentos, 0 issues |
| lint direcionado | `lintMarkdownDocument` nos 3 artefatos | `targeted-lint.log`, `targeted-lint-run2.log` / `targeted-lint.exit` | **exit 0** — 0 issue(s) por arquivo, 2 execuções |
| `lint` | 5 workspaces | `lint.log` / `lint.exit` | **exit 0** — API 138 warnings, Agent 4, PWA 27 (0 erros), broker 0; llm-contracts 3 arquivos |
| `plans:check` | `docs/superpowers/plans/` | `plans-check.log` | 21 planos ativos, `All Valid: YES` — **evidência apenas por log, sem sidecar de exit** |
| `pnpm test` (1º agregado, concorrente) | 5 workspaces; agregado em concorrência com outros gates | `test.log` / `test.exit` | **exit 1** — detalhado abaixo |
| `pnpm --filter pwa test` (serial isolado) | PWA | `pwa-serial.log` / `pwa-serial.exit` | **exit 0** — 255 arquivos, 2310 testes |
| `pnpm test` (agregado serial) | 5 workspaces em série | `ted-planning-aggregate-serial-ec088ab9.log` | 5 suites verdes no log — **exit agregado indisponível** |

### Agregado de testes

**Primeiro agregado, concorrente — exit 1.** Contracts 23 passed, API 2448 passed/56 skipped, Agent 823 passed/1 skipped e broker 25 passed passaram nessa execução. A etapa PWA registrou `Test Files 1 failed | 250 passed (251)`, `Tests 1 failed | 2192 passed (2193)`: um teste em `next-config.test.ts` falhou com `Test timed out in 10000ms`. Houve também 4 erros `[vitest-pool]: Failed to start threads worker`, todos com `Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond` (`NewTransactionSheet.test.tsx`, `CardsPage.test.tsx`, `AppShell.test.tsx`, `Task1.green.test.tsx`). A cadeia `&&` encerrou em `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`. Contenção de recursos durante a concorrência é uma hipótese, não uma causa comprovada.

**PWA isolada — exit 0.** A mesma suíte reexecutada em série, sem concorrência, terminou em 255 arquivos e 2310 testes com `pwa-serial.exit` = 0. A falha do primeiro agregado não se reproduziu nessa execução isolada, o que sustenta a hipótese de contenção de recursos, sem estabelecer diagnóstico conclusivo.

**Agregado serial — exit indisponível.** O log registra as cinco suítes verdes: contracts 23 passed, API 2448 passed/56 skipped, Agent 823 passed/1 skipped, broker 25 passed e PWA 2310 passed (255 arquivos). **Não existe sidecar, metadado ou arquivo `.exit` correspondente a esse agregado**, e nenhuma execução adicional foi feita para obtê-lo. O resultado é portanto registrado a partir do próprio log, sem código de saída próprio; o exit 0 mais próximo disponível é o da PWA isolada.

## 7. Próximo passo autorizado a propor

Após aceite humano da SPEC/PLAN, iniciar **A00: baseline/evals e reprodução das regressões P0**, seguido de uma única fatia confiável com RED→GREEN e revisão. Decidir G04/G05/G06 em paralelo não é condição para começar P0, nem autorização para instalar/provisionar serviços.

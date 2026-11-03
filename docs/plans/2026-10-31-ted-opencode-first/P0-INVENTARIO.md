# P0 — Inventário e matriz de importação

Base de produto: `0a37e9e0f7481e034b123336eff1267dddfde9ab`, branch local `feat/ted-opencode-product`, worktree `D:/projetos/pi-ted-opencode-product`. A `main` remota consultada estava em `3489352f47415d5b74aadb67d59db8a40a5ab132`, como no README. Fonte experimental: `D:/projetos/pi-ted-runtime-spike`, branch `experiment/ted-opencode-runtime`, HEAD `1567daed7c1744ad0b15d97c6e69a7d667eba685` **mais alterações tracked e untracked**. O SHA não identifica sozinho o conteúdo experimental. Essa worktree foi inspecionada sem limpeza ou alteração.

## Matriz

| Fonte experimental, sob `experiments/ted-runtime/` | Tratamento |
|---|---|
| `bootstrap/ted-config.cjs`, `env.cjs`, `session-bindings.mjs`, `ted-gateway.mjs` | Referência para isolamento, binding e superfície; adaptar e testar contra o contrato de produto, não importar cegamente. |
| `bootstrap/ted-finance-tools.mjs`, `bootstrap/plugins/ted-finance/` | Referência para schemas e duas leituras; somente os caminhos permitidos e identidade do host, sem escrita. |
| `bootstrap/finance-bridge*.ts`, `finance-transport*.mjs` | Referência de testes; bridges one-shot, seed e wiring sintético não são adaptadores de produção. O caminho real deve chamar a API autorizada. |
| `bootstrap/run-*`, `spike-04-oracles.mjs`, `spike-05*/`, fixtures, bancos, homes e traces | Não importar para produto. Preservar fontes originais; não copiar credenciais, `.env`, `node_modules` ou dados de execução. |
| `reports/SPIKE_04L_RESULTS.md`, `SPIKE_05L_RESULTS.md`, `SPIKE_05D_RESULTS.md` | Evidência histórica, não validação do produto. 05L era parcial cross-process; 05D relata ligação durável da mesma proposta até recibo em Postgres sintético, com confirmação sintética. Não é prova da PWA. |

Confirmar, executar, cancelar, propor despesas e seus transportes/bridges de escrita estão expressamente **fora de P0–P2**: não entram no runtime read-only. Preservar Pending V2 existente, sem reproduzir sua autoridade no novo runtime.
O array `TOOL_DEFS` em `bootstrap/ted-finance-tools.mjs:60–130` também contém `list_categories` e `propose_expense`: não copiá-lo inteiro como catálogo P1 de duas leituras.

O `bootstrap/ted-gateway.mjs:112–123` experimental permite `getSession` sem binding prévio e `:132–148` permite `removeSession` sem binding; não transportar esse fallback. Após restart, o binding em memória some: acesso a metadados também deve falhar fechado até ownership durável e reautenticação serem verificados. O filtro actor-private do spike, isoladamente, não implementa o coletivo por padrão da ADR-027.

Revisão estática independente de segurança: `session-bindings.mjs:72–93,117–129` permite revogação/rebinding pelo registro volátil e expõe o binding que contém token; `ted-gateway.mjs:152–167` expõe catálogos globais. Não portar essas superfícies diretamente: revogação e rebind exigem ownership autorizado, credenciais não devem ser expostas pelo binding ou log, e catálogos internos não são interface de usuário. A revisão diz respeito ao spike, não comprova segurança da implementação nova.

`bootstrap/env.cjs:9–43` altera `process.env` e diretórios globais antes do import. Não aplicar essa estratégia repetidamente por identidade dentro de um processo compartilhado concorrente; o isolamento precisa ser delimitado no processo e demonstrado em teste.

### Estado auditável do spike

Em `experiments/ted-runtime/`, `git diff --stat` registrou 8 arquivos tracked alterados: `.gitignore`, `bootstrap/finance-bridge.ts`, `bootstrap/finance-transport.mjs`, `bootstrap/plugins/ted-finance/index.mjs`, `bootstrap/ted-finance-tools.mjs`, `bootstrap/ted-gateway.mjs`, `tests/spike-02.test.mjs` e `tests/spike-03a.test.mjs` (453 inserções, 23 remoções). A lista completa de untracked é obtida sem modificar o estado com `git status --short --branch` na worktree experimental; inclui homes `.ted-home-05d-a/` e `.ted-home-05l-a/`, relatórios/traces e diretórios `spike-05/` e `spike-05d/`. Não é seguro substituir o inventário pelo SHA do HEAD.

Entre os untracked relevantes estão `bootstrap/finance-bridge-pg.ts`, `bootstrap/finance-transport-pg.mjs`, `bootstrap/run-03b-turn.mjs`, `run-04-journey.mjs`, `run-05d-live.mjs`, `run-05l-turn.mjs`, os respectivos testes, `bootstrap/spike-04-oracles.mjs`, os relatórios `SPIKE_03B_RESULTS.md`, `SPIKE_04L_RESULTS.md`, `SPIKE_04R_RESULTS.md`, `SPIKE_05_RESULTS.md`, `SPIKE_05L_RESULTS.md`, `SPIKE_05D_RESULTS.md`, os traces `SPIKE_04_TRACE_*` e `SPIKE_05L_TRACE*`, e testes `tests/spike-03b-dryrun.test.mjs`, `spike-04-dryrun.test.mjs`, `spike-04l-extract.test.mjs`, `spike-04r-*.test.mjs`. Esses caminhos são evidência ou referência, não cópia autorizada indiscriminadamente. A matriz exata origem→destino e as dependências importadas devem ser completadas após a implementação.

Na primeira versão do pacote, o autor informou adaptações de `ted-finance-tools.mjs` para `apps/ted-runtime/src/tool-defs.mjs`, `session-bindings.mjs` para `src/session-bindings.mjs`, `ted-gateway.mjs` para `src/facade.mjs`, `ted-config.cjs`/`env.cjs` para `src/bootstrap.mjs` e do plugin para `src/plugin.mjs`. O transporte HTTP novo substitui a bridge sintética. Esse mapa identifica a origem alegada, não certifica que o wiring, a segurança ou os testes estejam concluídos; a implementação está em correção.

O manifesto experimental identifica OpenCode 2.2.4. Consultas `npm view` individuais para `@opencode/sdk`, `@opencode/client`, `@opencode/plugin` e `@opencode/cli` nessa versão confirmaram licença MIT e integridade idêntica à do manifesto; o tarball do SDK é do registro npm. Ainda é preciso verificar o lockfile e as dependências efetivamente incorporadas antes de reivindicar reprodução. O experimento registra bypass de policy por `session.shell`: o SDK inteiro não pode ser entregue ao gateway ou navegador. O J07-B assumiu mês sem pedir esclarecimento; continuação com modelo após restart não foi comprovada por `provider.no-route`. Custo reportado zero pelo SDK não prova faturamento zero.

## Aceite mínimo a implementar

- Runtime privado, versão fixada, catálogo de leitura exato e façade sem métodos administrativos; bindings autenticados por host e rebind após restart, sem confiar em ID do cliente como autorização.
- Ambas as leituras chamam a API local autorizada, preservando erros e isolamento entre identidades. Testar ausência de binding, acesso cruzado, respostas malformadas e reinício; não tratar erro como lista vazia.
- PWA mantém proxy same-origin e DTO vigente; flag local desligada por padrão, owner durável por conversa e autorização/visibilidade ADR-027 em cada superfície, com teste de duas identidades, cancelamento, deduplicação e erros.
- O fluxo atual usa `/rpc/chat` e depois `/rpc/history` (`apps/pwa/src/lib/api/agent-client.ts` e `apps/pwa/src/features/ted/TedChat.tsx`); ambos devem consultar o mesmo owner. Token de conexão é validado e consumido uma vez pelo gateway atual com workspace canônico e revalidação de membership (`apps/agent/src/index.ts`); encaminhar headers não substitui essa fronteira. `sendAgentMessage` não expõe `AbortSignal` hoje, portanto cancelamento ponta a ponta requer prova própria.
- A prova `READ_SLICE_PASS` exige PWA, API e modelo real com autorização de orçamento específica. Sem essa autorização, não executar inferência nem declarar PASS.

**Estado P0:** inventário inicial registrado; gate completo depende da revisão do código efetivamente importado, das versões e dos testes da implementação. Produção não alterada.

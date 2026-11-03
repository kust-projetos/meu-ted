# MEU TED — P2 History Closure Results

**Data:** 2026-11-01  
**Veredito:** **HISTORY_PARTIAL**  
**READ_SLICE_PASS:** **NOT ACHIEVED — BLOCKED / NOT RUN**  
**Worktree:** `D:/projetos/pi-ted-opencode-product`  
**Branch:** `feat/ted-opencode-product`  
**HEAD-base observado:** `0a37e9e0f7481e034b123336eff1267dddfde9ab`

## Resumo

A leitura e a recuperação após reinício foram comprovadas com o SDK OpenCode real `2.2.4`, o SQLite criado pelo runtime em um diretório temporário isolado, o gateway real e a rota/client da PWA sobre a **mesma conversa de teste**. O transcript foi importado por `oc.experimental.session.import`, a interface oficial de transferência do SDK, e continha 120 mensagens sintéticas ordenadas. A recuperação após fechar o primeiro processo e abrir outro devolveu os mesmos IDs e conteúdos, sem duplicações. `session.prompt` permaneceu guardado para falhar antes de delegar e foi chamado **zero vezes**; não houve provider, transporte financeiro, API externa ou inferência.

O teste também reproduziu e corrigiu dois defeitos do caminho de histórico no contrato real 2.2.4: combinação inválida de cursor/ordem e rejeição incorreta do limite exato de 500 mensagens. A PWA recebeu o DTO saudável, recebeu `503 history.unavailable` sanitizado na falha injetada e recuperou o mesmo histórico depois. O comportamento visual que preserva uma resposta de envio já concluído durante falha de refresh continua coberto por teste de componente com doubles, não pela mesma execução integrada.

Por isso o resultado é **HISTORY_PARTIAL**, não prova de recuperação de uma resposta gerada pela LLM nem E2E de browser completo. O assistant text importado é fixture sintética; não foi produzido por modelo. O erro nativo exato e o SQLite da execução live original continuam indisponíveis; não foram reconstruídos, e não atribuo a eles a exceção encontrada no teste atual.

## Preservação, limites e segurança de execução

- O checkout já estava dirty antes desta missão, incluindo os relatórios F1 e alterações P1/P2. Eles foram preservados; os relatórios `P2-LIVE-CLOSURE-RESULTS.md` e `P2-REFRESH-REMEDIATION-RESULTS.md` não foram editados.
- **A exceção original do SDK e o banco SQLite original não estão disponíveis.** `opencode.log` não contém a entrada correspondente. Não houve tentativa de reconstrução artificial desse banco.
- O teste real cria novos diretórios temporários únicos sob a pasta aprovada; não removeu traces nem diretórios preexistentes.
- O transcript de 120 itens foi criado por `experimental.session.import` oficial em um SQLite temporário novo. Não houve escrita direta em tabelas internas. O texto assistant é explicitamente sintético, não uma resposta LLM.
- Nenhum `session.prompt`, provider, ferramenta financeira, chamada paga ou acesso a API/banco externo ocorreu. Nenhum commit, push, PR, merge, deploy ou acesso à produção foi feito. P3 não foi iniciado; a feature flag de produto não foi alterada.
- A autenticação do gateway no teste integrado usa um resolver sintético de cookie/device/workspace. O wrapper `withAuthenticatedSession`, o binding, a revogação ao final da janela e o controle de visibilidade são os reais; Better-Auth não foi exercitado nessa mesma execução. Os testes de integração de auth da API foram executados separadamente.

## Defeitos reproduzidos e correções

### 1. Continuação de cursor rejeitada pelo SDK 2.2.4

O handler instalado codifica ordem e direção no cursor opaco e rejeita `cursor` combinado com `order` (`Cursor cannot be combined with order`). A implementação enviava `order` em todas as páginas. Com isso, a leitura real do gateway falhava como `503 history.unavailable`.

`apps/ted-runtime/src/prompt.mjs` agora envia `order` somente na primeira página e, nas continuações, envia somente o cursor. A prova com SDK real valida páginas ascendentes e descendentes, continuação cursor-only e rejeição explícita da combinação inválida.

**Limite de atribuição:** essa é uma falha atual reproduzida com a versão fixada, compatível com o sintoma histórico. Como a exceção live original não foi recuperada, não afirmo que seja a exceção exata daquela execução.

### 2. Limite de 500 itens e página sentinela

O servidor 2.2.4 ainda retorna `next` em páginas não vazias, inclusive quando a última página já contém o fim do transcript. O adapter rejeitava ao completar dez páginas, antes de fazer a consulta cursor-only vazia que confirma o fim; assim, exatamente 500 itens produziam falso `prompt.history_overflow`.

O adapter agora permite até dez páginas **não vazias** mais a página vazia sentinela. A mensagem 501 continua falhando fechado, e continua não havendo truncamento silencioso.

### Evidência RED → GREEN

- **Cursor:** antes da alteração em `src/prompt.mjs`, `node --test tests/p2-real-history.test.mjs` falhou no GET saudável real com `503`. A sonda isolada chamou o método do SDK diretamente: `order + cursor` lançou `Cursor cannot be combined with order`; `cursor` sozinho continuou a página corretamente. Depois da correção, o mesmo teste de subprocessos passou.
- **Limite:** após adaptar o double para codificar ordem/direção no cursor e representar a página vazia sentinela 2.2.4, `node --test tests/prompt.test.mjs` falhou especificamente no caso de exatamente 500 mensagens (falso `prompt.history_overflow`). Depois da alteração no bound, passou 24/24; combinado com a suíte de refresh P2, 33/33.
- Nenhum teste RED foi fabricado por erro de fixture/import: a falha do primeiro caso veio do GET real do gateway/SDK; a segunda ocorreu no teste de comportamento existente com semântica de cursor atualizada independentemente da implementação.

## Prova do SDK, gateway e PWA

O teste `apps/ted-runtime/tests/p2-real-history.test.mjs` usa dois subprocessos:

1. **Seed:** SDK `2.2.4` real, `session.create` sem prompt para obter contexto válido e `oc.experimental.session.import` para criar uma sessão de teste com 60 pares sintéticos user/assistant. Leitura inicial via SDK e adapter; registry de conversa persistido; fechamento natural do host.
2. **Recovery:** processo novo sobre o mesmo diretório SQLite e registry. O gateway loopback e `createPromptHost` reais recuperam todas as 120 mensagens com IDs, conteúdo e ordem estáveis. O acesso ocorre dentro de `withAuthenticatedSession`; binding está ativo durante a leitura e revogado ao sair. Credencial inválida resulta em 401, workspace cruzado em 403 e conversa desconhecida em 404 antes de `message.list`.
3. **Falha e recuperação:** após um GET saudável, uma falha controlada em `promptHost.readHistory` resulta em `503 history.unavailable`, mensagem fixa e sem detalhe nativo. `prompt.failed` não é usado. Ao remover a falha, o mesmo histórico retorna com os mesmos IDs.
4. **PWA:** `apps/pwa/src/app/api/agent/[...path]/route.p2-real-history.test.ts` exercita a rota B real e o client real `fetchAgentHistory` com o mesmo gateway/session já reaberto. O DTO tem 120 itens, ordem cronológica e IDs únicos; um segundo GET simula reload e devolve o mesmo lote. Durante a falha, o client recebe `status=503`, `code=history.unavailable` e a mensagem sanitizada; após recovery, recebe novamente os mesmos IDs.

Seams declarados: o transcript é fixture sintética; a identidade do gateway é sintética; o mint de token PWA é mockado; o fetch same-origin do client é desviado ao handler real no teste. O upstream do handler para o gateway é HTTP loopback real. **Não é Playwright/browser E2E, não é Better-Auth real e não é saída de LLM.**

O teste de componente existente `TedChat.reload.test.tsx` verifica, com doubles, que um POST concluído seguido de falha do GET deixa a resposta concluída visível, mantém o envio como `sent`, mostra o erro de histórico e não chama `sendAgentMessage` novamente. Essa garantia visual não foi combinada ao transcript importado na prova integrada; por isso não a apresento como E2E da mesma sessão.

## Critérios H01–H08

| Critério | Resultado | Evidência / limite |
|---|---|---|
| **H01 — sessão real criada/recuperada pelo SDK** | **PASS** | `session.create` e `experimental.session.import` oficiais; `session.get` e leitura após novo processo. |
| **H02 — mensagens persistidas após restart** | **PASS — transcript importado** | 120 mensagens sintéticas no SQLite do SDK, recuperadas em outro processo, IDs/conteúdo/ordem/dedup verificados. Não é transcript original nem output de modelo. |
| **H03 — gateway autentica e isola recuperação** | **PARTIAL** | Gateway, wrapper, binding, revogação e negações reais; resolver de credenciais no teste integrado é sintético. API auth/read-slice passou separadamente (8/8). |
| **H04 — PWA recebe histórico correto** | **PASS — rota/client** | Handler B real + `fetchAgentHistory` real recebem o DTO da mesma sessão reaberta. O componente visual não foi conectado àquele child no teste integrado. |
| **H05 — refresh não executa `session.prompt`** | **PASS** | Guard no objeto SDK real; contador zero em seed, recovery, falha, reload e recuperação. O refresh chama apenas leitura de histórico. |
| **H06 — falha resulta em 503 e resposta concluída permanece visível** | **PARTIAL** | 503 sanitizado e propagação pelo client foram integrados. A preservação visual da resposta pós-envio é verificada no teste de componente com doubles, não na mesma execução SDK/PWA. |
| **H07 — falha genuína de prompt continua 502** | **CONTRATO PASS / live não exercitado** | Teste existente injeta `prompt.failed` no path de chat e preserva 502; não se executou `session.prompt` real nesta missão. |
| **H08 — sem regressões relevantes** | **PASS nos focos executados** | Runtime 144/144; auth/read-slice API 8/8; PWA focado 78/78; typechecks/lint focados descritos abaixo. Flag OFF permanece inalterada. |

## READ_SLICE_PASS e autorização pendente

**READ_SLICE_PASS não foi alcançado nesta missão.** A SPEC define o gate com PWA → proxy → gateway → OpenCode com LLM real autorizado → tools → API → DTO → PWA, incluindo duas identidades e oráculos financeiros. Esta tarefa proíbe nova inferência e não autorizou provider. O resultado histórico de uma conversa live não substitui uma prova da mesma sessão recuperada.

O menor teste para avaliar esse gate é uma única consulta somente-leitura autorizada pela PWA, contra API sintética/controlada, seguida de reinício do gateway e reload da **mesma** conversa, verificando IDs/texto do assistant e ausência de novo prompt no refresh. Isso exige autorização específica de provider/modelo e limite de custo antes de executar; fica aguardando essa autorização. Nenhuma chamada será feita por inferência.

## Verificação executada

| Verificação | Resultado |
|---|---|
| `pnpm --filter pi-finance-ted-runtime test` | **PASS — 144/144**, 20 suítes, 0 skips; inclui subprocessos SDK reais, P2 e paginação. |
| `node --test tests/p2-real-history.test.mjs` | **PASS — 1/1**; mesma base entre processos, gateway e SDK reais, sem prompt. |
| `node --test tests/prompt.test.mjs tests/p2-history-refresh.test.mjs` | **PASS — 33/33**. |
| `pnpm --filter pi-finance-ted-runtime typecheck` | **PASS** (`node --check` dos módulos runtime). |
| `pnpm --filter pi-finance-ted-runtime lint` | **PASS** (`node --check` dos módulos runtime). |
| API `ted-runtime-gateway-auth.test.ts` + `ted-runtime-read-slice.test.ts` | **PASS — 8/8**. |
| PWA sete arquivos focados (reload, contratos P2, client, cancel, view, proxy e integração de histórico real) | **PASS — 78/78**, serial (`--pool=forks --maxWorkers=1`). |
| `pnpm typecheck` (todos os workspaces) | **PASS**; houve apenas o warning Node `DEP0190`, sem erro de tipos. |
| `pnpm --filter pwa typecheck` | **PASS**. |
| `pnpm --filter meu-ted-api typecheck` | **PASS**. |
| `pnpm docs:lint` | **PASS**, 17 documentos, 0 issues. |
| `pnpm governance:check` | **PASS**, nenhuma mudança D01–D19 detectada. |
| ESLint focal do novo teste PWA | **PASS**, sem diagnósticos. |
| `pnpm test` agregado | **NÃO EXECUTADO**: o script roda suites F1 que regeneram `apps/agent/evals/reports/ted-f1-*.json`; preservar esses artefatos preexistentes tem prioridade. |
| `pnpm lint` agregado | **NÃO PASS / NÃO CONCLUÍDO**. O resultado anterior em `P2-REFRESH-REMEDIATION-RESULTS.md` expirou aos 900 s no primeiro estágio `@pi-finance/llm-contracts lint`. Nesta closure, a repetição isolada desse estágio excedeu 120 s sem diagnóstico; `biome check src/index.ts` excedeu 30 s. Biome `2.2.4` inicia, mas o package tem só 3 arquivos (incluindo `index.ts` de 58 bytes) e a varredura ainda trava; não foi observada violação de lint nem processo Biome residual. Isso estreita a investigação a inicialização/varredura/config/filesystem do Biome neste ambiente, mas **a causa exata segue indeterminada**. O gate completo permanece não verificado; não converti timeout em PASS. |

## Revisão e fechamento

- Reviewer independente: **APPROVED** para paginação/cursor/limite e para a integração PWA após verificar propagação de erro no client.
- Tester independente: **PASS** para runtime, API e PWA focados; confirmou os limites de transcript sintético, auth seam sintética e ausência de browser E2E.
- As provas são sobre o estado dirty preservado do worktree, não apenas sobre o HEAD. Os artefatos F1 e os relatórios P2 anteriores permanecem intactos.
- Sem conclusão de live LLM, Better-Auth integrado, browser E2E, READ_SLICE_PASS ou produção.

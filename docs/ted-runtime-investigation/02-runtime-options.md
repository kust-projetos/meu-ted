# Viabilidade e comparação dos runtimes

**Consulta:** 2026-10-30. **Natureza:** documentação oficial e inspeção estática; nenhum runtime experimental foi instalado ou exercitado nesta investigação.

## 1. Veredito técnico limitado

OpenCode V2 possui as peças necessárias para experimentar um TED com loop nativo de ferramentas. Isso **não demonstra** que compreenderá melhor os usuários, que será mais barato ou que reduzirá manutenção líquida. A candidata é viável para POC, não está aprovada para substituir produção.

Há duas decisões independentes: **qual harness** e **onde hospedá-lo**. O SDK oficial `@opencode/sdk/workerd` permite usar OpenCode em Durable Objects; VPS não é requisito intrínseco do OpenCode. A hospedagem será comparada depois de uma fatia funcional, evitando confundir ganho conversacional com mudança de infraestrutura.

## 2. Capacidades nativas verificadas

| Capacidade | Evidência oficial | Limite para o TED |
|---|---|---|
| Servidor HTTP/API | [API V2](https://opencode.ai/v2/docs/api), [OpenAPI](https://opencode.ai/v2/openapi.json) | Superfície ampla, incluindo filesystem, shell, config, credenciais e sessões. Não expor diretamente à PWA. ACL por usuário/workspace financeiro não está comprovada pela documentação consultada |
| Cliente de rede | [Client](https://opencode.ai/v2/docs/build/client) — `@opencode/client`, `OpenCode.make` | Adaptador deve fornecer endpoint/autenticação do runtime dedicado; não chamar `Service.ensure()` do ambiente pessoal |
| SDK embutido | [SDK](https://opencode.ai/v2/docs/build/sdk) — `OpenCode.create()` | Hospeda servidor/router em memória, sem listener HTTP. Reduz uma fronteira de rede; não elimina serviços/config/discovery do OpenCode nem cria sandbox por si só |
| Cloudflare | [SDK Workerd](https://opencode.ai/v2/docs/build/sdk/cloudflare) — `OpenCodeWorkerd.create({storage,config,plugins})` | SQLite do DO, eventos duráveis para eviction; um host por vida do objeto, `nodejs_compat`. Compatibilidade das tools/modelo TED e comportamento sob carga precisam ser testados |
| Histórico e sessões | [API](https://opencode.ai/v2/docs/api), [plugins/sessions](https://opencode.ai/v2/docs/build/plugins/server/) | CRUD, prompt, contexto, interrupção, compactação, fila. Sessão é unidade conversacional, não prova de autorização de tenant |
| Admissão de prompts | [hooks de prompt](https://opencode.ai/v2/docs/build/plugins/server/) | IDs já pendentes/entregues retornam admissão original; hooks concorrentes podem rodar várias vezes. Não fazer mutação financeira dentro de hook de admissão |
| Eventos | [Client — Stream events](https://opencode.ai/v2/docs/build/client) | Live-only, sem replay/reconexão automática. Retomar via consulta de mensagens/estado; evento perdido não implica comando perdido nem autoriza reenvio financeiro |
| Tools customizadas | [Plugin server — Tools](https://opencode.ai/v2/docs/build/plugins/server/) | `ctx.tool.transform` adiciona/atualiza/remove; schema e executor tipados. Contexto de execução permite correlação; identidade financeira deve vir do host confiável |
| Skills | [Skills](https://opencode.ai/v2/docs/skills) | Catálogo e carregamento sob demanda. Não substituem validação/autorização. Impedir descoberta de skills pessoais e ancestrais |
| MCP | [MCP servers](https://opencode.ai/v2/docs/mcp-servers) | Local/remoto, headers/env/OAuth; `_meta["ai.opencode/sessionID"]` é correlação, **não autenticação**. Não supor credenciais MCP isoladas por conversa |
| Contexto/compactação | [Compaction](https://opencode.ai/v2/docs/compaction) | Auto/manual; pode perder detalhe relevante. Dados e pendências devem ser reconsultados na API, não reconstruídos de resumo |
| Modelos/providers | [Providers](https://opencode.ai/v2/docs/providers) | Catálogo, providers compatíveis e parâmetros nativos. Não foi comprovado failover automático equivalente à política atual do TED |
| Permissões | [Permissions](https://opencode.ai/v2/docs/permissions), [Policies](https://opencode.ai/v2/docs/policies) | Defaults amplos, regras ordenadas e permissões salvas. `deny`/allowlist são defesa de tool; shell opera com autoridade do host. Não constituem sandbox OS |
| Configuração | [Config](https://opencode.ai/v2/docs/config) | Descoberta global/ancestral/project e merge. Um diretório novo no mesmo host/config pessoal não comprova isolamento |
| Telemetria | [API](https://opencode.ai/v2/docs/api), [Inference](https://opencode.ai/v2/docs/console/api/inference/) | Stats/usage disponíveis, parte experimental; custo informado pode não representar cobrança final. Instrumentar resultados por caso |
| Snapshots/revert | [Snapshots](https://opencode.ai/v2/docs/snapshots) | Arquivos Git/worktree, não transações financeiras nem rollback de API |

**Distinções que evitam erros:** chave da Console/Inference não equivale a ACL do servidor de sessões; `workspaceID` do OpenCode não equivale ao workspace financeiro; `sessionID` não é token; `permission:allow` não é confirmação financeira; `interrupt` não desfaz commit de tool.

## 3. Como dedicar a instalação

Hipótese operacional inicial: imagem/container local limpo, SDK embutido e plugin TED empacotado; apenas depois avaliar a mesma imagem numa VPS isolada. Um servidor HTTP privado com cliente explícito também é possível, mas adiciona listener e autenticação administrativa sem benefício inicial demonstrado.

- HOME/XDG/data/cache e diretório de trabalho exclusivos; nenhum volume da instalação de desenvolvimento, repo, Docker socket, SSH ou credencial pessoal.
- Um processo/container por fronteira `actor + workspace` na POC com poucos usuários; conversas são sessões dentro dela. A configuração/provedor da instância não recebe token financeiro mutável global por turno. Device/credencial ainda precisa ser vinculado por chamada autenticada.
- Modelo recebe apenas catálogo financeiro curado e skill TED. Remover tools genéricas no plugin e negar capacidades por configuração; validar o catálogo efetivo após restart/reload. Dependência/plugin não permitido não entra na imagem.
- Rede e recursos mínimos: API sintética e provider aprovado; runtime privado, sem painel/admin exposto ao browser. Disco persistente exclusivo para sessões; processos sem privilégio. Não confiar em prompt para impedir leitura de arquivos.
- Testar duas identidades antes de concluir isolamento. Ausência de ACL multitenant documentada impede recomendar um servidor geral compartilhado apenas separando `sessionID`.
- No perfil Workerd, o análogo é DO segregado por ator/workspace, com config e plugins empacotados. A chave de roteamento é obtida de identidade autenticada, não do corpo da mensagem.

Não especificamos flags de configuração não comprovadas como solução de isolamento. O primeiro spike deve validar opções reais da versão fixada e o inventário efetivo de agents/tools/skills/MCP/plugins/config.

## 4. Tools diretas ou MCP

**Recomendação experimental: tools nativas de plugin chamando a API**, com schemas/contratos reaproveitados. Existe um consumidor e a API já é HTTP; um MCP adicional exigiria operar mais um serviço, vincular credenciais e traduzir erros outra vez.

MCP passa a ser justificável com consumidores independentes reais ou um conector já disponível que reduza código. Se adotado, autenticação do servidor financeiro precisa continuar explícita e vinculada à identidade TED, nunca à metadata de sessão. Escolha de protocolo não muda as invariantes financeiras.

Não exportar automaticamente as 54 tools geradas: o checkout ainda contém referências contratuais a rotas V1 aposentadas. Curar uma superfície pequena e testar a rota real; schema gerado não prova disponibilidade.

## 5. Alternativa Pi atual

Fontes: [upstream Pi](https://github.com/earendil-works/pi), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).

O upstream consultado documenta `@earendil-works/pi-coding-agent`, `createAgentSession`, `SessionManager`, tools/extensions, skills, providers e compactação. O SDK é embutido; RPC usa subprocesso JSONL (`pi --mode rpc`), IDs correlacionados e eventos. A variante `--no-session`/`SessionManager.inMemory()` é útil em testes, mas **não** satisfaz persistência de produto. Selecionar storage persistente e provar restart se C for experimentado.

Pi é candidato potencialmente menor para um agente único com tools. Não oferece, na documentação consultada, uma solução automática de tenancy TED. Exige a mesma fronteira de identidade, integridade e apresentação que B. Seu custo de integração pode ser menor ou maior: ainda não medido. Não restaurar `.pi/extensions/financial-tools` nem o runtime legado; reaproveitar somente conhecimento histórico verificado.

## 6. Comparação objetiva antes da POC

| Critério | A — Cloudflare simplificado | B — OpenCode dedicado | C — Pi dedicado |
|---|---|---|---|
| Loop/modelo | AI SDK já integrado; fazer uma via experimental direta | Nativo, configurável, catálogo amplo | Nativo, SDK/RPC e providers |
| Sessão/compactação | Parte existe no DO; simplificação e retenção ainda próprias | Nativas; bridge de identidade/retomada ainda necessária | Nativas; host/storage/bridge necessários |
| Esforço de integração inicial | Menor mudança de transporte/PWA | Novo adaptador de runtime, formato de mensagens e tools | Novo adaptador e protocolo SDK/RPC |
| Recursos de coding a restringir | Não é o foco do runtime atual | Muitos recursos gerais; allowlist + isolamento obrigatório | Tools de coding também precisam exclusão explícita |
| Hospedagem | Workers/DO já conhecidos | Container VPS ou SDK Workerd/DO | Node/Bun/processo compatível a verificar na versão; VPS/container é hipótese simples |
| Operação incremental | Menos serviços novos | Container/disco/patching se VPS; DO evita parte disso | Processo/disco/patching e integração de streaming |
| Manutenção própria | Pode continuar maior se preservar mecanismos concorrentes | Potencial redução de loop/contexto/providers; custo do plugin/bridge conta | Potencial footprint menor; integração própria pode compensar |
| Qualidade conversacional | Não medida para A1 | Não medida para B com tools | Não medida para C atual |
| Risco de mudança | Menor distância, risco de manter rigidez | APIs/plugin/versão, tenancy, migração histórico | SDK/RPC/versão, tenancy, reconstrução de integração |
| Integridade financeira | Mesma API/protocolo | Mesma API/protocolo | Mesma API/protocolo |

Não há pontuação numérica inventada para custo, inteligência ou confiabilidade. A0 é controle, não sinônimo de A1. F2 rejeitou outro desenho e não substitui essa comparação.

## 7. Regra de decisão

Priorizar B como experimento e A1 como controle arquitetural. Se ambos melhorarem igualmente e A1 exigir menos código/operação, preferir A1. Se B simplificar materialmente sem regressão de integridade/custo/latência, preferir B; decidir VPS versus DO separadamente. Se B exigir muitos hooks internos/fork para remover comportamento de coding ou manter identidade, interromper e avaliar C ou A1. Não criar catálogo/roteador/gerente de subagentes novo.

## 8. Lacunas de evidência

Metadados públicos consultados em 30/10:

| Artefato | `latest` observado | Fonte |
|---|---|---|
| `@opencode/sdk` | 2.2.4, MIT, export `./workerd` | [npm](https://registry.npmjs.org/@opencode%2Fsdk/latest) |
| `@opencode/client` | 2.2.4, MIT | [npm](https://registry.npmjs.org/@opencode%2Fclient/latest) |
| `@opencode/cli` | 2.2.4, MIT | [npm](https://registry.npmjs.org/@opencode%2Fcli/latest) |
| `@opencode/plugin` | 2.2.4, MIT | [npm](https://registry.npmjs.org/@opencode%2Fplugin/latest) |
| `@earendil-works/pi-coding-agent` | 1.4.0, MIT, Node ≥22.19.0 | [npm](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest) |

Licenças: [OpenCode MIT](https://api.github.com/repos/anomalyco/opencode/license), [Pi MIT](https://raw.githubusercontent.com/earendil-works/pi/main/LICENSE). Preservar notices ao redistribuir; isso não dispensa termos/privacidade do provider.

**Drift verificável:** a página de [Policies](https://opencode.ai/v2/docs/policies) já descreve `integration.connect`, novo significado de `integration.use`, `mcp.use`, `skill.use` e `plugin.use` como ignorados por clientes anteriores a 2.3.0. Isso não significa que todas as policies ou skills só existam em 2.3.0. A POC 2.2.4 não pode apoiar sua segurança nesses controles novos. Checar o catálogo efetivo, permissões compatíveis e isolamento do processo; falha em restringir capabilities = parar o spike.

A versão do OpenAPI (`info.version`) não é versão do produto. Antes do spike, pin completo de SDK/plugin/dependências/imagem, digest/integrity e teste da versão publicada; não usar `latest` no runtime nem assumir que docs móveis descrevem exatamente o pacote. SDK documentado não prova execução no ambiente TED. Compatibilidade Node/Bun, autenticação administrativa, descoberta efetiva, throughput, RAM, recuperação, custo, latência e qualidade conversacional permanecem não medidos. Nenhum benchmark da instalação de desenvolvimento foi usado como substituto.

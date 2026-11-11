# Diagnóstico F2B0 — identidade nativa do cliente e 429

**Escopo (2026-10-27):** inspeção do executável instalado, experimentos locais com servidor mock e correção pontual da propagação do prompt. Nenhuma chamada real de inferência foi feita nesta missão. Este documento não altera o veredito do B0 nem transforma uma hipótese em causa comprovada.

## Veredito

- **Causa do 429: inconclusiva.** O registro publicado anterior mostra uma única requisição real, resposta 429 em 702 ms, erro classificado como `provider.free-limit` e nenhuma resposta gerada. O retry foi vetado; portanto não houve segunda chamada real. Isso demonstra o resultado, não identifica se a limitação decorreu de conta, IP, capacidade compartilhada, quota ou outra política do serviço.
- **Hipótese de headers de identidade incorretos: NOT REPRODUCED** na comparação controlada. O CLI nativo, em cada caminho isolado, gerou e preservou os headers esperados até o mock loopback. Isso não prova equivalência com o contexto global de autenticação/configuração nem explica o 429 real.
- Não há base para atribuir o 429 a diferença no prompt ou nos headers de identidade. Não se fizeram injeções artificiais de headers/IDs, nem nova tentativa para “confirmar”.

## Evidências examinadas

1. `apps/agent/tests/poc-structured/f2b0-runtime/header-diagnostic/evidence-v3-1793092518851-20640.json` (`header-diagnostic-safe-v3`, CLI 2.1.4): quatro execuções em casas/configurações isoladas, com mock somente em loopback.
2. `apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/published-b0-stop.json`: registro de parada anterior, status `STOPPED_NO_FURTHER_INFERENCE`; 1 requisição real, 0 respostas geradas, 21 casos não executados.
3. Prova de fonte empacotada registrada no diagnóstico: versão/hash do bloco e fingerprints dos trechos de identidade, afinidade, auth e mapeamento de erro. O offset/hash identifica a fonte binária examinada; não equivale a commit Git do código-fonte.

## Identidade nativa observada no diagnóstico

| Elemento | Observação | Resultado |
|---|---|---|
| `User-Agent` | Construído pelo CLI a partir de canal, versão e nome; comparação com o construtor nativo | esperado e correspondente antes/depois, nos quatro casos |
| `x-opencode-client` | Nome de cliente produzido pelo caminho nativo | correspondente ao construtor oficial nos quatro casos |
| `x-opencode-session` | Chave produzida pela seleção nativa de afinidade, sem ID artificial | presente, igual a `x-session-affinity` e `X-Session-Id`, preservada no mock |
| `x-opencode-session-id` | Comparado com o evento nativo de sessão | corresponde nos quatro casos |
| Afinidade | `x-session-affinity` e aliases de sessão presentes e iguais | valor preservado; não usado como prompt-cache key |
| Afinidade de pai | Headers de parent ausentes na execução raiz | esperado para raiz; a seleção nativa é parent → fork → session. Não há requisito demonstrado de ID parent com 64 hex nem evidência de que sua ausência cause 429 |
| Projeto | `x-opencode-project` presente | identidade de projeto nativa preservada |

Os campos oficiais foram comparados em memória; os valores sensíveis não foram copiados para este relatório. Não houve fabricação de identificadores nem alteração/injeção de headers. As rotas standalone e serve/SDK foram executadas em contextos separados, cada uma com identificadores nativos próprios; o mock só recebeu as requisições encaminhadas pelo caminho oficial do CLI.

## Entrada e contexto

- A entrada da fixture F1-B010 é “Mostre minhas faturas”; história, contas, categorias e opções exibidas estão vazias.
- O prompt de origem tem 8.361 bytes. Nos caminhos `argv`, o payload cresce 962 bytes, exatamente a expansão de 960 aspas escapadas mais duas aspas de representação; não há bytes adicionais de histórico do usuário demonstrados. Nos caminhos `stdin`, os 8.361 bytes são preservados literalmente, sem overhead de wrapper.
- As métricas `chars/4` são apenas heurísticas de tamanho, **não** tokens medidos pelo provider. O system/context difere em 9 bytes entre as rotas; a normalização explica essa diferença por substituição do nome de modo e do tamanho do workdir. Isso não prova equivalência semântica universal do contexto.
- Os quatro casos usam homes/configs isolados e não importam configuração global. No processo corrente e nos filhos não havia API key nos nomes de env verificados nem chave configurada no provider; o header de autorização observado foi classificado pela prova local como fallback público. O conteúdo do auth store global não foi lido. Logo, isso **não** demonstra que o launcher global use a mesma autenticação, nem permite comparar valores de credencial; nenhuma credencial foi acessada.

| Caminho mock | Texto user (bytes) | Estimativa user (`ceil(chars/4)`) | System (bytes) | Corpo HTTP (bytes) | Requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| CLI standalone, argv | 9.323 | 2.331 | 1.113 | 12.603 | 1 |
| serve + SDK + CLI, argv | 9.323 | 2.331 | 1.122 | 12.612 | 1 |
| CLI standalone, stdin | 8.361 | 2.091 | 1.116 | 10.682 | 1 |
| serve + SDK + CLI, stdin | 8.361 | 2.091 | 1.125 | 10.691 | 1 |

Cada payload tinha uma mensagem system, uma user, zero histórico e zero tools. Os números de corpo incluem serialização JSON e não são tokens. O prompt não é só a frase de 20 caracteres: inclui o contrato estruturado e o input sintético explícito.

### Correção delimitada

Em `real-runner.ts`, somente a entrega do prompt ao CLI mudou: saiu de argv para stdin UTF-8, mantendo captura de eventos NDJSON, modelo, endpoint, reservas e veto de retry. Não foi aplicado unescape ao conteúdo. A reconstrução exata `new Request(original, { redirect: 'error' })` foi exercitada antes do redirecionamento exclusivo ao mock; método, corpo e headers foram comparados em memória. A conferência dos valores oficiais no mock usou HMAC efêmero e persistiu apenas o resultado booleano, não o MAC.

Erros de escrita do pipe (`EOF`/`EPIPE`) são capturados antes do envio, registrados somente por código e tratados como fatais pelo fluxo de cleanup existente, sem reenvio. A correção foi testada com filho local e mock; não houve execução real para validá-la contra o provider.

## Interpretação do erro e limites

A fonte empacotada mapeia `QuotaExceeded`/`FreeUsageLimitError` para `provider.free-limit`. O registro de parada classifica a resposta real como `provider.free-limit` (429) e documenta `Retry-After` de 81.135.000 ms (~22 h 32 min 15 s, relativo àquela resposta). Esse intervalo não identifica o escopo da quota, não atesta capacidade futura e não autoriza nem recomenda nova chamada.

O mock de comparação testa transporte e identidade de cabeçalhos; não reproduz a política do servidor real, a autenticação normal do launcher, nem a causa da resposta 429. A evidência de fallback público é observação do processo isolado, não prova sobre o perfil global. Portanto a hipótese “identidade de headers incorreta causou 429” permanece **não reproduzida e sem causalidade demonstrada**; a causa do 429 permanece **inconclusiva**.

A [documentação oficial Console Models V2](https://opencode.ai/v2/docs/console/models/), consultada nesta investigação, exige OpenCode para chat Free e descreve a oferta como temporária. Ela não fornece uma quota numérica nem o mecanismo que distingue conta, IP ou capacidade neste erro. Não foram consultados usage/billing, alteradas credenciais, trocados IPs ou simulada identidade para investigar esse limite. Falta evidência do lado do serviço para confirmar a causa específica; nenhuma correção de quota é presumida.

## Privacidade e preservação do escopo

Nenhum valor de header, token ou cookie, conteúdo de auth store ou stdout bruto foi reproduzido. A evidência usa hashes/flags e comparações em memória; não foi persistido MAC temporário. Esta missão não executou requests reais, não retestou B0/B1, não usou fallback pago, não modificou dados financeiros, e não fez merge, deploy, commit ou publicação.

## Validação executada e reprodução local

O implementador executou `node apps/agent/tests/poc-structured/f2b0-runtime/header-diagnostic/run.mjs` somente contra mock: quatro braços, um request por braço, sem ferramentas ou retries. Evidência v3 referenciada acima. Os temporários não integram o relatório; nenhum valor de autenticação foi persistido.

Validação independente:

| Comando | Resultado |
| --- | --- |
| `pnpm --filter pi-finance-agent exec vitest run tests/poc-structured --reporter=dot` | PASS: 83 testes, 7 arquivos |
| `pnpm --filter pi-finance-agent typecheck` | PASS |
| `pnpm docs:lint` | PASS |
| `pnpm governance:check` | PASS |
| `git diff --check` | PASS |
| `pnpm typecheck` agregado | Timeout; não aprovado nesta missão |
| Biome focado | Timeout; resultado inconclusivo |

Revisão independente focal: **APPROVED**. Não se declara aprovação integral dos gates. Testes completos e build não foram repetidos; nenhuma chamada B0/B1 foi feita. Os testes Vitest cobrem fidelidade UTF-8/aspas/quebras de linha, reconstrução de Request, headers inválidos/alterados e fechamento antecipado do pipe. Não executar o runner real como parte desta validação.

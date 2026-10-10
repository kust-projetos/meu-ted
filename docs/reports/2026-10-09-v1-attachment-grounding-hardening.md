# Meu Ted V1 — hardening de anexos e grounding (2026-10-09)

## Baseline e escopo

- Repositório: `kust-projetos/meu-ted` (`D:/projetos/pi-financeiro`).
- Baseline consultado: `main@035d0a1d20` = `origin/main`; fetch não encontrou commits posteriores. Working tree limpa antes do início.
- Branch local: `fix/v1-attachment-grounding-hardening` (base `035d0a1d`). Nenhum commit, push, PR, merge ou deploy executado até este registro.
- PRs #125, #126, #127, #129 e #130 já estavam mergeados. Seus comentários foram tratados como pistas e comparados com o código corrente. Issues #105 e #107 permanecem OPEN.
- CI e PWA CI do SHA de baseline estavam verdes (CI `37860109697`, PWA CI `37860109691`). PRs anteriores tinham checks verdes, mas isso não elimina os findings reproduzidos no HEAD.

## Findings e correções locais

| Finding | Causa-raiz / impacto | Correção no branch | Evidência de regressão | Estado |
|---|---|---|---|---|
| PDF work limit (P1 #125) | `getTextContent()` materializa todos os itens de uma página antes do teto de caracteres; limite de páginas só atua entre páginas. `Promise.race` não cancela CPU síncrona. Uma única página densa não tem bound efetivo verificável. | Parser de runtime desabilitado incondicionalmente, mesmo com env `1`; `TED_PDF_TEXT_ENABLED=0`. `createUnpdfExtractor` permanece para testes/possível reabilitação após isolamento/limites efetivos. Upload/R2 não mudou. | RED→GREEN nos testes focados PDF; teste real de fluxo confirma `unsupported` e zero parse com env `1`; parser real continua testado isoladamente. | **Mitigado por disable**; limite efetivo não implementado. Produção ainda pode estar ativa no SHA antigo. |
| Grounding: unidade, contagens, moeda, sinal (#127/#129) | `flatten()` apagava campo/proveniência; números sem unidade e strings BR-decimal eram considerados dinheiro; BRL/USD e positivo/negativo podiam colidir; contagem podia justificar percentual. | Grounding tipado pelos campos `*Cents` do contrato de leitura e campos explicitamente percentuais; unidades e currencies preservadas; número negativo mantém sinal; campos desconhecidos falham fechados. Não há conversão cambial. | Testes de valores `10%`, `12,50%`, `0,75%`, R$, kg/km/unidades/toneladas, contagem, BRL/USD, unknown, sinal ± e publicação. | Corrigido localmente; requer CI/review do SHA final. |
| Vision Gemini/Groq (#129) | Renderer produz `42.50 R$`; matcher antigo não reconhecia sufixo e símbolo. Campos estruturados de provider não eram normalizados para grounding. | Normalização compartilhada de currency conhecida para código ISO; valor preservado; `unknown`/`ambiguous` não inferem moeda. Provider selection/allowlist/timeout/quota intactos. | Testes do contrato real HTTP-envelope de ambos os adapters e do parser/render/grounding integrado. | Corrigido localmente; canary live não repetido. |
| Anexo confundido com registro (#127/#129) | Texto do anexo era admitido como suporte financeiro sem assegurar que a afirmação se referia ao documento e não ao estado do workspace. | Claims de registro exigem suporte financeiro de API; valor de documento permanece aceito em afirmação atribuída ao documento. Nenhum caminho de mutation consome grounding. | E2E de `createGroundedResponseWithRetry`: documento citado passa; “despesa registrada”/saldo multiline sem API falha e retorna fallback. Prompt injection não autoriza mutation. | Corrigido localmente; residual: atribuição é validada por contexto textual bounded, não por novo envelope estruturado. |
| PDF privacy/egress (#130) | Extração local foi descrita como “sem egress”, omitindo que texto extraído entra no contexto enviado pelo LLM relay/provider. Isso altera premissa de privacidade do canary. | Retificação em `docs/reports/2026-10-08-a19-provider-validation.md` §11, `apps/agent/AGENTS.md`, `ROADMAP.md` e estado V1. Nenhuma alegação de ZDR ou retenção zero. | Fluxo revisado em `conversation-orchestrator.ts` (`responseProvider`) e upload/storage/TTL no adapter R2. | Documentado; **WAITING_OPERATOR** para revisar egress, provider/endpoint e retenção antes de rollout. |
| Instruction version (#126) | Conteúdo de precedence foi alterado sem incrementar a versão documentada. | `INSTRUCTIONS_VERSION` atualizado para `2026-10-09.b`; teste de formato/versão e budget de correction leg. | `cognitive-instructions.test.ts`. | Corrigido localmente. |
| Grounding observability (E2) | Evento de rejeição não distinguia eixos nem sucesso/retry/falha/latência. | Eventos sanitizados para grounded/rejected, eixo por contagem, retry attempt/outcome/provider failure/latência; sem texto ou valor financeiro; retry continua exatamente um. | `grounding-events-observability.test.ts` inclui verificação de sanitização e preservação do quota passthrough. | Corrigido localmente. |

Complementos após review: uso de `*CentsExact` preserva precisão `bigint` quando
o sibling `number` ultrapassa `2^53`; valores numéricos inseguros não sustentam
claim. Evidência monetária de anexo agora exige atribuição positiva à fonte na
frase (“o documento informa”, “no anexo consta”), além do deny-list de estado
registrado. O system prompt recebeu copy de atribuição (`INSTRUCTIONS_VERSION`
`2026-10-09.b`), mantendo o teste do limite da perna de correção verde.
Também foram adicionados os traps `BDT - 42,50`, `R$ - 42,50`, `42,50 TED/DOC`,
marcadores de moeda conflitantes e atribuição atravessando “e”.

## Fluxo de dados e privacy gate

```text
PDF → R2 privado → unpdf local → texto no contexto da conversa
    → LLM relay/provider autorizado → grounding → resposta
```

- `ATTACHMENT_TTL_MS` é 24 h; código de cleanup é bounded/resumível, mas não houve prova de execução de limpeza no bucket live nesta atividade.
- Upload/R2, flags STT/Vision, credenciais, provider/model default, PendingOperation, MutationReceipt, autorização, memória/forget, undo e autoexecute não foram alterados.
- A política de retenção do provider/endpoint usado pelo relay não foi evidenciada. O gate aceito sob premissa “sem egress” deve ser reapresentado ao operador.
- No SHA live `035d0a1d`, o manifesto versionado traz `TED_PDF_TEXT_ENABLED=1`; a configuração live exata não é exposta por `/health`. É inferência do SHA atestado + manifesto, não leitura direta de variável do runtime. O branch configura `0`, mas nenhuma alteração foi aplicada em produção.

## Validação local

- TDD PDF: regressão falhou antes do fail-closed; testes focados depois verdes. Integração/golden foram alinhados ao comportamento `unsupported`; testes unitários do parser isolado foram preservados.
- TDD grounding: testes RED para as colisões, depois GREEN; reviews independentes encontraram e os testes pinam traps adicionais (sinal, count→percent, unknown currency/unit, multiline, cents arredondado, atribuição, marcadores conflitantes, TED/DOC e sinal bare espaçado).
- `pnpm test` em `apps/agent`, execução final serial após todos os fixes: **183 files passed / 1 skipped; 2232 passed / 1 skipped**. Duas integrações excederam timeout quando executadas simultaneamente com typecheck/lint; ambas passaram isoladas e a suíte completa passou na repetição serial.
- Golden runner: `pnpm --filter pi-finance-agent exec vitest run tests/golden` → **21/21 testes do runner passaram**; dataset reporta `total=29 pass=23 fail=0 skipped-pending=6 falseSuccess=0`. Os 6 casos pending continuam pending, não foram convertidos em PASS. O alias raiz `pnpm test:golden` não existe.
- `pnpm typecheck` e `pnpm lint` em `apps/agent`: PASS; lint apresenta 4 warnings preexistentes em `tests/llm-api-to-agent.e2e.test.ts`, sem erros.
- Gates raiz após atualizações: `docs:lint`, `governance:check`, `capabilities:check`, `write-policy:check`, `test:skip-gate`, `public-safety --strict`: PASS. `git diff --check`: PASS.
- CI e PWA CI do SHA `f1c521355985e143db33ff38bca87e8e6d33ecc0`: **passaram**. CI run `37994630461` (Gate — all checks success `114047340174`); PWA CI run `37994630467` (`quality (22, 10)` e `e2e (22, 10)` success). Três jobs do primeiro attempt falharam apenas durante pulls Docker Hub (504/rate-limit); reruns recuperaram Docker build, Postgres e security scan. O SHA atual pode mudar neste commit documental, portanto estes resultados atestam `f1c5213`, não automaticamente seu sucessor.
- Reviewer: revisões intermediárias `CHANGES_REQUIRED`; findings corrigidos com regressões. Review estático independente final: **APPROVED** (reviewer não executou testes por limitação de ambiente; validação local listada acima). Codex PR review atingiu limite de quota e não foi aprovação; reviewer independente local + CI completo são a revisão alternativa registrada.

## Produção (somente leitura)

- Agent: `/health` = ready, `buildSha=035d0a1d…`, build `37860109691`.
- PWA: `/api/build-info` = `gitSha=035d0a1d…`, build `37860109691`.
- API Contabo: `/health` = `gitSha=bd1ed9b…`, build `37238430467`.
- PR: [#132](https://github.com/kust-projetos/meu-ted/pull/132), aberto, merge state CLEAN no SHA `f1c5213`; nenhum merge executado.
- Deploy executado: **não**. Flags alteradas live: **nenhuma**. Rollback: não aplicável nesta atividade; o rollback do futuro deploy segue redeploy do SHA anterior pelo fluxo existente.
- Smoke realizado: GET read-only dos três endpoints acima; não exercitou turno generativo nem anexo.

## Fechamento V1

| Frente | Estado | Bloqueador |
|---|---|---|
| A19 | `WAITING_OPERATOR` | Privacidade do texto PDF enviado pelo relay/provider; deactivation live autorizada e provas/canaries restantes. |
| Golden #105 | `WAITING_OPERATOR` | Golden suite completa e critérios restantes ainda não concluídos. |
| Autoexecute low-risk | `WAITING_OPERATOR` | Mantém SHADOW; `on` requer telemetria adequada. |
| Release B | `WAITING_DATE` | Gate `2026-10-16T21:36:06Z` e zero eventos. |
| F3–F5 | `WAITING_OPERATOR` | Gate humano de cutover/aposentadoria. |
| Backup/restore | `WAITING_OPERATOR` | Restore proof fresco pendente. |
| Production E2E | `WAITING_OPERATOR` | Aceite final integrado pendente. |
| Release v1 | `BLOCKED_EXTERNAL` | Este hardening não fecha os gates operacionais da v1. |

Veredito deste pacote: correções locais e CI/PWA CI do SHA `f1c5213` verdes,
review estático APPROVED; ainda faltam decisão do operador sobre privacidade e
desativação live autorizada. A v1 permanece NOT READY enquanto os gates
operacionais listados acima não forem fechados.

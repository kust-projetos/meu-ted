# P2 — Fechamento mínimo: classificação live-real (correção)

## Escopo
Correção mínima publicada no PR #290 sobre a classificação de egress do
live-real: registrar os motivos reais dos bloqueios no guard, derivar a
categoria exclusivamente dos reason codes originais e consumir essa
classificação no E2E opt-in. Sem nova inferência real, sem reavaliar o
provider e sem infraestrutura adicional.

## Mudanças publicadas — commit `a017337`
- `p2d-fetch-guard.mjs` mantém `stats.blockedReasons` com códigos curtos e
  fixos (sem URL, header ou credencial), incrementados em deny de
  classificação, falha de pin de modelo e bloqueio de redirect.
- `live-real-classification.ts`: `destination` (destino genérico fora da
  allowlist) deixa de ser presumido auxiliar e passa a `unidentified`. Só
  reason codes auxiliares explícitos (`telemetry`/`analytics`/`csp`/
  `auxiliary`) classificam como auxiliar; qualquer outro deny continua
  funcional.
- `p2d-live-real.spec.ts` consome `blockedReasons` e aplica
  `validateLiveRealEgress`: bloqueio funcional falha a execução; contagens
  funcional/auxiliar/não identificada vão para a evidência por execução.
- `live-real-classification.test.ts` cobre os reason codes reais, o
  `unidentified` sem evidência e a falha funcional (10 casos).

## Validação local
- `pnpm vitest run e2e/support/live-real-classification.test.ts` → 10/10 PASS.
- `pnpm vitest run e2e/support/live-closure-guards.test.ts` → 29/29 PASS.
- `pnpm typecheck` (pwa) → sem erros.
- `pnpm eslint` nos quatro arquivos alterados → sem erros.
- `node --check` no guard → sintaxe válida; `git diff --check` limpo.

## CI do commit `a017337` — verde
- CI run `42290956248` → success (API, Agent, TED Runtime, PWA, Codex Broker,
  Postgres, Docker, Security, Documentação, Governança, Capacidades,
  Write policy, Public safety).
- PWA CI run `42290956202` → success, incluindo `quality (22, 10)` e
  `e2e (22, 10)`.
- Todos os checks do PR #290 passam; `Gate — all checks` success.

## `check-pwa-audit` — origem de `@aws-sdk/core@^3.980.1`
O job `quality (22, 10)` falhou na execução anterior (`42285484959`) com
`npm error notarget No matching version found for @aws-sdk/core@^3.980.1` às
`2026-11-06T20:14:58Z`. Origem investigada e delimitada:

- A referência não existe no repositório: não há pin, override, dependência
  direta nem entrada com `3.980` no `pnpm-lock.yaml` nem nos `package.json`.
- O gate cria um manifesto temporário com as dependências diretas do PWA
  fixadas pelo lockfile e resolve as transitivas pela registry no momento da
  execução. Vinte e sete pacotes `@aws-sdk/*` presentes nessa árvore declaram
  `@aws-sdk/core@^3.980.1` nas suas versões `latest`.
- `@aws-sdk/core@3.980.1` foi publicado em `2026-11-06T20:15:18Z` — vinte
  segundos **depois** da resolução que falhou. Era uma publicação escalonada
  da AWS: os pacotes dependentes chegaram antes do `core`.

Correção aplicada: nenhuma no repositório. A referência passou a ser válida
assim que o upstream publicou a versão; a reexecução em `a017337` passou o
`Scoped audit` sem alteração de código, allowlist ou lockfile. Alterar pin,
override ou allowlist aqui seria mascarar uma corrida de publicação externa.

## Status registrados (sem nova inferência)
1. Leitura financeira com modelo real: **comprovada** — jornada DeepSeek real
   já executada em rodada anterior; não repetida nesta sessão.
2. Origem dos dez bloqueios históricos: **indeterminada** — os artefatos
   existentes não registram o motivo de cada bloqueio. Com a correção, eles
   são classificados como `unidentified`, nunca presumidos auxiliares.
3. Persistência live após restart com modelo real: **não comprovada** — segue
   sem evidência de execução real; nenhuma inferência foi executada para
   produzi-la.

## Preservação e restrições
- Sem merge, sem deploy e sem escrita financeira.
- Sem ampliação de allowlist, destinos adicionais ou alteração de transporte.
- Bloqueios funcionais continuam falhando a validação.
- F1 (relatórios de eval) e as alterações locais preexistentes — incluindo o
  diretório `--no-save/` e a evolução local dos specs de persistência —
  permaneceram intactos e fora deste commit.

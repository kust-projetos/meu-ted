# Configuração do repositório — saneamento, hooks e auditoria (2026-10-02)

- **Data:** 2026-10-02 · **Status:** `FINAL` (todas as frentes concluídas; mudanças NÃO commitadas — aguardando revisão/aprovação do operador, regra 4)
- **Baselines:** início `main@7bd24ca` (`origin/main` sincronizado; working tree limpa)
- **Autorização:** pedido direto do operador ("configure corretamente nosso repo"); escopo confirmado pelo operador em 4 frentes (gitignore, hooks, ai-memory routing, auditoria completa) e ampliado com "atualize a documentação do projeto"; correção do operador: skills do ai-memory já existem no root global — sem duplicação project-local; sem `CLAUDE.md` (Claude Code não é usado neste projeto)

## 1. Diagnóstico inicial — working tree

- `main` em sincronia com `origin/main` (`7bd24ca`, PR #65 docs), **sem** modificações não commitadas de código.
- 4 diretórios untracked sem cobertura no `.gitignore`: `apps/pwa/test-results-live-closure0930/` (5 PNGs de evidência do live closure), `apps/pwa/e2e/test-results-live-closure0930/` (`.last-run.json` do Playwright), `apps/pwa/test-results-prev-20260930-1826/` (21 entradas antigas) e `backups-local/` (contém `pi-rewind-store-20261001.bundle`, marcado no AGENTS.md como **nunca deletar**).
- Zero infraestrutura de hooks: sem husky/lefthook/simple-git-hooks, `core.hooksPath` não configurado, `.git/hooks/` só com `.sample`.

## 2. `.gitignore` — RESOLVIDO

- Adicionados na seção "Test artifacts" (root, linha 54): `test-results*/` — cobre o output default do Playwright e os diretórios datados de evidência (escritos por `apps/pwa/e2e/live-closure.config.ts:34` e `apps/pwa/e2e/specs/live-closure.spec.ts:128`, que hardcodam `outputDir` fora do padrão `/test-results/` já coberto em `apps/pwa/.gitignore:48`).
- Adicionada após `backups/` (root, linha 61): `backups-local/` — com comentário explícito de que os bundles são preservados em disco e recomendados para push off-machine.
- **Prova:** `git check-ignore -v` casa os 3 diretórios de test-results na linha 54 e `backups-local` na linha 61; `git status` passou a mostrar apenas as mudanças intencionais desta sessão.
- Nada foi deletado do disco. Duplicidade cosmética de `coverage/` (linhas 36 e 47) deixada como está (sem efeito semântico).

## 3. ai-memory routing — RESOLVIDO

- Bloco canônico marcado (`<!-- ai-memory:start -->` … `<!-- ai-memory:end -->`) anexado ao final de `AGENTS.md` (arquivo canônico do repo, lido por OpenCode e clientes AGENTS-aware), com o conteúdo core-owned de `memory_install_self_routing`.
- Skills gerenciadas: **6/6 no root global** `~/.agents/skills/` (todas com o marker `ai-memory-managed: routing-skill`). As 5 pré-existentes já cobriam esta máquina; `ai-memory-messaging` foi a única escrita nesta sessão para completar o set.
- **Decisão do operador aplicada:** sem cópias project-local (`.agents/skills/` do repo foi criado e depois removido) e sem `CLAUDE.md` (o import `@AGENTS.md` só faria sentido para Claude Code, não usado aqui). O bloco no `AGENTS.md` viaja pelo git e é o roteamento canônico; outras máquinas podem reproduzir o set global com `ai-memory install-skills`.

## 4. Hooks de pré-commit — RESOLVIDO

- **Design:** husky v9 como devDependency da raiz (`prepare: "husky"`), hook `pre-commit` executando apenas os 7 gates rápidos (fs/git walk, sem builds), com `set -e` e bypass documentado (`git commit --no-verify`). Gates pesados (`typecheck`, `test`, `lint`, `security:*`, e2e) permanecem **CI-autoritativos** nas required checks (`Gate — all checks` + `quality (22, 10)`).
- **Evidência dos 7 gates verdes nesta sessão (executados individualmente antes do wiring):**
  `pnpm docs:lint` (12 docs, 0 issues) · `pnpm action-pins:check` (85 usos SHA-pinned, 0 exceções) · `pnpm test:skip-gate` (97 arquivos, 0 novos skips) · `pnpm capabilities:check` (52 tools / 72 rows) · `pnpm write-policy:check` (186/186) · `pnpm governance:check` (sem mudança D01–D19) · `pnpm public-safety --strict` (PASS).
- **Caveat conhecido:** gitleaks **não** entra no hook — `scripts/security-secrets.mjs:55-58` sai com `exit(0)` em `win32` sem escanear (skip intencional, CI é autoritativo). Um hook local de gitleaks seria no-op silencioso na plataforma nativa do operador.
- **Bloqueio de ambiente (resolvido):** a ativação exigiu recriação do `node_modules` local — o diretório estava com `virtual-store-dir-max-length` divergente da config atual (pnpm 10.34.1, lockfile 9.0 compatível); resolvido com `CI=true pnpm install` e então `pnpm add -D -w husky` + `pnpm run prepare`.
- **Ativação concluída (evidência):** `pnpm add -D -w husky` → husky 9.1.7 em devDeps da raiz; `prepare: "husky"` no `package.json` raiz; `pnpm run prepare` → `core.hooksPath=.husky/_` confirmado via `git config`; wrappers gerados em `.husky/_/`. Teste end-to-end do conteúdo: `.husky/pre-commit` executado via `C:\Program Files\Git\bin\sh.exe` (mesmo runtime que o git usa para hooks) → **7/7 gates verdes, exit 0**. Sonda de commit real NÃO executada (regra 4 — commits só após aprovação); o primeiro commit do operador exercitará o wiring nativo.
- **Nota de ambiente:** `pnpm install` exigiu recriação do `node_modules` local (`virtual-store-dir-max-length` divergente da config atual; resolvido com `CI=true pnpm install` — 15m13s, 1.173 pacotes, store reutilizada, lockfile intacto). Warnings de peer dependencies exibidos pelo pnpm 10 (wrangler/agents/zod/stryker) são preexistentes do lockfile, não introduzidos nesta sessão. `core-js-pure` com build script ignorado é benigno (pacote de dados).

## 5. Atualização de documentação

- **`docs/MEU-TED-SPEC-HARDENING-SIMPLIFICACAO-E-DESCOMISSIONAMENTO-V4.md`** — 2 afirmações de "Estado atual" desatualizadas corrigidas com data (2026-10-02): (J1) `lint` e `typecheck` da API hoje são comandos semanticamente distintos (Biome vs `tsc`); (J2) Biome 2.2.4 está ativo em api/agent/broker e ESLint 9 na PWA — a frase "Biome em devDeps sem ser invocado" era falsa.
- **`docs/superpowers/plans/2026-08-16-p5-final-validation.md:74`** — menciona alias `apps/whatsapp-bridge lint` removido; **não editado** por ser plano histórico datado (registro do que foi executado em agosto). Corrigir histórico falsificaria o registro; a inconsistência fica registrada aqui.
- **`README.md`** — reescrito e ampliado (56 → ~130 linhas): componentes (inclui `packages/llm-contracts`), topologia de produção, requisitos, desenvolvimento local, gates de qualidade (hook + required checks + caveat gitleaks), estrutura do monorepo, deploy e documentação canônica. `pnpm docs:lint` PASS após a reescrita.
- **`AGENTS.md`** — reestruturado: (1) regra 5 agora inclui `pnpm lint` nos gates obrigatórios de conclusão (alinha AGENTS.md ao CI — resolve achado 11) + nota do hook; (2) nova seção "Configuração do Repositório (2026-10-02)" (hook, gitleaks win32, gitignore, ai-memory, convenção de relatórios); (3) seção de estado reorganizada em subseções (Sessões recentes / Estado de produção vigente / Gates humanos abertos / Regras permanentes), com a sessão 2026-10-02b registrada, duplicatas de "Gates humanos" fundidas e histórico pré-09-29 condensado — proibições e autorizações preservadas verbatim.
- **`docs/reports/2026-10-02-repo-config-audit.md`** — este relatório.

## 6. Auditoria de configuração — inconsistências mapeadas

Levantamento read-only (explorer) sobre `package.json` (raiz + 6 workspaces), workflows CI, `.gitignore`, `.gitleaks.toml`, configs de lint e scripts de gate. Ordem por impacto:

| # | Achado | Evidência | Impacto | Ação proposta | Dono |
| --- | --- | --- | --- | --- | --- |
| 1 | gitleaks no-op silencioso no Windows | `scripts/security-secrets.mjs:55-58` | `validate:final` local dá falsa segurança; CI permanece autoritativo | Manter CI-only (feito no design do hook); opcionalmente escopar o skip win32 | humano |
| 2 | `packages/llm-contracts` fora de todo gate agregado | `package.json:18,23`, `scripts/run-workspace-gate.mjs:4`, `vitest.config.ts:5-10`, sem job CI que rode `test`/`typecheck` dele (só `build`) | Contratos mudam sem teste/typecheck em nenhum lugar | Incluir no root `test`/`typecheck`/`lint` + job CI | humano |
| 3 | Root `pnpm lint`/`pnpm typecheck` nunca usados no CI (jobs chamam por workspace) | `ci.yml:36,58,113,134-135`, `pwa-ci.yml:64` | Drift entre gates do AGENTS.md e o que o CI prova | Alinhar (usar os agregados no CI ou documentar a diferença) | humano |
| 4 | Prettier declarado sem config e scripts `format:check`/`format` nunca invocados | `apps/api/package.json:29,31,50`; sem `.prettierrc*` no repo | Ferramenta morta | Comitar config e ligar ao CI, ou remover scripts/dep | humano |
| 5 | Floor de engine inconsistente | root `engines.pnpm >=9.0.0` vs CI pina `10` vs `apps/agent >=10.34.1` | Local pode rodar versão que o CI nunca usa | Bump root para `>=10` | humano |
| 6 | `scripts/check-working-tree-inventory.mjs` sem wiring | sem script/CI referenciando; só o próprio teste importa | Governança morta | Integrar ao `validate:final` ou remover | humano |
| 7 | Entradas legadas de `apps/whatsapp-bridge` no `.gitignore:79-81` | arquivos ainda existem em disco (leftovers), entradas ainda suprimem | Ruído; referências a workspace removido (P3 `f640e84`) | Limpar leftovers + entradas na aposentadoria legacy | humano |
| 8 | `check-pwa-audit.mjs:15` ainda whitelista advisories do workspace removido | `apps__whatsapp-bridge` + fixture em `scripts/__tests__/fixtures/sibling-only-advisory.json:15` | Allowlist morta alarga blast radius | Remover na aposentadoria legacy | humano |
| 9 | `apps/whatsapp-bridge/` ainda em disco (`node_modules/` + `scripts/`) | fora do pnpm-workspace, invisível aos gates | Sujeira residual conhecida | Decisão da aposentadoria legacy (já rastreada) | humano |
| 10 | Spec V4 com afirmações stale (Biome não invocado; lint alias de tsc) | `docs/MEU-TED-SPEC-…-V4.md:436,440` | Docs canônicas descrevendo estado falso | **Corrigido nesta sessão** (seção 5) | resolvido |
| 11 | AGENTS.md omite `pnpm lint` dos gates obrigatórios de conclusão | `AGENTS.md:72-73` (4 comandos) vs lint rodando em 4 jobs CI | Gate de conclusão mais fraco que o CI | **Resolvido nesta sessão** — regra 5 inclui `pnpm lint` | resolvido |
| 12 | `coverage/` duplicado no `.gitignore` | linhas 36 e 47 | Cosmético | Sem efeito; deixar | — |
| 13 | **CI não roda lint de Agent/Broker** (só API `ci.yml:36` e PWA `ci.yml:135`) — confirmado por grep após revisão independente | `.github/workflows/ci.yml` (jobs agent ~:58, broker ~:113 sem step lint) | Lint de agent/broker coberto APENAS localmente (regra 5 + hook não roda lint) | Avaliar incluir step `lint` nos jobs agent/broker do CI | humano |

## 7. Decisões humanas abertas

1. **Cobertura de `packages/llm-contracts`** (achado 2) — maior risco real: contratos mudam sem nenhum teste/typecheck em lugar nenhum.
2. **Prettier: ligar ou remover** (achado 4).
3. **Floor de pnpm** (achado 5) — bump para `>=10` alinha com CI e com o requisito do agent.
4. **Aposentadoria legacy** (achados 7-9) — já rastreada como cutover residual; não iniciada nesta sessão.
5. *(resolvido nesta sessão, escopo "melhore o AGENTS.md")* Regra 5 agora inclui `pnpm lint` — resolve o achado 11 e passa a ser a ÚNICA cobertura de lint de Agent/Broker (o CI não roda lint desses workspaces; ver achado 13).

## 8. Evidências e limites

- Gates executados localmente (Windows, pnpm 10.34.1, Node 22): ver seção 4. Duração individual de cada gate rápido: segundos (fs/git walk, sem build). Gates finais desta sessão: `docs:lint` PASS (12/0), `governance:check` sem mudança D01–D19, `typecheck` 4/4 workspaces OK, `pnpm lint` exit 0 (warnings preexistentes em arquivos fora do diff: in-memory stores api 138, agent e2e 4, pwa eslint 27 — 0 erros), `pnpm test` PASS (API — chain `&&` provado; Agent 812/1skip; Broker 25/25; PWA 2282/2282).
- **Revisão independente (reviewer):** 2 achados — (1) MEDIUM: textos sobrejavam cobertura de lint no CI (corrigido: README/AGENTS/hook qualificados + achado 13 adicionado); (2) LOW: estados pendentes contraditórios no relatório (corrigido: seção 4 RESOLVIDO, item 5 da seção 7 marcado resolvido, inventário `.husky` provado com `git status -uall` + `check-ignore`). Ambos confirmados com evidência antes da correção.
- Mudanças desta sessão no working tree (nada commitado — aguardando revisão do operador): `M .gitignore`, `M AGENTS.md` (bloco ai-memory + seção Configuração + regra 5 + estado reestruturado), `M README.md` (reescrito), `M docs/MEU-TED-SPEC-HARDENING-SIMPLIFICACAO-E-DESCOMISSIONAMENTO-V4.md` (2 linhas), `M package.json` (+husky 9.1.7, +`prepare`), `M pnpm-lock.yaml` (husky), `?? .husky/pre-commit` (único arquivo de `.husky/` que o staging pega — provado: `git status -uall .husky` e `git check-ignore -v` mostram que `_/.gitignore` com `*` ignora os wrappers e a si mesmo), `?? docs/reports/2026-10-02-repo-config-audit.md`.
- Não verificado nesta sessão: runtimes observados dos gates de CI (timeouts declarados ≠ duração real); branch protection via API do GitHub (lida de prosa de `pwa-ci.yml:10-13` e AGENTS.md).

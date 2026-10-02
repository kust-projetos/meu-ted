# Security deps bump + secret scanning (2026-10-02)

- **Data:** 2026-10-02 · **Status:** `APPROVED` (revisão independente integrada — 3 achados corrigidos; implementação autorizada pelo operador)
- **Baseline:** `main@9407bc4` (PR #66 mergeado; working tree limpo)
- **Autorização:** operador — "faça o planejamento, documente, revise e depois inicie a implementação", no escopo das recomendações 1–2 da verificação de vulnerabilidades pós-merge (fase 3 listada como follow-up, fora deste ciclo)
- **Origem:** verificação dos 43 alertas Dependabot do branch default + verificação pós-merge (conversa de 2026-10-02; resumo dos ranges em `docs/reports/2026-10-02-repo-config-audit.md` e no relatório de verificação desta data)

**Goal:** zerar os highs/middles acionáveis de dependências (fastify, qs, ip-address, fast-uri) e habilitar secret scanning + push protection no repositório, com gates locais e required checks provando cada passo.

**Non-goals:** undici (cadeia `@ai-sdk/provider-utils` — pin exato 5.29.0/6.x do SDK; resolução correta é bump do `@ai-sdk/anthropic` em PR próprio, Fase 3); `sharp` (pin future-dated deliberado até 2026-12-31); code scanning/CodeQL; bumps transitivos sem patch trivial (js-yaml, @modelcontextprotocol/sdk, basic-ftp, extract-zip, agents).

## 0. Evidências coletadas (pré-plano — não re-verificar)

| Fato | Evidência |
| --- | --- |
| Registry tem as 4 versões | `pnpm view fastify@5.12.5 / qs@6.16.0 / ip-address@10.7.1 / fast-uri@4.1.5` → todas respondem |
| `fastify` é pin exato | `apps/api/package.json` e `apps/codex-broker/package.json`: `"fastify": "5.12.2"` → convenção do pin mantida: bump para `"5.12.5"` |
| Overrides desatualizados | raiz `package.json` `pnpm.overrides`: `qs ">=6.15.2"`, `ip-address ">=10.3.1"`, `fast-uri ">=4.1.3"` |
| Ranges vulneráveis (Dependabot) | fastify `< 5.12.5` (GHSA-4mh8-r7rc-xpvc) · qs `≥2.2.5 <6.16.0` + `≥6.14.2 ≤6.15.3` · ip-address `≤10.7.0` (×2) · fast-uri `<4.1.5` (×2) |
| Lockfile hoje | `fastify@5.12.2`, `qs@6.15.2`, `ip-address@10.7.0`, `fast-uri@4.1.4` — todos dentro dos ranges |
| Security settings do repo | `secret_scanning: disabled`, `secret_scanning_push_protection: disabled`, `validity_checks: disabled`; token com `permissions.admin: true` → `PATCH /repos/…` é capaz |
| Estado atual dos alertas | 43 abertos (18 high, 22 medium, 3 low); local `pnpm audit` 36, **0 críticos** |

## 1. Fase 1 — Bumps de dependências (PR único)

Branch: `fix/security-deps-20261002` (a partir de `main@9407bc4`).

1. **Specs do fastify** (pin exato → convenção preservada):
   - `apps/api/package.json`: `"fastify": "5.12.2"` → `"fastify": "5.12.5"`
   - `apps/codex-broker/package.json`: idêntico
2. **Overrides na raiz** (`package.json` → `pnpm.overrides`):
   - `"qs": ">=6.15.2"` → `"qs": ">=6.16.0"`
   - `"ip-address": ">=10.3.1"` → `"ip-address": ">=10.7.1"`
   - `"fast-uri": ">=4.1.3"` → `"fast-uri": ">=4.1.5"`
3. **Reconciliar lockfile:** `pnpm install` (incremental esperado). **Somente se** o pnpm pedir purge/confirm: `$env:CI='true'; pnpm install --no-frozen-lockfile` (`CI=true` ativa frozen-lockfile por padrão — sem `--no-frozen-lockfile` a instalação falharia por lockfile desatualizado; e a atribuição inline `CI=true cmd` não é sintaxe pwsh).
4. **Provar resolução nova (manifests E lockfile):**
   - `Select-String -Path pnpm-lock.yaml -Pattern '^(  )?(qs|ip-address|fast-uri)@'` → espera-se `qs@6.16.0`, `ip-address@10.7.1`, `fast-uri@4.1.5` (e **nenhuma** `undici` nova — tocar em undici é NON-GOAL)
   - `Select-String -Path pnpm-lock.yaml -Pattern 'fastify@5\.12\.5'` → resolução do lockfile em **5.12.5** (não basta o manifest)
   - `node -e "console.log(require('./apps/api/package.json').dependencies.fastify, require('./apps/codex-broker/package.json').dependencies.fastify)"` → `5.12.5 5.12.5`
   - `pnpm audit --audit-level=high` → não pode mais listar fastify/qs/ip-address/fast-uri (undici permanece; **0 critical** inalterado)
5. **Gates (regra 5 completa):** `pnpm docs:lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm governance:check` — todos verdes. O bump do fastify (5.12.2→5.12.5, patch) é exercido pelas suítes API (2.4k testes) e Broker (25).
6. **Commit** (mensagem técnica em inglês; o hook de pré-commit roda os 7 gates rápidos nativamente) → **push** → **PR** `fix(security): bump fastify to 5.12.5 and refresh vulnerable override floors`.
7. **Merge** após required checks verdes (`Gate — all checks` + `quality (22, 10)`), seguindo a autorização vigente do operador (padrão do PR #66).

**Critérios de aceite da Fase 1:** CI verde no PR; **fechamento dos 9 alertas específicos** (3 entradas fastify GHSA-4mh8-r7rc-xpvc + 2 qs + 2 ip-address + 2 fast-uri) — a queda "43 → ~34" é expectativa, não aceite absoluto (novos alertas podem surgir); `pnpm audit` local sem fastify/qs/ip-address/fast-uri.

**Rollback:** `git revert` do merge commit; lockfile volta ao estado anterior. Sem migração/estado externo — reversão trivial e completa.

## 2. Fase 2 — Secret scanning + push protection (operação de settings)

1. **Habilitação via `--input` JSON (caminho primário — aninhamento `-f [a][b]` é frágil no pwsh):** escrever `{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}` em arquivo temporário e `gh api -X PATCH repos/kust-projetos/meu-ted --input <arquivo>`. Resposta esperada **HTTP 200** (update-a-repository); aplicação é assíncrona.
2. **Opcional (best-effort, nunca bloqueante):** tentar incluir `secret_scanning_validity_checks: enabled` no mesmo JSON; se o schema do PATCH recusar o campo, reenviar sem ele e registrar. `non_provider_patterns` permanece `disabled` (ruído desnecessário para este repo).
3. **Verificação (polling até refletir, ~1-2 min):** `gh api repos/… --jq '.security_and_analysis'` → `secret_scanning.status == "enabled"` **e** `secret_scanning_push_protection.status == "enabled"` (nome completo do campo — não existe atalho `push_protection`).
4. **Documento:** registrar a mudança de settings no corpo do PR da Fase 1 (ou issue dedicada) — settings de repo não geram commit.

**Critérios de aceite da Fase 2:** ambos os flags `enabled` via API; push de teste NÃO é necessário (push protection é validada pelo próprio GitHub em tempo de push; criar segredo falso propositalmente é desnecessário e polui histórico).

**Rollback:** mesmo `PATCH` com `status=disabled`. Sem efeito colateral em código.

**Fallback:** se a API recusar (403 em features de segurança pública), instruções manuais de 2 cliques: Settings → Code security and analysis → Secret scanning + Push protection → Enable.

## 3. Fase 3 — Follow-ups (FORA do escopo deste ciclo; listar, não executar)

1. `llm-contracts` nos gates agregados + CI (achado 2 do audit — maior risco estrutural)
2. Step `lint` nos jobs agent/broker do CI (achado 13)
3. Cadeia undici: resolução correta é bump dos pacotes-pai (`@ai-sdk/*` — **não só `@ai-sdk/anthropic`**: outros providers compartilham `@ai-sdk/provider-utils` e suas pins exatas de undici), validado pela suíte Agent (812 testes); alternativa a avaliar: override direcionado `undici@5.29.0`/`undici@6.*` com reversão pronta caso o SDK quebre
4. Decisões humanas pendentes do audit: prettier wire-or-drop, pnpm floor ≥10, aposentadoria legacy, CodeQL opcional

## 4. Riscos e mitigações

| Risco | Prob. | Impacto | Mitigação |
| --- | --- | --- | --- |
| fastify 5.12.2→5.12.5 quebra comportamento da API | baixa (patch release) | médio | suíte API completa + integração Postgres do CI; revert trivial |
| Override de range (`>=`) puxar versão além do esperado | baixa | baixo | floors especificados em versões exatas de patch existentes; lockfile fixa a resolução; step 4 prova os valores |
| PATCH de settings sem permissão | baixa (admin: true provado) | baixo | fallback manual documentado |
| pnpm install recriar store (15 min do PR #66) | média | baixo (tempo) | mudanças são pontuais; incremental esperado; `CI=true` se pedir purge |

## 5. Condições que invalidam o plano

- `pnpm view` falhar para alguma das 4 versões (registry desync) → re-selecionar versão mais próxima que exista, **sempre ≥ patch do advisory** (fastify: nunca abaixo de `5.12.5`; `5.12.4` permanece vulnerável e é PROIBIDO como fallback). Se nenhuma versão ≥ patch existir, BLOQUEAR a fase e reportar — nunca manter a vulnerabilidade que o plano existe para corrigir.
- CI revelar incompatibilidade do fastify 5.12.5 → BLOQUEAR a fase e escalar para decisão humana (investigar `@fastify/*` transitivos); nunca desabilitar gate para passar.
- Alertas Dependabot não recontarem após merge (cache do GitHub pode levar horas) → evidência alternativa: `pnpm audit` local pós-bump + ranges do lockfile.

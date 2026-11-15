# Plano — Meu TED Premium Experience V2 (delta)

**Goal:** elevar o Meu TED a um app financeiro visualmente sofisticado e personalizável — identidade consistente, catálogo real de instituições e cartões, Home editorial e navegação mobile refinada — sem tocar na verdade financeira, sem deploy e sem regressão.

**Status:** concluído (2026-11-14)
**Base:** relatório "Meu TED Premium Experience V2" + auditoria de código de 2026-11-14
**Direção visual:** Esmeralda Editorial (A) com rail de atenção (B)

## 1. Premissa corrigida

O relatório assume uma V1 sem redesign. A auditoria de código mostrou que parte relevante já foi entregue em set/2026 e na varredura de simplificação de nov/2026. O plano é um delta, não uma reconstrução.

| Pedido do relatório | Estado real em 2026-11-14 |
|---|---|
| Quatro destinos + ação central | Entregue: `BottomNav.tsx`, `AppShell.tsx` (Início/Extrato/Compromissos/Mais + FAB) |
| Tokens esmeralda, claro/escuro | Entregue: `globals.css` (`.dark` + `@theme`) |
| Gráficos e filtros | Entregue: `components/charts/*`, analytics server-driven |
| Personalização de blocos | Parcial: só Relatórios, chave global `meu-ted:report-blocks`, sem workspace e sem drag-and-drop |
| Catálogo de instituições e cartões | Inexistente: 12 presets de gradiente, sem logo, sem modelo de cartão, sem identificador persistido |
| `DESIGN.md` | Inexistente antes desta missão |
| Home editorial | Não: pilha de cartões (deltas, contas, cartões, contas a pagar, donut, insights) |

Consequência: nenhuma alteração em cálculo financeiro, contratos de API, Pending V2, idempotência ou autorização.

## 2. Escopo

**Dentro:** identidade e tokens, catálogo de instituições e produtos de cartão, apresentação de contas/cartões, Home editorial, personalização por workspace, formulários e navegação mobile, validação visual e testes.

**Fora:** backend financeiro, alterações de schema, WhatsApp, deploy de produção, artes oficiais de cartão, upload de imagem própria (fase futura), novo framework ou dependência de UI.

## 3. Decisões

- **D1 — Direção visual.** Direção A (Esmeralda Editorial) como base: saldo como manchete, contas em ledger com hairlines, um único painel esmeralda do mês, faixa proporcional de categorias, insight como linha. Da direção B adota-se apenas o rail de atenção. Rejeitados: cockpit de cartões empilhados e grades de cards repetidos.
- **D2 — Ativos de marca.** Logos reais apenas quando há direito de uso: Simple Icons v15 (CC0-1.0) com manifesto de proveniência. Instituições sem ativo licenciado usam monograma desenhado com cor oficial; nenhuma marca é redistribuída sem direito. Arte de cartão é original e ilustrativa, nunca imagem oficial de produto.
- **D3 - Persistência de aparência.** Implementada em código: `institutionId`/`cardProductId` são metadados de apresentação persistidos em `accounts` (colunas nullable) e espelhados no `localStorage` por workspace para fallback offline. Resolução: servidor → local → heurística de nome/cor. Verificado em 2026-11-15: V064 aplicada; API e PWA em `e40d338` (`/ready` retornou 200 e o guard de startup falha fechado quando o schema é inválido).
- **D4 — Layout da Home.** Visão Essencial (saldo, mês, atenção, contas, compromissos) e Visão Completa (acrescenta cartões, categorias e insights). Persistência por workspace, com mover/ocultar/restaurar acessíveis por teclado e alternativa por toque.
- **D5 — Dependências.** Nenhuma biblioteca nova; gráficos, drag-and-drop e gestos são implementados com o que já existe.

## 4. Fatias

| # | Fatia | Estado | Evidência de aceite |
|---|---|---|---|
| S1 | Auditoria visual real (375/430/768/1440, claro/escuro) | concluída (antes + depois) | `docs/design/v2-audit/REPORT.md` |
| S2 | Design system: tokens, primitivas, `DESIGN.md` | concluída | `docs/design/DESIGN.md`; testes das primitivas |
| S3 | Identidade de instituições: catálogo, produtos, logos, monogramas, arte | concluída | catálogo + manifesto + testes |
| S4 | Integração em cadastro, listas e detalhes | concluída | cadastro, listas e detalhes |
| S5 | Home editorial | concluída | composição editorial |
| S6 | Personalização da Home por workspace | concluída | mover/ocultar/restaurar por workspace |
| S7 | Formulários e navegação mobile | concluída | formulários e navegação |
| S8 | Validação final | concluída — gates funcionais verdes; 4 contratos P2D bloqueados por .env.local/porta 9229 locais | suítes e captura visual final |
| S9 | Ícones de categoria no Extrato | concluída | `CategoryBadge` + `CategoryIcon` |

Cada fatia exige: implementação mínima funcional, teste proporcional, evidência visual quando há mudança de UI e nenhuma alteração de contrato financeiro.

## 5. Restrições e riscos

- **Ativos de terceiros:** Itaú, Bradesco, Santander, BB, Caixa, C6, Inter, XP, Elo e Hipercard não têm ativo licenciado; permanecem monograma. Documentado em `apps/pwa/public/brands/README.md`.
- **Persistência de aparência:** V064 aplicada e API/PWA em `e40d338`, verificados por `/ready` 200 e guard de startup fail-closed; o E2E cross-device valida a leitura server-side sem localStorage prévio.
- **E2E existente:** `home.spec.ts`, `accounts.spec.ts`, `cards.spec.ts`, `navigation.spec.ts` e `reports.spec.ts` dependem de seletores e rótulos; toda mudança de estrutura precisa mantê-los ou atualizá-los de forma justificada.
- **Performance:** SVGs inline e novos componentes não podem estourar o orçamento de JS do PWA.
- **Integridade financeira:** nenhuma fórmula de saldo, fatura, limite ou resultado é alterada; métricas derivadas novas exigem fórmula definida e dados suficientes.

## 6. Gates

- Por fatia: `pnpm --filter pwa test` (focado), `pnpm typecheck`, `pnpm lint`.
- Antes de PR: `pnpm check:area` e os dois checks obrigatórios do repositório.
- Validação final: `pnpm validate:final`, capturas em 375/430/768/1440 nos dois temas, teclado e safe areas.
- Nenhum deploy sem autorização explícita.

### Build para captura visual (E2E)

O standalone deve ser built com o mesmo env de `e2e/run-ci.sh`: `NEXT_PUBLIC_PI_FINANCE_API_BASE_URL=http://127.0.0.1:4010`, `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off`, `NEXT_PUBLIC_TED_LIVE_SYNC_ENABLED=0` e `PWA_BACKEND_PROXY_ORIGIN`. Sem isso, o cliente usa `/api/backend` e o proxy de produção corretamente retorna 403 para a origem loopback. Essa divergência custou um ciclo de diagnóstico e não deve ser redescoberta.

## 7. Rollback

Reverter é `git revert` da fatia. A migration V064 e o deploy da API são rollout do operador, não executados nesta implementação. A aparência local pode ser limpa por workspace sem afetar dados financeiros.

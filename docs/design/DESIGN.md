# Meu TED — Design system

## Identity

Meu TED is an editorial finance companion: calm, precise, and encouraging.
The brand mark is TED's geometric monogram in `src/components/brand/TedMark.tsx`.
Palette anchors: esmeralda `#0B7A5B`, menta `#66C2A3`, carvão `#1F2A27`,
cinza-claro `#E8EFEA`. Voice: **“Tudo em dia.”** Prefer clear, human Portuguese
and direct language over financial jargon.

## Typography

- UI: Plus Jakarta Sans (`--font-ui`).
- Money and compact numeric emphasis: Space Grotesk (`--font-mono`).
- Use `.text-money` for prominent monetary values and `.tabular` for aligned
  figures. Keep tabular figures enabled with `--tracking-money`.
- The money scale is `--text-money-hero`, `--text-money-xl`,
  `--text-money-lg`, `--text-money-md`; each has a matching `-line-height`
  token. Use the smallest scale that preserves hierarchy.

## Surfaces & elevation

Three levels only: canvas, resting surface, and elevated overlay. Prefer
`--hairline` / `--hairline-strong` ledger rules over enclosing borders.
Existing shadow tokens remain available for elevation; do not apply a shadow
to every content group. `--statement-bg` and related statement tokens are
reserved for the single monthly summary panel.

## Dashboard composition rules

- **Statement panel:** one monthly headline or balance summary. Maximum one per
  screen; use `StatementPanel`, never repeat it for secondary metrics.
- **Ledger:** sequential transactions and activity, separated by hairlines.
- **Art object:** category composition or purpose-built visual, such as
  `ProportionBand`; keep it proportional and label it.
- **Insight line:** one timely TED observation with an optional direct action;
  it is not a card.
- `SectionHeader` gives a section a title, optional meta, and optional action.
- `AttentionChip` is for actionable danger, warning, or neutral items.
- Never turn a dashboard into a stack of identical rounded cards.

## Motion

Use `--duration-fast`, `--duration-standard`, `--duration-slow`,
`--easing-standard`, and `--easing-exit`. Motion is opt-in and responds to
interaction; these primitives add no default animation. Honor
`prefers-reduced-motion` for all transitions and animation.

## Accessibility

- Text on statement surfaces uses `--statement-text` / `--statement-muted`;
  preserve at least 4.5:1 contrast for normal text.
- Keep visible keyboard focus, semantic headings/lists/buttons, and accessible
  summaries for visual-only charts.
- Interactive targets are at least 44px tall. Keep chart colors paired with
  labels; color alone must not convey meaning.
- Respect safe-area insets in app-shell layouts; primitives do not override
  shell insets.

## Asset policy

Third-party brand marks use Simple Icons (CC0) when available. Otherwise use
a legible monogram fallback. Illustrative card art may be original and
abstract; never use official payment-card imagery or imitate a real card face.

Institution and card-product appearance metadata is persisted server-side on
`accounts` (`institution_id`, `card_product_id`, both nullable) and mirrored to
`localStorage` as an offline fallback. Resolution precedence is server data,
then local data, then the name/color heuristic.

## Do / don't

## Definições de indicadores financeiros

| Indicador | Fórmula | Fonte | Período | Escopo |
|---|---|---|---|---|
| Saldo total (Home) | Soma de saldos | Resumo do servidor | Atual | Todas as contas |
| Receitas (Home) | Soma de receitas | Resumo do servidor | Mês corrente | Todas as contas |
| Despesas (Home) | Soma de despesas | Resumo do servidor | Mês corrente | Todas as contas |
| Resultado do mês | Receitas − despesas | Resumo do servidor | Mês corrente | Todas as contas |
| Resultado / receitas | Resultado ÷ receitas × 100 | Resumo do servidor | Mês corrente; receitas > 0 | Todas as contas |
| Para onde foi | Despesas por macrocategoria ÷ despesas locais × 100 | Agregação local de transações | Mês corrente | Transações locais disponíveis |
| Fluxo de caixa | Saldo acumulado diário | Agregação analítica do servidor | Período selecionado | Contas selecionadas ou todas |
| Distribuição por categoria | Valor por categoria ÷ total de despesas × 100 | Analytics do servidor | Período selecionado | Contas selecionadas ou todas |
| Mapa de gastos | Total de despesas diárias | Analytics do servidor | Período selecionado | Contas selecionadas ou todas |

- **Do:** use the shared tokens and primitives; align money with tabular
  figures; separate ledger rows with hairlines; keep one focal statement.
- **Don't:** introduce new palette literals in primitives; rely on color alone;
  repeat identical card stacks; invent motion that ignores reduced-motion;
  use low-contrast muted copy on the statement surface.

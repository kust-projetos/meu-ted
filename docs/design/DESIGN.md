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

## Do / don't

- **Do:** use the shared tokens and primitives; align money with tabular
  figures; separate ledger rows with hairlines; keep one focal statement.
- **Don't:** introduce new palette literals in primitives; rely on color alone;
  repeat identical card stacks; invent motion that ignores reduced-motion;
  use low-contrast muted copy on the statement surface.

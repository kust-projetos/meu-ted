# Relatorio final - validacao visual V2 (Marco 6)

## NAV-03: causa da ambiguidade

Antes de escopar o seletor, o clique encontrou dois elementos: o card acessível
como `role="button"` com `aria-label="Abrir Nubank em Cartões"` (que também
corresponde ao nome acessível parcial “Cartões”) e o botão “Cartões” da
BottomNav. O teste foi corrigido para clicar somente no botão exato dentro de
`nav[data-nav="bottom"]`; nenhum rótulo ou comportamento do produto foi alterado.

## Correções após revisão visual

- Arte de cartões limitada a 440px na lista/detalhe e 360px na Home; proporção preservada.
- Metadados da lista usam `min-w-0`, emissor sem shrink e data truncável.
- Segmentos de categoria agora alternam `primary`, `info`, `warning`, `accent-money` e `surface-3`.
- Insight de orçamento explicita o denominador: “Alimentação Mensal: 18,8% do orçamento.”
- Chips mantêm carrossel mobile e quebram em múltiplas linhas a partir de `lg`.
- Home, Extrato e Cartões reservam espaço inferior mobile ao launcher, com `lg:pb-0`.
- CARD-09 agora valida “Disponível R$ 3.000,00”; capturas foram revalidadas em 375, 768 e 1440px.

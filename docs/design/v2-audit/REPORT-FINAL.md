# Relatorio final - validacao visual V2 (Marco 6)

## NAV-03: causa da ambiguidade

Antes de escopar o seletor, o clique encontrou dois elementos: o card acessível
como `role="button"` com `aria-label="Abrir Nubank em Cartões"` (que também
corresponde ao nome acessível parcial “Cartões”) e o botão “Cartões” da
BottomNav. O teste foi corrigido para clicar somente no botão exato dentro de
`nav[data-nav="bottom"]`; nenhum rótulo ou comportamento do produto foi alterado.

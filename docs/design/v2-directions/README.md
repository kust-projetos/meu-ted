# Meu TED — direções mobile v2

Protótipos estáticos de Home em 375 e 430 px. Os dois usam os mesmos dados fictícios, alternam tema com `prefers-color-scheme` e compartilham a navegação inferior: TED é um chat flutuante, não uma aba.

## A — Esmeralda Editorial

O saldo é a manchete, com bastante respiro e fio editorial. Um demonstrativo verde-escuro concentra o resultado mensal; contas formam um ledger, o Nubank Ultravioleta recebe a única peça de cartão ilustrada, compromissos viram timeline e despesas usam banda proporcional. Prioriza personalidade, leitura calma e hierarquia tipográfica.

**Trade-off:** o demonstrativo e o cartão em destaque favorecem leitura sequencial; comparação entre instituições e ações urgentes exigem mais varredura que na direção B. Reuso provável: `HeroSection` como headline (rever composição), `AccountsCard` como ledger sem container, `CreditCardsCard` + `BankCard` para o objeto Ultravioleta e lista simples, `PayablesCard` como timeline, `CategoryDonutCard` substituído por banda, `InsightsCard` como nota editorial, `ui/Card` apenas no demonstrativo (não em cada seção).

## B — Esmeralda Financial

Um cockpit compacto mostra saldo, período, resultado e tendência; a rail põe vencimento, atraso e limite no caminho. Contas e cartões ficam em duas colunas, barras com mês anterior facilitam comparação e os compromissos usam badges de dia. Otimiza densidade, comparação e priorização de pendências.

**Trade-off:** exige tipografia e espaçamento mais precisos para manter a leitura em 375 px; há menos pausa editorial e o objeto cartão perde protagonismo. Reuso provável: `HeroSection` como cockpit, `AccountsCard` e `CreditCardsCard` adaptados a grid, `BankCard` para marcas/product identity compactas, `PayablesCard` como lista datada, `CategoryDonutCard` substituído por barras comparativas, `InsightsCard` embutido no rodapé da categoria e `ui/Card` para os painéis compactos.

## Tokens e componentes

Os protótipos espelham os tokens existentes em `apps/pwa/src/app/globals.css`: light `#F8F9FA`, `#FFFFFF`, `#F1F3EF`, `#E9ECE5`, `#ECEEEA`, `#111814`, `#4B554E`, `#66716A`, primário/sucesso `#0E8C5A`, perigo `#C8483B`, alerta `#B8791F`; dark real `#0B0F0E`, `#131916`, `#1A231F`, `#222E29`, borda rgba(255,255,255,.06), texto `#F3F5F2`, secundário `#9DA8A0`, muted `#828E85`, primário `#10B981`, perigo `#F87171`, alerta `#FBBF24`, sucesso `#34D399`. Marca: `#0B7A5B`, menta `#66C2A3`, carvão `#1F2A27`. Fontes: Plus Jakarta Sans e Space Grotesk; números tabulares.

**Adições necessárias à implementação de produto (não aplicadas):**

- **A:** token semântico `statement` (fundo deep/gradient e foreground), tipografia `display-balance`/`ledger`, token de banda categórica de cinco tons e opção de superfície/card sem container. O token de cor é a única adição indispensável; escala e tonalidades também podem ficar como tokens locais do componente.
- **B:** tokens para estados de chip (alerta/atraso) e cor fantasma de comparação (`color-mix` de primary e surface-3), além de escala compacta de grid/spacing. O gráfico pode consumir as cores semânticas já disponíveis; adicionar apenas token para ghost-bar caso seja compartilhado.

## Renderização

Em `apps/pwa`, execute `node ../../docs/design/v2-directions/render.mjs` (o pacote `playwright` deve estar instalado nesse workspace). O script grava oito PNGs em `shots/`; usa Chromium, viewport solicitado, DPR 2, `fullPage`, scheme explícito e espera fontes web antes do screenshot. Se Google Fonts estiver indisponível, a pilha `system-ui` é fallback.

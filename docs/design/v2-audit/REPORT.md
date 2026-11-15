# Auditoria visual — redesign V2

## Escopo

Auditoria visual do redesign V2 (delta), realizada em 2026-11-14. O objetivo era comparar o baseline pré-redesign com capturas finais em diferentes larguras e temas.

## Baseline "antes"

`docs/design/v2-audit/before/` contém 12 PNGs capturados em 375 px, tema claro, a partir do standalone pré-redesign: Home (full + viewport), Extrato, Contas, Cartões, Compromissos, Relatórios, Planejamento, Patrimônio, Configurações, Perfil e TED.

**Limitação:** a matriz 430/768/1440 e o tema escuro não foram capturados no baseline porque a execução anterior caiu no meio.

## "Depois" — matriz capturada

A matriz final contém 51 PNGs e 45 SHA-256 distintos; os 5/5 testes de captura passaram.

| Tema | Largura | Capturas |
|---|---:|---:|
| claro | 375 | 18 |
| escuro | 375 | 17 |
| claro | 430 | 4 |
| escuro | 430 | 4 |
| claro | 768 | 4 |
| claro | 1440 | 4 |

`home.png` está presente nas seis combinações, com as cinco seções visíveis. Os badges com letras no Extrato são dados do fixture (categorias sem `icon`), não um defeito. Nas capturas `fullPage`, elementos fixos (nav e FAB do TED) são pintados na posição do viewport e se sobrepõem ao conteúdo no meio da imagem: artefato de captura, não problema de layout.

## Gate autoritativo (run-ci)

- Build concluído.
- `functional-mobile`: 151 passaram / 33 ignorados. `ACC-03` teve um flake: o overlay “Novo cartão” interceptou o ponteiro; passou na nova tentativa.
- `functional-desktop`: passou; `pwa-runtime`: 6/6; `push-runtime`: 4/4; contratos da matriz: 14/14.
- Restam 4 testes de contrato P2D falhando por condições do ambiente local: `apps/pwa/.env.local` existe (o launcher recusa deliberadamente arquivos de ambiente carregáveis pelo Next em execuções live) e há contenção na porta 9229 do inspector. São condições locais preexistentes, não mudanças da branch; `.env.local` não foi modificado.

O gate funcional está verde. O script autoritativo termina com código 1 somente por causa dessas guardas de contrato P2D.

## Histórico de diagnóstico

Resolvido/explicado: o primeiro build usou env incorreto e direcionou o cliente para `/api/backend`; o proxy recusou a origem loopback com 403 `csrf.origin_mismatch` (fail-closed correto). Depois, o aviso sobre `PWA_AGENT_PROXY_ORIGIN` apontou a configuração necessária para o proxy no build de captura. A investigação anterior do abort de autenticação foi superada pela captura final bem-sucedida; não representa o estado atual.

Última causa raiz: SVGs vendorizados do Simple Icons contêm `<title>…</title>`, que `getByText` encontrava antes do rótulo visível e quebrava todo o cluster E2E de cartões. `stripSvgTitle` remove `<title>` e o `role="img"` interno redundante antes de inline. Registro como regra de DOM/acessibilidade para futuros assets de marca.

## O que foi validado por outra via

- Home: 42 testes.
- Contas: 43 testes + 6 E2E.
- Cartões: 45 testes + 8 E2E.
- Relatórios/Home/layout: 140 testes + 14 E2E.
- Componentes (drafts/sheet): 89 testes.
- Categoria/records: 160 testes.
- Suíte PWA completa: 2.981 testes passando, com 2 falhas ambientais:
  - `run-ci-outputs.test.ts`: harness bash/pnpm falso; arquivos não tocados.
  - `next-config.test.ts`: timeout no run completo; passa isolado.
- E2E funcional: 151 passando, 29 skip e 1 flake (`ACC-01`): 502 intermitente em `/_next/image`, não reproduzido em 2 execuções isoladas nem na spec inteira.
- Home E2E: 10/10 passando.

## Limitações e riscos

- Assets de marca usam Simple Icons CC0 e monogramas; não há arte oficial.
- Aparência de conta/cartão é armazenada em localStorage por workspace e não sincroniza entre dispositivos.
- Nenhuma migration ou deploy foi realizado.

## Próximo passo

Rodar `e2e/run-ci.sh` em CI. Opcionalmente, adicionar valores `icon` às categorias do fixture para comprovar visualmente o caminho de ícones do Extrato.

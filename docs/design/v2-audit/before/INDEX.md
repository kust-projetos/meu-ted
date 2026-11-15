# Meu TED PWA — V2 audit BEFORE

These screenshots were served by the pre-redesign `.next/standalone` build, not the current working tree. The captured PNGs have 12 distinct byte sizes (48,156–170,143 bytes), evidence they are not identical login-page images. The run stopped during the first mobile transaction-sheet capture; the remaining theme/viewport/screen matrix was not produced. `home-viewport.png` caught the loading skeleton because this capture did not wait for data.

| File | Route | Viewport | Theme | Status |
|---|---|---:|---|---|
| `light/375/home.png` | `/` | 375×812 | light | captured |
| `light/375/home-viewport.png` | `/` | 375×812 | light | captured; loading skeleton visible |
| `light/375/registros.png` | `/registros` | 375×812 | light | captured |
| `light/375/compromissos.png` | `/compromissos` | 375×812 | light | captured |
| `light/375/patrimonio.png` | `/hub/patrimonio` | 375×812 | light | captured |
| `light/375/relatorios.png` | `/hub/relatorios` | 375×812 | light | captured |
| `light/375/planejamento.png` | `/hub/planejamento` | 375×812 | light | captured |
| `light/375/configuracoes.png` | `/hub/configuracoes` | 375×812 | light | captured |
| `light/375/perfil.png` | `/perfil` | 375×812 | light | captured |
| `light/375/ted.png` | `/ted` | 375×812 | light | captured |
| `light/375/contas.png` | `/hub/patrimonio?aba=contas` | 375×812 | light | captured |
| `light/375/cartoes.png` | `/hub/patrimonio?aba=cartoes` | 375×812 | light | captured |

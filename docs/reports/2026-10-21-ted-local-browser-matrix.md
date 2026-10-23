# Matriz TED no navegador Orca — primeira rodada local

## Ambiente e validade

Somente `http://localhost:3000`, stack `ted-local`, imagem Agent inicial anterior ao fix Itaú. Workspace sintético **QA TED Local**, ID `a8618422-d885-4e1c-91c4-c57bd652ce81`. Rodada executada pelo Tester; relatório persistido pelo Planner, pois o papel Tester não tinha permissão de edição. Produção não acessada. A rodada não completa o CRUD de todos os domínios.

## Readback independente do Planner

Após o retorno do Tester, GETs same-origin `/api/backend/accounts` e `/api/backend/transactions`, com o workspace QA e sessão local já autenticada, retornaram HTTP 200:

- Uma conta ativa `bank`, `QA Aurora banco`, ID `fae765f2-73ef-4858-9480-83f6caa36073`, `balanceCents=115750`.
- Receita `f12e9fd6-95ce-473d-a2cd-b153afe67d59`, `amountCents=20000`, descrição `salario conta QA Aurora`, data `2026-10-21`.
- Despesa `21a4692d-6f39-48ec-b0b7-8ffbd4bbb6ff`, `amountCents=4250`, descrição `mercado conta QA Aurora`, mesma data e conta.
- Total de transações: dois. Saldo inicial 100000 + receita 20000 − despesa 4250 = **115750 centavos**.

O resumo inicial do Tester transcreveu despesa como 42500 e saldo de conta como 100000 em um trecho, inconsistentes com a tela. O readback acima corrige esses números; não há evidência de erro aritmético neste cenário.

## Cenários

| Área | Entrada/ação | Observado | Veredito/limite |
| --- | --- | --- | --- |
| Conta criar | `crie conta QA Aurora banco saldo 1000` → `banco` → confirmar | Conta criada com nome `QA Aurora banco`, tipo e saldo inicial corretos | FAIL nome: marcador de tipo incorporado ao nome |
| Conta listar | Listar contas após criação | Entidade persistida e disponível | PASS deste cenário |
| Conta saldo parcial | `saldo QA Aurora` | Não encontrou, embora liste `QA Aurora banco` como disponível | FAIL lookup parcial |
| Conta anáfora | `e o saldo daquela conta` | Não encontrou a conta | FAIL contexto; resolver apenas quando alvo contextual for inequívoco |
| Conta saldo exato | `qual o saldo da conta QA Aurora banco` | R$ 1.157,50 | PASS, readback independente |
| Conta editar/desativar | CRUD completo | Não exercitado nesta rodada | NÃO TESTADO |
| Despesa criar | Despesa de mercado R$ 42,50, conta QA | Um lançamento 4250c após confirmação | PASS criar; update/delete não testados |
| Receita criar | Salário R$ 200,00, conta QA | Um lançamento 20000c após confirmação | PASS criar; update/delete não testados |
| Extrato | Consulta após lançamentos | Exibiu salário R$ 200,00 e mercado R$ 42,50 | PASS leitura simples |
| Resumo mensal | Resumo outubro | Gastos42,50, receitas200, resultado157,50, dois lançamentos | PASS cenário simples; demais relatórios não testados |
| Cartão criar | `crie cartao QA Visa final 1234 vencimento dia 10` | Caiu em contas a pagar | FAIL roteamento; nenhuma criação |
| Cartão criar alternativo | `cadastrar cartao de credito QA Visa` → `sim cadastre QA Visa` | Reconhece cartões, depois informa ausência de operação pendente | Fluxo de escrita ausente; não é CRUD suportado |
| Fatura vazia | Consulta de faturas | Ausência honesta | PASS vazio; não prova fatura real/pagamento |
| A pagar | `tenho contas a pagar` | Não conseguiu processar | FAIL leitura; diagnosticar API/payload antes de fix |
| Cancelar draft | Intenção picotada, depois cancelar | Draft descartado; transações continuam duas | PASS cenário |
| Undo cancelar | Pedir desfazer receita200 e cancelar proposta | Nada alterado; transações continuam duas | PASS cancel; undo confirmado não testado |
| Histórico | Recarregar depois de turnos concluídos | Histórico e ledger preservados | PASS cenário |
| Fragmentos | Intenção em dois turnos | Retomou contexto sem escrita prematura | PASS cenário limitado; ampliar combinações |
| Typo | `liste mihnas contaz` | Resposta honesta/fail-closed | Seguro, não comprova correção de typo |
| Fora do escopo | Previsão do tempo | Aproximadamente dois minutos escrevendo; resposta restrita a finanças observada após reload | Fragilidade de latência/UX, causa não comprovada |
| Envio em transição | Envio durante undo-cancel | Tester relata uma mensagem perdida sem erro | Suspeita a reproduzir, sem causa confirmada |
| Categorias standalone | CRUD | Não exercitado | NÃO TESTADO |
| Parcelamentos | CRUD | Não exercitado | NÃO TESTADO |
| Assinaturas | CRUD | Não exercitado | NÃO TESTADO |
| Pagamentos/vencimentos | CRUD e baixa | Não exercitado | NÃO TESTADO |
| Itaú | Criação/reconhecimento | Não exercitado por imagem stale | NÃO TESTADO |

## Particularidade do harness

Cliques CDP Orca nos botões Enviar/Confirmar nem sempre disparam React nesta configuração. O Tester usou `fill` e `form.requestSubmit()`; decisões por `button.click()` no DOM. Refs sempre oriundas de snapshot. Isso não substitui a validação futura de toque/clique real, e zero request não deve ser classificado como erro do servidor.

## Próxima rodada

Corrigir extração de nome e lookup com regressões, concluir/revisar a fatia de renomeação e idempotência, atualizar imagens locais com fonte estabilizada e reexecutar os casos acima. Diagnosticar a falha de leitura de payables e continuar os domínios ainda não testados, sem alegação de CRUD completo.

## Segunda rodada — capacidade dos domínios restantes (runtime inicial)

Tester enviou18prompts no mesmo QA sintético, semconfirmarpropostas. **Ledgerantes/depois idêntico:** uma conta QA Aurora banco/115750c, duastransações20000/4250c, categorias60, cartões/payables/faturasvazios. Três cancelamentos só de drafts criadospela rodada; nenhuma escritafinanceira, produção/restart/arquivoalterado.

| Domínio/operação | Prompt | Observado | Veredito |
| --- | --- | --- | --- |
| CategoriaR | `liste minhas categorias` | Fallback nãoidentificou | FAILleitura existenteAPI |
| CategoriaC | `crie categoria QA Transporte` | Fallback | SemfluxoC |
| CategoriaU | `renomeie categoria QA Transporte para QA Transporte Novo` | Fallback | SemfluxoU |
| CategoriaD | `Desative categoria QA Transporte` | Pergunta qual conta desativar e ofereceQA Aurora banco | FAILconfusãocategoria→banco |
| PayableC | `crie conta a pagar QA Luz de 100 vencimento 25/10/2026` | Pede saldo inicial/tipo bank/cash | FAILcompromisso→bankdraft; cancelado semescrita |
| PayableR | `liste minhas contas a pagar` | Soft-failure | FAIL; fixfonte roteamentopendentereteste |
| PayableU | `altere conta a pagar QA Luz para 120` | Fallbackpayables | SemfluxoU |
| Fatura/pagamento | `pague fatura QA Visa` | Informa ausência de faturas, sem proposta avulsa | Segurocombasevazia; nãoprova pagamento |
| ParcelamentoC | `crie parcelamento QA Teste 3x de 50 conta QA Aurora banco` | Pede saldo inicial/tipo bank/cash | FAILparcelamento→bankdraft; cancelado |
| ParcelamentoR | `liste meus parcelamentos` | Fallback | Semleitura conversacional |
| AssinaturaC | `cadastrar assinatura QA Netflix 29,90 mensal` | Fallback | SemfluxoC |
| AssinaturaR | `liste minhas assinaturas` | Fallback | Semleitura conversacional |
| Relatório | `resumo do mes por categoria` | Resumomensal15750c/twoitems, semgrupopor categoria | Mensalsimples correto; **requisito porcategoria nãoatendido** |
| VencimentosR | `quais contas vencem esta semana` | Lookupconta bancária/nãoencontrada | FAILcompromissos→banco |
| CartõesR | `liste meus cartoes` | Vaziohonesto | PASSvazio |

**Não testados nesta rodada:** Dpayable, U/Dparcelamento, U/Dassinatura, pagamentocomfatura/compromissoexistente e unpay dedicado. Basevazia nãoautoriza afirmarPASSdessasoperações. Históricoanterior de extrato/resumo/undo nãofoi reexecutado nem contado comonovoPASS.

Os achados foram obtidos **antes de instalar fontes novas**. Explorer confronta o roteamento no workingtree atual para evitar classificar bugjáresolvido como regressão nova. Fallbackhonesto é seguro ondefaltacapacidade, mas não atende ao objetivoCRUD completo.

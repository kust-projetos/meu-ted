import type { Skill } from './types.js';

export const registrosSkill: Skill = {
  name: 'registros',
  title: 'Lançamentos (receitas, despesas, parcelas)',
  when: 'criar, consultar, editar ou excluir um lançamento, incluindo parcelados',
  keywords: [
    'lanç', 'gasto', 'gastei', 'despesa', 'receita', 'recebi', 'registr', 'anotar',
    'parcela', 'parcel', 'compra', 'paguei', 'pagar', 'editar', 'corrigir', 'excluir',
    'apagar', 'reembolso', 'pix', 'boleto', 'desfaz', 'desfazer', 'undo',
  ],
  tools: [
    'create_expense',
    'create_income',
    'create_transfer',
    'update_transaction',
    'delete_transaction',
    'list_recent_transactions',
    'create_card_purchase',
    'create_card_installments',
    'detect_duplicate',
  ],
  steps: [
    'Entenda o que a pessoa quer: valor, descrição, data e onde caiu (conta ou cartão).',
    'Conta XOR cartão: lançamento em conta usa create_expense/create_income com accountId; compra no cartão usa create_card_purchase com accountId do cartão. Nunca os dois.',
    'Parcelado no cartão: use create_card_installments (valor total + número de parcelas), não N lançamentos manuais.',
    'Antes de criar, confira duplicidade com detect_duplicate quando houver risco (mesmo valor e data próxima).',
    'Para editar ou excluir, localize primeiro com list_recent_transactions e confirme o lançamento certo pela descrição e data.',
    'Desfazer NÃO é tool do modelo: um pedido de desfazer cria apenas uma proposta persistente e a confirmação/cancelamento acontece no botão do PWA via RPC autenticado; texto nunca executa desfazer.',
    'Após sucesso confirmado, responda curto com ação, resultado, valor/descrição/conta e ofereça desfazer pelo fluxo existente; nunca declare sucesso sem resultado confirmado.',
  ],
  pitfalls: [
    'Nunca crie lançamento sem valor e descrição confirmados.',
    'Nunca misture accountId de conta com fluxo de cartão.',
    'Edição/exclusão e pagamento exigem confirmação explícita (ver política de mutações); lançamentos simples podem concluir imediatamente somente com intenção explícita e resultado confirmado.',
    'Nunca execute desfazer por texto: sem proposta + decisão no RPC, explique e peça a confirmação no botão.',
  ],
};

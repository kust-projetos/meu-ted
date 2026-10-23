import type { Skill } from './types.js';

export const categoriasSkill: Skill = {
  name: 'categorias',
  title: 'Categorias (macros e subcategorias)',
  when: 'organizar, criar ou entender categorias e subcategorias de lançamentos',
  keywords: [
    'categoria', 'categorias', 'subcategoria', 'macro', 'classificar', 'organizar',
    'alimentação', 'moradia', 'transporte', 'lazer', 'saúde', 'saude',
  ],
  tools: ['list_categories'],
  steps: [
    'Leia a árvore atual com list_categories (macros com subcategorias aninhadas).',
    'Explique usando nomes ("Alimentação > Mercado"), nunca IDs.',
    'Criar categoria é fluxo conversacional manual com confirmação (rascunho → proposta → confirmação): nome + tipo (despesa|receita) + pai exato opcional; subcategoria exige pai.',
    'Renomear ou desativar categoria existente usa proposta V2 manual; nunca execute sem confirmação humana no cartão.',
    'Desativar preserva os dados e só funciona quando não há lançamentos ou dependências vinculados; dependência recusada não é sucesso.',
    'Excluir categoria permanece não suportado: não confunda excluir com desativar nem use forget_memory.',
    'Não crie categorias duplicadas com nomes parecidos — reuse a existente.',
  ],
  pitfalls: [
    'Não crie categorias duplicadas com nomes parecidos — reuse a existente.',
    'Subcategoria sem pai vira clarificação, nunca macro silenciosa; "sem pai" só vale como resposta explícita.',
    'Tipo ("despesa ou receita") sem escolha nunca decide sozinho — clarifique.',
  ],
};

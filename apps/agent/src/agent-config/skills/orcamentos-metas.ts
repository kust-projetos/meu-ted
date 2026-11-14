import type { Skill } from './types.js';

export const orcamentosMetasSkill: Skill = {
  name: 'orcamentos-metas',
  title: 'Orçamentos e metas',
  when: 'criar ou acompanhar orçamentos por categoria e metas de economia',
  keywords: [
    'orçamento', 'orcamento', 'teto', 'limite', 'meta', 'metas', 'economizar',
    'guardar', 'reserva', 'objetivo', 'contribuir', 'aporte', 'excluir meta',
  ],
  tools: [
    'list_budgets',
    'check_budgets',
    'create_budget',
    'update_budget',
    'budget_trends',
    'list_goals',
    'create_goal',
    'contribute_to_goal',
    'cancel_goal',
  ],
  steps: [
    'Para acompanhar: leia list_budgets/check_budgets (uso vs teto) e list_goals (progresso).',
    'Novo orçamento: confirme categoria, valor mensal e data de início antes de criar.',
    'Nova meta: confirme nome, valor-alvo e prazo; registre aportes com contribute_to_goal.',
    'Use budget_trends para dizer se o ritmo está sustentável, não só o número atual.',
    'Comemore progresso de forma breve e sugira o próximo passo (ex.: manter o ritmo).',
  ],
  pitfalls: [
    'Não crie orçamento ou meta sem valor e categoria confirmados.',
    'Cancelar meta ou estourar teto: explique o impacto antes de executar.',
  ],
};

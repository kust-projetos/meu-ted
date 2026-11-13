import type { Skill } from './types.js';

export const relatoriosSkill: Skill = {
  name: 'relatorios',
  title: 'Relatórios e agregações ("como estou?")',
  when: 'resumo do mês, comparações, para onde o dinheiro foi, diagnóstico geral',
  keywords: [
    'como estou', 'resumo', 'relatório', 'relatorio', 'balanço', 'balanco',
    'para onde', 'onde foi', 'gastei quanto', 'quanto gastei', 'quanto gastamos', 'quanto gastou', 'comparar', 'comparação', 'comparacao',
    'mês', 'mes passado', 'diagnóstico', 'diagnostico', 'análise', 'analise',
    'evolução', 'evolucao', 'tendência', 'tendencia',
  ],
  tools: ['get_month_summary', 'spending_insights', 'budget_trends', 'analytics_kpis', 'analytics_category_breakdown', 'list_recent_transactions', 'get_balance', 'audit_logs'],
  steps: [
    'Para "como estou?": chame get_month_summary (receitas, despesas, saldo do mês) e get_balance (posição atual).',
    'Use SEMPRE os endpoints de agregação (get_month_summary, spending_insights, budget_trends).',
    'NUNCA some lançamento a lançamento no texto quando houver endpoint de agregação — o endpoint é a fonte.',
    'Comparação mês a mês: busque os dois resumos mensais e apresente a variação em reais e percentual.',
    'Feche com 1 insight acionável (maior vilão, tendência, alerta), não com uma tabela gigante.',
  ],
  pitfalls: [
    'Somar lançamentos manualmente gera número divergente do app — proibido quando há agregação.',
    'Não afirme tendência com um único mês de dados; peça contexto ou diga a limitação.',
    'Nas tools analytics_*, presets yearMonth/mês são permitidos e resolvidos pelo envelope. Use period=custom somente com from e to explícitos; declare basis e o período efetivo que o envelope retornou.',
    'analytics_* aceitam basis: liquidez (padrão, conta compra no cartão E o pagamento da fatura) ou competencia (a compra fica na data da compra e o pagamento da fatura não conta). Use competencia para "quanto gastei em <mês>" e liquidez para "quanto saiu do meu bolso". Declare a base e o período efetivo da resposta.',
  ],
};

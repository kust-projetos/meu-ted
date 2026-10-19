import type { Skill } from './types.js';

export const saldoExtratoSkill: Skill = {
  name: 'saldo-extrato',
  title: 'Saldo e extrato',
  when: 'saber quanto tem, ver saldo por conta ou puxar o extrato recente',
  keywords: [
    'saldo', 'quanto tenho', 'quanto tem', 'extrato', 'movimentação', 'movimentacao',
    'consultar', 'quanto sobrou', 'sobrou',
  ],
  tools: ['get_balance', 'list_accounts', 'list_recent_transactions', 'get_month_summary'],
  steps: [
    'Para "quanto tenho" ou saldo: use list_accounts para ver o saldo de cada conta ativa e apresentar o total consolidado mais o detalhamento por conta.',
    'Para extrato: use list_recent_transactions com limite sensato (padrão 10–20) e resuma por dia ou categoria.',
    'Se a pessoa citar uma conta pelo nome, resolva o id com list_accounts antes de filtrar.',
    'Dê os números exatos em reais (R$) com os nomes reais das contas.',
    'Apresente os números e a resposta completa imediatamente nesta mensagem.',
  ],
  pitfalls: [
    'Nunca estime saldo de cabeça: sempre use os números reais retornados por list_accounts ou get_balance.',
    'Não liste dezenas de lançamentos crus no chat — resuma e ofereça detalhar.',
    'NUNCA responda dizendo apenas "vou conferir", "um instante" ou mensagens vazias de espera: entregue a resposta e os saldos diretamente.',
  ],
};

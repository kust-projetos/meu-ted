/**
 * POC Fase 2 — intenção determinística mínima para os 8 cenários do PLAN.
 *
 * Escopo propositalmente estreito: cobre S1–S8 e nada mais. Fora disso,
 * responde como geral (sem leitura) em vez de inventar um mapeamento.
 */
import type { PocReadName } from './poc-reads.js';

export const POC_SCENARIO_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'] as const;
export type PocScenarioId = (typeof POC_SCENARIO_IDS)[number];

export type PocIntent =
  | { readonly kind: 'read'; readonly read: PocReadName; readonly params: Record<string, unknown> }
  | { readonly kind: 'general' };

export const POC_SCENARIO_TEXTS: Record<PocScenarioId, string> = {
  S1: 'Quais contas eu tenho?',
  S2: 'Liste meus cartões.',
  S3: 'Mostre minhas faturas.',
  S4: 'Quanto gastei esse mês?',
  S5: 'Quanto gastei no mês passado?',
  S6: 'Quais foram meus gastos de supermercado?',
  S7: 'O que é cartão de crédito?',
  S8: 'Quanto gastei em janeiro de 2020?',
};

const norm = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export const routePocIntent = (text: string, now: Date = new Date()): PocIntent => {
  const t = norm(text);
  if (/\b(fatura|faturas)\b/.test(t)) return { kind: 'read', read: 'listStatements', params: {} };
  if (/\b(cartoes|cartao)\b/.test(t)) {
    // "o que é cartão de crédito?" é conceito — sem leitura.
    if (/o que e\b|o que sao\b|como funciona\b|significa\b/.test(t)) return { kind: 'general' };
    return { kind: 'read', read: 'listCards', params: {} };
  }
  if (/\b(contas|conta)\b/.test(t) && /\b(tenho|tenho\?|minhas|meus|quais|lista|mostra)\b/.test(t)) {
    return { kind: 'read', read: 'listAccounts', params: {} };
  }
  if (/\b(supermercado|mercado)\b/.test(t) && /\b(gasto|gastos|gastei|compras?)\b/.test(t)) {
    return { kind: 'read', read: 'listTransactions', params: { category: 'supermercado', limit: 20 } };
  }
  if (/\b(gastei|gastos|gastou|total|resumo)\b/.test(t)) {
    if (/2020|janeiro de 2020|periodo sem/.test(t)) {
      return { kind: 'read', read: 'getMonthSummary', params: { yearMonth: '2020-01' } };
    }
    if (/\bmes passado\b|\bultimo mes\b|\bmes anterior\b/.test(t)) {
      const current = now.toISOString().slice(0, 7);
      const [year, month] = current.split('-').map(Number);
      const prev = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 2, 1));
      return { kind: 'read', read: 'getMonthSummary', params: { yearMonth: prev.toISOString().slice(0, 7) } };
    }
    return { kind: 'read', read: 'getMonthSummary', params: { yearMonth: now.toISOString().slice(0, 7) } };
  }
  if (/\bcategorias\b/.test(t)) return { kind: 'read', read: 'listCategories', params: {} };
  return { kind: 'general' };
};

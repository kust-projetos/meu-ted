import { extractNamedAmountCents } from './budget-creation-intent.js';
import { parseMoneyToCents } from './financial-parser.js';

const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const isBudgetUpdateIntent = (text: string): boolean => {
  const value = fold(text);
  if (!value || /\b(?:quanto|qual|como|posso)\b/.test(value)) return false;
  if (/\b(?:nao|nunca|jamais)\b/.test(value)) return false;
  if (/\b(?:crie|criar|cria|cadastre|cadastrar|monte|montar|cancele|cancelar|cancela|desista|desistir)\b/.test(value)) return false;
  if (/\b(?:e|mas|ou)\s+(?:aumente|reduza|ajuste|altere|mude|atualize|compre|crie)\b/.test(value)) return false;
  return /\b(?:aumentar|aumente|reduzir|reduza|ajustar|ajuste|alterar|altere|mudar|mude|atualizar|atualize)\b/.test(value)
    && /\b(?:orcament\w*|budget\w*|teto)\b/.test(value);
};

export const extractBudgetUpdateAmount = (text: string, names: string[]): number | undefined => {
  const value = fold(text);
  const numbers = [...value.matchAll(/(?:r\$\s*)?(\d[\d.,]*)(?:\s*reais?)?/gu)];
  const monetaryNumbers = numbers.filter((match) => !/%/.test(value.slice(match.index! + match[0].length, match.index! + match[0].length + 2)));
  if (monetaryNumbers.length === 2) {
    const afterPara = monetaryNumbers.find((match) => /^\s*/.test(value.slice(match.index! + match[0].length)) && /\bpara(?:\s+ficar\s+em)?\s*$/.test(value.slice(0, match.index!)));
    if (afterPara) {
      try { const cents = parseMoneyToCents(afterPara[1]!); return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined; }
      catch { return undefined; }
    }
  }
  if (monetaryNumbers.length !== 1 || names.length !== 1) return undefined;
  return extractNamedAmountCents(text, names[0]!);
};

export const hasThresholdIntent = (text: string): boolean => /\b(?:alerta|limiar|limite)\b/i.test(fold(text));

export const thresholdOf = (text: string): number | undefined => {
  if (!hasThresholdIntent(text)) return undefined;
  const match = fold(text).match(/\b(?:alerta\s+em|limiar|limite)(?:\s+de)?\s*(\d{1,3})\s*%?/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : undefined;
};

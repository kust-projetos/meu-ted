const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
import { parseMoneyToCents } from './financial-parser.js';

export const isBudgetCreationIntent = (text: string): boolean => {
  const value = fold(text);
  if (!value || /\b(?:quanto|qual|como|posso)\b/.test(value)) return false;
  if (/\bnao\s+sei\s+como\b/.test(value)) return false;
  if (/\b(?:nao|nunca)\s+(?:crie|criar|cria|cadastre|cadastrar|monte|montar)\b/.test(value)) return false;
  if (/\b(?:cancele|cancelar|cancela|desista|desistir)\b/.test(value)) return false;
  if (/\b(?:e|mas|ou)\s+(?:crie|criar|cria|liste|listar|cadastre|adicione|defina|monte)\b/.test(value)) return false;
  return /\b(?:crie|criar|cria|cadastre|cadastrar|monte|montar)\b/.test(value) && /\b(?:orcament\w*|budget\w*)\b/.test(value);
};

export const budgetPeriodOf = (text: string): 'monthly' | 'quarterly' | 'yearly' => {
  const value = fold(text);
  if (/\b(?:trimestral\w*|trimestre)\b/.test(value)) return 'quarterly';
  if (/\b(?:anual\w*|ano|12\s+meses)\b/.test(value)) return 'yearly';
  return 'monthly';
};

export const extractNamedAmountCents = (text: string, entityName: string): number | undefined => {
  const folded = fold(text);
  const foldedName = fold(entityName.trim());
  const escaped = foldedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  let source = folded.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u'), ' ');
  source = source.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{1,2}\/\d{1,2}\b/g, ' ').replace(/\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4}\b/g, ' ').replace(/\bem\s+\d{4}\b/g, ' ').replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ').replace(/\bdia\s+\d+\b/g, ' ');
  if (/\b\d[\d.,]*\s*(?:milh(?:ao|oes)|mil|k|mi)\b/u.test(source)) return undefined;
  const monetary = source.match(/(?:r\$\s*([\d][\d.,]*)|([\d][\d.,]*)\s*reais?)/iu);
  const raw = monetary?.slice(1).find(Boolean) ?? source.match(/\b\d[\d.,]*\b/u)?.[0];
  if (!raw || (!monetary && [...source.matchAll(/\b\d[\d.,]*\b/gu)].length > 1)) return undefined;
  if (!/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/u.test(raw) && (/^\d{1,3}(?:\.\d{3})+$/u.test(raw) || /^\d+,\d{3,}$/u.test(raw) || /^\d+\.\d{3,}$/u.test(raw))) return undefined;
  try { const cents = parseMoneyToCents(raw); return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined; } catch { return undefined; }
};

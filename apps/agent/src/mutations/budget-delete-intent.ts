const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const isBudgetDeleteIntent = (text: string): boolean => {
  const value = fold(text);
  if (!value || /\b(?:quanto|qual|como|posso)\b/.test(value)) return false;
  if (/\b(?:nao|nunca|jamais)\b/.test(value)) return false;
  if (/\b(?:crie|criar|cria|cadastre|cadastrar|monte|montar|aumente|aumentar|reduza|reduzir|ajuste|ajustar|altere|alterar|mude|mudar|atualize|atualizar)\b/.test(value)) return false;
  if (/\b(?:e|mas|ou)\s+(?:crie|criar|cadastre|cadastrar|monte|montar|aumente|reduza|ajuste|altere|mude|atualize)\b/.test(value)) return false;
  return /\b(?:apagar|apague|remover|remova|excluir|exclua|delete)\b/.test(value)
    && /\b(?:orcament\w*|budget\w*)\b/.test(value);
};

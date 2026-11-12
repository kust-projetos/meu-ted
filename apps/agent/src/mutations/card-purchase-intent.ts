/** Conservative lexical gate for a new credit-card purchase (not a payment/read). */
export const isCardPurchaseIntent = (text: string): boolean => {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(debito|fatura|paguei\s+a\s+fatura|saldo|limite|quanto)\b/.test(normalized)) return false;
  return /\b(?:comprei|compra|gastei|parcelei|parcelar|parcelado|parcelada)\b/.test(normalized) &&
    /\b(?:no|na|com|usando)\s+(?:cartao|credito)\b/.test(normalized);
};

export const hasInstallmentIntent = (text: string): boolean => {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b\d+\s*[x×](?![\p{L}\p{N}])/u.test(normalized) ||
    /\b\d+\s+vezes\b/.test(normalized) ||
    /\b\d+\s+parcelas?\b/.test(normalized) ||
    /\b(?:parcelas?|dividi|dividido|dividida|dividir|a\s+prazo|parcelei|parcelado|parcelada|parcelar|prestacao|prestacoes)\b/.test(normalized) ||
    /\b(?:um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta)\s+vezes\b/.test(normalized);
};

export const hasWholeEntityName = (text: string, name: string): boolean => {
  const foldedText = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const foldedName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!foldedName) return false;
  const escaped = foldedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  return [...foldedText.matchAll(matcher)].some((match) => {
    const end = (match.index ?? 0) + match[0].length;
    return !/^\s+de\s+som\b/.test(foldedText.slice(end));
  });
};

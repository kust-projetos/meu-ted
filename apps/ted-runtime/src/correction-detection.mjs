// Deterministic lexical detection only. Values are human-readable text; this
// deliberately does not resolve entities or parse authoritative money/date data.
const ATTACHMENT_MARKER = /^\s*\[(?:transcri(?:ç|c)[ãa]o do anexo|texto do pdf|conte[uú]do do anexo)\b/i;

export function isAttachmentMarkedText(text) {
  return typeof text === 'string' && ATTACHMENT_MARKER.test(text);
}

export function isReferentialCorrectionText(text) {
  if (typeof text !== 'string' || ATTACHMENT_MARKER.test(text)) return false;
  return /^(?:coloca(?:r)?|na verdade|era|foi|isso é|isso e|o valor certo é|o valor certo e|corrige|ajusta|muda|troca)(?:\s|$)/iu.test(text.trim());
}

/**
 * Extract only a single explicit field/value pair. Unsupported phrasing,
 * multiple field signals, negation, and attachment-marked content fail closed.
 * This is not a financial parser: amounts/dates remain display text for review.
 */
export function parseCorrectionFields(text) {
  if (typeof text !== 'string' || ATTACHMENT_MARKER.test(text) ||
      /^\s*(?:não|nao|cancela)\b/i.test(text)) return null;
  const normalized = text.trim().replace(/[.!?,;:]+$/u, '').replace(/\s+/gu, ' ');
  const categorySignals = normalized.match(/\bcategoria\b/giu) ?? [];
  if (categorySignals.length > 1) return null;
  const patterns = [
    ['amount', /(?:valor(?: certo)?|quantia)\s*(?:é|e|para|de|:)?\s*(.+)$/iu],
    ['date', /data\s*(?:é|e|para|de|:)?\s*(.+)$/iu],
    ['category', /categoria\s*(?:é|e|para|de|:)?\s*(.+)$/iu],
    ['account', /conta\s*(?:é|e|para|de|:)?\s*(.+)$/iu],
    ['description', /descriç(?:ão|ao)|descrição|descriçao/iu],
  ];
  const hits = [];
  for (const [field, pattern] of patterns) {
    const match = pattern.exec(normalized);
    if (match) {
      if (field === 'description') {
        const value = normalized.slice(match.index + match[0].length).replace(/^\s*(?:é|e|como|para|:)?\s*/iu, '');
        if (value) hits.push({ field, value });
      } else if (match[1]) hits.push({ field, value: match[1].trim() });
    }
  }
  if (hits.length === 0 && /^(?:coloca(?:r)?\s+como)\s+(.+)$/iu.test(normalized)) {
    hits.push({ field: 'description', value: normalized.replace(/^(?:coloca(?:r)?\s+como)\s+/iu, '').trim() });
  }
  if (hits.length !== 1) return null;
  const { field, value } = hits[0];
  if (!value || /^\s*(?:não|nao|cancela)\b/iu.test(value) ||
      /\b(?:e também|e ainda|além disso)\b/iu.test(value) ||
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(value) ||
      /\b[0-9a-f]{32,}\b/iu.test(value)) return null;
  return { field, value };
}

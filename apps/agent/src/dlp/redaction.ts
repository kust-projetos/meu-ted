/** Deterministic, allowlist-oriented sanitizer for operational events. */
const SECRET_KEY = /password|secret|token|authorization|cookie|api[_-]?key|credential|private[_-]?key|passphrase|cvv|cvc/i;
const TECHNICAL_KEY = /^(id|.*Id|.*_id|trace|request|session|workspace|actor|device)/i;
const FINANCIAL_KEY = /amount|balance|saldo|value|valor|currency|price|pre[cç]o|total|limit|fatura/i;
export const REDACTED = '[REDACTED]';

/**
 * Cuts text to `max` characters WITHOUT ever splitting a surrogate pair: a
 * cut that lands between 0xD83D/0xDE00 yields corrupt text no renderer can
 * display. Drops the incomplete pair instead (at most one character short of
 * the cap). Not grapheme-aware — a cut inside a combining sequence is still
 * allowed, because the minimum here is a valid string.
 */
export const truncateSafely = (value: string, max: number): string => {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  const endsOnHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return value.slice(0, endsOnHighSurrogate ? max - 1 : max);
};

export const sanitizeForEvent = (value: unknown, key = ''): unknown => {
  if (SECRET_KEY.test(key) || FINANCIAL_KEY.test(key) || TECHNICAL_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') {
    const scrubbed = value
      .replace(/((?:password|secret|token|api[_-]?key|authorization|cookie|passphrase)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
      .replace(/\b(?:R\$|BRL|USD|EUR)\s*[\d.,]+/gi, `${REDACTED}`)
      .replace(/\b(?:eyJ[a-z0-9_-]+\.)[a-z0-9_.-]+/gi, REDACTED)
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, REDACTED);
    return scrubbed.length > 160 ? `${truncateSafely(scrubbed, 160)}…` : scrubbed.replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(value)) return value.slice(0, 8).map((v) => sanitizeForEvent(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([k, v]) => [k, sanitizeForEvent(v, k)]));
  }
  return value;
};

export const sanitizeErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown');
  const scrubbed = raw
    .replace(/((?:password|secret|token|api[_-]?key|authorization|cookie|passphrase)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:Bearer|Basic|Token)\s+[^\s]+/gi, REDACTED);
  return String(sanitizeForEvent(scrubbed)).slice(0, 160) || 'unknown';
};

/**
 * H-09: centralized DLP/redaction policy for EVERY durable write and export.
 *
 * Single funnel: `scrubForPersistence` (text) + `scrubAttachments`
 * (metadata-only attachments). Covers:
 * - PAN / card numbers, 13–19 digits with spaces/dashes/dots, Luhn-checked
 *   (so phone numbers and random digit runs are NOT clobbered);
 * - CVV/CVC only with explicit context (cvv/cvc/código de segurança/...);
 * - CPF/CNPJ with check-digit validation;
 * - credentials/secrets via the existing `sanitizeForPersistence` +
 *   `redactTranscript` chain (superset, never a replacement).
 *
 * Sinks forced through this module: /rpc/chat ingress (text + attachments),
 * memory writes (`sanitizeMemoryContent` → `rememberFact`), session summaries
 * (`endSession`), legacy-history migration transform, and every export path
 * (which additionally redacts JSON payloads).
 *
 * Attachments are METADATA-ONLY: inline content (`data`/`content`/base64
 * fields, `data:` URLs) is never persisted — it is dropped and counted.
 *
 * A13: the metadata shape additionally carries an OPTIONAL opaque `ref` (the
 * server-side attachment reference). This module only VALIDATES the opaque
 * format — it never resolves a reference, and no byte ever traverses this
 * funnel (bytes live in the private storage pipeline). Name scrubbing and
 * inline-content dropping are unchanged.
 */

import { sanitizeForPersistence } from './history.js';
import { redactTranscript } from '../transcript-safety.js';
import { ATTACHMENT_REF_PATTERN } from '../attachments/types.js';

export const REDACTED = '[REDACTED]';

/** 13–19 digits with optional single separators (PAN with variants). */
const PAN_CANDIDATE_RE = /\b(?:\d[ \-\.]?){13,19}\b/g;

/**
 * CVV/CVC only when an explicit context keyword is adjacent (up to a short
 * filler such as "é"/"e"/":" — real-world phrasing is "meu cvv é 123").
 * Safe direction: may over-redact a nearby 3–4 digit run, never under-redact.
 */
const CVV_CONTEXT_RE =
  /\b(?:cvv2?|cvc2?|c[oó]digo(?: de seguran[cç]a)?|security code|verification code)\b[^\d]{0,12}(\d{3,4})\b/gi;

/** CPF: 11 digits in plain or dotted form. */
const CPF_RE = /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/g;

/** CNPJ: 14 digits in plain or punctuated form. */
const CNPJ_RE = /\b(\d{2}\.? ?\d{3}\.? ?\d{3}\/? ?\d{4}-?\d{2})\b/g;

const onlyDigits = (value: string): string => value.replace(/\D/g, '');

const luhnValid = (digits: string): boolean => {
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

const cpfValid = (digits: string): boolean => {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i);
  let rest = (sum * 10) % 11;
  if (rest === 10) rest = 0;
  if (rest !== Number(digits[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (11 - i);
  rest = (sum * 10) % 11;
  if (rest === 10) rest = 0;
  return rest === Number(digits[10]);
};

const cnpjValid = (digits: string): boolean => {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * weights1[i]!;
  let rest = sum % 11;
  const dv1 = rest < 2 ? 0 : 11 - rest;
  if (dv1 !== Number(digits[12])) return false;
  sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(digits[i]) * weights2[i]!;
  rest = sum % 11;
  const dv2 = rest < 2 ? 0 : 11 - rest;
  return dv2 === Number(digits[13]);
};

const scrubPan = (value: string): string =>
  value.replace(PAN_CANDIDATE_RE, (match) => (luhnValid(onlyDigits(match)) ? REDACTED : match));

const scrubCvv = (value: string): string =>
  value.replace(CVV_CONTEXT_RE, (match, digits: string) => match.replace(digits, REDACTED));

const scrubDocuments = (value: string): string =>
  value
    .replace(CPF_RE, (match) => (cpfValid(onlyDigits(match)) ? REDACTED : match))
    .replace(CNPJ_RE, (match) => (cnpjValid(onlyDigits(match)) ? REDACTED : match));

/**
 * Refuse-before-write probe: true when the text carries a valid PAN (any
 * separator variant). Callers refuse the whole write (memory learns nothing
 * from a card number); CVV/documents are scrubbed but storable.
 */
export const containsCardPan = (value: string): boolean => {
  if (!value) return false;
  PAN_CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAN_CANDIDATE_RE.exec(value)) !== null) {
    if (luhnValid(onlyDigits(match[0]))) return true;
  }
  return false;
};

/** Probe for CVV-with-context or valid CPF/CNPJ (scrubbed, but storable). */
export const containsSensitiveDocument = (value: string): boolean => {
  if (!value) return false;
  CVV_CONTEXT_RE.lastIndex = 0;
  if (CVV_CONTEXT_RE.test(value)) return true;
  CPF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CPF_RE.exec(value)) !== null) {
    if (cpfValid(onlyDigits(match[1]!))) return true;
  }
  CNPJ_RE.lastIndex = 0;
  while ((match = CNPJ_RE.exec(value)) !== null) {
    if (cnpjValid(onlyDigits(match[1]!))) return true;
  }
  return false;
};

/**
 * THE text funnel for durable writes: secrets → PAN → CVV → CPF/CNPJ →
 * credential redaction. Idempotent (re-scrubbing redacted text is a no-op
 * for detection purposes; markers contain no digits).
 */
export const scrubForPersistence = (value: string): string => {
  if (!value) return '';
  const secretsFirst = sanitizeForPersistence(value);
  return redactTranscript(scrubDocuments(scrubCvv(scrubPan(secretsFirst))));
};

/**
 * A13: `ref` is the opaque server-side attachment reference. It is METADATA —
 * never a URL, a local path or content — and is only carried when it matches
 * the opaque format, so a caller cannot smuggle an arbitrary string into the
 * durable transcript through this field.
 */
export type ScrubbedAttachment = { type: string; url: string; name: string; ref?: string };

export type ScrubAttachmentsResult = {
  attachments: ScrubbedAttachment[];
  /** Count of attachments whose inline/raw content was dropped. */
  droppedInlineContent: number;
};

const INLINE_CONTENT_KEYS = ['data', 'content', 'base64', 'blob', 'buffer', 'file'];

/**
 * Attachments persist as METADATA ONLY ({type, url, name, ref?}). Inline
 * content fields and `data:` URLs are dropped - never persisted raw. Names are
 * scrubbed (a file named after a card number must not leak either). A `ref`
 * survives ONLY in the opaque format; anything else is dropped silently.
 */
export const scrubAttachments = (items: unknown): ScrubAttachmentsResult => {
  if (!Array.isArray(items)) return { attachments: [], droppedInlineContent: 0 };
  const attachments: ScrubbedAttachment[] = [];
  let droppedInlineContent = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? (record['type'] as string) : 'file';
    const rawUrl = typeof record['url'] === 'string' ? (record['url'] as string) : '';
    const rawName = typeof record['name'] === 'string' ? (record['name'] as string) : type;
    let dropped = false;
    for (const key of INLINE_CONTENT_KEYS) {
      const v = record[key];
      if (typeof v === 'string' ? v.length > 0 : v !== undefined && v !== null) {
        dropped = true;
        break;
      }
    }
    let url = rawUrl;
    if (url.toLowerCase().startsWith('data:')) {
      url = '';
      dropped = true;
    }
    if (dropped) droppedInlineContent += 1;
    const rawRef = record['ref'];
    const ref = typeof rawRef === 'string' && ATTACHMENT_REF_PATTERN.test(rawRef) ? rawRef : undefined;
    attachments.push({
      type,
      url,
      name: scrubForPersistence(rawName).slice(0, 200),
      ...(ref ? { ref } : {}),
    });
  }
  return { attachments, droppedInlineContent };
};

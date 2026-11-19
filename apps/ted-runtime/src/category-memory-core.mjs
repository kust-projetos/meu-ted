import { createHash } from 'node:crypto';

export const CATEGORY_MEMORY_VALUE_MAX = 120;

const normalizePart = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('memory identity part is required');
  return value.normalize('NFC').trim();
};

export function categoryMemoryFingerprint({ workspaceId, actorId, target, field }) {
  const identity = [workspaceId, actorId, target, field]
    .map(normalizePart)
    .map((part, index) => index === 2 ? part.toLocaleLowerCase() : part)
    .join('\0');
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

// Values are untrusted DATA, never instructions. Learning must only receive
// validated typed corrections; attachment/transcript content is never learned.
export function normalizeMemoryValue(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > CATEGORY_MEMORY_VALUE_MAX) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(normalized)) return null;
  if (/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(normalized)) return null;
  if (/\b(?:sk|pk|tok|api)[_-][a-z0-9_-]{12,}\b/i.test(normalized) ||
      /\b[a-f0-9]{32,}\b/i.test(normalized)) return null;
  if (/\b(?:password|senha|token|secret|api[_ -]?key)\s*[:=]/i.test(normalized)) return null;
  return normalized;
}

export function isForgetTombstoneActive(entry, nowMs = Date.now()) {
  return Number.isFinite(entry?.tombstoneAt) &&
    Number.isFinite(entry?.expiresAt) &&
    entry.tombstoneAt <= nowMs && entry.expiresAt > nowMs;
}

export function shouldReplaceMemory(existing, incoming, nowMs = Date.now()) {
  if (!existing) return true;
  if (isForgetTombstoneActive(existing, nowMs)) return false;
  if (existing.value === incoming.value) return false;
  return (incoming.updatedAt ?? 0) > (existing.updatedAt ?? 0) ||
    (incoming.confidence ?? 0) > (existing.confidence ?? 0);
}

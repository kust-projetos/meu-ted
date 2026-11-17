// Display normalization preserves a readable NFC name; comparison additionally
// collapses whitespace and uses locale-independent lowercase for deduplication.
export function normalizeCategoryName(name) {
  if (typeof name !== 'string') return null;
  return name.trim().normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
}

export function isAutocreatableCategoryName(name) {
  if (typeof name !== 'string') return false;
  const normalized = name.normalize('NFC');
  return normalized.trim().length >= 1 && normalized.trim().length <= 60 &&
    !/[\p{Cc}\p{Cf}]/u.test(normalized);
}

export function findDuplicateCategory(items, name, kind) {
  if (!Array.isArray(items) || !isAutocreatableCategoryName(name) ||
      !['expense', 'income'].includes(kind)) return null;
  const target = normalizeCategoryName(name);
  return items.find((item) => item && typeof item === 'object' &&
    item.kind === kind && item.isActive !== false &&
    (item.status === undefined || (typeof item.status === 'string' && item.status.trim().toLowerCase() === 'active')) &&
    normalizeCategoryName(item.name) === target) ?? null;
}

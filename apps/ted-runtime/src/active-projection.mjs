export const ACTIVE_PENDING_OPERATION_KEYS = Object.freeze([
  'id', 'status', 'tool', 'createdAt', 'expiresAt', 'amountCents',
  'description', 'date', 'accountId', 'categoryId', 'statementId',
  'fromAccountId', 'supersedes', 'failureCode', 'presentation',
]);

const REQUIRED = ['id', 'status', 'tool', 'createdAt', 'expiresAt'];

export function projectActivePendingOperations(value) {
  const source = Array.isArray(value?.items) ? value.items : [];
  const items = [];
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        REQUIRED.some((key) => typeof item[key] !== 'string' || !item[key].trim())) continue;
    const projected = {};
    for (const key of ACTIVE_PENDING_OPERATION_KEYS) {
      if (Object.hasOwn(item, key)) projected[key] = item[key];
    }
    items.push(projected);
  }
  return { items, total: items.length };
}

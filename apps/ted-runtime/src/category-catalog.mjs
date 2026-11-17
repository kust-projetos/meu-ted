// Ephemeral process-local context, keyed by host-bound sessionID. It dies with
// the process and is not persistent memory or an authoritative financial source.
const catalogs = new Map();

export function recordCatalog(sessionID, body) {
  if (typeof sessionID !== 'string' || !sessionID || !body || typeof body !== 'object' ||
      !Array.isArray(body.items)) return false;
  catalogs.set(sessionID, Object.freeze(body.items.map((item) => Object.freeze({
    id: item?.id, name: item?.name, kind: item?.kind,
    ...(item?.isActive !== undefined ? { isActive: item.isActive } : {}),
    ...(item?.status !== undefined ? { status: item.status } : {}),
  }))));
  return true;
}

export function getCatalog(sessionID) { return catalogs.get(sessionID) ?? null; }
export function clearCatalog(sessionID) { catalogs.delete(sessionID); }

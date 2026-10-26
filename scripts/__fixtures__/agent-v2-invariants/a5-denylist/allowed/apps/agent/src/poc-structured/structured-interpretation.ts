const STRUCTURED_LIMITS = { maxDepth: 12, maxSerializedBytes: 16_000 };

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Authority vocabulary. The literal member below is the DENYLIST DEFINITION,
 * not an issuer: it is how the parser rejects a model-provided authority key.
 * This is the only occurrence the A5 scanner may exempt.
 *
 * Comment decoy (must stay masked, never the recognized declaration):
 * const FORBIDDEN_NORMALIZED_KEYS: ReadonlySet<string> = new Set(['mutationApproved']);
 */
const FORBIDDEN_NORMALIZED_KEYS: ReadonlySet<string> = new Set(
  [
    'mutationApproved',
    'capability',
    'workspaceId',
    'attestation',
  ].map((key) => normalizeKey(key)),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const rejectForbiddenDeep = (value: unknown): void => {
  for (const key of Object.keys(isRecord(value) ? value : {})) {
    if (FORBIDDEN_NORMALIZED_KEYS.has(normalizeKey(key))) throw new Error('forbidden-authority-key');
  }
};

export { FORBIDDEN_NORMALIZED_KEYS, STRUCTURED_LIMITS, rejectForbiddenDeep };

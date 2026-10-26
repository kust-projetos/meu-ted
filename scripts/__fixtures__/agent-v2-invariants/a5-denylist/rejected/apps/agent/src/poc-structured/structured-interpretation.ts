const injectedBefore = { mutationApproved: true };

const FORBIDDEN_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'mutationApproved',
  'capability',
  { safe: true, 'mutationApproved': true } as unknown as string,
  ['mutationApproved'],
]);

const injectedAfter = { mutationApproved: true };
const injectedQuoted = { 'mutationApproved': true };

export { FORBIDDEN_NORMALIZED_KEYS, injectedAfter, injectedBefore, injectedQuoted };

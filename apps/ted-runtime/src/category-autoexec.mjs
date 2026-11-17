import { createHash } from 'node:crypto';
import { isAutocreatableCategoryName } from './category-intelligence.mjs';

export function deriveAutoExecIdempotencyKey(workspaceId, intentionId, toolCallId = 'categories.create') {
  return createHash('sha256').update(`${workspaceId}:${intentionId}:${toolCallId}`).digest('hex');
}

export function isAutoEligibleCategoryIntent(intent) {
  const args = intent?.normalizedArgs;
  return intent?.tool === 'categories.create' && args && Object.keys(args).length === 2 &&
    Object.hasOwn(args, 'name') && Object.hasOwn(args, 'kind') &&
    isAutocreatableCategoryName(args.name) && ['expense', 'income'].includes(args.kind);
}

export const CATEGORY_AUTOEXEC_BUDGET_MS = 12_000;

export async function tryAutoCreateCategory({
  client, identity, intentionId, intent, signal,
  budgetMs = CATEGORY_AUTOEXEC_BUDGET_MS,
}) {
  const pending = (reason = 'autoexec_failed') => ({ status: 'left_pending', reason });
  if (!client || !isAutoEligibleCategoryIntent(intent)) return pending('not_eligible');
  if (signal?.aborted) return pending('uncertain');
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, budgetMs));
  let authorized = false;
  try {
    const args = intent.normalizedArgs;
    const mint = await client.mint({ workspaceId: identity.workspace, actorId: identity.actorId, deviceId: identity.deviceId, intentionId, signal: controller.signal });
    if (controller.signal.aborted) return pending('uncertain');
    if (!mint?.token) return pending();
    const idempotencyKey = deriveAutoExecIdempotencyKey(identity.workspace, intentionId);
    const proposal = await client.propose({ token: mint.token, ...identityFields(identity), idempotencyKey, normalizedArgs: args, signal: controller.signal });
    if (controller.signal.aborted) return pending('uncertain');
    if (!proposal?.operationId) return pending();
    if (proposal.existing === true) return pending('existing_proposal');
    const authorization = await client.authorize({ token: mint.token, ...identityFields(identity), operationId: proposal.operationId, signal: controller.signal });
    if (controller.signal.aborted) return pending('uncertain');
    if (authorization?.status !== 'confirmed' || typeof authorization?.attestation !== 'string' || authorization.attestation.length < 32) return pending('authorize_not_confirmed');
    authorized = true;
    const result = await client.execute({ token: mint.token, ...identityFields(identity), operationId: proposal.operationId, attestation: authorization.attestation, signal: controller.signal });
    if (controller.signal.aborted || !validReceipt(result, proposal.operationId)) return pending('uncertain');
    return { status: 'executed' };
  } catch {
    return pending(authorized || controller.signal.aborted ? 'uncertain' : 'autoexec_failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function identityFields(identity) {
  return { workspaceId: identity.workspace, actorId: identity.actorId, deviceId: identity.deviceId };
}

function validReceipt(result, pendingId) {
  const execution = result?.execution;
  const receipt = execution?.receipt;
  return result?.id === pendingId && result?.status === 'succeeded' &&
    execution?.status === 'succeeded' && typeof execution.operationId === 'string' && execution.operationId.length > 0 &&
    receipt?.mutationKind === 'categories.create' && receipt?.status === 'succeeded' &&
    typeof receipt.mutationId === 'string' && receipt.mutationId.length > 0 &&
    receipt.operationId === pendingId && receipt.entity?.type === 'category' &&
    receipt.entity.id === execution.operationId;
}

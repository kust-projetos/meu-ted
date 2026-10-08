/**
 * F1 PR-A (issue #107) — server-side gate do RPC de upload de attachments.
 *
 * O binding R2 (`getAttachmentStorage`) sozinho NÃO elege mais o upload: a
 * rota `POST /rpc/attachments` exige, nesta ordem fail-closed,
 *   1. storage configurado (binding `TED_ATTACHMENTS_BUCKET` presente), senão
 *      503 `attachment_storage_unavailable`;
 *   2. flag explícita `TED_ATTACHMENTS_ENABLED === '1'` (trava ESTRITA,
 *      sem trim — whitespace nega; difere de STT/vision/PDF, que dão trim,
 *      por contrato do relatório A19 §4.1; default-off), senão 503
 *      `attachment_upload_disabled`;
 *   3. coorte explícita `TED_ATTACHMENTS_COHORT` (CSV de workspace/actor ids;
 *      vazia/ausente = NINGUÉM, fail-closed; entrada curinga `'*'` = TODOS,
 *      decisão do operador para rollout geral), senão 503
 *      `attachment_upload_disabled`.
 *
 * A negação no DO acontece ANTES de qualquer leitura de corpo/bytes: nenhum
 * objeto é escrito quando o gate recusa (zero-write). Nota honesta de escopo:
 * no caminho real o Worker faz buffer limitado do corpo (teto por rota) antes
 * de repassar ao DO — a garantia aqui é zero-write no bucket, não zero-read
 * end-to-end. O gate é o mesmo do RPC de upload E dos deletes (F1 PR-A fix,
 * finding REV-PRC-GOLDEN P2): com o gate negado, a limpeza de ref expirada no
 * chat (`resolveAttachmentRef` com `allowDelete: false`) e o sweep
 * (`cleanupExpiredAttachments` com `allowDelete: false`) são pulados — zero
 * MUTAÇÃO global (nem `put`, nem `delete`); expirados aguardam a capability
 * ligada ou um janitor dedicado. Os turnos
 * LLM continuam regidos por `selectRolloutCohort` (llm/rollout.ts), intacto.
 */

import { getAttachmentStorage } from './storage.js';

/** Nome da env da trava exata do upload (documentado aqui e no DO). */
export const ATTACHMENTS_ENABLED_ENV = 'TED_ATTACHMENTS_ENABLED';
/** Nome da env da allowlist de coorte do upload (CSV, documentado no DO). */
export const ATTACHMENTS_COHORT_ENV = 'TED_ATTACHMENTS_COHORT';

type UploadGateEnv = {
  TED_ATTACHMENTS_BUCKET?: unknown;
  TED_ATTACHMENTS_ENABLED?: unknown;
  TED_ATTACHMENTS_COHORT?: unknown;
};

/** Parse da coorte: CSV com trim, vazios descartados. Ausente/vazia ⇒ []. */
export const parseAttachmentUploadCohort = (env: unknown): string[] => {
  const raw = (env as UploadGateEnv | undefined)?.TED_ATTACHMENTS_COHORT;
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

/**
 * Coorte attachment-specific: casa por workspaceId OU actorId. Lista vazia
 * (env ausente/vazia) = ninguém — fail-closed por construção, sem caso
 * especial no chamador. Entrada curinga `'*'` = TODOS (decisão do operador
 * para rollout geral; registrada e testada) — qualquer outra entrada segue
 * casamento exato, case-sensitive.
 */
export const isAttachmentUploadCohortMember = (
  env: unknown,
  workspaceId: string,
  actorId: string,
): boolean => {
  const allow = parseAttachmentUploadCohort(env);
  if (allow.length === 0) return false;
  if (allow.includes('*')) return true;
  return allow.includes(workspaceId) || allow.includes(actorId);
};

/** Trava estrita: `=== '1'`, sem trim (whitespace nega). Diverge
 * intencionalmente dos gates STT/vision/PDF (que dão trim): aqui o contrato é
 * o do relatório A19 §4.1, e negar por whitespace é o lado fail-closed. */
const isUploadFlagEnabled = (env: unknown): boolean => {
  const raw = (env as UploadGateEnv | undefined)?.TED_ATTACHMENTS_ENABLED;
  return raw === '1';
};

/**
 * Elegibilidade total: storage configurado E flag==='1' E coorte. Pura (sem
 * I/O): nunca escreve bytes/objetos, só lê env + forma da coorte.
 */
export const isAttachmentUploadAllowed = (
  env: unknown,
  workspaceId: string,
  actorId: string,
): boolean => {
  if (!getAttachmentStorage(env)) return false;
  if (!isUploadFlagEnabled(env)) return false;
  return isAttachmentUploadCohortMember(env, workspaceId, actorId);
};

export type AttachmentUploadDenial = {
  code: 'attachment_storage_unavailable' | 'attachment_upload_disabled';
  status: 503;
};

/**
 * O motivo da recusa (para a rota responder o 503 tipado), ou `null` quando
 * elegível. Ordem fail-closed: binding primeiro (indisponível), depois
 * flag/coorte (desativado) — um upload sem binding nunca é "desativado", é
 * indisponível, como antes.
 */
export const attachmentUploadDenial = (
  env: unknown,
  workspaceId: string,
  actorId: string,
): AttachmentUploadDenial | null => {
  if (!getAttachmentStorage(env)) {
    return { code: 'attachment_storage_unavailable', status: 503 };
  }
  if (!isUploadFlagEnabled(env)) {
    return { code: 'attachment_upload_disabled', status: 503 };
  }
  if (!isAttachmentUploadCohortMember(env, workspaceId, actorId)) {
    return { code: 'attachment_upload_disabled', status: 503 };
  }
  return null;
};

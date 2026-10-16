import { createHash } from 'node:crypto';
import { WorkspaceError } from './workspaces-store.js';

/**
 * D2 (ADR-027) — delete só-vazio: confirmação forte + inventário
 * versionado + expiração + tombstone. Purge com-dados permanece
 * BLOQUEADO até retenção/exportação/política existirem.
 */

/** Ação vinculada da confirmação forte de delete. */
export const DELETION_CONFIRM_ACTION = 'workspace.delete' as const;

/** Janela de validade do inventário de exclusão (15 min). */
export const DELETION_INVENTORY_TTL_MS = 15 * 60 * 1000;

/** Tolerância de relógio na validação de expiração (60 s). */
const CONFIRMATION_CLOCK_SKEW_MS = 60 * 1000;

export type DeletionInventoryCounts = Record<string, number>;

export type DeletionInventory = {
  workspaceId: string;
  inventoryVersion: string;
  expiresAt: string;
  empty: boolean;
  counts: DeletionInventoryCounts;
  /** Purge com-dados é uma ação separada, bloqueada (D2 §3). */
  purgeBlocked: true;
  /**
   * Lado Agent (Durable Objects / R2 / memória) não é observável pelo
   * Postgres da API: a barreira cross-store é pendente (ver Riscos do
   * ADR-027). O delete API-side prossegue para inventário vazio e o
   * fechamento registra a ausência de atestação.
   */
  agentAttestation: 'unverified';
};

export type DeleteConfirmation = {
  workspaceId: string;
  actor: string;
  action: typeof DELETION_CONFIRM_ACTION;
  inventoryVersion: string;
  expiresAt: string;
};

export type DeleteReceipt = {
  id: string;
  deletedAt: string;
  inventoryVersion: string;
};

const invalid = (message: string): WorkspaceError =>
  new WorkspaceError('workspace.confirmation_invalid', 409, message);

/** Versão canônica do inventário: sha256 do JSON ordenado das contagens. */
export const hashInventoryCounts = (
  workspaceId: string,
  counts: DeletionInventoryCounts,
): string => {
  const keys = Object.keys(counts).sort();
  const canonical = JSON.stringify({ workspaceId, counts: keys.map((k) => [k, counts[k]]) });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

export const buildDeleteConfirmation = (input: {
  workspaceId: string;
  actor: string;
  inventoryVersion: string;
  expiresAt: string;
}): DeleteConfirmation => ({
  workspaceId: input.workspaceId,
  actor: input.actor,
  action: DELETION_CONFIRM_ACTION,
  inventoryVersion: input.inventoryVersion,
  expiresAt: input.expiresAt,
});

export const deletionInventoryExpiry = (now = Date.now()): string =>
  new Date(now + DELETION_INVENTORY_TTL_MS).toISOString();

/**
 * Validação pura da confirmação forte: vínculo (UUID/ator/ação/versão)
 * + expiração com TTL limitado server-side. Não toca no banco.
 */
export const verifyDeleteConfirmation = (
  confirmation: DeleteConfirmation,
  expected: { workspaceId: string; actor: string; inventoryVersion: string },
  now = Date.now(),
): void => {
  if (
    !confirmation ||
    confirmation.action !== DELETION_CONFIRM_ACTION ||
    confirmation.workspaceId !== expected.workspaceId ||
    confirmation.actor !== expected.actor ||
    confirmation.inventoryVersion !== expected.inventoryVersion
  ) {
    throw invalid('Confirmação de exclusão inválida ou divergente do inventário.');
  }
  const expiresAt = Date.parse(confirmation.expiresAt);
  if (!Number.isFinite(expiresAt)) throw invalid('Confirmação de exclusão sem expiração válida.');
  // A janela nunca estende além do TTL + skew: relógio do cliente não amplia.
  if (expiresAt <= now) throw invalid('Confirmação de exclusão expirada.');
  if (expiresAt > now + DELETION_INVENTORY_TTL_MS + CONFIRMATION_CLOCK_SKEW_MS) {
    throw invalid('Confirmação de exclusão com expiração além da janela permitida.');
  }
};

/**
 * Gate do congelamento de archived (D2 §1): consultado SOMENTE quando o
 * status do workspace já é `archived`. Workspaces ativos nunca passam por
 * aqui. Leituras passam; restore/archive-idempotente/delete-vazio,
 * saída e revogação (redução de acesso) passam; todo o resto congela.
 */
export const isArchivedMutationAllowed = (method: string, rawPath: string): boolean => {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return true;
  const path = rawPath.split('?')[0] ?? rawPath;
  // Delete-vazio do próprio workspace (segmento único).
  if (verb === 'DELETE' && /^\/workspaces\/[^/]+$/.test(path)) return true;
  const workspaceOp = /^\/workspaces\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(path);
  if (workspaceOp) {
    const op = workspaceOp[2]!;
    // Lifecycle sobre archived: restore, re-archive idempotente.
    if (verb === 'POST' && (op === 'restore' || op === 'archive')) return true;
    // Saída do membro e remoção/revogação (redução de acesso, sem dado financeiro).
    if (verb === 'POST' && op === 'leave') return true;
    if (verb === 'DELETE' && (op === 'members' || op === 'invites')) return true;
    return false;
  }
  // Aceite de convite (token, sem workspace resolvido) não é bloqueado aqui.
  if (verb === 'POST' && path === '/auth/invites/accept') return true;
  return false;
};

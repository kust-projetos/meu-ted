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

/**
 * Atestação cross-store do lado Agent (Durable Objects / R2 / memória).
 * O Postgres da API não observa esse lado: o inventário API-side sempre
 * retorna `unverified`, e o delete SÓ conclui com `verified-empty`
 * apresentado na confirmação (barreira fail-closed, ADR-027 Riscos).
 */
export type AgentAttestation = 'unverified' | 'verified-empty';

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
   * Postgres da API: o inventário API-side sempre retorna `unverified`.
   * O delete SÓ conclui com `verified-empty` na confirmação — `unverified`
   * BLOQUEIA o delete (fail-closed, nunca conclui sem a barreira).
   */
  agentAttestation: AgentAttestation;
};

export type DeleteConfirmation = {
  workspaceId: string;
  actor: string;
  action: typeof DELETION_CONFIRM_ACTION;
  inventoryVersion: string;
  expiresAt: string;
  /**
   * Barreira cross-store (FIX-WS-D2-R2): só `verified-empty` conclui o
   * delete. `unverified` é recusado com `workspace.agent_unverified`
   * antes de qualquer efeito — nunca conclui sem atestação.
   */
  agentAttestation: AgentAttestation;
};

export type DeleteReceipt = {
  id: string;
  deletedAt: string;
  inventoryVersion: string;
};

const invalid = (message: string): WorkspaceError =>
  new WorkspaceError('workspace.confirmation_invalid', 409, message);

const agentUnverified = (): WorkspaceError =>
  new WorkspaceError(
    'workspace.agent_unverified',
    409,
    'Exclusão bloqueada: ausência do lado Agent (Durable Objects / R2 / memória) não atestada. Apresente agentAttestation verified-empty.',
  );

/**
 * Versão canônica do inventário: sha256 do JSON ordenado das contagens
 * VINCULADO à expiração (FIX-WS-D2-R2 item 5). Sem o vínculo, o cliente
 * poderia reemitir a confirmação com `expiresAt` adulterado (dentro da
 * janela) e renovar a validade indefinidamente: qualquer `expiresAt`
 * divergente do inventariado gera versão divergente e recusa.
 */
export const hashInventoryCounts = (
  workspaceId: string,
  counts: DeletionInventoryCounts,
  expiresAt: string,
): string => {
  const keys = Object.keys(counts).sort();
  const canonical = JSON.stringify({ workspaceId, counts: keys.map((k) => [k, counts[k]]), expiresAt });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

export const buildDeleteConfirmation = (input: {
  workspaceId: string;
  actor: string;
  inventoryVersion: string;
  expiresAt: string;
  agentAttestation: AgentAttestation;
}): DeleteConfirmation => ({
  workspaceId: input.workspaceId,
  actor: input.actor,
  action: DELETION_CONFIRM_ACTION,
  inventoryVersion: input.inventoryVersion,
  expiresAt: input.expiresAt,
  agentAttestation: input.agentAttestation,
});

export const deletionInventoryExpiry = (now = Date.now()): string =>
  new Date(now + DELETION_INVENTORY_TTL_MS).toISOString();

/**
 * Validação pura da confirmação forte: vínculo (UUID/ator/ação/versão)
 * + barreira cross-store + expiração com TTL limitado server-side.
 * Não toca no banco. A expiração é IMUTÁVEL por vínculo: o chamador
 * (deleteEmpty) recomputa a versão sobre as contagens vivas E o
 * `expiresAt` apresentado — `expiresAt` adulterado gera versão
 * divergente (ver `verifyInventoryBinding`).
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
  // Barreira cross-store ANTES de qualquer outra validação temporal:
  // `unverified` nunca conclui, mesmo com o restante válido.
  if (confirmation.agentAttestation !== 'verified-empty') {
    throw agentUnverified();
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
 * Vínculo inventário↔confirmação sob a barreira (FIX-WS-D2-R2 item 5):
 * a versão esperada é recomputada sobre as contagens vivas (sob o lock
 * do delete) E o `expiresAt` apresentado na confirmação. Expiração
 * adulterada → versão divergente → recusa, sem tocar nos dados.
 * Na prática o deleteEmpty passa essa versão vinculada como
 * `expected.inventoryVersion` de `verifyDeleteConfirmation`, de modo que
 * vínculo, barreira e expiração são checados numa única validação pura.
 */
export const boundInventoryVersion = (
  workspaceId: string,
  liveCounts: DeletionInventoryCounts,
  presentedExpiresAt: string,
): string => hashInventoryCounts(workspaceId, liveCounts, presentedExpiresAt);

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

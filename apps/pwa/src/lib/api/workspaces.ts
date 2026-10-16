import { apiFetch } from "./client";
import { getSessionToken } from "@/lib/auth/token-store";
import {
  emptyResponseSchema,
  ownershipTransferListSchema,
  ownershipTransferSchema,
  pendingInviteListSchema,
  resendInviteResponseSchema,
  revokeInviteResponseSchema,
  workspaceInviteAcceptanceSchema,
  workspaceInviteSchema,
  workspaceListSchema,
  workspaceMemberListSchema,
  workspaceSchema,
  deletionInventorySchema,
  deleteReceiptSchema,
} from "./schemas";

/**
 * Canonical session token source: localStorage 'pi-finance:session-token'
 * Persisted after sign-in/sign-up (see token-store.ts and convite/page.tsx,
 * AuthGate.tsx). Used as fallback for Better-Auth when Secure cookie is not
 * persisted (http://localhost via proxy). Production https continues to use
 * cookie (credentials:'include'); Bearer is accepted by getBetterAuthSessionContext
 * in both cases.
 */
function sessionAuthHeader(): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type Workspace = {
  id: string;
  name: string;
  kind: "personal" | "shared";
  role: "owner" | "member";
  status: "active" | "archived" | "deleted";
};

export type WorkspaceMember = {
  userId: string;
  name: string;
  email: string;
  role: "owner" | "member";
  status: "active" | "pending";
};

export type PendingInvite = {
  id: string;
  householdId: string;
  email: string;
  role: "owner" | "member";
  expiresAt: string;
  createdAt?: string;
};

export type OwnershipTransfer = {
  id: string;
  householdId: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  createdAt: string;
  acceptedAt?: string;
};

export async function fetchWorkspaces(): Promise<Workspace[]> {
  const response = await apiFetch<{ items: Workspace[] }>("/workspaces", {
    headers: sessionAuthHeader(),
    responseSchema: workspaceListSchema,
  });
  return response.items;
}

export async function createWorkspace(input: { name: string; kind: "personal" | "shared" }): Promise<Workspace> {
  return apiFetch<Workspace>("/workspaces", {
    method: "POST",
    headers: sessionAuthHeader(),
    body: JSON.stringify(input),
    idempotencyKey: createIdempotencyKey(),
    responseSchema: workspaceSchema,
  });
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
  return apiFetch<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    headers: sessionAuthHeader(),
    body: JSON.stringify({ name: name.trim() }),
    idempotencyKey: createIdempotencyKey(),
    responseSchema: workspaceSchema,
  });
}

export async function archiveWorkspace(workspaceId: string): Promise<Workspace> {
  return updateWorkspaceStatus(workspaceId, "archive");
}

export async function restoreWorkspace(workspaceId: string): Promise<Workspace> {
  return updateWorkspaceStatus(workspaceId, "restore");
}

/**
 * D2 (ADR-027): inventário autoritativo de exclusão (owner-only).
 * Retorna versão vinculada + expiração para a confirmação forte.
 */
export type DeletionInventory = {
  workspaceId: string;
  inventoryVersion: string;
  expiresAt: string;
  empty: boolean;
  counts: Record<string, number>;
  purgeBlocked: true;
  agentAttestation: string;
};

export type DeleteReceipt = {
  id: string;
  deletedAt: string;
  inventoryVersion: string;
};

/**
 * FIX-WS-D2-R4 — prova HMAC de vazio emitida server-side pelo Agent.
 * O PWA só transporta o objeto opaco (revalidado pelo schema); a API
 * verifica o HMAC com o segredo compartilhado. Importado do contrato
 * do agent-client para nunca divergir do que o Agent emite.
 */
export type { AgentEmptyProof } from "./agent-client";

export async function fetchDeletionInventory(workspaceId: string): Promise<DeletionInventory> {
  return apiFetch<DeletionInventory>(`/workspaces/${encodeURIComponent(workspaceId)}/deletion-inventory`, {
    headers: sessionAuthHeader(),
    responseSchema: deletionInventorySchema,
  });
}

export type DeleteConfirmationInput = {
  workspaceId: string;
  inventoryVersion: string;
  expiresAt: string;
  /**
   * Barreira cross-store (FIX-WS-D2-R4): a string é legado de fio e
   * ignorada como prova pelo servidor. O que conclui o delete é
   * `agentProof` (atestação HMAC emitida pelo Agent); ausente/inválida
   * → 409 workspace.agent_unverified, fail-closed.
   */
  agentAttestation: "unverified" | "verified-empty";
  agentProof?: import("./agent-client").AgentEmptyProof;
};

/**
 * D2 (ADR-027): delete SÓ-vazio, permanente. `purge: true` é recusado
 * pelo servidor (409 workspace.purge_blocked) — nunca executa.
 */
export async function deleteWorkspace(
  workspaceId: string,
  confirmation: DeleteConfirmationInput,
  options?: { purge?: boolean },
): Promise<DeleteReceipt> {
  return apiFetch<DeleteReceipt>(`/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "DELETE",
    headers: sessionAuthHeader(),
    body: JSON.stringify({
      confirmation: { ...confirmation, action: "workspace.delete" },
      ...(options?.purge === true ? { purge: true } : {}),
    }),
    idempotencyKey: createIdempotencyKey(),
    responseSchema: deleteReceiptSchema,
  });
}

async function updateWorkspaceStatus(workspaceId: string, action: "archive" | "restore"): Promise<Workspace> {
  return apiFetch<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/${action}`, {
    method: "POST",
    headers: sessionAuthHeader(),
    idempotencyKey: createIdempotencyKey(),
    responseSchema: workspaceSchema,
  });
}

export async function fetchWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const response = await apiFetch<{ items: WorkspaceMember[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {
    headers: sessionAuthHeader(),
    responseSchema: workspaceMemberListSchema,
  });
  return response.items;
}

export async function fetchPendingInvites(workspaceId: string): Promise<PendingInvite[]> {
  const response = await apiFetch<{ items: PendingInvite[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
    headers: sessionAuthHeader(),
    responseSchema: pendingInviteListSchema,
  });
  return response.items;
}

export async function resendWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
): Promise<{ success: boolean; inviteId: string; email: string; expiresAt: string }> {
  return apiFetch<{ success: boolean; inviteId: string; email: string; expiresAt: string }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}/resend`,
    {
      method: "POST",
      headers: sessionAuthHeader(),
      idempotencyKey: createIdempotencyKey(),
      responseSchema: resendInviteResponseSchema,
    },
  );
}

export async function revokeWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
): Promise<{ success: boolean; inviteId: string; revokedAt?: string }> {
  return apiFetch<{ success: boolean; inviteId: string; revokedAt?: string }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`,
    {
      method: "DELETE",
      headers: sessionAuthHeader(),
      idempotencyKey: createIdempotencyKey(),
      responseSchema: revokeInviteResponseSchema,
    },
  );
}

export async function fetchOwnershipTransfers(workspaceId: string): Promise<OwnershipTransfer[]> {
  const response = await apiFetch<{ items: OwnershipTransfer[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/ownership-transfers`,
    {
      headers: sessionAuthHeader(),
      responseSchema: ownershipTransferListSchema,
    },
  );
  return response.items;
}

export async function createOwnershipTransfer(
  workspaceId: string,
  toUserId: string,
): Promise<OwnershipTransfer> {
  return apiFetch<OwnershipTransfer>(
    `/workspaces/${encodeURIComponent(workspaceId)}/ownership-transfers`,
    {
      method: "POST",
      headers: sessionAuthHeader(),
      body: JSON.stringify({ toUserId }),
      idempotencyKey: createIdempotencyKey(),
      responseSchema: ownershipTransferSchema,
    },
  );
}

export async function acceptOwnershipTransfer(
  workspaceId: string,
  transferId: string,
): Promise<OwnershipTransfer> {
  return apiFetch<OwnershipTransfer>(
    `/workspaces/${encodeURIComponent(workspaceId)}/ownership-transfers/${encodeURIComponent(transferId)}/accept`,
    {
      method: "POST",
      headers: sessionAuthHeader(),
      idempotencyKey: createIdempotencyKey(),
      responseSchema: ownershipTransferSchema,
    },
  );
}

export async function createWorkspaceInvite(workspaceId: string, email: string, expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)): Promise<{ inviteId: string; email: string; expiresAt: string }> {
  return apiFetch<{ inviteId: string; email: string; expiresAt: string }>("/auth/invites", {
    method: "POST",
    body: JSON.stringify({
      householdId: workspaceId,
      email: email.trim(),
      role: "member",
      expiresAt: expiresAt.toISOString(),
    }),
    idempotencyKey: createIdempotencyKey(),
    headers: sessionAuthHeader(),
    responseSchema: workspaceInviteSchema,
  });
}

export async function acceptWorkspaceInvite(token: string): Promise<{ inviteId: string; membership: { userId: string; householdId: string; role: "owner" | "member" } }> {
  return apiFetch<{ inviteId: string; membership: { userId: string; householdId: string; role: "owner" | "member" } }>("/auth/invites/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
    idempotencyKey: createIdempotencyKey(),
    headers: sessionAuthHeader(),
    responseSchema: workspaceInviteAcceptanceSchema,
  });
}

export async function verifyWorkspaceInvite(token: string): Promise<{ email: string; householdId: string; role: "owner" | "member"; expiresAt: string }> {
  return apiFetch<{ email: string; householdId: string; role: "owner" | "member"; expiresAt: string }>("/auth/invites/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function removeWorkspaceMember(workspaceId: string, memberUserId: string): Promise<void> {
  return apiFetch<void>(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberUserId)}`, {
    method: "DELETE",
    headers: sessionAuthHeader(),
    idempotencyKey: createIdempotencyKey(),
    responseSchema: emptyResponseSchema,
  });
}

export async function leaveWorkspace(workspaceId: string): Promise<void> {
  return apiFetch<void>(`/workspaces/${encodeURIComponent(workspaceId)}/leave`, {
    method: "POST",
    headers: sessionAuthHeader(),
    idempotencyKey: createIdempotencyKey(),
    responseSchema: emptyResponseSchema,
  });
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

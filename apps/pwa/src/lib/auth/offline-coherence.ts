/**
 * Offline coherence (#215, opção a — fail-closed).
 *
 * Estabilidade ≠ coerência: os guards FIX-168 verificam que a identidade não
 * MUDOU mid-flight na mesma aba; a coerência exige que as três fontes
 * concordem ENTRE SI no momento do uso:
 *
 * - workspace da aba (in-memory por aba, `getActiveWorkspaceId` em client.ts)
 * - subject V2 compartilhado (`getOfflineSubjectId`)
 * - workspace V3 utilizado (identidade validada ou binding persistido)
 *
 * Sem coerência → BLOQUEAR (zero fetch, zero publicação/gravação, boot
 * concluído, erro acionável). NUNCA reescreve subject, purga cache global ou
 * desloga aqui — o chamador estaciona e preserva.
 *
 * Sem ciclo de import: este módulo é folha (só offline-subject +
 * offline-identity). O client.ts informa a seleção da aba via
 * `noteActiveWorkspaceForCoherence` (o snapshot-db lê sem importar o
 * client, que o importaria de volta).
 */

import { getOfflineSubjectId } from "./offline-subject";
import { getOfflineWorkspaceId } from "./offline-identity";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value.trim())
    ? value
    : null;
}

/**
 * Coerência pura entre os três lados. Valores ausentes ou não-UUID não
 * provam divergência (boot legado/teste sem partição) — exceto aba UUID sem
 * subject: seleção endereçável sem partição verificável não é confiável.
 */
export function isOfflineCoherent(
  activeWorkspaceId: string | undefined | null,
  subjectId: string | null | undefined,
  v3WorkspaceId: string | undefined | null,
): boolean {
  const active = asUuid(activeWorkspaceId ?? null);
  const subject = asUuid(subjectId ?? null);
  const v3 = asUuid(v3WorkspaceId ?? null);
  // Aba endereçável (UUID) sem partição verificável → não confiável.
  if (active !== null && subject === null) return false;
  if (active !== null && subject !== null && active !== subject) return false;
  if (v3 !== null) {
    if (active !== null && v3 !== active) return false;
    if (subject !== null && v3 !== subject) return false;
  }
  return true;
}

export interface LiveOfflineCoherence {
  activeWorkspaceId: string | undefined;
  subjectId: string | null;
  v3WorkspaceId: string | null;
  coherent: boolean;
}

/** Lê o estado vivo (aba informada + partições compartilhadas). */
export function getLiveOfflineCoherence(
  activeWorkspaceId?: string | undefined,
  v3WorkspaceIdOverride?: string | undefined | null,
): LiveOfflineCoherence {
  const active = activeWorkspaceId ?? notedActiveWorkspace;
  const subjectId = getOfflineSubjectId();
  const v3WorkspaceId =
    v3WorkspaceIdOverride !== undefined ? (v3WorkspaceIdOverride ?? null) : getOfflineWorkspaceId();
  return {
    activeWorkspaceId: active,
    subjectId,
    v3WorkspaceId,
    coherent: isOfflineCoherent(active, subjectId, v3WorkspaceId),
  };
}

// ── Seleção da aba observada (sem importar client.ts) ───────────────
// O client.ts espelha cada set/clear aqui; o snapshot-db consulta sem ciclo.

let notedActiveWorkspace: string | undefined;

export function noteActiveWorkspaceForCoherence(
  workspaceId: string | undefined,
): void {
  notedActiveWorkspace = workspaceId;
}

export function getNotedActiveWorkspace(): string | undefined {
  return notedActiveWorkspace;
}

export const OFFLINE_COHERENCE_RELOAD_MESSAGE =
  "Sessão de workspace incoerente — recarregue a página para revalidar.";

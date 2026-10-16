import { createHmac, timingSafeEqual } from 'node:crypto';
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

/**
 * Janela de validade da atestação do lado Agent (5 min, FIX-WS-D2-R4):
 * curta porque o lado Agent é eventualmente consistente com o PG — a
 * prova morre rápido para não cobrir escrita concorrente por muito tempo.
 */
export const AGENT_ATTESTATION_TTL_MS = 5 * 60 * 1000;

/** Tolerância de relógio na validação de expiração (60 s). */
const CONFIRMATION_CLOCK_SKEW_MS = 60 * 1000;

export type DeletionInventoryCounts = Record<string, number>;

/**
 * Atestação cross-store do lado Agent (Durable Objects / R2 / memória).
 * O Postgres da API não observa esse lado: o inventário API-side sempre
 * retorna `unverified`, e o delete SÓ conclui com prova HMAC válida
 * (`agentProof`) emitida pelo Agent e verificada aqui com o segredo
 * compartilhado (FIX-WS-D2-R4). A string `agentAttestation` do fio nunca
 * é prova — só transporte legado.
 */
export type AgentAttestation = 'unverified' | 'verified-empty';

/**
 * Contagens do lado Agent vinculadas à prova (FIX-WS-D2-R4). Chaves
 * fixas: `sessions` (agent_sessions), `messages` (mensagens do DO),
 * `memories` (agent_memory viva) e `attachments` (objetos R2 do
 * workspace). A prova só é emitida com tudo zerado.
 */
export type AgentEmptyCounts = {
  sessions: number;
  messages: number;
  memories: number;
  attachments: number;
};

export const AGENT_EMPTY_COUNT_KEYS = ['sessions', 'messages', 'memories', 'attachments'] as const;

/**
 * Prova de vazio do lado Agent (FIX-WS-D2-R4): emitida server-side pelo
 * Agent (que observa seu próprio SQLite/R2), transportada opacamente pelo
 * cliente e verificada aqui com o segredo compartilhado
 * `WORKSPACE_DELETION_HMAC_SECRET`. Sem segredo configurado, emissão e
 * verificação são indisponíveis (fail-closed, 409).
 */
export type AgentEmptyProof = {
  workspaceId: string;
  inventoryVersion: string;
  counts: AgentEmptyCounts;
  expiresAt: string;
  hmac: string;
};

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
   * Barreira cross-store (FIX-WS-D2-R2, endurecida na R3 e resolvida na
   * R4): a string segue no contrato de fio mas NUNCA é prova — é
   * ignorada na verificação. O que conclui o delete é `agentProof`
   * (atestação HMAC emitida server-side pelo Agent e verificada com o
   * segredo compartilhado). Sem prova válida, `verifyDeleteConfirmation`
   * recusa com `workspace.agent_unverified` antes de qualquer efeito
   * (fail-closed).
   */
  agentAttestation: AgentAttestation;
  /** Prova HMAC do lado Agent (FIX-WS-D2-R4); ausente = bloqueio. */
  agentProof?: AgentEmptyProof | undefined;
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
    'Exclusão bloqueada: o lado Agent (Durable Objects / R2 / memória) não apresentou atestação válida emitida server-side. Nenhuma declaração do cliente é aceita (fail-closed).',
  );

/**
 * Atestação indisponível (FIX-WS-D2-R4): o segredo compartilhado
 * `WORKSPACE_DELETION_HMAC_SECRET` não está configurado — emissão e
 * verificação são impossíveis, e o delete bloqueia fail-closed com 409
 * (nunca conclui sem prova). Contrato: mesmo `code` da barreira
 * (`workspace.agent_unverified`), mensagem distinguindo a causa para a
 * UX mostrar qual lado falhou.
 */
export const agentAttestationUnavailable = (): WorkspaceError =>
  new WorkspaceError(
    'workspace.agent_unverified',
    409,
    'Exclusão indisponível: atestação do lado Agent não configurada (segredo HMAC ausente). Provisione WORKSPACE_DELETION_HMAC_SECRET na API e no Agent.',
  );

/**
 * Segredo HMAC da confirmação de exclusão (FIX-WS-D2-R3 item 3). Explícito
 * nos testes; em runtime vem de `WORKSPACE_DELETION_HMAC_SECRET`. Ausente
 * = emissão/verificação indisponível (fail-closed, nunca conclui).
 */
export const resolveDeletionHmacSecret = (explicit?: string): string => {
  const secret = explicit ?? process.env.WORKSPACE_DELETION_HMAC_SECRET ?? '';
  if (!secret) {
    throw invalid('Inventário de exclusão indisponível: segredo HMAC não configurado.');
  }
  return secret;
};

/**
 * Versão canônica do inventário: HMAC-SHA256 com segredo server-side sobre
 * o JSON ordenado das contagens VINCULADO à expiração (FIX-WS-D2-R3 item
 * 3). O SHA-256 público anterior era recomputável pelo cliente: como as
 * contagens de um workspace vazio são trivialmente adivinháveis (zeros),
 * o atacante re-carimbava `expiresAt` E recomputava o hash, renovando a
 * validade offline indefinidamente. Com HMAC, a versão só é emitida pelo
 * servidor — qualquer `expiresAt` divergente do inventariado gera versão
 * divergente e recusa.
 */
export const hashInventoryCounts = (
  workspaceId: string,
  counts: DeletionInventoryCounts,
  expiresAt: string,
  secret: string,
): string => {
  const keys = Object.keys(counts).sort();
  const canonical = JSON.stringify({ workspaceId, counts: keys.map((k) => [k, counts[k]]), expiresAt });
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
};

export const buildDeleteConfirmation = (input: {
  workspaceId: string;
  actor: string;
  inventoryVersion: string;
  expiresAt: string;
  agentAttestation: AgentAttestation;
  agentProof?: AgentEmptyProof | undefined;
}): DeleteConfirmation => ({
  workspaceId: input.workspaceId,
  actor: input.actor,
  action: DELETION_CONFIRM_ACTION,
  inventoryVersion: input.inventoryVersion,
  expiresAt: input.expiresAt,
  agentAttestation: input.agentAttestation,
  ...(input.agentProof !== undefined ? { agentProof: input.agentProof } : {}),
});

export const deletionInventoryExpiry = (now = Date.now()): string =>
  new Date(now + DELETION_INVENTORY_TTL_MS).toISOString();

/** Expiração curta da prova do lado Agent (FIX-WS-D2-R4, 5 min). */
export const agentAttestationExpiry = (now = Date.now()): string =>
  new Date(now + AGENT_ATTESTATION_TTL_MS).toISOString();

/**
 * JSON canônico da prova do lado Agent (FIX-WS-D2-R4): HMAC-SHA256 com o
 * segredo compartilhado sobre workspace + versão do inventário +
 * contagens ordenadas + expiração. O MESMO canônico é implementado no
 * Agent (`apps/agent/src/workspace-deletion-attestation.ts`) — qualquer
 * divergência de formato quebra a verificação (fail-closed), nunca abre.
 */
export const agentEmptyProofCanonical = (
  workspaceId: string,
  inventoryVersion: string,
  counts: AgentEmptyCounts,
  expiresAt: string,
): string => {
  // Chaves ORDENADAS — igual ao Agent: o canônico é byte-idêntico nos
  // dois lados, ou a verificação quebra fail-closed. Não reordenar sem
  // mudar junto o Agent.
  const pairs = [...AGENT_EMPTY_COUNT_KEYS].sort().map((key) => [key, counts[key]]);
  return JSON.stringify({ workspaceId, inventoryVersion, counts: pairs, expiresAt });
};

const signAgentEmptyProofCanonical = (canonical: string, secret: string): string =>
  createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');

/**
 * Emissão da prova de vazio (lado Agent; espelhada aqui para testes
 * white-box). Fail-closed na origem: qualquer contagem não-zero recusa
 * assinar (nunca assina vazio falso). Sem segredo = indisponível.
 */
export const signAgentEmptyProof = (
  input: { workspaceId: string; inventoryVersion: string; counts: AgentEmptyCounts },
  secret: string | undefined,
  now = Date.now(),
): AgentEmptyProof => {
  const resolved = (secret ?? process.env.WORKSPACE_DELETION_HMAC_SECRET ?? '').trim();
  if (!resolved) throw agentAttestationUnavailable();
  for (const key of AGENT_EMPTY_COUNT_KEYS) {
    const value = input.counts[key];
    if (!Number.isInteger(value) || value < 0) throw agentUnverified();
    if (value !== 0) {
      throw new WorkspaceError(
        'workspace.agent_unverified',
        409,
        `Atestação recusada: o lado Agent não está vazio (${key}=${value}).`,
      );
    }
  }
  const expiresAt = agentAttestationExpiry(now);
  const canonical = agentEmptyProofCanonical(input.workspaceId, input.inventoryVersion, input.counts, expiresAt);
  return {
    workspaceId: input.workspaceId,
    inventoryVersion: input.inventoryVersion,
    counts: { ...input.counts },
    expiresAt,
    hmac: signAgentEmptyProofCanonical(canonical, resolved),
  };
};

/**
 * Verificação pura da prova do lado Agent (FIX-WS-D2-R4). Vínculo
 * (workspace/versão) divergente → `confirmation_invalid`; prova
 * intrínseca inválida (segredo ausente, expiração, contagem não-zero,
 * HMAC divergente) → `agent_unverified`. Não toca no banco.
 */
export const verifyAgentEmptyProof = (
  proof: AgentEmptyProof,
  expected: { workspaceId: string; inventoryVersion: string; secret: string | undefined },
  now = Date.now(),
): void => {
  if (
    !proof ||
    typeof proof !== 'object' ||
    proof.workspaceId !== expected.workspaceId ||
    proof.inventoryVersion !== expected.inventoryVersion
  ) {
    throw invalid('Atestação do lado Agent divergente do workspace/inventário.');
  }
  const resolved = (expected.secret ?? process.env.WORKSPACE_DELETION_HMAC_SECRET ?? '').trim();
  if (!resolved) throw agentAttestationUnavailable();
  const expiresAt = Date.parse(proof.expiresAt);
  if (!Number.isFinite(expiresAt)) throw agentUnverified();
  if (expiresAt <= now) {
    throw new WorkspaceError('workspace.agent_unverified', 409, 'Atestação do lado Agent expirada.');
  }
  if (expiresAt > now + AGENT_ATTESTATION_TTL_MS + CONFIRMATION_CLOCK_SKEW_MS) {
    throw new WorkspaceError('workspace.agent_unverified', 409, 'Atestação do lado Agent com expiração além da janela permitida.');
  }
  for (const key of AGENT_EMPTY_COUNT_KEYS) {
    const value = proof.counts?.[key];
    if (!Number.isInteger(value) || (value as number) < 0) throw agentUnverified();
    if (value !== 0) {
      throw new WorkspaceError(
        'workspace.agent_unverified',
        409,
        `Atestação recusada: o lado Agent não está vazio (${key}=${value}).`,
      );
    }
  }
  if (typeof proof.hmac !== 'string' || !/^[0-9a-f]{64}$/.test(proof.hmac)) throw agentUnverified();
  const canonical = agentEmptyProofCanonical(proof.workspaceId, proof.inventoryVersion, proof.counts, proof.expiresAt);
  const expectedHmac = signAgentEmptyProofCanonical(canonical, resolved);
  const a = Buffer.from(proof.hmac, 'utf8');
  const b = Buffer.from(expectedHmac, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw agentUnverified();
};

/**
 * Validação pura da confirmação forte: vínculo (UUID/ator/ação/versão)
 * + prova HMAC do lado Agent + expiração com TTL limitado server-side.
 * Não toca no banco. A string `agentAttestation` do fio é IGNORADA como
 * prova (qualquer valor declarado pelo cliente é indistinguível de
 * falsificação): só `agentProof` válida conclui — ausente/inválida =
 * `workspace.agent_unverified` antes de qualquer efeito (fail-closed).
 * A expiração é IMUTÁVEL por vínculo: o chamador (deleteEmpty)
 * recomputa a versão sobre as contagens vivas E o `expiresAt`
 * apresentado — `expiresAt` adulterado gera versão divergente (ver
 * `verifyInventoryBinding`).
 */
export const verifyDeleteConfirmation = (
  confirmation: DeleteConfirmation,
  expected: { workspaceId: string; actor: string; inventoryVersion: string; agentProofSecret?: string | undefined },
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
  // Barreira cross-store (FIX-WS-D2-R4): só prova HMAC emitida
  // server-side pelo Agent e verificada com o segredo compartilhado
  // conclui. Sem prova válida, bloqueia aqui (fail-closed).
  if (!confirmation.agentProof) throw agentUnverified();
  verifyAgentEmptyProof(
    confirmation.agentProof,
    {
      workspaceId: expected.workspaceId,
      inventoryVersion: expected.inventoryVersion,
      secret: expected.agentProofSecret,
    },
    now,
  );
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
  secret: string,
): string => hashInventoryCounts(workspaceId, liveCounts, presentedExpiresAt, secret);

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

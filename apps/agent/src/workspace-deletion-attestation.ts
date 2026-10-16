/**
 * FIX-WS-D2-R4 — emissor server-side da atestação de vazio (lado Agent).
 *
 * O Agent observa seu próprio SQLite (`agent_sessions`, mensagens do DO,
 * `agent_memory` viva) e o R2; workspace vazio → prova HMAC-SHA256
 * assinada com o segredo compartilhado `WORKSPACE_DELETION_HMAC_SECRET`;
 * não-vazio → erro `agent.workspace_not_empty` com as contagens (SEM
 * assinar vazio falso); sem segredo → `agent.attestation_unavailable`
 * (409, fail-closed).
 *
 * O canônico assinado é BYTE-IDÊNTICO ao da API
 * (`apps/api/src/auth/workspace-deletion.ts::agentEmptyProofCanonical`):
 * qualquer divergência de formato quebra a verificação (fail-closed),
 * nunca abre. HMAC via WebCrypto (`crypto.subtle`) — runtime-safe em
 * Workers e Node.
 */

export const AGENT_ATTESTATION_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export const AGENT_EMPTY_COUNT_KEYS = ['sessions', 'messages', 'memories', 'attachments'] as const;

export type AgentEmptyCounts = {
  sessions: number;
  messages: number;
  memories: number;
  attachments: number;
};

export type AgentEmptyProof = {
  workspaceId: string;
  inventoryVersion: string;
  counts: AgentEmptyCounts;
  expiresAt: string;
  hmac: string;
};

export type MemorySqlLike = {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
};

export type AttachmentInventory = {
  count: number;
  truncated: boolean;
};

export type AttestationDeps = {
  sql: MemorySqlLike | null;
  countChatMessages: (workspaceId: string) => number | Promise<number>;
  countAttachments: (workspaceId: string) => AttachmentInventory | Promise<AttachmentInventory>;
};

export class AgentAttestationError extends Error {
  constructor(
    readonly code: 'agent.workspace_not_empty' | 'agent.attestation_unavailable' | 'agent.invalid_attestation_request',
    message: string,
    readonly status: number,
    readonly counts?: AgentEmptyCounts & { truncated?: boolean },
  ) {
    super(message);
    this.name = 'AgentAttestationError';
  }
}

const nowIso = (): string => new Date().toISOString();

/**
 * Canônico BYTE-IDÊNTICO ao da API: JSON com workspace + versão do
 * inventário + pares de contagem ordenados + expiração. Não mudar o
 * formato sem mudar junto a API (quebra fail-closed).
 */
export const agentEmptyProofCanonical = (
  workspaceId: string,
  inventoryVersion: string,
  counts: AgentEmptyCounts,
  expiresAt: string,
): string => {
  // Chaves ORDENADAS — igual à API (`Object.keys(counts).sort()`): o
  // canônico é byte-idêntico nos dois lados, ou a verificação quebra
  // fail-closed. Não reordenar sem mudar junto a API.
  const pairs = [...AGENT_EMPTY_COUNT_KEYS].sort().map((key) => [key, counts[key]]);
  return JSON.stringify({ workspaceId, inventoryVersion, counts: pairs, expiresAt });
};

const hmacHex = async (secret: string, canonical: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const resolveSecret = (explicit: string | undefined): string => {
  const secret = (explicit ?? '').trim();
  if (!secret) {
    throw new AgentAttestationError(
      'agent.attestation_unavailable',
      'Atestação indisponível: segredo HMAC não configurado no Agent.',
      409,
    );
  }
  return secret;
};

const zeroCounts = (): AgentEmptyCounts => ({ sessions: 0, messages: 0, memories: 0, attachments: 0 });

const countRows = (sql: MemorySqlLike, query: string, ...bindings: unknown[]): number => {
  const rows = [...sql.exec<{ c: unknown }>(query, ...bindings)];
  const value = rows[0]?.c;
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

/**
 * Inventário do lado Agent por workspace (fail-closed): qualquer falha de
 * observação (SQLite ausente, tabela ilegível) recusa como indisponível
 * em vez de relatar vazio falso.
 */
export const countWorkspaceRemnants = async (
  input: { workspaceId: string } & AttestationDeps,
): Promise<AgentEmptyCounts> => {
  if (!input.sql) {
    throw new AgentAttestationError(
      'agent.attestation_unavailable',
      'Atestação indisponível: armazenamento do Agent inacessível.',
      409,
    );
  }
  const { sql, workspaceId } = input;
  let sessions: number;
  let memories: number;
  try {
    sessions = countRows(sql, `SELECT COUNT(*) AS c FROM agent_sessions WHERE workspace_id = ?`, workspaceId);
    memories = countRows(
      sql,
      `SELECT COUNT(*) AS c FROM agent_memory WHERE workspace_id = ? AND invalidated_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      workspaceId,
      nowIso(),
    );
  } catch {
    throw new AgentAttestationError(
      'agent.attestation_unavailable',
      'Atestação indisponível: inventário do Agent ilegível.',
      409,
    );
  }
  let messages: number;
  try {
    const counted = await input.countChatMessages(workspaceId);
    if (!Number.isInteger(counted) || counted < 0) throw new Error('invalid chat message count');
    messages = counted;
  } catch (error) {
    if (error instanceof AgentAttestationError) throw error;
    throw new AgentAttestationError(
      'agent.attestation_unavailable',
      'Atestação indisponível: histórico de conversas ilegível.',
      409,
    );
  }
  let attachments: AttachmentInventory;
  try {
    attachments = await input.countAttachments(workspaceId);
    if (!Number.isInteger(attachments.count) || attachments.count < 0) throw new Error('invalid attachment count');
  } catch (error) {
    if (error instanceof AgentAttestationError) throw error;
    throw new AgentAttestationError(
      'agent.attestation_unavailable',
      'Atestação indisponível: inventário de anexos ilegível.',
      409,
    );
  }
  // Listagem truncada = cobertura parcial: trata como não-vazio
  // (fail-closed) em vez de atestar sobre inventário incompleto.
  if (attachments.truncated && attachments.count === 0) {
    throw new AgentAttestationError(
      'agent.workspace_not_empty',
      'Exclusão bloqueada: inventário de anexos incompleto (listagem truncada).',
      409,
      { ...zeroCounts(), truncated: true },
    );
  }
  return { sessions, messages, memories, attachments: attachments.count };
};

const isEmpty = (counts: AgentEmptyCounts): boolean =>
  AGENT_EMPTY_COUNT_KEYS.every((key) => counts[key] === 0);

/**
 * Emite a prova de vazio (workspace vazio) ou recusa com as contagens
 * (não-vazio). Nunca assina vazio falso; sem segredo, indisponível.
 */
export const attestWorkspaceEmpty = async (
  input: { workspaceId: string; inventoryVersion: string; deps: AttestationDeps; secret: string | undefined },
  now = Date.now(),
): Promise<AgentEmptyProof> => {
  if (!input.workspaceId || !/^[0-9a-f]{64}$/.test(input.inventoryVersion)) {
    throw new AgentAttestationError('agent.invalid_attestation_request', 'Pedido de atestação inválido.', 400);
  }
  const secret = resolveSecret(input.secret);
  const counts = await countWorkspaceRemnants({ workspaceId: input.workspaceId, ...input.deps });
  if (!isEmpty(counts)) {
    throw new AgentAttestationError(
      'agent.workspace_not_empty',
      'Exclusão bloqueada: o lado Agent possui conteúdo neste workspace.',
      409,
      counts,
    );
  }
  const expiresAt = new Date(now + AGENT_ATTESTATION_TTL_MS).toISOString();
  const canonical = agentEmptyProofCanonical(input.workspaceId, input.inventoryVersion, counts, expiresAt);
  return {
    workspaceId: input.workspaceId,
    inventoryVersion: input.inventoryVersion,
    counts,
    expiresAt,
    hmac: await hmacHex(secret, canonical),
  };
};

export const agentAttestationClockSkewMs = (): number => CLOCK_SKEW_MS;

/** Superfície mínima de listagem R2 usada na contagem por workspace. */
export type R2ListBucketLike = {
  list: (options?: { prefix?: string; cursor?: string; include?: string[] }) => Promise<{
    objects: Array<{ key: string; customMetadata?: Record<string, string> }>;
    truncated?: boolean;
    cursor?: string;
  }>;
};

/** Prefixo da família de anexos no bucket (igual ao storage adapter). */
export const ATTACHMENT_R2_PREFIX = 'ted/attachments/v1/';

/** Teto de páginas por inventário R2 (igual ao sweep TTL: barato e retomável). */
export const ATTACHMENT_INVENTORY_MAX_PAGES = 10;

/**
 * Conta objetos R2 cujo metadata declara o workspace (fail-closed):
 * cobertura parcial (truncado no teto) reporta `truncated: true` para o
 * chamador tratar como não-vazio em vez de atestar sobre inventário
 * incompleto. Chaves são refs opacas — nenhum workspace vaza na chave.
 */
export const countR2WorkspaceAttachments = async (
  bucket: R2ListBucketLike | null | undefined,
  workspaceId: string,
): Promise<AttachmentInventory> => {
  if (!bucket || typeof bucket.list !== 'function') {
    throw new AgentAttestationError(
      'agent.attestation_unavailable',
      'Atestação indisponível: armazenamento de anexos inacessível.',
      409,
    );
  }
  let found = 0;
  let cursor: string | undefined;
  for (let page = 0; page < ATTACHMENT_INVENTORY_MAX_PAGES; page += 1) {
    let listed: { objects: Array<{ customMetadata?: Record<string, string> }>; truncated?: boolean; cursor?: string };
    try {
      listed = await bucket.list({
        prefix: ATTACHMENT_R2_PREFIX,
        include: ['customMetadata'],
        ...(cursor !== undefined ? { cursor } : {}),
      });
    } catch {
      throw new AgentAttestationError(
        'agent.attestation_unavailable',
        'Atestação indisponível: listagem de anexos falhou.',
        409,
      );
    }
    for (const object of listed.objects) {
      if (object.customMetadata?.['workspaceId'] === workspaceId) found += 1;
    }
    if (!listed.truncated || typeof listed.cursor !== 'string') return { count: found, truncated: false };
    cursor = listed.cursor;
  }
  return { count: found, truncated: true };
};

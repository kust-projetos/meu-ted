/**
 * ADR-027 D3 — visibilidade de conversas: coletivo-com-atribuição default,
 * privado opt-in por conversa, gated por flag server-side.
 *
 * - Flag `TED_PRIVATE_VIEWS_ENABLED`: default 0; SÓ o valor exato `'1'`
 *   habilita a criação de conversas privadas (sem trim, sem truthy).
 *   Flag off NUNCA converte conversas existentes (nem coletivo→privado,
 *   nem privado→coletivo): apenas bloqueia NOVAS privadas; as existentes
 *   permanecem como estão.
 * - Cada conversa carrega `visibility: 'workspace' | 'private'` +
 *   `owner_actor_id` + `conversation_id` (metadados aditivos, sem migração
 *   destrutiva).
 * - Predicado mínimo de acesso: membro ativo (identidade verificada pelo
 *   gateway — actor/workspace presentes) + mesmo workspace + visibilidade:
 *   `workspace` ⇒ visível; `private` ⇒ visível SOMENTE ao `owner_actor_id`.
 *   Owner do workspace NÃO tem acesso implícito a privadas que não criou.
 * - `actorId = 'ted'` (respostas do assistente) NUNCA é prova de público e
 *   NUNCA concede acesso: ids de sistema (`ted`, `assistant`, `unknown`,
 *   `system`, vazio) são recusados como solicitante E como dono.
 * - Legado sem audiência: COM proveniência (atribuição actor) ⇒ coletivo;
 *   SEM proveniência ⇒ preservado-não-publicado (invisível a todos).
 * - Renovação de sessão fecha/abre SEM apagar; trocar de modo cria NOVA
 *   conversa (sem mudar audiência retroativa).
 * - Resumos de conversa privada NUNCA viram memória compartilhada: resumos
 *   persistem SEMPRE com escopo de ator, nunca na camada shared (`actor=''`).
 */

export const PRIVATE_VIEWS_ENABLED_ENV = 'TED_PRIVATE_VIEWS_ENABLED';

export type ConversationVisibility = 'workspace' | 'private';

export type ConversationAudience = {
  workspaceId: string;
  visibility: ConversationVisibility;
  /** Ator dono da conversa (atribuição; obrigatório para `private`). */
  ownerActorId: string;
  conversationId: string;
};

export type LegacyAudienceClass = 'collective-with-provenance' | 'preserved-unpublished';

/** Ids de sistema que nunca provam publicidade nem concedem acesso. */
const SYSTEM_ACTOR_IDS: ReadonlySet<string> = new Set(['ted', 'assistant', 'unknown', 'system', '']);

export const isSystemActorId = (actorId: string | null | undefined): boolean => {
  if (typeof actorId !== 'string') return true;
  const trimmed = actorId.trim();
  if (trimmed.length === 0) return true;
  return SYSTEM_ACTOR_IDS.has(trimmed);
};

/** D3.2 — flag server-side, default 0; só o valor exato `'1'` habilita. */
export const isPrivateViewsEnabled = (env: { TED_PRIVATE_VIEWS_ENABLED?: string } | undefined): boolean =>
  env?.TED_PRIVATE_VIEWS_ENABLED === '1';

export const normalizeVisibility = (value: unknown): ConversationVisibility =>
  value === 'private' ? 'private' : 'workspace';

/**
 * D3.5 — predicado mínimo de acesso a uma conversa.
 * Membro ativo (actor real, não-sistema) + mesmo workspace + visibilidade.
 */
export const canAccessConversation = (input: {
  actorId: string;
  workspaceId: string;
  conversation: Pick<ConversationAudience, 'workspaceId' | 'visibility' | 'ownerActorId'>;
}): boolean => {
  if (isSystemActorId(input.actorId)) return false;
  if (!input.workspaceId || input.workspaceId !== input.conversation.workspaceId) return false;
  if (input.conversation.visibility === 'private') {
    const owner = input.conversation.ownerActorId;
    if (isSystemActorId(owner)) return false;
    return owner === input.actorId;
  }
  return true;
};

export type MessageAudienceMeta = {
  workspaceId?: unknown;
  visibility?: unknown;
  /** Dono da conversa (novo); `actorId` do metadata é a atribuição legada. */
  ownerActorId?: unknown;
  actorId?: unknown;
};

/**
 * D3.6/D3.8 — predicado por mensagem (leitura, detalhe, busca, WS, export,
 * anexos, resumos, caches, contexto LLM).
 * - Com audiência explícita: aplica o predicado da conversa.
 * - Legado COM proveniência (actor atribuído) ⇒ coletivo.
 * - Legado SEM proveniência ⇒ preservado-não-publicado (nega a todos,
 *   inclusive ao solicitante — nunca "ressuscita" como público).
 */
export const canAccessMessage = (input: {
  actorId: string;
  workspaceId: string;
  meta: MessageAudienceMeta | null | undefined;
}): boolean => {
  if (isSystemActorId(input.actorId)) return false;
  const meta = input.meta ?? {};
  const msgWorkspace = typeof meta.workspaceId === 'string' ? meta.workspaceId : undefined;
  // Isolamento por workspace (defesa em profundidade: o DO já é por workspace).
  if (msgWorkspace && msgWorkspace !== input.workspaceId) return false;
  const visibility = typeof meta.visibility === 'string' ? normalizeVisibility(meta.visibility) : null;
  if (visibility) {
    const owner =
      typeof meta.ownerActorId === 'string' && meta.ownerActorId
        ? meta.ownerActorId
        : typeof meta.actorId === 'string'
          ? meta.actorId
          : '';
    return canAccessConversation({
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      conversation: {
        workspaceId: input.workspaceId,
        visibility,
        ownerActorId: owner,
      },
    });
  }
  // Legado sem audiência explícita: proveniência = atribuição presente.
  const attributed = typeof meta.actorId === 'string' && meta.actorId.trim().length > 0;
  if (!attributed) return false;
  return true;
};

/** D3.8 — classifica legado sem audiência para export/migração. */
export const classifyLegacyAudience = (input: {
  actorId?: unknown;
  ownerActorId?: unknown;
  visibility?: unknown;
}): LegacyAudienceClass => {
  if (typeof input.visibility === 'string' && (input.visibility === 'workspace' || input.visibility === 'private')) {
    return 'collective-with-provenance';
  }
  const attributed =
    (typeof input.actorId === 'string' && input.actorId.trim().length > 0) ||
    (typeof input.ownerActorId === 'string' && input.ownerActorId.trim().length > 0);
  return attributed ? 'collective-with-provenance' : 'preserved-unpublished';
};

export type CreationVisibilityRequest = {
  requested?: unknown;
  privateViewsEnabled: boolean;
};

/**
 * D3.2/D3.3 — resolve a visibilidade de UMA NOVA conversa.
 * Privado exige flag on; flag off NUNCA converte (só recusa o pedido com
 * erro tipado — a conversa segue coletiva, nada é reescrito).
 */
export const resolveCreationVisibility = (
  input: CreationVisibilityRequest,
): { ok: true; visibility: ConversationVisibility } | { ok: false; code: string } => {
  if (input.requested === 'private') {
    if (!input.privateViewsEnabled) {
      return { ok: false, code: 'agent.private_views_disabled' };
    }
    return { ok: true, visibility: 'private' };
  }
  return { ok: true, visibility: 'workspace' };
};

/** Audiência default de conversa nova: coletivo-com-atribuição. */
export const defaultCollectiveAudience = (input: {
  workspaceId: string;
  ownerActorId: string;
  conversationId: string;
}): ConversationAudience => ({
  workspaceId: input.workspaceId,
  visibility: 'workspace',
  ownerActorId: input.ownerActorId,
  conversationId: input.conversationId,
});

export type MessageAudienceStamp = {
  visibility: ConversationVisibility;
  ownerActorId: string;
  conversationId: string;
};

/**
 * D3.6 — carimbo de audiência para `metadata` de mensagens persistidas
 * (SDK + REST, user + assistant). Respostas `ted` em conversa privada
 * carregam a audiência da conversa (owner = ator dono), NUNCA `ted` como
 * prova de público.
 */
export const stampMessageAudience = (
  metadata: Record<string, unknown>,
  audience: MessageAudienceStamp,
): Record<string, unknown> => ({
  ...metadata,
  visibility: audience.visibility,
  ownerActorId: audience.ownerActorId,
  conversationId: audience.conversationId,
});

export type ConversationSummaryStore = {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
};

/**
 * D3.7 — resumos de conversa NUNCA viram memória compartilhada: persistem
 * SEMPRE com escopo de ator (`actor = <dono>`), nunca na camada shared
 * (`actor=''`). Vale para conversa coletiva E privada — resumo é audiência
 * do turno que o gerou, não broadcast do workspace.
 */
export const persistConversationSummary = async (
  remember: (input: {
    workspaceId: string;
    actor: string;
    kind: 'summary';
    content: string;
    salience: number;
  }) => unknown,
  input: { workspaceId: string; actorId: string; summary: string; salience?: number },
): Promise<void> => {
  if (isSystemActorId(input.actorId)) return;
  const content = input.summary.trim();
  if (!content) return;
  await remember({
    workspaceId: input.workspaceId,
    actor: input.actorId,
    kind: 'summary',
    content,
    salience: input.salience ?? 0.7,
  });
};

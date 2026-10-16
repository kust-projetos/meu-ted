/**
 * WS-FATIA3 (D3) RED: predicado de visibilidade de conversas.
 * - flag default 0, só exato '1' habilita;
 * - coletivo visível a membro; privado só ao dono (owner do workspace sem
 *   acesso implícito);
 * - 'ted'/sistema nunca prova público nem concede acesso;
 * - legado com proveniência = coletivo; sem = preservado-não-publicado;
 * - flag off bloqueia criação privada sem converter.
 */
import { describe, expect, it } from 'vitest';
import {
  canAccessConversation,
  canAccessMessage,
  classifyLegacyAudience,
  defaultCollectiveAudience,
  isPrivateViewsEnabled,
  isSystemActorId,
  normalizeVisibility,
  resolveCreationVisibility,
} from '../src/privacy/conversation-visibility.js';

describe('D3 — flag TED_PRIVATE_VIEWS_ENABLED', () => {
  it('default off: ausente/vazio/outro valor nega', () => {
    expect(isPrivateViewsEnabled(undefined)).toBe(false);
    expect(isPrivateViewsEnabled({})).toBe(false);
    expect(isPrivateViewsEnabled({ TED_PRIVATE_VIEWS_ENABLED: '0' })).toBe(false);
    expect(isPrivateViewsEnabled({ TED_PRIVATE_VIEWS_ENABLED: '' })).toBe(false);
    expect(isPrivateViewsEnabled({ TED_PRIVATE_VIEWS_ENABLED: 'true' })).toBe(false);
    expect(isPrivateViewsEnabled({ TED_PRIVATE_VIEWS_ENABLED: ' 1' })).toBe(false);
    expect(isPrivateViewsEnabled({ TED_PRIVATE_VIEWS_ENABLED: '1 ' })).toBe(false);
  });

  it("só o valor exato '1' habilita", () => {
    expect(isPrivateViewsEnabled({ TED_PRIVATE_VIEWS_ENABLED: '1' })).toBe(true);
  });
});

describe('D3 — ids de sistema nunca provam nada', () => {
  it.each(['ted', 'assistant', 'unknown', 'system', '', '   '])('"%s" é sistema', (id) => {
    expect(isSystemActorId(id)).toBe(true);
  });

  it('ator real não é sistema', () => {
    expect(isSystemActorId('actor-A')).toBe(false);
  });
});

describe('D3 — predicado de conversa', () => {
  const collective = { workspaceId: 'ws-1', visibility: 'workspace' as const, ownerActorId: 'actor-A' };
  const priv = { workspaceId: 'ws-1', visibility: 'private' as const, ownerActorId: 'actor-A' };

  it('coletivo visível a outro membro do workspace', () => {
    expect(canAccessConversation({ actorId: 'actor-B', workspaceId: 'ws-1', conversation: collective })).toBe(true);
  });

  it('privado invisível a outro ator', () => {
    expect(canAccessConversation({ actorId: 'actor-B', workspaceId: 'ws-1', conversation: priv })).toBe(false);
  });

  it('privado invisível ao owner do workspace que não é o dono', () => {
    expect(canAccessConversation({ actorId: 'workspace-owner', workspaceId: 'ws-1', conversation: priv })).toBe(false);
  });

  it('privado visível ao dono', () => {
    expect(canAccessConversation({ actorId: 'actor-A', workspaceId: 'ws-1', conversation: priv })).toBe(true);
  });

  it("'ted' como solicitante nunca acessa", () => {
    expect(canAccessConversation({ actorId: 'ted', workspaceId: 'ws-1', conversation: collective })).toBe(false);
    expect(canAccessConversation({ actorId: 'ted', workspaceId: 'ws-1', conversation: priv })).toBe(false);
  });

  it("'ted' como dono nunca concede (privado sem dono real = invisível)", () => {
    const tedOwned = { workspaceId: 'ws-1', visibility: 'private' as const, ownerActorId: 'ted' };
    expect(canAccessConversation({ actorId: 'actor-A', workspaceId: 'ws-1', conversation: tedOwned })).toBe(false);
  });

  it('workspace distinto nega', () => {
    expect(canAccessConversation({ actorId: 'actor-A', workspaceId: 'ws-2', conversation: collective })).toBe(false);
    expect(canAccessConversation({ actorId: 'actor-A', workspaceId: 'ws-2', conversation: priv })).toBe(false);
  });
});

describe('D3 — predicado por mensagem', () => {
  it('coletivo explícito visível a membro', () => {
    expect(
      canAccessMessage({ actorId: 'actor-B', workspaceId: 'ws-1', meta: { workspaceId: 'ws-1', visibility: 'workspace', actorId: 'actor-A' } }),
    ).toBe(true);
  });

  it('privado explícito só ao dono; resposta ted da conversa privada não abre acesso', () => {
    const meta = { workspaceId: 'ws-1', visibility: 'private', ownerActorId: 'actor-A', actorId: 'ted' };
    expect(canAccessMessage({ actorId: 'actor-A', workspaceId: 'ws-1', meta })).toBe(true);
    expect(canAccessMessage({ actorId: 'actor-B', workspaceId: 'ws-1', meta })).toBe(false);
  });

  it('legado com proveniência = coletivo', () => {
    expect(
      canAccessMessage({ actorId: 'actor-B', workspaceId: 'ws-1', meta: { workspaceId: 'ws-1', actorId: 'actor-A' } }),
    ).toBe(true);
  });

  it('legado sem proveniência = preservado-não-publicado (nega a todos)', () => {
    expect(canAccessMessage({ actorId: 'actor-A', workspaceId: 'ws-1', meta: {} })).toBe(false);
    expect(canAccessMessage({ actorId: 'actor-A', workspaceId: 'ws-1', meta: null })).toBe(false);
    expect(canAccessMessage({ actorId: 'actor-A', workspaceId: 'ws-1', meta: { workspaceId: 'ws-1' } })).toBe(false);
  });
});

describe('D3 — legado e criação', () => {
  it('classifica legado: com atribuição = coletivo; sem = preservado', () => {
    expect(classifyLegacyAudience({ actorId: 'actor-A' })).toBe('collective-with-provenance');
    expect(classifyLegacyAudience({})).toBe('preserved-unpublished');
    expect(classifyLegacyAudience({ actorId: '' })).toBe('preserved-unpublished');
  });

  it('criação: privado exige flag; off recusa sem converter', () => {
    expect(resolveCreationVisibility({ requested: 'private', privateViewsEnabled: false })).toEqual({
      ok: false,
      code: 'agent.private_views_disabled',
    });
    expect(resolveCreationVisibility({ requested: 'private', privateViewsEnabled: true })).toEqual({
      ok: true,
      visibility: 'private',
    });
    expect(resolveCreationVisibility({ requested: undefined, privateViewsEnabled: false })).toEqual({
      ok: true,
      visibility: 'workspace',
    });
    expect(resolveCreationVisibility({ requested: 'workspace', privateViewsEnabled: false })).toEqual({
      ok: true,
      visibility: 'workspace',
    });
  });

  it('default de conversa nova é coletivo-com-atribuição', () => {
    expect(defaultCollectiveAudience({ workspaceId: 'ws-1', ownerActorId: 'actor-A', conversationId: 'c-1' })).toEqual({
      workspaceId: 'ws-1',
      visibility: 'workspace',
      ownerActorId: 'actor-A',
      conversationId: 'c-1',
    });
    expect(normalizeVisibility('banana')).toBe('workspace');
  });
});

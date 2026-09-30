import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FinanceChatAgent,
  ensureIntentionSnapshotColumns,
  resolveBareModelName,
  type IntentionSnapshotRow,
} from '../src/finance-chat-agent.js';

type SqlCall = { query: string; bindings: unknown[] };

const makeSql = (opts: { pragmaColumns: string[]; selectRows: unknown[] }) => {
  const calls: SqlCall[] = [];
  const exec = <T>(query: string, ...bindings: unknown[]): Iterable<T> => {
    calls.push({ query, bindings });
    if (query.startsWith('PRAGMA')) {
      return opts.pragmaColumns.map((name) => ({ name })) as unknown as Iterable<T>;
    }
    if (query.startsWith('SELECT')) {
      return opts.selectRows as unknown as Iterable<T>;
    }
    return [] as unknown as Iterable<T>;
  };
  return { exec, calls };
};

const makeAgent = (sql: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> }) => {
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
  Object.defineProperty(agent, 'ctx', { value: { storage: { sql } }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', {
    value: { API_ORIGIN: 'https://api.test.local', AGENT_CONFIG_TOKEN: 'config-test-token' },
    writable: true,
    configurable: true,
  });
  return agent;
};

const callResolve = (agent: FinanceChatAgent, intentionId: string) =>
  (
    agent as unknown as {
      resolveIntentionSnapshot(id: string): Promise<IntentionSnapshotRow | null>;
    }
  ).resolveIntentionSnapshot(intentionId);

const snapshotResponse = (fallbackProviderId: string | null, fallbackModelId: string | null) =>
  new Response(
    JSON.stringify({
      runtime: {
        singleton: 'active',
        version: 2,
        securityEpoch: 1,
        activeProviderId: 'openai-api',
        activeModelId: 'openai-api:gpt-4o',
        activeProtocol: 'chat-completions',
        activeRolloutPercentage: 100,
        activeRolloutMode: 'all',
        canaryAllowlist: [],
        fallbackProviderId,
        fallbackModelId,
        updatedBy: 'admin@test.com',
      },
      activeProvider: {
        id: 'openai-api',
        kind: 'openai-api',
        transport: 'direct',
        authMode: 'api-key',
        secretAlias: 'OPENAI_API_KEY',
        serviceAlias: null,
        eligibility: 'approved',
      },
      activeModel: {
        id: 'openai-api:gpt-4o',
        modelId: 'gpt-4o',
        protocol: 'chat-completions',
        privacyClass: 'training_prohibited',
      },
      fallbackProvider: null,
      fallbackModel: null,
      activeDisabled: false,
      fallbackDisabled: false,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('Intention snapshot fallback persistence (Fase 1b F3 RED)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('migrates a legacy table by adding only the missing columns (fallback + model names)', () => {
    const { exec, calls } = makeSql({
      pragmaColumns: [
        'intention_id',
        'version',
        'provider_id',
        'model_id',
        'protocol',
        'rollout_percentage',
        'security_epoch',
        'fallback_provider_id',
        'created_at',
      ],
      selectRows: [],
    });
    ensureIntentionSnapshotColumns({ exec });
    const alters = calls.filter((c) => c.query.startsWith('ALTER TABLE'));
    expect(alters).toHaveLength(3);
    expect(alters[0]?.query).toContain('fallback_model_id');
    expect(alters.map((a) => a.query)).toEqual([
      expect.stringContaining('fallback_model_id'),
      expect.stringContaining('model_name'),
      expect.stringContaining('fallback_model_name'),
    ]);
  });

  it('issues no ALTER when fallback and model-name columns already exist', () => {
    const { exec, calls } = makeSql({
      pragmaColumns: [
        'intention_id',
        'fallback_provider_id',
        'fallback_model_id',
        'model_name',
        'fallback_model_name',
      ],
      selectRows: [],
    });
    ensureIntentionSnapshotColumns({ exec });
    expect(calls.filter((c) => c.query.startsWith('ALTER TABLE'))).toHaveLength(0);
  });

  it('persists fallback ids in the INSERT on first resolution', async () => {
    const { exec, calls } = makeSql({ pragmaColumns: [], selectRows: [] });
    // stubGlobal (not spyOn): hermetic even if another file leaked a fetch mock.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(snapshotResponse('opencode-zen', 'opencode-zen:zen-1')));
    const snapshot = await callResolve(makeAgent({ exec }), 'intent-fb-1');
    expect(snapshot?.fallback_provider_id).toBe('opencode-zen');
    expect(snapshot?.fallback_model_id).toBe('opencode-zen:zen-1');
    const insert = calls.find((c) => c.query.startsWith('INSERT INTO intention_snapshots'));
    expect(insert).toBeDefined();
    expect(insert?.query).toContain('fallback_provider_id');
    expect(insert?.query).toContain('fallback_model_id');
    expect(insert?.bindings).toContain('opencode-zen');
    expect(insert?.bindings).toContain('opencode-zen:zen-1');
  });

  it('recovers fallback ids from a stored row on later resolutions', async () => {
    const stored = {
      intention_id: 'intent-fb-1',
      version: 2,
      provider_id: 'openai-api',
      model_id: 'openai-api:gpt-4o',
      protocol: 'chat-completions',
      rollout_percentage: 100,
      security_epoch: 1,
      fallback_provider_id: 'opencode-zen',
      fallback_model_id: 'opencode-zen:zen-1',
      created_at: '2026-09-05T00:00:00.000Z',
    };
    const { exec } = makeSql({ pragmaColumns: [], selectRows: [stored] });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const snapshot = await callResolve(makeAgent({ exec }), 'intent-fb-1');
    expect(snapshot?.fallback_provider_id).toBe('opencode-zen');
    expect(snapshot?.fallback_model_id).toBe('opencode-zen:zen-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a legacy row without fallback keys to nulls instead of crashing', async () => {
    const legacy = {
      intention_id: 'intent-legacy',
      version: 1,
      provider_id: 'openai-api',
      model_id: 'openai-api:gpt-4o',
      protocol: 'chat-completions',
      rollout_percentage: 100,
      security_epoch: 1,
      created_at: '2026-09-05T00:00:00.000Z',
    };
    const { exec } = makeSql({ pragmaColumns: [], selectRows: [legacy] });
    const snapshot = await callResolve(makeAgent({ exec }), 'intent-legacy');
    expect(snapshot?.fallback_provider_id).toBeNull();
    expect(snapshot?.fallback_model_id).toBeNull();
    expect(snapshot?.model_name).toBeNull();
    expect(snapshot?.fallback_model_name).toBeNull();
  });

  it('adds the model_name columns to a legacy table (Fase 3 item 5)', () => {
    const { exec, calls } = makeSql({
      pragmaColumns: [
        'intention_id',
        'version',
        'provider_id',
        'model_id',
        'protocol',
        'rollout_percentage',
        'security_epoch',
        'fallback_provider_id',
        'fallback_model_id',
        'created_at',
      ],
      selectRows: [],
    });
    ensureIntentionSnapshotColumns({ exec });
    const alters = calls.filter((c) => c.query.startsWith('ALTER TABLE'));
    expect(alters.map((a) => a.query)).toEqual([
      expect.stringContaining('model_name'),
      expect.stringContaining('fallback_model_name'),
    ]);
  });

  it('persists the bare upstream model_name from the validated slot (Fase 3 item 5)', async () => {
    const { exec, calls } = makeSql({ pragmaColumns: [], selectRows: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(snapshotResponse(null, null)));
    const snapshot = await callResolve(makeAgent({ exec }), 'intent-name-1');
    expect(snapshot?.model_id).toBe('openai-api:gpt-4o');
    expect(snapshot?.model_name).toBe('gpt-4o');
    const insert = calls.find((c) => c.query.startsWith('INSERT INTO intention_snapshots'));
    expect(insert?.query).toContain('model_name');
    expect(insert?.bindings).toContain('gpt-4o');
  });

  it('resolveBareModelName prefers the stored name, derives the convention, else null', () => {
    expect(resolveBareModelName('openai-api', 'openai-api:gpt-4o', 'gpt-4o')).toBe('gpt-4o');
    expect(resolveBareModelName('openai-api', 'openai-api:gpt-4o', null)).toBe('gpt-4o');
    expect(resolveBareModelName('openai-api', 'openai-api:gpt-4o', undefined)).toBe('gpt-4o');
    // Opaque row ids without a stored name are unresolvable (fail-closed).
    expect(resolveBareModelName('openai-api', 'custom-row-id', null)).toBeNull();
    expect(resolveBareModelName('openai-api', 'other:x', null)).toBeNull();
    expect(resolveBareModelName('openai-api', 'gpt-4o', null)).toBeNull();
    expect(resolveBareModelName('openai-api', 'openai-api:', null)).toBeNull();
  });

  it('a corrupted stored row is discarded and forces a remote refetch (Fase 3-FIX R2)', async () => {
    const corrupted = {
      intention_id: 'intent-bad',
      version: 'not-a-number',
      provider_id: 'openai-api',
      model_id: 123,
      protocol: 'carrier-pigeon',
      created_at: '2026-09-06T00:00:00.000Z',
    };
    const { exec, calls } = makeSql({ pragmaColumns: [], selectRows: [corrupted] });
    const fetchSpy = vi.fn().mockResolvedValueOnce(snapshotResponse(null, null));
    vi.stubGlobal('fetch', fetchSpy);
    const snapshot = await callResolve(makeAgent({ exec }), 'intent-bad');
    // Remotely validated snapshot wins; the corrupted row is never returned.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(snapshot?.model_id).toBe('openai-api:gpt-4o');
    expect(snapshot?.model_name).toBe('gpt-4o');
    const insert = calls.find((c) => c.query.startsWith('INSERT INTO intention_snapshots'));
    expect(insert?.bindings).toContain('gpt-4o');
  });

  it('an opaque row id without a name triggers a refetch; remote failure stays fail-closed (Fase 3-FIX R2)', async () => {
    const opaque = {
      intention_id: 'intent-opaque',
      version: 2,
      provider_id: 'openai-api',
      model_id: 'opaque-xyz',
      protocol: 'chat-completions',
      rollout_percentage: 100,
      security_epoch: 1,
      created_at: '2026-09-06T00:00:00.000Z',
    };
    const { exec } = makeSql({ pragmaColumns: [], selectRows: [opaque] });
    const fetchSpy = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchSpy);
    const snapshot = await callResolve(makeAgent({ exec }), 'intent-opaque');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(snapshot).toBeNull();
  });

  it('backfills derivable model_name values with UPDATE, leaving opaque NULLs (Fase 3-FIX R2)', async () => {
    const { exec, calls } = makeSql({ pragmaColumns: [], selectRows: [] });
    ensureIntentionSnapshotColumns({ exec });
    const updates = calls.filter((c) => c.query.startsWith('UPDATE intention_snapshots SET'));
    expect(updates).toHaveLength(2);
    const names = updates.map((u) => u.query);
    expect(names[0]).toContain('SET model_name = SUBSTR(model_id, LENGTH(provider_id) + 2)');
    expect(names[0]).toContain("WHERE model_name IS NULL AND model_id LIKE provider_id || ':%'");
    expect(names[1]).toContain('SET fallback_model_name = SUBSTR(fallback_model_id');
    expect(names[1]).toContain('WHERE fallback_model_name IS NULL');
  });

  it('a fresh stored row with a name is returned without refetch (Fase 3-FIX R2)', async () => {
    const stored = {
      intention_id: 'intent-fresh',
      version: 2,
      provider_id: 'openai-api',
      model_id: 'openai-api:gpt-4o',
      protocol: 'chat-completions',
      rollout_percentage: 100,
      security_epoch: 1,
      model_name: 'gpt-4o',
      created_at: '2026-09-06T00:00:00.000Z',
    };
    const { exec } = makeSql({ pragmaColumns: [], selectRows: [stored] });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const snapshot = await callResolve(makeAgent({ exec }), 'intent-fresh');
    expect(snapshot?.model_name).toBe('gpt-4o');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

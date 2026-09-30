import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import {
  scrubForPersistence,
  containsCardPan,
  containsSensitiveDocument,
  scrubAttachments,
} from '../src/privacy/dlp.js';
import { initializeMemorySchema, rememberFact } from '../src/agent-config/memory/store.js';
import { transformLegacyMessages } from '../src/migration/legacy-history.js';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { attachRelayUsageStorage } from './helpers/relay-usage-storage.js';

const PAN = '4111111111111111';
const PAN_SPACED = '4111 1111 1111 1111';
const PAN_DASHED = '4111-1111-1111-1111';
const CVV_TEXT = 'meu cvv é 123';
const CPF = '529.982.247-25';
const CNPJ = '11.222.333/0001-81';

const snapshotBody = {
  runtime: {
    singleton: 'active',
    version: 3,
    securityEpoch: 2,
    activeProviderId: 'opencode-zen',
    activeModelId: 'opencode-zen:zen-1',
    activeProtocol: 'chat-completions',
    activeRolloutPercentage: 100,
    activeRolloutMode: 'all',
    fallbackProviderId: null,
    fallbackModelId: null,
    updatedBy: null,
  },
  activeProvider: null,
  activeModel: null,
  fallbackProvider: null,
  fallbackModel: null,
  activeDisabled: false,
  fallbackDisabled: false,
};

type Row = Record<string, unknown>;

const createMemorySql = () => {
  const tables = new Map<string, Row[]>();
  return {
    rows: tables,
    exec<T = Row>(query: string, ...bindings: unknown[]): Iterable<T> {
      const q = query.trim().replace(/\s+/g, ' ');
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        const name = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
        if (name && !tables.has(name)) tables.set(name, []);
        return [] as T[];
      }
      if (q.startsWith('INSERT INTO agent_memory')) {
        const [id, workspace_id, actor, kind, content, salience, created_at, last_seen_at, expires_at] = bindings;
        tables.get('agent_memory')!.push({ id, workspace_id, actor, kind, content, salience, created_at, last_seen_at, expires_at });
        return [] as T[];
      }
      if (q.startsWith('SELECT * FROM agent_memory')) {
        return (tables.get('agent_memory') ?? []) as T[];
      }
      if (q.startsWith('UPDATE agent_memory')) return [] as T[];
      if (q.startsWith('SELECT memory_enabled FROM agent_prefs')) return [] as T[];
      if (q.startsWith('INSERT INTO agent_prefs')) return [] as T[];
      throw new Error(`unhandled query in mock: ${q.slice(0, 80)}`);
    },
  };
};

describe('H-09: DLP central antes de qualquer escrita/export durável', () => {
  it('PAN válido, espaçado e com traços é detectado e redigido', () => {
    for (const pan of [PAN, PAN_SPACED, PAN_DASHED]) {
      expect(containsCardPan(`meu cartão ${pan} vence em 2030`)).toBe(true);
      const scrubbed = scrubForPersistence(`meu cartão ${pan} vence em 2030`);
      expect(scrubbed).not.toContain('4111');
      expect(scrubbed).toContain('[REDACTED]');
    }
  });

  it('CVV com contexto e documentos válidos são redigidos', () => {
    expect(containsSensitiveDocument(CVV_TEXT)).toBe(true);
    expect(scrubForPersistence(CVV_TEXT)).not.toContain('123');
    expect(scrubForPersistence(`meu cpf ${CPF}`)).not.toContain('529');
    expect(scrubForPersistence(`cnpj ${CNPJ}`)).not.toContain('11.222');
  });

  it('não clobbera telefone nem dígitos aleatórios (Luhn/check-digits)', () => {
    expect(scrubForPersistence('me liga no (11) 98765-4321')).toContain('98765-4321');
    expect(scrubForPersistence('protocolo 1234567890123456')).toContain('1234567890123456');
    expect(containsCardPan('protocolo 1234567890123456')).toBe(false);
  });

  it('rememberFact recusa PAN (qualquer variante) e redige o resto', () => {
    const sql = createMemorySql();
    initializeMemorySchema(sql);
    const refused = rememberFact(sql, { workspaceId: 'ws', actor: 'u', content: `cartão ${PAN_SPACED}` });
    expect(refused).toMatchObject({ stored: false });
    const ok = rememberFact(sql, { workspaceId: 'ws', actor: 'u', content: `prefiro pagar com cpf ${CPF} na conta` });
    expect(ok.stored).toBe(true);
    if (ok.stored) {
      expect(ok.item.content).not.toContain('529');
    }
  });

  it('migração legada nunca republica PAN cru', () => {
    const out = transformLegacyMessages(
      [
        { id: 'm1', actor_id: 'u', role: 'user', content_json: JSON.stringify(`pague com ${PAN}`), created_at: '2026-01-01' },
      ],
      'ws-1',
    );
    expect(JSON.stringify(out)).not.toContain(PAN);
  });

  it('anexos persistem só metadados: conteúdo inline e data: URL são descartados', () => {
    const { attachments, droppedInlineContent } = scrubAttachments([
      { type: 'image', url: 'https://cdn.test/fatura.png', name: 'fatura.png' },
      { type: 'image', url: 'https://cdn.test/x.png', name: `cartao ${PAN}`, data: 'iVBORw0KGgoAAAANSUhEUg==' },
      { type: 'pdf', url: 'data:application/pdf;base64,JVBERi0xLjQ=', name: 'doc.pdf' },
    ]);
    expect(droppedInlineContent).toBe(2);
    expect(JSON.stringify(attachments)).not.toContain('iVBORw0KGgo');
    expect(JSON.stringify(attachments)).not.toContain('JVBERi0xLjQ');
    expect(JSON.stringify(attachments)).not.toContain('4111');
    expect(attachments[0]).toMatchObject({ type: 'image', url: 'https://cdn.test/fatura.png', name: 'fatura.png' });
  });
});

describe('H-09: ingresso /rpc/chat com PAN + anexo inline', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('texto e anexos chegam ao transcript/memória sem valor cru', async () => {
    const persisted: UIMessage[] = [];
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
      messages: UIMessage[];
      persistMessages: (msgs: UIMessage[]) => Promise<void>;
    };
    agent.messages = [];
    agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
      persisted.push(...msgs);
    });
    Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
    // Usage-attempt ledger: the relay leg reserves per dispatch (fail-closed
    // 503 without atomic storage), so the harness provides it like production.
    attachRelayUsageStorage(agent);
    Object.defineProperty(agent, 'env', {
      value: { API_ORIGIN: 'https://api.example.test', AGENT_CONFIG_TOKEN: 'config-test-token' },
      writable: true,
      configurable: true,
    });
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/internal/agent/llm-config')) {
        return new Response(JSON.stringify(snapshotBody), { status: 200 });
      }
      if (u.includes('/internal/agent/llm-relay')) {
        return new Response(JSON.stringify({ text: 'anotado' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await agent.fetch(
      new Request('https://agent.test.local/rpc/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-actor': 'user-1',
          'x-agent-workspace': 'ws-1',
        },
        body: JSON.stringify({
          text: `pague a fatura com o cartão ${PAN_SPACED}`,
          intentionId: 'intent-dlp-1',
          attachments: [{ type: 'image', url: 'https://cdn.test/x.png', name: 'c.png', data: 'RAWBASE64' }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const blob = JSON.stringify(persisted);
    expect(blob).not.toContain('4111');
    expect(blob).not.toContain('RAWBASE64');
  });
});

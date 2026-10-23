/**
 * Round rename-2: guard de lifecycle legado (fake, sem PG).
 *
 * `assertWorkspaceWritableLegacyInTx` mapeia o guard canônico (mesma query
 * FOR SHARE, active/archived/deleted, linha ausente = pré-lifecycle). Sem a
 * tabela/coluna (schema legado real até V054): fail-closed explicado
 * (`unsupported`) — nunca bypass silencioso, nunca DDL nova. Erros reais
 * de query propagam intocados.
 */
import { describe, expect, it } from 'vitest';
import { assertWorkspaceWritableLegacyInTx } from '../../src/auth/workspace-lifecycle-guard.js';

const H = 'household-1';

const fakeClient = (behavior: { status?: string | null; error?: { code: string; message: string } }) => ({
  query: async (text: string) => {
    if (!text.includes('FROM households')) throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    if (behavior.error) {
      const err = new Error(behavior.error.message) as Error & { code: string };
      err.code = behavior.error.code;
      throw err;
    }
    if (behavior.status === null || behavior.status === undefined) return { rows: [], rowCount: 0 };
    return { rows: [{ status: behavior.status }], rowCount: 1 };
  },
});

describe('assertWorkspaceWritableLegacyInTx (fake)', () => {
  it('active passa', async () => {
    await expect(
      assertWorkspaceWritableLegacyInTx(fakeClient({ status: 'active' }) as never, H),
    ).resolves.toBeUndefined();
  });

  it('linha ausente passa (pré-lifecycle, paridade com o canônico)', async () => {
    await expect(
      assertWorkspaceWritableLegacyInTx(fakeClient({ status: null }) as never, H),
    ).resolves.toBeUndefined();
  });

  it('archived → 403, sem bypass', async () => {
    await expect(
      assertWorkspaceWritableLegacyInTx(fakeClient({ status: 'archived' }) as never, H),
    ).rejects.toMatchObject({ code: 'workspace.archived', statusCode: 403 });
  });

  it('deleted → 410, sem bypass', async () => {
    await expect(
      assertWorkspaceWritableLegacyInTx(fakeClient({ status: 'deleted' }) as never, H),
    ).rejects.toMatchObject({ code: 'workspace.deleted', statusCode: 410 });
  });

  it('tabela ausente (42P01) → unsupported explicado, nunca bypass silencioso', async () => {
    await expect(
      assertWorkspaceWritableLegacyInTx(
        fakeClient({ error: { code: '42P01', message: 'relation "households" does not exist' } }) as never,
        H,
      ),
    ).rejects.toMatchObject({ code: 'unsupported', statusCode: 400 });
  });

  it('coluna ausente (42703) → unsupported explicado', async () => {
    await expect(
      assertWorkspaceWritableLegacyInTx(
        fakeClient({ error: { code: '42703', message: 'column "status" does not exist' } }) as never,
        H,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('erro real de query propaga intocado (não vira unsupported)', async () => {
    await expect(
      assertWorkspaceWritableLegacyInTx(
        fakeClient({ error: { code: '57P01', message: 'admin shutdown' } }) as never,
        H,
      ),
    ).rejects.toThrow('admin shutdown');
  });
});

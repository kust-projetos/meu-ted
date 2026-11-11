// P1 RED: facade surface + session ownership (A/B isolation, re-bind rules).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FACADE_KEYS,
  filterSessionsForHost,
  createFacade,
} from './helpers/facade.mjs';
import { bindSession, clearAll } from '../src/session-bindings.mjs';

const hostA = Object.freeze({ label: 'a', token: 't-a', household: 'H_A', actorId: 'actor-a', deviceId: 'dev-a' });
const hostB = Object.freeze({ label: 'b', token: 't-b', household: 'H_B', actorId: 'actor-b', deviceId: 'dev-b' });

function fakeOc(rows) {
  return {
    session: {
      create: async ({ title }) => ({ id: `ses_${Math.random().toString(36).slice(2, 8)}`, title }),
      get: async ({ sessionID }) => ({ id: sessionID }),
      list: async () => rows,
      remove: async ({ sessionID }) => ({ id: sessionID, removed: true }),
    },
  };
}

describe('ted-runtime facade', () => {
  it('exposes exactly the allowlisted surface (no shell/prompt/edit/mcp)', async () => {
    clearAll();
    const facade = createFacade({ oc: fakeOc([]), host: hostA, executors: {} });
    assert.deepEqual(Object.keys(facade).sort(), [...FACADE_KEYS].sort());
    assert.ok(!('call' in facade) && !('shell' in facade) && !('prompt' in facade), 'no dynamic dispatch surface');
  });

  it('isolates session lists per host (A never sees B rows)', async () => {
    clearAll();
    bindSession('ses_A1', hostA);
    bindSession('ses_B1', hostB);
    const facadeA = createFacade({ oc: fakeOc([{ id: 'ses_A1' }, { id: 'ses_B1' }, { id: 'ses_orphan' }]), host: hostA, executors: {} });
    const listed = await facadeA.listSessions();
    const ids = (Array.isArray(listed) ? listed : listed.data).map((r) => r.id);
    assert.deepEqual(ids, ['ses_A1']);
  });

  it('blocks cross-host get/remove before any row is returned', async () => {
    clearAll();
    bindSession('ses_B9', hostB);
    const facadeA = createFacade({ oc: fakeOc([{ id: 'ses_B9' }]), host: hostA, executors: {} });
    const getErr = await facadeA.getSession('ses_B9').catch((e) => e);
    assert.equal(getErr.code, 'host_binding_mismatch');
    const rmErr = await facadeA.removeSession('ses_B9').catch((e) => e);
    assert.equal(rmErr.code, 'host_binding_mismatch');
  });

  it('fail-closes unknown list shapes to an empty envelope', () => {
    const out = filterSessionsForHost({ weird: true }, hostA);
    assert.deepEqual(out, { data: [], cursor: null });
  });

  it('fail-closes get/remove on unbound IDs without touching the SDK (incl. post-restart)', async () => {
    clearAll();
    let calls = 0;
    const oc = {
      session: {
        get: async () => { calls++; return { id: 'ses_ghost' }; },
        remove: async () => { calls++; return { removed: true }; },
        list: async () => [],
      },
    };
    const facadeA = createFacade({ oc, host: hostA, executors: {} });
    await assert.rejects(() => facadeA.getSession('ses_ghost'), /host-bound session context is required/);
    await assert.rejects(() => facadeA.removeSession('ses_ghost'), /host-bound session context is required/);
    assert.equal(calls, 0, 'SDK must not be reached without a live binding');

    // Post-restart: rows may persist in sqlite, but bindings do not.
    bindSession('ses_R1', hostA);
    clearAll(); // simulates restart (process-local registry lost)
    const facadeA2 = createFacade({ oc, host: hostA, executors: {} });
    await assert.rejects(() => facadeA2.getSession('ses_R1'), /host-bound session context is required/);
    assert.equal(calls, 0, 'post-restart metadata requires explicit host-side re-bind first');
  });
});

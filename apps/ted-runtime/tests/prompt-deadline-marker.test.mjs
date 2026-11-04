// Etapa C-REVIEW-FIX finding 1 (TDD RED-first): the local prompt wait
// deadline is directly observable runtime evidence. When the poll loop
// exhausts `timeoutMs` with no assistant output, the thrown
// `prompt.no_output` must carry an internal boolean-only marker
// (`details.deadlineExceeded === true`) so diagnostics can classify the
// runtime `timeout` — while the public code/message stay unchanged and the
// physical provider cause stays NOT_PROVEN. Plain no_output (no marker) and
// cancelled turns must NOT gain the marker.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPromptHost } from '../src/prompt.mjs';

const PUBLIC_NO_OUTPUT_MESSAGE =
  'prompt admitted but no assistant output observable — failing closed (no fabricated output)';

function emptyHistoryHost(admitId = 'u-deadline-1') {
  return {
    session: { prompt: async () => ({ id: admitId }) },
    message: { list: async () => ({ data: [], cursor: { previous: null, next: null } }) },
  };
}

describe('prompt deadline evidence marker', () => {
  it('deadline-exhausted no_output carries deadlineExceeded === true, public contract unchanged', async () => {
    const host = createPromptHost({ oc: emptyHistoryHost(), timeoutMs: 60, pollIntervalMs: 10 });
    const err = await host.chat({ sessionID: 's', text: 'saldo?', intentionId: 'dl-1' }).catch((e) => e);
    assert.equal(err.code, 'prompt.no_output');
    assert.equal(err.message, PUBLIC_NO_OUTPUT_MESSAGE);
    assert.equal(err.details && err.details.deadlineExceeded, true);
    assert.equal(err.details && err.details.userMessageId, 'u-deadline-1');
    // Marker is boolean-only evidence — no text, no payload.
    assert.deepEqual(Object.keys(err.details).sort(), ['deadlineExceeded', 'userMessageId']);
  });

  it('cancelled turns carry no deadline marker', async () => {
    const oc = {
      session: {
        prompt: async () => ({ id: 'u-cancel-1' }),
        interrupt: async () => ({ ok: true }),
      },
      message: { list: async () => ({ data: [], cursor: { previous: null, next: null } }) },
    };
    const host = createPromptHost({ oc, timeoutMs: 5000, pollIntervalMs: 10 });
    const controller = new AbortController();
    const pending = host.chat({ sessionID: 's', text: 'x?', intentionId: 'dl-cancel-1', signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e) => e);
    assert.equal(err.code, 'prompt.cancelled');
    assert.ok(!(err.details && err.details.deadlineExceeded), 'cancelled must not claim deadline evidence');
  });
});

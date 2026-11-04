// PR290-RETRY-HOOK live proof: scripted LOCAL OpenAI-compatible provider
// returning HTTP 500 for completions, through the REAL SDK 2.2.4 prompt
// host with the PRODUCT plugin wired (retry veto active).
//
// Contract: exactly ONE provider POST per one session.prompt — no automatic
// retry of the same gateway intention, no second prompt, no false success.
// Loopback-only: the fetch guard blocks every non-loopback destination
// pre-flight (zero bytes leave the machine); the only allowed non-loopback
// shape is the known blocked SDK catalog fetch (thrown before any socket).
// All providers loopback-scripted, dummy apiKey, no external/paid/provider
// live, no DB/production/financial writes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { setupIsolation, tedConfig, wirePlugin } from '../src/bootstrap.mjs';
import { defineTedFinancePlugin } from '../src/plugin.mjs';
import { bindSession } from '../src/session-bindings.mjs';
import { createPromptHost } from '../src/prompt.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE_PROVIDER = 'noretry';
const FIXTURE_MODEL = 'test-500';
const FIXTURE_PACKAGE = '@opencode/ai/providers/openai-compatible';

function fixtureModel(id) {
  return {
    name: `Test ${id}`,
    modelID: id,
    capabilities: { input: ['text'], output: ['text'] },
    limit: { context: 8000, output: 2000 },
  };
}

// Known SDK catalog fetch (models.opencode.ai): the native loop attempts it
// during a turn (retried); the zero-external guard blocks it pre-flight, so
// no byte leaves the machine and every COMPLETED fetch is loopback.
const BLOCKED_CATALOG_RE = /^GET https:\/\/models\.opencode\.ai\//;

describe('PR290-RETRY-HOOK live: scripted HTTP 500 issues exactly one provider POST', () => {
  let iso;
  let oc = null;
  let stub = null;
  let stubUrl;
  let realFetch;
  let fetchAllowedLoopback = 0;
  const fetchBlocked = [];
  const stubPosts = [];

  before(async () => {
    const root = approvedTmpRoot('ted-noretry');
    iso = setupIsolation(root, 'noretry');

    stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method === 'POST') {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = { _parseError: true }; }
          stubPosts.push({ url: req.url, body });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'scripted stub failure', type: 'stub' } }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(0, '127.0.0.1', resolve);
    });
    stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      let s = '';
      try { s = String(url && url.url ? url.url : url); } catch { s = String(url); }
      let hostname = '';
      try { hostname = new URL(s).hostname; } catch { hostname = ''; }
      if (hostname === '127.0.0.1') {
        fetchAllowedLoopback++;
        return realFetch(url, init);
      }
      fetchBlocked.push(`${(init && init.method) || 'GET'} ${s.slice(0, 200)}`);
      throw new Error('guard: non-loopback fetch blocked (zero external inference)');
    };

    const base = tedConfig();
    const cfg = {
      ...base,
      model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      policies: [
        ...(base.policies || []),
        { action: 'provider.use', resource: FIXTURE_PROVIDER, effect: 'allow' },
      ],
      providers: {
        [FIXTURE_PROVIDER]: {
          name: 'No-retry scripted stub (dummy apiKey)',
          package: FIXTURE_PACKAGE,
          settings: { baseURL: stubUrl, apiKey: 'test-fixture-not-a-real-secret' },
          models: { [FIXTURE_MODEL]: fixtureModel(FIXTURE_MODEL) },
        },
      },
    };
    fs.mkdirSync(iso.dirs.config, { recursive: true });
    fs.writeFileSync(path.join(iso.dirs.config, 'opencode.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const sdk = await import('@opencode/sdk');
    oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });

    // Product plugin wired: the native retry veto installs in setup when the
    // prompt loop runs. Finance transport is never reached on the 500 path.
    const neverTransport = async () => ({ statusCode: 200, body: { items: [], total: 0 } });
    await wirePlugin(oc, defineTedFinancePlugin(() => neverTransport));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    if (stub) await new Promise((resolve) => stub.close(resolve)).catch(() => {});
    if (oc) await oc.close().catch(() => {});
  });

  it('one prompt, one provider POST, turn fails closed (no repeat, no success)', { timeout: 120000 }, async () => {
    const created = await oc.session.create({ title: 'noretry-neg', agent: 'ted' });
    bindSession(created.id, {
      label: 'noretry',
      token: 'test-token-not-a-real-secret',
      household: 'H_NORETRY',
      actorId: 'actor-noretry',
      deviceId: 'dev-noretry',
    });
    const promptHost = createPromptHost({ oc, timeoutMs: 30000, pollIntervalMs: 250 });
    let thrown = null;
    try {
      await promptHost.chat({ sessionID: created.id, text: 'noretry turn: scripted 500', intentionId: 'noretry-01' });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'scripted 500 must fail the turn (never fabricated success)');
    assert.equal(stubPosts.length, 1, `exactly ONE provider POST per prompt (no automatic retry) — got ${stubPosts.length}`);
    for (const b of fetchBlocked) {
      assert.match(b, BLOCKED_CATALOG_RE, `only the blocked SDK catalog fetch may be non-loopback (got ${b.slice(0, 120)})`);
    }
    assert.ok(fetchAllowedLoopback > 0, 'loopback stub was actually hit');
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  discoverApiRoutes,
  discoverNextRouteWrites,
  discoverPiToolWrites,
  discoverPwaCommands,
  collectWriteSurface,
  discoverPwaEndpointWrites,
  parsePolicyDocument,
  validateWritePolicy,
} from './check-write-policy.mjs';

const POLICY_HEADER = '| ID | Layer | Operation | Method | Path | Source | Idempotency | Success | Failure | Projection | Risk |';

function policyRow(id, layer, operation, method, path, source) {
  return `| ${id} | ${layer} | ${operation} | ${method} | ${path} | ${source} | required | canonical | throw + rollback | refetch | medium |`;
}

test('discovers all supported write surfaces from source', () => {
  const commands = discoverPwaCommands(`
    export interface Commands {
      saveThing(input: SaveInput): Promise<Thing>;
      removeThing(id: string): Promise<void>;
    }
  `, 'apps/pwa/src/lib/state/commands.ts');
  const endpoints = discoverPwaEndpointWrites(`
    export async function saveThing(input: SaveInput): Promise<Thing> {
      return apiFetch<Thing>("/things", { method: "POST", body: JSON.stringify(input) });
    }
    export async function removeThing(id: string): Promise<void> {
      await apiFetch<Thing>(\`/things/\${id}\`, { method: "DELETE" });
    }
    export async function patchThing(id: string, input: SaveInput): Promise<Thing> {
      return apiFetch<Thing>(\`/things/\${id}\`, mutationOptions("PATCH", input));
    }
  `, 'apps/pwa/src/lib/api/endpoints.ts');
  const routes = discoverApiRoutes(`
    app.post('/things', async () => ({}));
    app.delete('/things/:id', async () => ({}));
    postHandler('/things/import', schema, 'things.import', handler);
    originPostHandler('/things/expense', originSchema, strictSchema, producer);
  `, 'apps/api/src/routes/things.ts');
  const tools = discoverPiToolWrites(`
    const result = await requestPiApiJson("POST", "/things", { body: params });
  `, 'tools/things.ts');
  const generatedTools = discoverPiToolWrites(`
const specs = [
    {
    "name": "create_thing",
    "method": "POST",
    "path": "/things/{thingId}",
    },
];
  `, '.pi/extensions/financial-tools/generated/http-tools.ts');
  const nextRoute = discoverNextRouteWrites(
    'export async function POST(request) { return Response.json({ ok: true }); }',
    'apps/pwa/src/app/api/things/[id]/route.ts',
  );

  assert.deepEqual(commands.map((entry) => entry.operation), ['saveThing', 'removeThing']);
  assert.deepEqual(endpoints.map((entry) => [entry.operation, entry.method, entry.path]), [
    ['saveThing', 'POST', '/things'],
    ['removeThing', 'DELETE', '/things/:id'],
    ['patchThing', 'PATCH', '/things/:id'],
  ]);
  assert.deepEqual(routes.map((entry) => [entry.method, entry.path]), [
    ['POST', '/things'],
    ['DELETE', '/things/:id'],
    ['POST', '/things/import'],
    ['POST', '/things/expense'],
  ]);
  assert.deepEqual(tools.map((entry) => [entry.method, entry.path]), [['POST', '/things']]);
  assert.deepEqual(generatedTools.map((entry) => [entry.method, entry.path]), [['POST', '/things/:id']]);
  assert.deepEqual(nextRoute.map((entry) => [entry.method, entry.path]), [['POST', '/api/things/:id']]);
});

test('requires a policy row for every discovered write and rejects malformed rows', () => {
  const discovered = [
    { id: 'api.route.POST:/things', layer: 'api-route', operation: 'POST /things', method: 'POST', path: '/things', source: 'apps/api/src/routes/things.ts' },
    { id: 'pwa.command.saveThing', layer: 'pwa-command', operation: 'saveThing', method: 'COMMAND', path: 'commands.saveThing', source: 'apps/pwa/src/lib/state/commands.ts' },
  ];
  const missing = validateWritePolicy(parsePolicyDocument(`${POLICY_HEADER}\n${policyRow('api.route.POST:/things', 'api-route', 'POST /things', 'POST', '/things', 'apps/api/src/routes/things.ts')}`), discovered);
  assert.deepEqual(missing.errors, ['missing policy for pwa.command.saveThing']);

  const valid = validateWritePolicy(parsePolicyDocument([
    POLICY_HEADER,
    policyRow('api.route.POST:/things', 'api-route', 'POST /things', 'POST', '/things', 'apps/api/src/routes/things.ts'),
    policyRow('pwa.command.saveThing', 'pwa-command', 'saveThing', 'COMMAND', 'commands.saveThing', 'apps/pwa/src/lib/state/commands.ts'),
  ].join('\n')), discovered);
  assert.deepEqual(valid.errors, []);
});

test('current repository has a policy row for every discovered write', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const policyPath = `${root}/docs/architecture/write-mutator-policy.md`;
  const result = validateWritePolicy(
    parsePolicyDocument(fs.readFileSync(policyPath, 'utf8')),
    collectWriteSurface(root),
  );
  assert.deepEqual(result.errors, []);
  assert.ok(result.discovered > 0);
  assert.equal(result.discovered, result.rows);
});

test('rejects duplicate ids, unknown ids, and blank policy fields', () => {
  const discovered = [{ id: 'api.route.POST:/things', layer: 'api-route', operation: 'POST /things', method: 'POST', path: '/things', source: 'apps/api/src/routes/things.ts' }];
  const rows = parsePolicyDocument([
    POLICY_HEADER,
    policyRow('api.route.POST:/things', 'api-route', 'POST /things', 'POST', '/things', 'apps/api/src/routes/things.ts'),
    '| api.route.POST:/things | api-route | duplicate | POST | /things | source | required | canonical | throw | refetch | medium |',
    '| unknown | api-route | unknown | POST | /unknown | source | required | canonical | throw | refetch | medium |',
  ].join('\n'));
  const result = validateWritePolicy(rows, discovered);
  assert.deepEqual(result.errors, [
    'duplicate policy id api.route.POST:/things',
    'policy id unknown is not discovered',
  ]);
});

test('discovers PWA commands whose parameter list contains an inline object type', () => {
  const commands = discoverPwaCommands(`
    export interface Commands {
      updateThing(id: string, input: { name?: string; kind?: string | null }): Promise<Thing>;
    }
  `, 'apps/pwa/src/lib/state/commands.ts');
  assert.deepEqual(commands.map((c) => c.id), ['pwa.command.updateThing']);
});

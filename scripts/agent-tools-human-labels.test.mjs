import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

const contractPath = 'apps/api/openapi/agent-tools.openapi.json';
const generatedPath = 'apps/agent/src/generated/http-tools.ts';
const generatorPath = 'scripts/generate-agent-tools.mjs';
const agentToolsPath = 'apps/agent/src/agent-config/tools.ts';

const collectTools = (contract) => {
  const tools = [];
  for (const [routePath, pathItem] of Object.entries(contract.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
      for (const tool of operation['x-pi-tools'] ?? []) {
        tools.push({
          name: tool.name ?? operation.operationId,
          label: tool.label ?? operation.operationId,
          description: tool.description ?? operation.summary ?? tool.name ?? operation.operationId,
          route: `${tool.method ?? method.toUpperCase()} ${tool.path ?? routePath}`,
        });
      }
      if (operation['x-pi-tool']) {
        const tool = operation['x-pi-tool'];
        tools.push({
          name: tool.name ?? operation.operationId,
          label: tool.label ?? operation.operationId,
          description: tool.description ?? operation.summary ?? tool.name ?? operation.operationId,
          route: `${tool.method ?? method.toUpperCase()} ${tool.path ?? routePath}`,
        });
      }
    }
  }
  return tools;
};

describe('agent tool labels/descriptions are human-facing (P1 tools fix)', () => {
  it('generated registry is in sync with the contract', () => {
    execFileSync(process.execPath, ['scripts/generate-agent-tools.mjs', '--check'], { stdio: 'pipe' });
  });

  it('no tool keeps a placeholder description or an internal id as label', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    const tools = collectTools(contract);
    assert.ok(tools.length >= 50, `expected the full tool surface, got ${tools.length}`);
    for (const tool of tools) {
      assert.ok(
        typeof tool.description === 'string' && tool.description.trim().length > 0,
        `${tool.name}: description must be non-empty`,
      );
      assert.doesNotMatch(tool.description, /HTTP contract for/, `${tool.name}: placeholder description`);
      assert.notEqual(tool.description, tool.name, `${tool.name}: description must not be the tool id`);
      assert.notEqual(tool.label, tool.name, `${tool.name}: label must not be the internal id`);
      assert.doesNotMatch(tool.label, /^[a-z][a-z0-9_]*$/, `${tool.name}: label must be human, not snake_case`);
    }
  });

  it('generated module carries the human labels (what onUpdate renders)', async () => {
    const generated = await readFile(generatedPath, 'utf8');
    assert.doesNotMatch(generated, /HTTP contract for/, 'generated module must not contain placeholder descriptions');
    for (const match of generated.matchAll(/"name": "([^"]+)",\s+"label": "([^"]+)"/g)) {
      const [, name, label] = match;
      assert.notEqual(label, name, `generated tool ${name}: label must not be the internal id`);
      assert.doesNotMatch(label, /^[a-z][a-z0-9_]*$/, `generated tool ${name}: label must be human`);
    }
  });

  it('retired-route exemptions stay exactly the V1 trio kept by RETIRED_MODEL_TOOLS', async () => {
    const generator = await readFile(generatorPath, 'utf8');
    const agentTools = await readFile(agentToolsPath, 'utf8');
    const exempted = [...generator.matchAll(/'(GET|POST) (\/pending-operations\/[a-z-]+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(
      [...new Set(exempted)].sort(),
      [
        'GET /pending-operations/details',
        'POST /pending-operations/approve',
        'POST /pending-operations/reject',
      ].sort(),
      'exemptions must stay exactly the retired V1 trio — widening them hides contract drift',
    );
    for (const retired of ['get_pending_operation', 'confirm_pending_operation', 'cancel_pending_operation']) {
      assert.match(agentTools, new RegExp(`'${retired}'`), `${retired} must stay in RETIRED_MODEL_TOOLS`);
    }
  });
});

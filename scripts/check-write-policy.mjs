#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = path.join(ROOT, 'docs', 'architecture', 'write-mutator-policy.md');
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const POLICY_COLUMNS = [
  'ID', 'Layer', 'Operation', 'Method', 'Path', 'Source',
  'Idempotency', 'Success', 'Failure', 'Projection', 'Risk',
];

function normalizeSource(sourcePath) {
  return sourcePath.replaceAll('\\', '/');
}

function normalizePath(value) {
  return value.replace(/\$\{[^}]+\}/g, ':id').replace(/\{[^}]+\}/g, ':id');
}

function entry(id, layer, operation, method, routePath, source) {
  return {
    id,
    layer,
    operation,
    method,
    path: normalizePath(routePath),
    source: normalizeSource(source),
  };
}

export function discoverPwaCommands(source, sourcePath) {
  const body = source.match(/export interface Commands\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
  const result = [];
  // Parameter lists may contain `;` (inline object types such as `{ a?: string; b?: string }`).
  const methodPattern = /^\s*([A-Za-z_$][\w$]*)\s*\([^\n]*\):\s*Promise<[^;\n]+>;\s*$/gm;
  for (const match of body.matchAll(methodPattern)) {
    const operation = match[1];
    result.push(entry(`pwa.command.${operation}`, 'pwa-command', operation, 'COMMAND', `commands.${operation}`, sourcePath));
  }
  return result;
}

function findExportBodies(source) {
  const exports = [...source.matchAll(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  return exports.map((match, index) => ({
    operation: match[1],
    body: source.slice(match.index, exports[index + 1]?.index ?? source.length),
  }));
}

export function discoverPwaEndpointWrites(source, sourcePath) {
  const result = [];
  for (const { operation, body } of findExportBodies(source)) {
    // Inline `{ method: "POST", ... }` or the shared
    // `mutationOptions("POST", ...)` helper (idempotency boundary).
    const method = body.match(/\bmethod\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/i)?.[1]?.toUpperCase()
      ?? body.match(/\bmutationOptions\s*\(\s*["'](POST|PUT|PATCH|DELETE)["']/i)?.[1]?.toUpperCase();
    const routePath = body.match(/(?:apiFetch|endpoint)(?:<[^>\n]*>)?\s*\(\s*(["'`])([\s\S]*?)\1/)?.[2];
    if (!method || !routePath) continue;
    result.push(entry(`pwa.endpoint.${operation}`, 'pwa-endpoint', operation, method, routePath, sourcePath));
  }
  return result;
}

function discoverRouteCalls(source, sourcePath) {
  const result = [];
  const patterns = [
    { re: /\b(?:app|router)\.(post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\2/gi, methodAt: 1, pathAt: 3 },
    { re: /\b(postHandler|putHandler|patchHandler|deleteHandler)\s*\(\s*(["'`])([^"'`]+)\2/gi, methodAt: 1, pathAt: 3 },
    // Local registration helpers that forward to app.post/... with a
    // literal path (e.g. originPostHandler in transactions-write.ts).
    { re: /\borigin(Post|Put|Patch|Delete)Handler\s*\(\s*(["'`])([^"'`]+)\2/gi, methodAt: 1, pathAt: 3 },
  ];
  for (const { re, methodAt, pathAt } of patterns) {
    for (const match of source.matchAll(re)) {
      const method = match[methodAt].replace('Handler', '').toUpperCase();
      const routePath = match[pathAt];
      result.push(entry(`api.route.${method}:${routePath}`, 'api-route', `${method} ${routePath}`, method, routePath, sourcePath));
    }
  }
  return result;
}

export function discoverApiRoutes(source, sourcePath) {
  return discoverRouteCalls(source, sourcePath);
}

function nextRoutePath(sourcePath) {
  const appPath = sourcePath.match(/(?:^|\/)src\/app\/(.+)\/route\.(?:ts|tsx)$/)?.[1];
  if (!appPath) return null;
  return `/${appPath.replace(/\[([^\]]+)\]/g, ':$1')}`;
}

export function discoverNextRouteWrites(source, sourcePath) {
  const routePath = nextRoutePath(sourcePath);
  if (!routePath) return [];
  const result = [];
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\s*\(/gi)) {
    const method = match[1].toUpperCase();
    result.push(entry(`pwa.route.${method}:${routePath}`, 'pwa-route', `${method} ${routePath}`, method, routePath, sourcePath));
  }
  return result;
}

export function discoverPiToolWrites(source, sourcePath) {
  const result = [];
  const stableSource = normalizeSource(sourcePath).replace(/^\./, '');
  const pattern = /requestPiApiJson(?:<[^>]*>)?\s*\(\s*(["'])(POST|PUT|PATCH|DELETE)\1\s*,\s*(["'`])([^"'`]+)\3/gi;
  for (const match of source.matchAll(pattern)) {
    const method = match[2].toUpperCase();
    const routePath = match[4];
    result.push(entry(`pi.tool${stableSource}:${method}:${normalizePath(routePath)}`, 'pi-tool', `${method} ${normalizePath(routePath)}`, method, routePath, sourcePath));
  }
  if (sourcePath.endsWith('/generated/http-tools.ts')) {
    const specPattern = /^    "name": "([^"]+)"[\s\S]*?(?=^    "name":|\n\];)/gm;
    for (const match of source.matchAll(specPattern)) {
      const block = match[0];
      const method = block.match(/"method": "(POST|PUT|PATCH|DELETE)"/)?.[1];
      const routePath = block.match(/"path": "([^"]+)"/)?.[1];
      if (!method || !routePath) continue;
      result.push(entry(`pi.tool${stableSource}:${method}:${normalizePath(routePath)}`, 'pi-tool', `${method} ${normalizePath(routePath)}`, method, routePath, sourcePath));
    }
  }
  return result;
}

function walkFiles(directory, predicate) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const fullPath = path.join(directory, item.name);
    if (item.isDirectory()) return walkFiles(fullPath, predicate);
    return predicate(fullPath) ? [fullPath] : [];
  });
}

function relativeToRoot(filePath) {
  return normalizeSource(path.relative(ROOT, filePath));
}

export function collectWriteSurface(root = ROOT) {
  const commandsPath = path.join(root, 'apps', 'pwa', 'src', 'lib', 'state', 'commands.ts');
  const endpointsPath = path.join(root, 'apps', 'pwa', 'src', 'lib', 'api', 'endpoints.ts');
  const routeRoot = path.join(root, 'apps', 'api', 'src', 'routes');
  const toolRoot = path.join(root, '.pi', 'extensions', 'financial-tools', 'tools');
  const canonicalToolRoot = path.join(root, 'apps', 'agent', 'src', 'generated');
  const pwaRouteRoot = path.join(root, 'apps', 'pwa', 'src', 'app');
  const bridgeServerPath = path.join(root, 'apps', 'whatsapp-bridge', 'src', 'server.ts');
  const surface = [
    ...discoverPwaCommands(fs.readFileSync(commandsPath, 'utf8'), relativeToRoot(commandsPath)),
    ...discoverPwaEndpointWrites(fs.readFileSync(endpointsPath, 'utf8'), relativeToRoot(endpointsPath)),
  ];
  for (const filePath of walkFiles(routeRoot, (file) => file.endsWith('.ts'))) {
    surface.push(...discoverApiRoutes(fs.readFileSync(filePath, 'utf8'), relativeToRoot(filePath)));
  }
  for (const filePath of walkFiles(pwaRouteRoot, (file) => file.endsWith('/route.ts') || file.endsWith('\\route.ts'))) {
    surface.push(...discoverNextRouteWrites(fs.readFileSync(filePath, 'utf8'), relativeToRoot(filePath)));
  }
  if (fs.existsSync(bridgeServerPath)) {
    surface.push(...discoverApiRoutes(fs.readFileSync(bridgeServerPath, 'utf8'), relativeToRoot(bridgeServerPath)).map((item) => ({
      ...item,
      id: item.id.replace('api.route.', 'bridge.route.'),
      layer: 'bridge-route',
    })));
  }
  if (fs.existsSync(toolRoot)) {
    for (const filePath of walkFiles(toolRoot, (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))) {
      surface.push(...discoverPiToolWrites(fs.readFileSync(filePath, 'utf8'), relativeToRoot(filePath)));
    }
  }
  const canonicalGenerated = path.join(canonicalToolRoot, 'http-tools.ts');
  const generatedToolPath = path.join(root, '.pi', 'extensions', 'financial-tools', 'generated', 'http-tools.ts');
  if (fs.existsSync(canonicalGenerated)) {
    surface.push(...discoverPiToolWrites(fs.readFileSync(canonicalGenerated, 'utf8'), relativeToRoot(canonicalGenerated)));
  } else if (fs.existsSync(generatedToolPath)) {
    surface.push(...discoverPiToolWrites(fs.readFileSync(generatedToolPath, 'utf8'), relativeToRoot(generatedToolPath)));
  }
  return surface;
}

function splitTableRow(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

export function parsePolicyDocument(source) {
  const lines = source.split(/\r?\n/);
  const headerLine = lines.find((line) => line.trim().startsWith('| ID |'));
  if (!headerLine) return { columns: [], rows: [], headerError: 'policy table header is missing' };
  const columns = splitTableRow(headerLine);
  const headerIndex = lines.indexOf(headerLine);
  const rows = lines.slice(headerIndex + 1)
    .filter((line) => /^\|\s*[^-][^|]*\|/.test(line) && !/^\|\s*:?-+/.test(line))
    .map((line) => {
      const cells = splitTableRow(line);
      return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? '']));
    });
  return { columns, rows, headerError: null };
}

export function validateWritePolicy(parsed, discovered) {
  const errors = [];
  if (parsed.headerError) errors.push(parsed.headerError);
  if (parsed.columns.join('|') !== POLICY_COLUMNS.join('|')) {
    errors.push(`policy columns must be exactly: ${POLICY_COLUMNS.join(' | ')}`);
  }

  const policyById = new Map();
  for (const row of parsed.rows) {
    const id = row.ID?.trim();
    if (!id) {
      errors.push('policy row has blank ID');
      continue;
    }
    if (policyById.has(id)) {
      errors.push(`duplicate policy id ${id}`);
      continue;
    }
    policyById.set(id, row);
    for (const column of POLICY_COLUMNS) {
      if (!row[column]?.trim()) errors.push(`policy ${id} is missing ${column}`);
    }
  }

  const discoveredById = new Map();
  for (const item of discovered) {
    if (discoveredById.has(item.id)) errors.push(`duplicate discovered write ${item.id}`);
    discoveredById.set(item.id, item);
  }

  for (const item of discovered) {
    const row = policyById.get(item.id);
    if (!row) {
      errors.push(`missing policy for ${item.id}`);
      continue;
    }
    for (const [column, value] of Object.entries({
      Layer: item.layer,
      Operation: item.operation,
      Method: item.method,
      Path: item.path,
      Source: item.source,
    })) {
      if (row[column] !== value) errors.push(`policy ${item.id} ${column} is ${JSON.stringify(row[column])}, expected ${JSON.stringify(value)}`);
    }
  }
  for (const id of policyById.keys()) {
    if (!discoveredById.has(id)) errors.push(`policy id ${id} is not discovered`);
  }

  return { rows: parsed.rows.length, discovered: discovered.length, errors };
}

function defaultPolicy(item) {
  const destructive = /DELETE|deactivate|cancel|revoke|unpay|payStatement/i.test(`${item.method} ${item.operation} ${item.path}`);
  const idempotency = item.layer === 'api-route'
    ? (item.path === '/auth/devices/register' ? 'not-applicable (disabled)' : 'required')
    : item.layer === 'pwa-endpoint' ? 'client-generated' : item.layer === 'pi-tool' ? 'tool-generated' : item.layer === 'pwa-command' ? 'delegated' : 'not-applicable (transport)';
  const failure = item.layer === 'api-route' ? 'throw; transaction rollback' : item.layer === 'pwa-command' ? 'throw; retain dirty state' : 'throw to caller';
  const success = item.layer === 'pwa-route' ? 'telemetry acknowledgement' : item.layer === 'bridge-route' ? 'ingress acknowledgement' : 'canonical response';
  const projection = item.layer === 'pwa-route' || item.layer === 'bridge-route' ? 'not-applicable (transport)' : 'reconcile affected domain';
  return {
    ...item,
    idempotency,
    success,
    failure,
    projection,
    risk: destructive ? 'high' : 'medium',
  };
}

export function renderPolicyDocument(discovered) {
  const rows = discovered.map(defaultPolicy);
  const header = `| ${POLICY_COLUMNS.join(' | ')} |`;
  const separator = `| ${POLICY_COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${POLICY_COLUMNS.map((column) => row[column.toLowerCase()] ?? row[column]).join(' | ')} |`);
  return [
    '# Write and Mutator Policy Matrix',
    '',
    'This matrix is the policy ledger for every discovered write surface. CI discovers non-GET API routes, PWA command mutators, typed PWA endpoint writes, and Pi tools that call the API with a write method. A new item fails CI until its exact ID is documented here with all policy columns populated.',
    '',
    '## Policy vocabulary',
    '',
    '- **Idempotency:** `required` means the boundary must carry a stable key; `client-generated`, `tool-generated`, and `delegated` identify the generating layer; disabled bootstrap endpoints may use `not-applicable (disabled)`.',
    '- **Success:** writes return the canonical server response; no generic success-only acknowledgement is accepted as the policy target.',
    '- **Failure:** errors propagate; API transactions roll back and PWA commands retain dirty state for retry/recovery.',
    '- **Projection:** the affected domain is reconciled after a committed write; this column is a required policy decision even when the implementation is deferred to a later goal.',
    '- **Risk:** `high` covers destructive or irreversible actions; `medium` covers ordinary writes. A future `critical` classification requires an explicit ADR.',
    '',
    '## Discovery contract',
    '',
    '- Sources: `apps/pwa/src/lib/state/commands.ts`, `apps/pwa/src/lib/api/endpoints.ts`, `apps/pwa/src/app/**/route.ts`, `apps/api/src/routes/**/*.ts`, `apps/whatsapp-bridge/src/server.ts`, `.pi/extensions/financial-tools/tools/**/*.ts`, and the generated `.pi/extensions/financial-tools/generated/http-tools.ts` artifact.',
    '- Only `POST`, `PUT`, `PATCH`, and `DELETE` are write methods. GET/read paths are intentionally excluded.',
    '- `Source`, `Method`, `Path`, `Layer`, and `Operation` are source-derived and must match exactly; do not hand-edit them to hide drift.',
    '- PWA telemetry and bridge ingress rows are included as transport writes; they use `not-applicable (transport)` for idempotency/projection and do not mutate financial projections.',
    '',
    '## Matrix',
    '',
    header,
    separator,
    ...body,
    '',
  ].join('\n');
}

function main() {
  const discovered = collectWriteSurface();
  if (process.argv.includes('--generate')) {
    fs.writeFileSync(POLICY_PATH, renderPolicyDocument(discovered));
    console.log(`Write policy matrix generated: ${discovered.length} entries`);
    return;
  }
  const parsed = parsePolicyDocument(fs.readFileSync(POLICY_PATH, 'utf8'));
  const result = validateWritePolicy(parsed, discovered);
  if (result.errors.length) {
    console.error(result.errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`Write policy valid: ${result.discovered} discovered writes / ${result.rows} policy rows`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

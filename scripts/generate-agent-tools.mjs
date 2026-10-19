#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const contractPath = argValue('--contract', path.join(root, 'apps', 'api', 'openapi', 'agent-tools.openapi.json'));
const routeInventoryPath = path.join(root, 'apps', 'api', 'src', 'routes', 'route-inventory.ts');
const outputPath = argValue('--out', path.join(root, 'apps', 'agent', 'src', 'generated', 'http-tools.ts'));
const document = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const routeInventory = fs.readFileSync(routeInventoryPath, 'utf8');
const actualRoutes = [...routeInventory.matchAll(/method: '([A-Z]+)', path: '([^']+)'/g)].map((match) => `${match[1]} ${match[2]}`);
const normalizeRoute = (value) => value.replace(/\{[^}]+\}/g, ':id');

// Debt-pending-v1-v2 (#152): V1 pending routes retired permanently (v2Only).
// Their specs stay in the registry on purpose (filtered from the model surface
// by RETIRED_MODEL_TOOLS in apps/agent/src/agent-config/tools.ts), so the
// inventory check below exempts exactly these three routes.
const RETIRED_ROUTE_EXEMPTIONS = new Set([
  'GET /pending-operations/details',
  'POST /pending-operations/approve',
  'POST /pending-operations/reject',
]);

const schemaType = (schema, optional = false) => {
  let expression;
  if (schema.enum) expression = `Type.Union([${schema.enum.map((value) => `Type.Literal(${JSON.stringify(value)})`).join(', ')}])`;
  else if (schema.type === 'array') expression = `Type.Array(${schemaType(schema.items ?? { type: 'string' })})`;
  else if (schema.type === 'integer') expression = `Type.Integer(${JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([key]) => ['minimum', 'maximum', 'default', 'description'].includes(key))))})`;
  else if (schema.type === 'number') expression = `Type.Number(${JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([key]) => ['minimum', 'maximum', 'default', 'description'].includes(key))))})`;
  else if (schema.type === 'boolean') expression = `Type.Boolean(${JSON.stringify(schema.description ? { description: schema.description } : {})})`;
  else expression = `Type.String(${JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([key]) => ['format', 'pattern', 'minLength', 'maxLength', 'description'].includes(key))))})`;
  return optional ? `Type.Optional(${expression})` : expression;
};

const specs = [...(document['x-pi-tools'] ?? [])];
const addPathSpec = (routePath, method, operation, tool) => {
  if (tool.parameters) {
    specs.push({ ...tool, name: tool.name ?? operation.operationId, label: tool.label ?? operation.operationId, description: tool.description ?? operation.summary ?? operation.operationId, method: tool.method ?? method.toUpperCase(), path: tool.path ?? routePath });
    return;
  }
  const parameters = [...(operation.parameters ?? [])];
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  for (const [name, schema] of Object.entries(bodySchema?.properties ?? {})) parameters.push({ name, in: 'body', required: bodySchema.required?.includes(name) ?? false, schema });
  specs.push({
    name: tool.name ?? operation.operationId,
    label: tool.label ?? operation.operationId,
    description: tool.description ?? operation.summary ?? tool.name ?? operation.operationId,
    method: method.toUpperCase(),
    path: routePath,
    idempotency: Boolean(tool.idempotency),
    shadow: method.toLowerCase() === 'get' && Boolean(tool.shadow ?? true),
    result: tool.result ?? null,
    parameters: parameters.map((parameter) => ({ name: parameter.name, in: parameter.in, required: Boolean(parameter.required), context: Boolean(parameter['x-pi-context']), schema: parameter.schema })),
  });
};
for (const [routePath, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
    if (operation['x-pi-tool']) addPathSpec(routePath, method, operation, operation['x-pi-tool']);
    for (const tool of operation['x-pi-tools'] ?? []) addPathSpec(routePath, method, operation, tool);
  }
}

for (const spec of specs) {
  const route = `${spec.method} ${normalizeRoute(spec.path)}`;
  // Debt-pending-v1-v2 (#152): the V1 pending routes were retired permanently
  // (v2Only), but the generated registry intentionally keeps their specs —
  // apps/agent/src/agent-config/tools.ts RETIRED_MODEL_TOOLS filters them from
  // the model surface. Exempt exactly these routes; everything else fails closed.
  if (!actualRoutes.includes(route) && !RETIRED_ROUTE_EXEMPTIONS.has(route)) throw new Error(`OpenAPI tool route is not declared by API route inventory: ${route}`);
}

// --- authoritative validation: refuse malformed contracts (no partial adapters) ---
{
  const seenNames = new Set();
  for (const spec of specs) {
    if (seenNames.has(spec.name)) throw new Error(`Authoritative error: duplicate tool name "${spec.name}"`);
    seenNames.add(spec.name);
    if (!spec.path || !spec.method) continue;
    for (const match of spec.path.matchAll(/\{([^}]+)\}/g)) {
      if (!(spec.parameters ?? []).some((parameter) => parameter.name === match[1])) {
        throw new Error(`Authoritative error: path parameter "${match[1]}" of "${spec.method} ${spec.path}" (tool "${spec.name}") is not declared in operation parameters`);
      }
    }
    if (spec.method !== 'GET' && !spec.idempotency) {
      throw new Error(`Authoritative error: write tool "${spec.name}" (${spec.method} ${spec.path}) lacks idempotency metadata`);
    }
  }
  for (const [routePath, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
      for (const [code, response] of Object.entries(operation.responses ?? {})) {
        if (/^2\d\d$/.test(code) && !response?.content?.['application/json']?.schema) {
          throw new Error(`Authoritative error: ${method} ${routePath} declares ${code} response without a JSON schema`);
        }
      }
    }
  }
}

const parameterEntries = (spec) => {
  const seen = new Set();
  const unique = (spec.parameters ?? []).filter((parameter) => {
    if (seen.has(parameter.name)) return false;
    seen.add(parameter.name);
    return true;
  });
  return unique.map((parameter) =>
    `    ${JSON.stringify(parameter.name)}: ${schemaType(parameter.schema, !parameter.required)},`).join('\n');
};

const source = `/* AUTO-GENERATED by scripts/generate-agent-tools.mjs. DO NOT EDIT. */
import { Type } from "@sinclair/typebox";
import { requestPiApiJson } from "../tools/api-client.js";
import { capabilityDisabled, checkToolExecutionPolicy } from "../tools/api-tool-helpers.js";
import { runShadowRead } from "../shadow/shadow-runner.js";

type JsonObject = Record<string, unknown>;
type ToolParams = Record<string, unknown>;
const specs = ${JSON.stringify(specs, null, 2)} as const;
type ToolSpec = typeof specs[number];

function getAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current) && /^\\d+$/.test(key)) return current[Number(key)];
    return current && typeof current === "object" ? (current as JsonObject)[key] : undefined;
  }, value);
}

function project(spec: ToolSpec, response: JsonObject): JsonObject {
  const result = spec.result;
  if (!result) return { success: true, ...response };
  if (result.kind === "first") return { success: true, ...response, [result.key]: getAt(response, result.path) };
  const items = Array.isArray(response.items) ? response.items : [];
  const mapped = items.map((item) => Object.fromEntries(Object.entries(result.fields).map(([key, descriptor]) => {
    if (typeof descriptor === "string") return [key, getAt(item, descriptor)];
    const value = getAt(item, descriptor.path);
    return [key, descriptor.equals === undefined ? value : value === descriptor.equals];
  })));
  return { success: true, ...response, [result.key]: mapped };
}

function extractIntentionId(params: ToolParams, ctx?: unknown): string | undefined {
  if (typeof params.intentionId === "string" && params.intentionId.trim()) return params.intentionId.trim();
  if (ctx && typeof ctx === "object" && "sessionManager" in ctx) {
    const session = (ctx as { sessionManager?: { getBranch?: () => Array<{ message?: { content?: string } }> } }).sessionManager;
    const branch = session?.getBranch?.();
    if (Array.isArray(branch)) {
      for (const item of branch) {
        const text = typeof item?.message?.content === "string" ? item.message.content : "";
        const match = text.match(/\\[PI_INTENTION_ID=([^\\]]+)\\]/);
        if (match?.[1]) return match[1].trim();
      }
    }
  }
  return undefined;
}

/**
 * Per-invocation request credential carried in the tool \`ctx\` (5th
 * \`execute\` argument) by first-party callers (evidence reads, model tools).
 * Presence of either key opts the call OUT of the legacy module-global
 * fallback in \`requestPiApiJson\`: an explicit \`delegatedToken\` key — even
 * with an \`undefined\` value (unauthenticated/fail-closed read) — is
 * authoritative, so concurrent turns from different workspaces can never
 * observe each other's token. Callers that omit \`ctx\` keep the legacy
 * global-fallback behavior unchanged.
 */
export type ToolRequestAuth = { delegatedToken?: string; apiOrigin?: string };

function extractRequestAuth(ctx?: unknown): { hasAuth: boolean; delegatedToken?: string; apiOrigin?: string } {
  if (!ctx || typeof ctx !== 'object') return { hasAuth: false };
  const record = ctx as Record<string, unknown>;
  if (!('delegatedToken' in record) && !('apiOrigin' in record)) return { hasAuth: false };
  const delegatedToken = typeof record.delegatedToken === 'string' && record.delegatedToken ? record.delegatedToken : undefined;
  const apiOrigin = typeof record.apiOrigin === 'string' && record.apiOrigin ? record.apiOrigin : undefined;
  return {
    hasAuth: true,
    // Always present (possibly undefined): suppresses the global fallback
    // in requestPiApiJson by own-property presence.
    delegatedToken,
    ...(apiOrigin !== undefined ? { apiOrigin } : {}),
  };
}

function createTool(spec: ToolSpec) {
  const properties = {
${specs.map((spec) => `  ${JSON.stringify(spec.name)}: Type.Object({\n${parameterEntries(spec)}\n  }),`).join('\n')}
  } as const;
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: properties[spec.name as keyof typeof properties],
    async execute(toolCallIdOrParams: string | ToolParams, paramsOrSignal?: ToolParams | AbortSignal, _signal?: AbortSignal, onUpdate?: (update: { content: { type: "text"; text: string }[] }) => void, ctx?: unknown) {
      const toolCallId = typeof toolCallIdOrParams === "string" ? toolCallIdOrParams : "generated-call";
      const params = (typeof toolCallIdOrParams === "string" ? paramsOrSignal : toolCallIdOrParams) as ToolParams;
      const kind = spec.method === "GET" ? "read" : "write";
      const policyViolation = checkToolExecutionPolicy(spec.name, kind, ctx);
      if (policyViolation) return policyViolation;
      const resolvedPath = spec.path.replace(/\\{([^}]+)\\}/g, (_match, name) => encodeURIComponent(String(params[name])));
      const query = Object.fromEntries(spec.parameters
        .filter((parameter) => parameter.in === "query" && !parameter.context && params[parameter.name] !== undefined)
        .map((parameter) => [parameter.name, params[parameter.name] as string | number]));
      const body = spec.method === "GET" ? undefined : Object.fromEntries(spec.parameters
        .filter((parameter) => parameter.in === "body" && params[parameter.name] !== undefined)
        .map((parameter) => [parameter.name, params[parameter.name]]));
      const headers = Object.fromEntries(spec.parameters
        .filter((parameter) => parameter.in === "header" && params[parameter.name] !== undefined)
        .map((parameter) => [parameter.name.replace(/[A-Z]/g, (letter) => \`-\${letter.toLowerCase()}\`), params[parameter.name] as string | number]));
      const intentionId = extractIntentionId(params, ctx);
      const idempotencyKey = spec.idempotency ? (intentionId ?? String(params.idempotencyKey ?? toolCallId)) : undefined;
      const auth = extractRequestAuth(ctx);
      const response = await requestPiApiJson<JsonObject>(spec.method, resolvedPath, {
        query,
        body,
        headers,
        idempotencyKey,
        // Per-invocation credential: present keys are authoritative and
        // suppress the legacy global fallback (see extractRequestAuth).
        ...(auth.hasAuth ? { delegatedToken: auth.delegatedToken } : {}),
        ...(auth.hasAuth && auth.apiOrigin !== undefined ? { apiOrigin: auth.apiOrigin } : {}),
      });
      const projected = project(spec, response);
      if (spec.shadow) void runShadowRead(spec.name, params as unknown as Parameters<typeof runShadowRead>[1], projected);
      onUpdate?.({ content: [{ type: "text", text: \`\${spec.label}...\` }] });
      return projected;
    },
  };
}

export const generatedHttpTools = specs.map(createTool);
${specs.map((spec) => { const pascal = spec.name.replace(/(^|_)([a-z])/g, (_m, _s, letter) => letter.toUpperCase()); const symbol = `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}Tool`; return `export const ${symbol} = generatedHttpTools.find((tool) => tool.name === ${JSON.stringify(spec.name)})!;`; }).join('\n')}
`;

const validateModule = (source) => {
  const sourceFile = ts.createSourceFile('http-tools.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = sourceFile.parseDiagnostics;
  if (diagnostics.length) {
    throw new Error(`Generated module is not valid TypeScript: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`);
  }
};

const writeAtomic = (filePath, content) => {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, content);
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
};

const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== source) {
    console.error(`Generated agent tools are stale. Run: node scripts/generate-agent-tools.mjs`);
    process.exitCode = 1;
  } else {
    console.log(`Generated agent tools are up to date (${specs.length} tools)`);
  }
} else {
  validateModule(source);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeAtomic(outputPath, source);
  console.log(`Generated ${specs.length} HTTP tools from ${path.relative(root, contractPath)}`);
}

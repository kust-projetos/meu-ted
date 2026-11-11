import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { OpenCode } from '@opencode/client';
import { evaluateF2B0Attempts, F2B0_CASE_IDS, getF2B0Cases } from '../f2b0-adapter.js';
import { createCaseReservation, createExclusiveRunLock, finalizeStoppedRun, listReservationIDs, createAuthorizedRetryReservation, listAuthorizedRetryReservations, createConsumedSmokeReservation, listConsumedSmokeReservations, createFreshSmokeReservation, listFreshSmokeReservations, createRemaining22Reservation, listRemaining22Reservations, createRemaining22CampaignClaim, listRemaining22CampaignClaims, createRemaining22SupersedeCampaignClaim, createRemaining22SupersedeReservation } from './real-storage.mjs';
import {
  aggregateObservedMetric,
  applyConsumedSmokeTerminalPolicy,
  AUTHORIZED_CONSUMED_SMOKE_CASE_ID,
  AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
  AUTHORIZED_FRESH_SMOKE_CASE_ID,
  AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER,
  AUTHORIZED_RETRY_CASE_ID,
  AUTHORIZED_RETRY_SOURCE_RUN_ID,
  AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2,
  AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3,
  AUTHORIZED_REMAINING22_SOURCE_RUN_IDS,
  isAuthorizedRemaining22SourceRunID,
  REMAINING22_EXCLUDED_CASE_ID,
  REMAINING22_EXPECTED_COUNT,
  buildRemaining22Attestation,
  isAuthorizedRemaining22Source,
  classifyLocalServerFailure,
  classifyProviderFailure,
  classifyAssistantOutcome,
  buildSafeStoppedReport,
  extractCliOutput,
  isAuthorizedConsumedSingleSmokeSource,
  isAuthorizedFatalRetrySource,
  isAuthorizedFreshSmokeSource,
  isBootstrapFreshChainAllowed,
  evaluateFreshSmokeRetry,
  getMaxFreshSmokeAttempts,
  MUSE_SPARK_SLUG,
  isApprovedInfrastructureEndedCase,
  isReadinessPollRetriable,
  MAX_CASES,
  parseExecutionMode,
  resolveRealExecutionPlan,
  normalizeTokenUsage,
  summarizeRealRunMetrics,
  summarizeStoppedRun,
  REAL_CONFIRMATION,
  GO_QUOTA_CONFIRMATION,
  GO_EXTRA_USAGE_CONFIRMATION,
  AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID,
  BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION,
  REAL_MODEL,
  REAL_URL,
  validateCatalogCost,
  validateGoUsageLimits,
  evaluateGoSmoke,
  isStoppedIncompleteRun,
  evaluateRemaining22Supersede,
  redactPersistedOutput,
} from './real-guard.mjs';

const ROOT = path.resolve(import.meta.dirname);
const OUTPUT_ROOT = path.join(ROOT, 'evidence', 'real');
// P2 hygiene (branch no-retry-controlled): every path under evidence/real/
// (run dirs with private-temp/private-config/private-data/private-cache/
// private-state/work/*.db*, reservations/, plugin-hooks.ndjson) is harness-
// private and git-ignored (see .gitignore lines 5-15). Before ANY publication
// or PR that carries evidence: sanitize — remove private-*, *.db*,
// configs/keys, and any credential-bearing file. Shared results must contain
// ONLY synthetic fixtures (F2A1_INPUTS via getF2B0Cases) + verdicts/metrics,
// never raw prompts with secrets, tokens, or per-run private state.
const DEFAULT_CLI = process.platform === 'win32'
  ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@opencode', 'cli', 'node_modules', '@opencode', 'cli-windows-x64', 'bin', 'opencode.exe')
  : 'opencode';
const CLI = process.env.OPENCODE_EXE ?? DEFAULT_CLI;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RUN_TIMEOUT_MS = 120_000;

const safeID = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');
const sessionKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const jsonLines = (value: string) => value.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; }
});
const atomicCreate = async (file: string, value: unknown) => {
  const handle = await open(file, 'wx');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
};

// P1 security-reviewer (branch test/ted-f2b0-no-retry-controlled): supersede
// artifact reads are fail-closed. ONLY ENOENT counts as "absent"; any other
// read error (EACCES/EIO/...) propagates and refuses the authorization, so a
// present-but-unreadable evaluation can never release a 2nd claim.
export async function loadStoppedIncompleteFlags(
  readArtifact: (file: string) => Promise<string>,
  outputRoot: string,
  priorRunID: string,
): Promise<{ hasStoppedSummary: boolean; hasEvaluation: boolean }> {
  let hasStoppedSummary = false;
  try {
    await readArtifact(path.join(outputRoot, priorRunID, 'stopped-summary.json'));
    hasStoppedSummary = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    hasStoppedSummary = false;
  }
  let hasEvaluation = false;
  try {
    await readArtifact(path.join(outputRoot, priorRunID, 'evaluation.json'));
    hasEvaluation = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    hasEvaluation = false;
  }
  return { hasStoppedSummary, hasEvaluation };
};

const usage = () => {
  console.log([
    'F2B0 native real-run guard (does not run unless explicitly armed)',
    '  --preflight-only                       fetch catalog metadata and verify the approved Go price; no session prompt',
    '  --self-test-guard                      load native plugin and verify readiness; no session/prompt',
    `  --execute-real ${REAL_CONFIRMATION} ${GO_QUOTA_CONFIRMATION} ${GO_EXTRA_USAGE_CONFIRMATION} --smoke-only   execute one case, then stop for review`,
    `  --execute-real ${REAL_CONFIRMATION} ${GO_QUOTA_CONFIRMATION} ${GO_EXTRA_USAGE_CONFIRMATION}   execute serially (maximum 23; after smoke approval)`,
    '  --resume=<run-id>                      skip persisted cases; never replay completed IDs',
    '  --export-stopped-run=<run-id>          create one sanitized review artifact; no server/catalog/model call',
    '  --retry-authorized-case=F1-B005 --retry-authorized-run=2026-10-27T15-19-19-424Z-5620   single authorized F1-B005 smoke retry after the fatal 401; requires --execute-real --smoke-only plus exact confirmations',
    '  --consumed-smoke-authorized-case=F1-B005 --consumed-smoke-authorized-run=2026-10-29T10-55-14-534Z-21048   single authorized F1-B005 smoke attempt sourced from the consumed HTTP200 run; requires --execute-real --smoke-only plus exact confirmations; never a retry source, never resumable, no continuation even on PASS',
    '  --fresh-smoke-authorized-case=F1-B005 --fresh-smoke-authorized-run=fresh   single authorized F1-B005 fresh controlled smoke (new source S2); requires --execute-real --smoke-only plus exact confirmations; never a retry source, never resumable, no continuation even on PASS',
    '  --bootstrap-fresh-chain-F1-B005   one-time F1-B005 anchor for the muse-spark chain (creates only F1-B005.reserved in the model slug; refuses when the slug already has any reservation/claim); requires --execute-real --smoke-only plus exact confirmations; no server, no session, no prompt, no smoke evaluation',
    '  --remaining22-authorized-run=2026-10-29T12-26-34-600Z-4324|2026-10-29T20-54-25-649Z-6500   authorized 22-case campaign (F2B0_CASE_IDS minus F1-B005), serial, no B1/retry/fallback; requires --execute-real plus exact confirmations; mutually exclusive with smoke-only/resume/retry/consumed/preflight/self-test/export; single-ACTIVE-claim per source plus one -r2 supersede only for a stopped-incomplete run',
    'No flags means no model/catalog request. One global wx lock serializes all runs; stale locks/reservations require manual review and are never auto-cleared.',
    'OpenCode Go auth is supplied only through OPENCODE_GO_API_KEY environment substitution; the runner never stores the key. Native data is shared, config/database remain per-run.',
  ].join('\n'));
};

export function minimalEnvironment(runDir: string, runNonce: string, serverPassword: string) {
  const temp = path.join(runDir, 'private-temp');
  const config = path.join(runDir, 'private-config');
  const data = path.join(runDir, 'private-data');
  const cache = path.join(runDir, 'private-cache');
  const state = path.join(runDir, 'private-state');
  const nativeHome = process.env.USERPROFILE ?? homedir();
  const nativeAppData = process.env.APPDATA ?? path.join(nativeHome, 'AppData', 'Roaming');
  const nativeLocalAppData = process.env.LOCALAPPDATA ?? path.join(nativeHome, 'AppData', 'Local');
  const nativeXdgData = process.env.XDG_DATA_HOME ?? path.join(nativeHome, '.local', 'share');
  const nativeData = process.env.OPENCODE_DATA_DIR ?? path.join(nativeXdgData, 'opencode');
  return {
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      USERPROFILE: nativeHome,
      APPDATA: nativeAppData,
      LOCALAPPDATA: nativeLocalAppData,
      ...(process.env.OPENCODE_GO_API_KEY ? { OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY } : {}),
      HOME: nativeHome,
      TEMP: temp,
      TMP: temp,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: nativeXdgData,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_DATA_DIR: nativeData,
      OPENCODE_DB: path.join(data, 'opencode.db'),
      OPENCODE_CACHE_DIR: cache,
      OPENCODE_STATE_DIR: state,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_SERVER_PASSWORD: serverPassword,
      F2B0_REAL_NONCE: runNonce,
      F2B0_REAL_EVIDENCE: path.join(runDir, 'plugin-hooks.ndjson'),
    } as unknown as NodeJS.ProcessEnv,
    paths: { temp, config, data, cache, state },
  };
}

export function goProviderSettings() {
  return {
    apiKey: '{env:OPENCODE_GO_API_KEY}',
    transport: 'http',
    timeout: 90_000,
    headerTimeout: 30_000,
    chunkTimeout: 30_000,
  };
}

export async function loadGoApiKey(envFile = path.resolve(ROOT, '../../../../../.env')) {
  const inherited = process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_GO;
  if (inherited?.trim()) return inherited.trim();
  try {
    return parseEnv(await readFile(envFile, 'utf8')).OPENCODE_GO?.trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('could not read OpenCode Go credential source');
  }
}

export async function writeConfig(configDir: string, workDir: string, withPlugin: boolean) {
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    model: `${REAL_MODEL.providerID}/${REAL_MODEL.modelID}`,
    default_agent: 'build',
    compaction: { auto: false },
    warming: false,
    mcp: { servers: {} },
    skills: [],
    plugins: withPlugin ? [path.join(ROOT, 'real-plugin').replaceAll('\\', '/')] : [],
    agents: {
      build: {
        mode: 'primary',
        model: `${REAL_MODEL.providerID}/${REAL_MODEL.modelID}`,
        system: 'Return exactly one JSON object matching the supplied closed interpretation contract. Do not use tools or perform any action.',
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      },
    },
    providers: {
      [REAL_MODEL.providerID]: {
        settings: goProviderSettings(),
      },
    },
  };
  await mkdir(configDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const file = path.join(configDir, 'opencode.json');
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  try {
    const existing = await readFile(file, 'utf8');
    if (existing !== contents) throw new Error('existing isolated OpenCode config does not match requested real-run guard');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(file, contents, { flag: 'wx' });
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate loopback port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function localOnlyFetch(baseURL: string, serverPassword: string, onAuthRejected: (status: number) => void): typeof fetch {
  const basicAuth = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== baseURL) throw new Error('preflight API attempted non-loopback URL');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('authorization', basicAuth);
    const response = await fetch(input, { ...init, headers, redirect: 'error' });
    if (response.status === 401 || response.status === 403) {
      onAuthRejected(response.status);
      await response.body?.cancel().catch(() => undefined);
      const error = new Error(`local OpenCode server rejected Basic Auth (HTTP ${response.status})`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return response;
  }) as typeof fetch;
}

async function startServer(runDir: string, env: NodeJS.ProcessEnv, workDir: string, serverPassword: string) {
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawn(CLI, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const childClosed: Promise<unknown[]> = once(child, 'close');
  let stderr = '';
  let authRejectedStatus: number | null = null;
  const spawnFailure: { message?: string } = {};
  child.on('error', (error) => { spawnFailure.message = error.message; });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const client = OpenCode.make({ baseUrl: baseURL, fetch: localOnlyFetch(baseURL, serverPassword, (status) => { authRejectedStatus = status; }) });
  try {
    const until = Date.now() + 20_000;
    let info: unknown;
    while (Date.now() < until) {
      if (spawnFailure.message) throw new Error(`local OpenCode server spawn failed: ${spawnFailure.message}`);
      if (child.exitCode !== null) throw new Error(`local OpenCode server exited before ready (${child.exitCode})`);
      try { info = await client.server.info(); break; }
      catch (error) {
        if (authRejectedStatus === 401 || authRejectedStatus === 403) throw new Error(`local OpenCode readiness failed closed (Basic Auth HTTP ${authRejectedStatus})`);
        // Branch no-retry-controlled: this bounded wait polls server.info()
        // ONLY (no session, no prompt, no model call), so it can never
        // repeat inference. classifyLocalServerFailure() is fail-closed
        // (retry:false) for the inference layer; isReadinessPollRetriable()
        // gates ONLY this pre-prompt poll. Any local failure once a prompt
        // path is reachable aborts with zero resends (see per-case flow:
        // single captureCli per case, stop+finalize on first failure).
        const readiness = classifyLocalServerFailure(error);
        if (!isReadinessPollRetriable(error)) {
          const status = 'status' in readiness ? ` HTTP ${readiness.status}` : '';
          throw new Error(`local OpenCode readiness failed closed (${readiness.category}${status})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    if (!info) throw new Error(`local OpenCode server readiness timeout: ${redactPersistedOutput(stderr, serverPassword)}`);
    return { child, childClosed, client, baseURL, serverVersion: (info as any).version ?? null };
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await childClosed;
    throw error;
  }
}

async function stopServer(child: ReturnType<typeof spawn>, childClosed: Promise<unknown[]>) {
  if (child.exitCode === null) {
    child.kill();
    await childClosed;
  }
}

async function preflightCatalog(client: ReturnType<typeof OpenCode.make>, workDir: string) {
  const result = await client.model.list({ location: { directory: workDir } });
  const model = result.data.find((entry) => entry.providerID === REAL_MODEL.providerID && entry.id === REAL_MODEL.modelID);
  if (!model) throw new Error('target OpenCode Go model absent from fetched model catalog');
  const cost = validateCatalogCost(model.cost);
  if (!cost.ok) throw new Error(`catalog cost gate failed closed: ${cost.reason}`);
  return {
    source: 'OpenCode Model.Info via loopback API',
    providerID: model.providerID,
    modelID: model.id,
    displayName: model.name,
    cost: model.cost.map((tier) => ({ tier: tier.tier ?? null, input: tier.input, output: tier.output, cache: { read: tier.cache.read, write: tier.cache.write } })),
    catalogPriceAllowed: true,
    billingMode: 'opencode-go-subscription',
    tiers: cost.tiers,
  };
}

async function readGoUsage(client: ReturnType<typeof OpenCode.make>) {
  try {
    const response = await client.usage.limits({ location: { directory: ROOT } });
    return validateGoUsageLimits(response.data);
  } catch {
    return { ok: false as const, reason: 'go-usage-api-error' as const };
  }
}

function goUsageAudit(result: Awaited<ReturnType<typeof readGoUsage>>, operatorConfirmed: boolean) {
  if (result.ok) return { source: 'opencode-usage-api', usage: result.usage };
  if (result.reason === 'go-quota-limited') return { source: 'opencode-usage-api', status: result.reason, usage: result.usage ?? null };
  return { source: operatorConfirmed ? 'operator-attestation' : 'unverified', status: result.reason, usage: null };
}

async function requireGoUsage(client: ReturnType<typeof OpenCode.make>, operatorConfirmed: boolean) {
  const result = await readGoUsage(client);
  if (!result.ok && result.reason === 'go-quota-limited') {
    const window = 'window' in result && result.window ? ` (${result.window})` : '';
    throw new Error(`Go quota preflight failed closed: ${result.reason}${window}`);
  }
  if (!result.ok && !operatorConfirmed) throw new Error(`Go quota preflight requires ${GO_QUOTA_CONFIRMATION}: ${result.reason}`);
  return goUsageAudit(result, operatorConfirmed);
}

async function waitForPluginReady(evidenceFile: string, child: ReturnType<typeof spawn>, runNonce: string, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before real-run plugin readiness (${child.exitCode})`);
    const contents = await readFile(evidenceFile, 'utf8').catch(() => '');
    const events = jsonLines(contents);
    if (events.some((event) => event.runNonce === runNonce && event.event === 'guard-failed')) throw new Error('real-run plugin preflight guard failed');
    if (events.some((event) => event.runNonce === runNonce && event.event === 'plugin-ready')) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('real-run plugin readiness event missing; no session prompt was sent');
}

export async function captureCli(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, credentials: Array<string | undefined>, stdinPrompt?: string) {
  const startedAt = Date.now();
  const child = spawn(exe, args, { cwd, env, stdio: [stdinPrompt === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (!child.stdout || !child.stderr) throw new Error('CLI output pipes were not created');
  if (stdinPrompt !== undefined && !child.stdin) throw new Error('CLI stdin pipe was not created');
  let stdout = '';
  let stderr = '';
  let stdinErrorCode: string | null = null;
  let timedOut = false;
  let oversized = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) { oversized = true; child.kill(); }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.on('error', (error) => { stderr += `SPAWN_ERROR:${error.message}`; });
  if (stdinPrompt !== undefined) child.stdin!.on('error', (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    stdinErrorCode = typeof code === 'string' ? code : 'UNKNOWN';
  });
  const childClosed: Promise<unknown[]> = once(child, 'close');
  if (stdinPrompt !== undefined) child.stdin!.end(stdinPrompt);
  let timer: NodeJS.Timeout | undefined;
  const completed = childClosed.then(([code]) => ({ exitCode: typeof code === 'number' ? code : null }));
  const timed = new Promise<{ exitCode: number | null }>((resolve) => {
    timer = setTimeout(async () => {
      timedOut = true;
      child.kill();
      const [code] = await childClosed;
      resolve({ exitCode: typeof code === 'number' ? code : null });
    }, RUN_TIMEOUT_MS);
  });
  const { exitCode } = await Promise.race([completed, timed]);
  if (timer) clearTimeout(timer);
  const secrets = credentials.filter((value): value is string => typeof value === 'string');
  const rawStdout = redactPersistedOutput(stdout, secrets);
  const parsed = extractCliOutput(rawStdout);
  return {
    exitCode,
    timedOut,
    oversized,
    stdinErrorCode,
    durationMs: Date.now() - startedAt,
    rawStdout,
    text: redactPersistedOutput(parsed.text, secrets),
    eventTypes: parsed.eventTypes,
    usage: parsed.usage,
    cost: parsed.cost,
    terminalErrors: parsed.events.filter((event) => event.type === 'error').map((event) => ({
      type: event.error?.type ?? event.error?.code ?? 'unknown',
      ...(typeof event.error?.status === 'number' ? { status: event.error.status } : {}),
      message: redactPersistedOutput(String(event.error?.message ?? '').slice(0, 240), secrets),
    })),
    stderr: redactPersistedOutput(stderr, secrets),
  };
}

export function classifyStdinWriteError(errorCode: string | null) {
  return errorCode === null ? null : { stop: true as const, category: 'stdin-write-error' as const, errorCode };
}

export function diagnoseReadback(messages: unknown, expectedPrompt: string) {
  const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const sanitizedNull = {
    messageCount: 0,
    typeCounts: { user: 0, assistant: 0, other: 0, missing: 0 } as Record<string, number>,
    userMessageCount: 0,
    assistantMessageCount: 0,
    structureValid: false,
    structureReason: 'not-array' as string | null,
    promptConfirmed: false,
    userTextLength: null as number | null,
    userTextSha256: null as string | null,
    assistantTextLength: null as number | null,
    assistantTextSha256: null as string | null,
  };
  if (!Array.isArray(messages)) return { ...sanitizedNull, structureReason: 'not-array' };
  const typeCounts: Record<string, number> = { user: 0, assistant: 0, other: 0, missing: 0 };
  for (const message of messages) {
    const rawType = (message as any)?.type;
    if (typeof rawType !== 'string') typeCounts.missing += 1;
    else if (rawType === 'user') typeCounts.user += 1;
    else if (rawType === 'assistant') typeCounts.assistant += 1;
    else typeCounts.other += 1;
  }
  const base = {
    messageCount: messages.length,
    typeCounts,
    userMessageCount: messages.filter((message: any) => message?.type === 'user').length,
    assistantMessageCount: messages.filter((message: any) => message?.type === 'assistant').length,
  };
  if (messages.some((message: any) => typeof message?.type !== 'string')) {
    return {
      ...base,
      structureValid: false,
      structureReason: 'message-missing-type' as string | null,
      promptConfirmed: false,
      userTextLength: null,
      userTextSha256: null,
      assistantTextLength: null,
      assistantTextSha256: null,
    };
  }
  const joinContentText = (content: unknown): string | null => {
    if (!Array.isArray(content)) return null;
    return (content as Array<any>)
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('');
  };
  const topLevelTextOf = (message: any): string | null =>
    typeof message?.text === 'string' ? (message.text as string) : null;
  const effectiveRoleText = (message: any): string => {
    const fromContent = joinContentText((message as any)?.content);
    const fromTop = topLevelTextOf(message);
    if (fromContent !== null && fromTop !== null) return fromContent === fromTop ? fromContent : `${fromContent}${fromTop}`;
    return fromContent ?? fromTop ?? '';
  };
  const collectText = (type: string) => messages
    .filter((message: any) => message?.type === type)
    .map((message: any) => effectiveRoleText(message))
    .join('');
  const userText = collectText('user');
  const assistantText = collectText('assistant');
  return {
    ...base,
    structureValid: true,
    structureReason: null,
    promptConfirmed: isPromptConfirmed(messages, expectedPrompt),
    userTextLength: userText.length,
    userTextSha256: sha256(userText),
    assistantTextLength: assistantText.length,
    assistantTextSha256: sha256(assistantText),
  };
}

export function isPromptConfirmed(messages: unknown, expectedPrompt: string) {
  if (!Array.isArray(messages)) return false;
  const userMessages = messages.filter((message: any) => message?.type === 'user');
  if (userMessages.length !== 1) return false;
  const candidate = userMessages[0] as any;
  if (candidate !== null && typeof candidate === 'object') {
    if ('content' in candidate && candidate.content !== undefined && !Array.isArray(candidate.content)) return false;
    if ('text' in candidate && candidate.text !== undefined && typeof candidate.text !== 'string') return false;
    if (Array.isArray(candidate.content) && (candidate.content as Array<any>).some((part: any) => part?.type === 'text' && typeof part?.text !== 'string')) return false;
    const fromContent: string | null = Array.isArray(candidate.content)
      ? (candidate.content as Array<any>)
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('')
      : null;
    const fromTop: string | null = typeof candidate.text === 'string' ? candidate.text : null;
    if (fromContent === null && fromTop === null) return false;
    if (fromContent !== null && fromTop !== null && fromContent !== fromTop) return false;
    const text = fromContent !== null && fromTop !== null ? fromContent : (fromContent ?? fromTop ?? '');
    return text === expectedPrompt;
  }
  return false;
}

export type AssistantApiTextResult = { text: string; valid: boolean; reason: string };

export function extractAssistantApiText(assistantMessages: unknown): AssistantApiTextResult {
  if (!Array.isArray(assistantMessages)) return { text: '', valid: false, reason: 'not-array' };
  if (assistantMessages.length === 0) return { text: '', valid: false, reason: 'empty' };
  let invalidReason: string | null = null;
  const parts: string[] = [];
  for (const message of assistantMessages as Array<any>) {
    if (message === null || typeof message !== 'object') { invalidReason ??= 'invalid-message'; continue; }
    const hasContent = 'content' in message && (message as any).content !== undefined;
    const hasTop = 'text' in message && (message as any).text !== undefined;
    if (hasContent && !Array.isArray((message as any).content)) { invalidReason ??= 'invalid-content-shape'; continue; }
    if (hasTop && typeof (message as any).text !== 'string') { invalidReason ??= 'invalid-text-shape'; continue; }
    if (Array.isArray((message as any)?.content) && ((message as any).content as Array<any>).some((part: any) => part?.type === 'text' && typeof part?.text !== 'string')) { invalidReason ??= 'invalid-text-part'; }
    const fromContent: string | null = Array.isArray((message as any)?.content)
      ? ((message as any).content as Array<any>)
        .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
        .map((part: any) => part.text)
        .join('')
      : null;
    const fromTop: string | null = typeof (message as any)?.text === 'string' ? (message as any).text : null;
    if (fromContent !== null && fromTop !== null) {
      if (fromContent !== fromTop) { invalidReason ??= 'ambiguous-dual-representation'; parts.push(`${fromContent}${fromTop}`); }
      else parts.push(fromContent);
      continue;
    }
    if (fromContent === null && fromTop === null) { invalidReason ??= 'invalid-message'; continue; }
    parts.push(fromContent ?? fromTop ?? '');
  }
  const text = parts.join('');
  if (invalidReason !== null) return { text, valid: false, reason: invalidReason };
  if (text.length === 0) return { text, valid: false, reason: 'no-text-content' };
  return { text, valid: true, reason: 'ok' };
}

export function decideAssistantTextStop(extraction: unknown, stdoutText: unknown): { stop: true; category: string; reason?: string } | null {
  const result = (extraction !== null && typeof extraction === 'object' ? extraction as AssistantApiTextResult : null);
  if (!result || result.valid !== true || typeof result.text !== 'string') {
    const reason = result && typeof (result as any).reason === 'string' ? (result as any).reason : 'invalid-extraction';
    return { stop: true, category: 'assistant-text-invalid', reason };
  }
  if (typeof stdoutText !== 'string' || result.text !== stdoutText) return { stop: true, category: 'cli-api-output-mismatch' };
  return null;
}

export function isFreshSmokeResumeBlocked(input?: {
  resumeID?: string;
  smoke?: { freshSmoke?: unknown; sourceMarker?: unknown } | null;
  freshReservationFiles?: string[] | null;
  freshReservationRunIDs?: string[] | null;
}): boolean {
  const resumeID = input?.resumeID;
  if (typeof resumeID !== 'string' || resumeID.length === 0) return false;
  const smoke = input?.smoke as { freshSmoke?: unknown; sourceMarker?: unknown } | null | undefined;
  if (smoke && (smoke.freshSmoke === true || smoke.sourceMarker === AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER)) return true;
  const runIDs = input?.freshReservationRunIDs;
  if (Array.isArray(runIDs) && runIDs.includes(resumeID)) return true;
  const files = input?.freshReservationFiles;
  if (Array.isArray(files) && files.some((file) => typeof file === 'string' && file.endsWith(`${safeID(resumeID)}.json`))) return true;
  return false;
}

// Branch test/ted-f2b0-no-retry-controlled: controlled fresh-smoke retry.
// Loads evidence/real/<runID>/smoke-evaluation.json for every prior fresh
// reservation; a missing/unreadable evaluation refuses fail-closed (no
// inference). A single PASS is preserved; only all-FAIL/INCONCLUSIVE priors
// allow one new reservation with a distinct runID (old files preserved).
async function loadFreshSmokeRetryEvaluations(priorFreshFiles: string[]): Promise<any[]> {
  const evaluations: any[] = [];
  for (const file of priorFreshFiles) {
    let reservation: any = null;
    try {
      reservation = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new Error('fresh smoke refused: prior fresh reservation unreadable (fail-closed)');
    }
    const priorRunID = (reservation as any)?.runID;
    if (typeof priorRunID !== 'string' || priorRunID.length === 0) throw new Error('fresh smoke refused: prior fresh reservation runID missing (fail-closed)');
    try {
      evaluations.push(JSON.parse(await readFile(path.join(OUTPUT_ROOT, priorRunID, 'smoke-evaluation.json'), 'utf8')));
    } catch {
      throw new Error(`fresh smoke refused: prior fresh smoke evaluation missing or unreadable for ${priorRunID} (fail-closed)`);
    }
  }
  return evaluations;
}

async function atomicCaseResult(file: string, value: unknown) {
  const handle = await open(file, 'wx');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

async function exportStoppedRun(runID: string) {
  const expectedRunID = '2026-10-27T01-04-23-758Z-13588';
  const mockRunID = '2026-10-26T23-56-15-510Z-7596';
  const selfTestRunID = '2026-10-27T01-13-36-063Z-17984';
  if (runID !== expectedRunID) throw new Error('safe publication export is limited to the reviewed stopped run');
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const lock = await createExclusiveRunLock(path.join(OUTPUT_ROOT, '.f2b0-real-run.lock'), { runID: `safe-export-${runID}`, pid: process.pid });
  try {
    const sourceRunDir = path.join(OUTPUT_ROOT, runID);
    const manifest = JSON.parse(await readFile(path.join(sourceRunDir, 'manifest.json'), 'utf8'));
    const infraCase = JSON.parse(await readFile(path.join(sourceRunDir, 'cases', 'F1-B005.json'), 'utf8'));
    const providerCase = JSON.parse(await readFile(path.join(sourceRunDir, 'cases', 'F1-B010.json'), 'utf8'));
    const stoppedSummaryFile = path.join(sourceRunDir, 'stopped-summary.json');
    const stoppedSummary = summarizeStoppedRun(runID, manifest.caseIDs, [infraCase, providerCase]);
    try { await atomicCreate(stoppedSummaryFile, stoppedSummary); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(stoppedSummaryFile, 'utf8'));
      if (existing.runID !== runID || existing.status !== stoppedSummary.status) throw new Error('existing stopped summary does not match this run');
    }
    const catalogPreflight = JSON.parse(await readFile(path.join(sourceRunDir, 'catalog-preflight.json'), 'utf8'));
    const guardSelfTest = JSON.parse(await readFile(path.join(OUTPUT_ROOT, selfTestRunID, 'guard-self-test.json'), 'utf8'));
    const mockDirectory = path.join(ROOT, 'evidence');
    const mockSummary = JSON.parse(await readFile(path.join(mockDirectory, `${mockRunID}-summary.json`), 'utf8'));
    const mockRows = [];
    let capturedRequests = 0;
    let allCapturedRequestsAuthless = true;
    for (const item of mockSummary.cases) {
      const artifact = JSON.parse(await readFile(path.join(mockDirectory, `${mockRunID}-${item.mode}.json`), 'utf8'));
      const requests = Array.isArray(artifact.requests) ? artifact.requests : [];
      capturedRequests += requests.length;
      if (requests.some((request: any) => request.authorizationPresent !== false)) allCapturedRequestsAuthless = false;
      if (requests.some((request: any) => request.toolsCount !== 0)) throw new Error(`mock proof contains tool payload in ${item.mode}`);
      mockRows.push({
        mode: item.mode,
        exitCode: item.exitCode,
        acceptedLocalConnections: item.acceptedLocalConnections,
        requestsReceived: item.physicalRequestsReceived,
        retryAttempts: item.retryAttempts,
        toolCounts: item.toolCounts,
        terminalErrorTypes: item.terminalErrors.map((error: any) => error.type),
        assistantText: item.assistantText,
      });
    }
    const mockProof = {
      runID: mockRunID,
      cliVersion: mockSummary.cliVersion,
      nativeEndpoint: mockSummary.nativeEndpoint,
      cases: mockRows.length,
      capturedRequests,
      allCapturedRequestsAuthless,
      caseResults: mockRows,
    };
    const report = buildSafeStoppedReport({
      runID,
      caseIDs: manifest.caseIDs,
      infraCase,
      providerCase,
      catalogPreflight,
      guardSelfTest,
      mockProof,
    });
    const published: Record<string, any> = {
      ...report,
      sourceArtifacts: { realStopRunID: runID, mockProofRunID: mockRunID, nativePluginSelfTestRunID: selfTestRunID },
    };
    const destination = path.join(OUTPUT_ROOT, 'published-b0-stop.json');
    let artifact = published;
    let alreadyExists = false;
    try { await atomicCreate(destination, published); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      artifact = JSON.parse(await readFile(destination, 'utf8'));
      if (artifact.sourceRunID !== runID || artifact.schemaVersion !== 'f2b0-safe-stop-v1') throw new Error('existing publication artifact belongs to another run');
      alreadyExists = true;
    }
    console.log(JSON.stringify({ status: artifact.status, file: path.relative(ROOT, destination), alreadyExists, counts: artifact.counts, inferenceRequestsExecutedByExporter: 0 }, null, 2));
  } finally {
    await lock.release();
  }
}

async function main(argv: string[]) {
  const options = parseExecutionMode(argv);
  if (options.help) { usage(); return; }
  if (options.exportStoppedRunID) {
    await exportStoppedRun(options.exportStoppedRunID);
    return;
  }
  if ((options as any).bootstrapFreshChain) {
    // One-time chain anchor: creates ONLY F1-B005.reserved in the muse-spark
    // slug so the existing fresh-smoke -> remaining22 chain can run. No
    // credential is loaded, no server is started, no session/prompt/model
    // call happens, and no smoke evaluation is created here.
    await mkdir(OUTPUT_ROOT, { recursive: true });
    const bootstrapLock = await createExclusiveRunLock(path.join(OUTPUT_ROOT, '.f2b0-real-run.lock'), { runID: 'bootstrap-fresh-chain', pid: process.pid });
    try {
      const reservationDir = path.join(OUTPUT_ROOT, 'reservations', safeID(`${REAL_MODEL.providerID}-${REAL_MODEL.modelID}`));
      await mkdir(reservationDir, { recursive: true });
      const slugState = {
        caseID: AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID,
        reservationIDs: await listReservationIDs(reservationDir),
        freshReservations: await listFreshSmokeReservations(reservationDir, AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID),
        consumedReservations: await listConsumedSmokeReservations(reservationDir, AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID),
        retryReservations: await listAuthorizedRetryReservations(reservationDir, AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID),
        remaining22Reservations: await listRemaining22Reservations(reservationDir),
        campaignClaims: await listRemaining22CampaignClaims(reservationDir),
      };
      const allowed = isBootstrapFreshChainAllowed(slugState);
      if (!allowed.ok) throw new Error(`bootstrap fresh chain refused: slug already has reservations/claims (${(allowed as any).reason}); single-use per slug`);
      const runID = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`;
      const runNonce = randomUUID();
      const reservationFile = await createCaseReservation(reservationDir, AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID, {
        runID,
        runNonce,
        provider: REAL_MODEL.providerID,
        model: REAL_MODEL.modelID,
        nativeURL: REAL_URL,
        authorization: BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION,
        bootstrapFreshChain: true,
      });
      console.log(JSON.stringify({ status: 'bootstrap-fresh-chain-anchored', caseID: AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID, reservation: path.relative(OUTPUT_ROOT, reservationFile), runID, inferenceRequestsExecutedByBootstrap: 0, smokeEvaluationCreated: false }, null, 2));
    } finally {
      await bootstrapLock.release();
    }
    return;
  }
  const goApiKey = await loadGoApiKey();
  if (!goApiKey) throw new Error('OPENCODE_GO credential is required for this F2B0 mode');
  process.env.OPENCODE_GO_API_KEY = goApiKey;
  const cases = options.selfTestGuard ? [] : getF2B0Cases();
  if (!options.selfTestGuard && (cases.length !== MAX_CASES || F2B0_CASE_IDS.length !== MAX_CASES)) throw new Error('F2B0 manifest changed: expected exactly 23 cases');
  const runID = options.resumeID ?? `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`;
  const runNonce = randomUUID();
  const serverPassword = randomBytes(32).toString('base64url');
  const runDir = path.join(OUTPUT_ROOT, runID);
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const envState = minimalEnvironment(runDir, runNonce, serverPassword);
  const configDir = envState.paths.config;
  const workDir = path.join(runDir, 'work');
  await mkdir(runDir, { recursive: true });
  for (const directory of Object.values(envState.paths)) await mkdir(directory, { recursive: true });
  const runLock = await createExclusiveRunLock(path.join(OUTPUT_ROOT, '.f2b0-real-run.lock'), { runID, pid: process.pid });
  try {
  await writeConfig(configDir, workDir, !options.preflightOnly);
  const evidenceFile = path.join(runDir, 'plugin-hooks.ndjson');
  await writeFile(evidenceFile, '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST' || !options.resumeID) throw error;
  });
  if (options.selfTestGuard) {
    const server = await startServer(runDir, envState.env, workDir, serverPassword);
    try {
      const catalog = await preflightCatalog(server.client, workDir);
      const goUsage = goUsageAudit(await readGoUsage(server.client), options.quotaConfirmation);
      const readyEvents = await waitForPluginReady(evidenceFile, server.child, runNonce);
      const currentEvents = readyEvents.filter((event) => event.runNonce === runNonce);
      const ready = currentEvents.find((event) => event.event === 'plugin-ready');
      if (!ready || ready.provider !== REAL_MODEL.providerID || ready.model !== REAL_MODEL.modelID || catalog.catalogPriceAllowed !== true || ready.mcpCount !== 0 || ready.skillCount !== 0 || ready.otherPluginCount !== 0) {
        throw new Error('native guard self-test failed readiness invariant');
      }
      if (currentEvents.some((event) => ['http-request-allowed', 'retry-decision', 'http-response'].includes(event.event))) {
        throw new Error('native guard self-test unexpectedly reached model HTTP transport');
      }
      const result = {
        mode: 'native-plugin-self-test-no-inference',
        runID,
        pluginReady: true,
        providerID: REAL_MODEL.providerID,
        modelID: REAL_MODEL.modelID,
        nativeURL: REAL_URL,
        catalog,
        goUsage,
        extraUsageStatus: options.extraUsageConfirmation ? 'operator-attested-disabled' : 'not-attested-in-this-invocation',
        mcpCount: ready.mcpCount,
        skillCount: ready.skillCount,
        otherPluginCount: ready.otherPluginCount,
        promptRequests: 0,
        inferenceRequests: 0,
        authMode: 'opencode-go-api-key-env',
      };
      await atomicCreate(path.join(runDir, 'guard-self-test.json'), result);
      console.log(JSON.stringify(result, null, 2));
    } finally { await stopServer(server.child, server.childClosed); }
    return;
  }
  if (options.preflightOnly) {
    // Auth/cost preflight is independent of persisted case reservations and never creates a session or prompt.
    const server = await startServer(runDir, envState.env, workDir, serverPassword);
    try {
      const catalog = await preflightCatalog(server.client, workDir);
      const goUsage = goUsageAudit(await readGoUsage(server.client), options.quotaConfirmation);
      const result = { mode: 'catalog-preflight-only', catalog, goUsage, authMode: 'opencode-go-api-key-env', extraUsageStatus: options.extraUsageConfirmation ? 'operator-attested-disabled' : 'not-attested-in-this-invocation', inferenceRequests: 0 };
      await atomicCreate(path.join(runDir, 'preflight.json'), result);
      console.log(JSON.stringify(result, null, 2));
    } finally { await stopServer(server.child, server.childClosed); }
    return;
  }
  const caseDir = path.join(runDir, 'cases');
  await mkdir(caseDir, { recursive: true });
  const reservationDir = path.join(OUTPUT_ROOT, 'reservations', safeID(`${REAL_MODEL.providerID}-${REAL_MODEL.modelID}`));
  await mkdir(reservationDir, { recursive: true });
    const manifestFile = path.join(runDir, 'manifest.json');
  const manifest = {
    runID,
    provider: REAL_MODEL.providerID,
    model: REAL_MODEL.modelID,
    nativeURL: REAL_URL,
    caseIDs: cases.map((item) => item.id),
    authMode: 'opencode-go-api-key-env',
    createdAt: new Date().toISOString(),
    prompts: cases.map((item) => ({ id: item.id, input: item.input, prompt: item.prompt })),
  };
  if (options.resumeID) {
    const existing = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (existing.model !== REAL_MODEL.modelID || existing.authMode !== manifest.authMode || JSON.stringify(existing.caseIDs) !== JSON.stringify(manifest.caseIDs) || JSON.stringify(existing.prompts) !== JSON.stringify(manifest.prompts)) throw new Error('resume manifest differs from this F2B0 model/case/Go-auth state');
    const smokeFile = path.join(runDir, 'smoke-evaluation.json');
    const smoke = JSON.parse(await readFile(smokeFile, 'utf8').catch(() => { throw new Error('resume requires a persisted one-case smoke evaluation') }));
    const freshReservationFiles = await listFreshSmokeReservations(reservationDir, AUTHORIZED_FRESH_SMOKE_CASE_ID);
    const freshReservationRunIDs: string[] = [];
    for (const file of freshReservationFiles) {
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (typeof record.runID === 'string') freshReservationRunIDs.push(record.runID);
    }
    if (isFreshSmokeResumeBlocked({ resumeID: options.resumeID, smoke, freshReservationFiles, freshReservationRunIDs })) throw new Error('resume blocked: fresh smoke run is terminal single-use; continuation is never allowed');
    if (smoke.status !== 'SMOKE_PASS' || smoke.continuationAllowed !== true) throw new Error('resume blocked: smoke did not pass with a current Go quota readback');
  } else await atomicCreate(manifestFile, manifest);

  const existingIDs: string[] = [];
  const reservedIDs = await listReservationIDs(reservationDir);
  for (const item of cases) {
    const file = path.join(caseDir, `${safeID(item.id)}.json`);
    try {
      const prior = JSON.parse(await readFile(file, 'utf8'));
      if (prior.fatal === true && !isApprovedInfrastructureEndedCase(runID, prior)) throw new Error(`prior fatal result for ${item.id} prevents resume`);
      if (prior.status === 'infrastructure-ended-zero-attempt' && !isApprovedInfrastructureEndedCase(runID, prior)) throw new Error(`unapproved infrastructure-ended result for ${item.id} prevents resume`);
      existingIDs.push(item.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
    if (existingIDs.some((id) => !reservedIDs.includes(id))) throw new Error('existing case result lacks its durable reservation');
    const { plan, executionPlan, authorized, campaign } = resolveRealExecutionPlan({
      caseIDs: cases.map((item) => item.id),
      existingIDs,
      reservedIDs,
      options: { resumeID: options.resumeID, smokeOnly: options.smokeOnly, retryCaseID: options.retryCaseID, retryRunID: options.retryRunID, consumedSmokeCaseID: options.consumedSmokeCaseID, consumedSmokeRunID: options.consumedSmokeRunID, freshSmokeCaseID: (options as any).freshSmokeCaseID, freshSmokeRunID: (options as any).freshSmokeRunID, remaining22RunID: (options as any).remaining22RunID },
    }) as { plan: { run: string[]; skipped: string[]; unresolvedReservations: string[] }; executionPlan: { run: string[]; deferred: string[] }; authorized: boolean; campaign?: string };
    const isRemaining22 = (options as any).remaining22RunID !== undefined;
    let authorizedRetryReservationFile: string | null = null;
    let consumedSmokeReservationFile: string | null = null;
    let freshSmokeReservationFile: string | null = null;
    let remaining22SupersedeRunID: string | null = null;
    if (authorized && options.retryCaseID !== undefined) {
      let reservationRecord: any = null;
      try {
        reservationRecord = JSON.parse(await readFile(path.join(reservationDir, `${safeID(AUTHORIZED_RETRY_CASE_ID)}.reserved`), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('authorized retry refused: historic reservation is missing');
        throw error;
      }
      let sourceResult: any = null;
      try {
        sourceResult = JSON.parse(await readFile(path.join(OUTPUT_ROOT, AUTHORIZED_RETRY_SOURCE_RUN_ID, 'cases', `${safeID(AUTHORIZED_RETRY_CASE_ID)}.json`), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('authorized retry refused: associated fatal result is missing');
        throw error;
      }
      const check = isAuthorizedFatalRetrySource({ caseID: options.retryCaseID, sourceRunID: options.retryRunID, reservationRecord, sourceResult });
      if (!check.ok) throw new Error(`authorized retry refused: ${check.reason}`);
      const priorRetries = await listAuthorizedRetryReservations(reservationDir, AUTHORIZED_RETRY_CASE_ID);
      if (priorRetries.length > 0) throw new Error('authorized retry already consumed; refusing second attempt');
    }
    if (authorized && options.consumedSmokeCaseID !== undefined) {
      let historicReservation: any = null;
      try {
        historicReservation = JSON.parse(await readFile(path.join(reservationDir, `${safeID(AUTHORIZED_RETRY_CASE_ID)}.reserved`), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('consumed smoke refused: historic 401 reservation is missing');
        throw error;
      }
      let fatalSource: any = null;
      try {
        fatalSource = JSON.parse(await readFile(path.join(OUTPUT_ROOT, AUTHORIZED_RETRY_SOURCE_RUN_ID, 'cases', `${safeID(AUTHORIZED_RETRY_CASE_ID)}.json`), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('consumed smoke refused: associated fatal 401 result is missing');
        throw error;
      }
      const fatalCheck = isAuthorizedFatalRetrySource({ caseID: AUTHORIZED_RETRY_CASE_ID, sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: historicReservation, sourceResult: fatalSource });
      if (!fatalCheck.ok) throw new Error(`consumed smoke refused: historic chain broken (${fatalCheck.reason})`);
      let consumedReservation: any = null;
      try {
        consumedReservation = JSON.parse(await readFile(path.join(reservationDir, `${safeID(AUTHORIZED_CONSUMED_SMOKE_CASE_ID)}.authorized-retry-${safeID(AUTHORIZED_CONSUMED_SMOKE_RUN_ID)}.json`), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('consumed smoke refused: consumed HTTP200 reservation is missing');
        throw error;
      }
      let consumedResult: any = null;
      try {
        consumedResult = JSON.parse(await readFile(path.join(OUTPUT_ROOT, AUTHORIZED_CONSUMED_SMOKE_RUN_ID, 'cases', `${safeID(AUTHORIZED_CONSUMED_SMOKE_CASE_ID)}.json`), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('consumed smoke refused: consumed HTTP200 result is missing');
        throw error;
      }
      const consumedCheck = isAuthorizedConsumedSingleSmokeSource({ caseID: options.consumedSmokeCaseID, runID: options.consumedSmokeRunID, reservationRecord: consumedReservation, sourceResult: consumedResult });
      if (!consumedCheck.ok) throw new Error(`consumed smoke refused: ${consumedCheck.reason}`);
      const priorConsumed = await listConsumedSmokeReservations(reservationDir, AUTHORIZED_CONSUMED_SMOKE_CASE_ID);
      if (priorConsumed.length > 0) throw new Error('consumed smoke already consumed; refusing second attempt');
    }
    if (authorized && (options as any).freshSmokeCaseID !== undefined) {
      let historicReservation: any = null;
      try {
        historicReservation = JSON.parse(await readFile(path.join(reservationDir, `${safeID(AUTHORIZED_FRESH_SMOKE_CASE_ID)}.reserved`), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('fresh smoke refused: historic F1-B005 reservation is missing');
        throw error;
      }
      if (historicReservation.caseID !== AUTHORIZED_FRESH_SMOKE_CASE_ID || historicReservation.status !== 'reserved') throw new Error('fresh smoke refused: historic reservation mismatch');
      const freshCheck = isAuthorizedFreshSmokeSource({ caseID: (options as any).freshSmokeCaseID, sourceMarker: (options as any).freshSmokeRunID });
      if (!freshCheck.ok) throw new Error(`fresh smoke refused: ${freshCheck.reason}`);
      const priorFresh = await listFreshSmokeReservations(reservationDir, AUTHORIZED_FRESH_SMOKE_CASE_ID);
      if (priorFresh.length > 0) {
        const priorEvaluations = await loadFreshSmokeRetryEvaluations(priorFresh);
        const retryCheck = evaluateFreshSmokeRetry(priorEvaluations, MUSE_SPARK_SLUG);
        if (!retryCheck.ok) throw new Error(`fresh smoke refused: ${retryCheck.reason}; single PASS preserved, all-FAIL/INCONCLUSIVE only, max ${getMaxFreshSmokeAttempts(MUSE_SPARK_SLUG)} attempts per slug`);
      }
    }
    if (isRemaining22) {
      // Static plan-shape asserts only (no I/O, no claim): fail fast before starting any server.
      // Historic validation and the single durable campaign claim happen after all
      // inference-free preflights plus plugin readiness, under the same lock,
      // immediately before the first prompt/reservation (see below).
      const sourceRunID = (options as any).remaining22RunID as string;
      if (!isAuthorizedRemaining22SourceRunID(sourceRunID)) throw new Error(`remaining22 campaign is limited to source allowlist [${AUTHORIZED_REMAINING22_SOURCE_RUN_IDS.join(',')}]`);
      if (campaign !== 'remaining22') throw new Error('remaining22 campaign plan mismatch');
      if (executionPlan.run.length !== REMAINING22_EXPECTED_COUNT) throw new Error('remaining22 campaign must run exactly 22 cases');
      if (executionPlan.run.includes(REMAINING22_EXCLUDED_CASE_ID)) throw new Error('remaining22 campaign must never re-execute the historic smoke case');
      const canonicalCampaignOrdered = cases.map((item) => item.id).filter((id) => id !== REMAINING22_EXCLUDED_CASE_ID);
      if (JSON.stringify(executionPlan.run) !== JSON.stringify(canonicalCampaignOrdered)) throw new Error('remaining22 campaign run must equal F2B0_CASE_IDS minus F1-B005 in canonical order');
    }
    const server = await startServer(runDir, envState.env, workDir, serverPassword);
    let completed = false;
    try {
    const catalog = await preflightCatalog(server.client, workDir);
    const goUsage = await requireGoUsage(server.client, options.quotaConfirmation && !options.resumeID);
    const preflight = { catalog, goUsage, authMode: 'opencode-go-api-key-env', extraUsageStatus: options.extraUsageConfirmation ? 'operator-attested-disabled' : 'not-attested-in-this-invocation', inferenceRequests: 0 };
    const preflightFile = path.join(runDir, 'catalog-preflight.json');
    if (!options.resumeID) await atomicCreate(preflightFile, preflight);
    else {
      const old = JSON.parse(await readFile(preflightFile, 'utf8'));
      if (old.catalog?.catalogPriceAllowed !== true) throw new Error('stored resume preflight does not prove the approved Go catalog price');
    }
    if (!options.execute) throw new Error('no inference attempted: use --execute-real plus exact confirmation after separate approval');

    if (isRemaining22) {
      // Single durable campaign claim, created wx+sync AFTER all inference-free
      // preflights plus plugin readiness, under the same global lock, and BEFORE
      // the first prompt/reservation. Any preflight/readiness failure throws
      // before this point, so nothing is consumed. History is re-validated here
      // (immediately before the claim) so the check cannot go stale.
      const sourceRunID = (options as any).remaining22RunID as string;
      const readyEvents = await waitForPluginReady(evidenceFile, server.child, runNonce);
      if (!readyEvents.some((event) => event.runNonce === runNonce && event.event === 'plugin-ready' && event.provider === REAL_MODEL.providerID && event.model === REAL_MODEL.modelID && event.mcpCount === 0 && event.skillCount === 0)) {
        throw new Error('remaining22 campaign refused: plugin cost/skills/MCP readiness proof is incomplete; no prompt was sent');
      }
      const preClaimEvents = jsonLines(await readFile(evidenceFile, 'utf8'));
      if (preClaimEvents.some((event) => event.event === 'http-request-allowed')) throw new Error('remaining22 campaign refused: model request observed before campaign claim');
      if (preClaimEvents.some((event) => event.event === 'guard-failed')) throw new Error('remaining22 campaign refused: guard failed before campaign claim');
      const sourceRunDir = path.join(OUTPUT_ROOT, sourceRunID);
      let sourceManifest: any = null;
      let sourceSmoke: any = null;
      let sourceCase: any = null;
      let sourceCatalog: any = null;
      let sourceHooks: any[] = [];
      let sourceReservation: any = null;
      try {
        sourceManifest = JSON.parse(await readFile(path.join(sourceRunDir, 'manifest.json'), 'utf8'));
        sourceSmoke = JSON.parse(await readFile(path.join(sourceRunDir, 'smoke-evaluation.json'), 'utf8'));
        sourceCase = JSON.parse(await readFile(path.join(sourceRunDir, 'cases', `${safeID(REMAINING22_EXCLUDED_CASE_ID)}.json`), 'utf8'));
        sourceCatalog = JSON.parse(await readFile(path.join(sourceRunDir, 'catalog-preflight.json'), 'utf8'));
        sourceHooks = jsonLines(await readFile(path.join(sourceRunDir, 'plugin-hooks.ndjson'), 'utf8'));
        const expectedReservationFile = (sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2 || sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3)
          ? `${safeID(REMAINING22_EXCLUDED_CASE_ID)}.fresh-smoke-${safeID(sourceRunID)}.json`
          : `${safeID(REMAINING22_EXCLUDED_CASE_ID)}.consumed-smoke-${safeID(AUTHORIZED_CONSUMED_SMOKE_RUN_ID)}.json`;
        sourceReservation = JSON.parse(await readFile(path.join(reservationDir, expectedReservationFile), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('remaining22 campaign refused: historic source artifact is missing');
        throw error;
      }
      const canonical = { caseIDs: cases.map((item) => item.id), prompts: cases.map((item) => ({ id: item.id, input: (item as any).input, prompt: (item as any).prompt })) };
      const sourceCheck = isAuthorizedRemaining22Source({ sourceRunID, manifest: sourceManifest, smokeEvaluation: sourceSmoke, caseResult: sourceCase, catalogPreflight: sourceCatalog, hookEvents: sourceHooks, reservationRecord: sourceReservation, canonical });
      if (!sourceCheck.ok) throw new Error(`remaining22 campaign refused: historic source integrity failed (${(sourceCheck as any).reason})`);
      if (typeof sourceCase.text !== 'string' || sourceCase.text.length === 0) throw new Error('remaining22 campaign refused: historic case text is not a non-empty string');
      if (typeof sourceSmoke.responseText !== 'string' || sourceSmoke.responseText.length === 0) throw new Error('remaining22 campaign refused: historic smoke response is not a non-empty string');
      if (sourceCase.text !== sourceSmoke.responseText) throw new Error('remaining22 campaign refused: historic case text does not equal smoke response');
      if (typeof sourceCase.reservation !== 'string' || sourceCase.reservation.length === 0) throw new Error('remaining22 campaign refused: historic case reservation path is missing');
      const historicReeval = evaluateF2B0Attempts([{ id: REMAINING22_EXCLUDED_CASE_ID, raw: sourceCase.text }]);
      const historicParsed = (historicReeval.results as Record<string, { jsonValid: boolean; schemaValid: boolean }>)[REMAINING22_EXCLUDED_CASE_ID];
      if (!historicParsed || historicParsed.jsonValid !== true || historicParsed.schemaValid !== true) throw new Error('remaining22 campaign refused: historic response failed parser/schema re-evaluation');
      const historicOracle = historicReeval.evaluation.scenarios.find((row: { corpusId: string }) => row.corpusId === REMAINING22_EXCLUDED_CASE_ID);
      if (!historicOracle || (historicOracle as { verdict: string }).verdict !== 'PASS') throw new Error('remaining22 campaign refused: historic response failed oracle re-evaluation');
      for (const historicFile of [path.join(reservationDir, `${safeID(AUTHORIZED_RETRY_CASE_ID)}.reserved`)]) {
        try { await readFile(historicFile, 'utf8'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('remaining22 campaign refused: historic reservation is missing');
          throw error;
        }
      }
      const priorCampaignClaims = await listRemaining22CampaignClaims(reservationDir, sourceRunID);
      const baseClaims = priorCampaignClaims.filter((file) => !file.endsWith('-r2.json'));
      const supersedeClaims = priorCampaignClaims.filter((file) => file.endsWith('-r2.json'));
      if (baseClaims.length === 0 && supersedeClaims.length === 0) {
        const priorRemaining22 = await listRemaining22Reservations(reservationDir, sourceRunID);
        if (priorRemaining22.length > 0) throw new Error('remaining22 campaign already claimed; refusing second attempt (crash fail-closed, manual review required)');
        await createRemaining22CampaignClaim(reservationDir, sourceRunID, { runID, runNonce, sourceRunID });
      } else if (baseClaims.length === 1 && supersedeClaims.length === 0) {
        // F2-B4-via-S4: one controlled second claim, ONLY when the first
        // claim references a stopped-incomplete run (stopped-summary.json
        // present, evaluation.json absent). Full 22-case campaign; the new
        // claim and its 22 reservations use the -r2 namespace and record
        // supersedes:<stoppedRunID>. Complete campaigns never release a
        // second claim; a third claim always refuses.
        const priorClaim = JSON.parse(await readFile(baseClaims[0], 'utf8'));
        const priorRunID = (priorClaim as any)?.runID;
        if (typeof priorRunID !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(priorRunID)) throw new Error('remaining22 supersede refused: prior claim runID missing or unsafe');
        // P1 security-reviewer: fail-closed artifact reads — only ENOENT is
        // "absent"; any other error propagates and refuses before any claim.
        const { hasStoppedSummary, hasEvaluation } = await loadStoppedIncompleteFlags(
          (file) => readFile(file, 'utf8'),
          OUTPUT_ROOT,
          priorRunID,
        );
        const gate = evaluateRemaining22Supersede({ sourceRunID, baseClaimCount: baseClaims.length, supersedeClaimCount: supersedeClaims.length, priorIsStoppedIncomplete: isStoppedIncompleteRun({ hasStoppedSummary, hasEvaluation }) });
        if (!gate.ok) throw new Error(`remaining22 supersede refused: ${(gate as any).reason}; single-ACTIVE-claim preserved`);
        await createRemaining22SupersedeCampaignClaim(reservationDir, sourceRunID, { runID, runNonce, sourceRunID, supersedes: priorRunID });
        remaining22SupersedeRunID = priorRunID;
      } else {
        throw new Error('remaining22 campaign already claimed; refusing third attempt (single-ACTIVE-claim plus one supersede only, new decision required)');
      }
    }

    for (const id of executionPlan.run) {
      const item = cases.find((candidate) => candidate.id === id)!;
      const caseFile = path.join(caseDir, `${safeID(id)}.json`);
      const caseWorkDir = workDir;
      const goUsageBefore = await requireGoUsage(server.client, options.quotaConfirmation && !options.resumeID);
      let reservationFile: string | null = null;
      if (!isRemaining22 && !(authorized && (id === AUTHORIZED_RETRY_CASE_ID || id === AUTHORIZED_CONSUMED_SMOKE_CASE_ID || id === AUTHORIZED_FRESH_SMOKE_CASE_ID))) {
        reservationFile = await createCaseReservation(reservationDir, id, { runID, runNonce });
      }
      const hookStart = jsonLines(await readFile(evidenceFile, 'utf8')).length;
      const session = await server.client.session.create({
        title: `F2B0 ${id}`,
        agent: 'build',
        model: { providerID: REAL_MODEL.providerID, id: REAL_MODEL.modelID },
        location: { directory: caseWorkDir },
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      });
      const readyEvents = await waitForPluginReady(evidenceFile, server.child, runNonce);
      if (!readyEvents.some((event) => event.runNonce === runNonce && event.event === 'plugin-ready' && event.provider === REAL_MODEL.providerID && event.model === REAL_MODEL.modelID && event.mcpCount === 0 && event.skillCount === 0)) {
        throw new Error('plugin cost/skills/MCP readiness proof is incomplete; no prompt was sent');
      }
      if (authorized && options.retryCaseID !== undefined && id === AUTHORIZED_RETRY_CASE_ID) {
        const priorRetries = await listAuthorizedRetryReservations(reservationDir, AUTHORIZED_RETRY_CASE_ID);
        if (priorRetries.length > 0) throw new Error('authorized retry already consumed; refusing second attempt');
        authorizedRetryReservationFile = await createAuthorizedRetryReservation(reservationDir, AUTHORIZED_RETRY_CASE_ID, runID, { runID, runNonce, sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID });
        reservationFile = authorizedRetryReservationFile;
      }
      if (authorized && options.consumedSmokeCaseID !== undefined && id === AUTHORIZED_CONSUMED_SMOKE_CASE_ID) {
        const priorConsumed = await listConsumedSmokeReservations(reservationDir, AUTHORIZED_CONSUMED_SMOKE_CASE_ID);
        if (priorConsumed.length > 0) throw new Error('consumed smoke already consumed; refusing second attempt');
        consumedSmokeReservationFile = await createConsumedSmokeReservation(reservationDir, AUTHORIZED_CONSUMED_SMOKE_CASE_ID, AUTHORIZED_CONSUMED_SMOKE_RUN_ID, { runID, runNonce, sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID });
        reservationFile = consumedSmokeReservationFile;
      }
      if (authorized && (options as any).freshSmokeCaseID !== undefined && id === AUTHORIZED_FRESH_SMOKE_CASE_ID) {
        const priorFresh = await listFreshSmokeReservations(reservationDir, AUTHORIZED_FRESH_SMOKE_CASE_ID);
        if (priorFresh.length > 0) {
          const priorEvaluations = await loadFreshSmokeRetryEvaluations(priorFresh);
          const retryCheck = evaluateFreshSmokeRetry(priorEvaluations, MUSE_SPARK_SLUG);
          if (!retryCheck.ok) throw new Error(`fresh smoke refused: ${retryCheck.reason}; single PASS preserved, all-FAIL/INCONCLUSIVE only, max ${getMaxFreshSmokeAttempts(MUSE_SPARK_SLUG)} attempts per slug`);
        }
        freshSmokeReservationFile = await createFreshSmokeReservation(reservationDir, AUTHORIZED_FRESH_SMOKE_CASE_ID, runID, { runID, runNonce, sourceMarker: AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER });
        reservationFile = freshSmokeReservationFile;
      }
      if (isRemaining22) {
        if (id === REMAINING22_EXCLUDED_CASE_ID) throw new Error('remaining22 campaign must never re-execute the historic smoke case');
        const campaignSourceRunID = (options as any).remaining22RunID as string;
        reservationFile = remaining22SupersedeRunID !== null
          ? await createRemaining22SupersedeReservation(reservationDir, id, campaignSourceRunID, { runID, runNonce, sourceRunID: campaignSourceRunID, supersedes: remaining22SupersedeRunID })
          : await createRemaining22Reservation(reservationDir, id, campaignSourceRunID, { runID, runNonce, sourceRunID: campaignSourceRunID });
      }
      if (!reservationFile) throw new Error('reservation missing before prompt');
      const stdout = await captureCli(CLI, [
        'run', '--server', server.baseURL, '--session', session.id,
        '--model', `${REAL_MODEL.providerID}/${REAL_MODEL.modelID}`, '--agent', 'build', '--format', 'json',
      ], caseWorkDir, envState.env, [serverPassword, process.env.OPENCODE_GO_API_KEY], item.prompt);
      let apiWaitFailure: string | null = null;
      let assistantMessages: any[] = [];
      let stdinPromptObserved = false;
      let readback = diagnoseReadback(undefined, item.prompt);
      if (stdout.timedOut) {
        await server.client.session.interrupt({ sessionID: session.id }, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      }
      try {
        await server.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
        const messages = await server.client.message.list({ sessionID: session.id, limit: 20 }, { signal: AbortSignal.timeout(10_000) });
        stdinPromptObserved = isPromptConfirmed(messages.data, item.prompt);
        readback = diagnoseReadback(messages.data, item.prompt);
        assistantMessages = messages.data.filter((message: any) => message.type === 'assistant');
      } catch (error) {
        apiWaitFailure = redactPersistedOutput(String(error instanceof Error ? error.message : error), serverPassword).slice(0, 240);
      }
      const assistantText = extractAssistantApiText(assistantMessages);
      const apiText = assistantText.text;
      const assistantTextStop = decideAssistantTextStop(assistantText, stdout.text);
      const hookRows = jsonLines(await readFile(evidenceFile, 'utf8')).slice(hookStart).filter((event) => event.sessionKey === sessionKey(session.id));
      const fatalResponse = hookRows.find((event) => event.event === 'http-response' && event.status >= 400);
      const requestRows = hookRows.filter((event) => event.event === 'http-request-allowed');
      const guardFailure = hookRows.find((event) => event.event === 'guard-failed');
      const assistantOutcome = classifyAssistantOutcome({ waitError: apiWaitFailure, assistantMessages });
      const outputModelMismatch = assistantMessages.some((message: any) => message.model?.providerID !== REAL_MODEL.providerID || message.model?.id !== REAL_MODEL.modelID);
      const perMessageUsage = assistantMessages.map((message: any) => normalizeTokenUsage(message.tokens));
      const usageByCase = Object.fromEntries(['input', 'output', 'total', 'reasoning', 'cacheRead', 'cacheWrite'].map((field) => [field, aggregateObservedMetric(perMessageUsage.map((usage: any) => usage[field]))]));
      const apiCostByCase = aggregateObservedMetric(assistantMessages.map((message: any) => ({ value: message.cost, observed: typeof message.cost === 'number' && Number.isFinite(message.cost) })));
      const cliCostByCase = aggregateObservedMetric([{ value: stdout.cost, observed: typeof stdout.cost === 'number' && Number.isFinite(stdout.cost) }]);
      let goUsageAfter: any = null;
      let goUsageAfterStatus: string | null = null;
      try {
        const usageAfter = await readGoUsage(server.client);
        goUsageAfter = goUsageAudit(usageAfter, options.quotaConfirmation);
        if (!usageAfter.ok) goUsageAfterStatus = usageAfter.reason;
      } catch {
        goUsageAfterStatus = 'go-usage-read-error';
      }
      const terminalFailure = stdout.terminalErrors[0] ?? (stdout.exitCode === 0 ? null : { type: 'cli-runtime-error', message: stdout.stderr.slice(-240) });
      const stdinWriteFailure = classifyStdinWriteError(stdout.stdinErrorCode);
      const stop = guardFailure
        ? { stop: true, category: 'route-guard', reason: guardFailure.reason }
        : stdinWriteFailure
          ? stdinWriteFailure
        : !stdinPromptObserved
          ? { stop: true, category: 'stdin-prompt-not-confirmed' }
        : assistantOutcome.terminal
          ? { stop: true, category: assistantOutcome.category }
        : stdout.timedOut
          ? { stop: true, category: 'watchdog-timeout' }
          : stdout.oversized
            ? { stop: true, category: 'stdout-size-limit' }
            : stdout.exitCode !== 0
              ? { stop: true, category: 'cli-nonzero-exit' }
              : stdout.terminalErrors.length !== 0
                ? { stop: true, category: 'cli-terminal-error' }
                : outputModelMismatch
                  ? { stop: true, category: 'assistant-model-mismatch' }
                  : assistantTextStop
                ? assistantTextStop
        : fatalResponse
          ? classifyProviderFailure({ status: fatalResponse.status, message: terminalFailure?.message })
          : terminalFailure
            ? classifyProviderFailure(terminalFailure)
             : !apiCostByCase.observed && !cliCostByCase.observed
               ? { stop: true, category: 'go-cost-unobserved' }
             : (apiCostByCase.observed && apiCostByCase.value !== 0) || (cliCostByCase.observed && cliCostByCase.value !== 0)
               ? { stop: true, category: 'unexpected-nonzero-usage-cost' }
              : requestRows.length !== 1
                ? { stop: true, category: 'request-count-mismatch' }
                : { stop: false, category: 'schema-check-or-success' };
      const result = {
        caseID: id,
        reservation: path.relative(OUTPUT_ROOT, reservationFile),
        input: item.input,
        prompt: item.prompt,
        request: { providerID: REAL_MODEL.providerID, modelID: REAL_MODEL.modelID, url: REAL_URL, requestCount: requestRows.length },
        status: stop.stop ? 'fatal-provider-or-guard-error' : 'completed-for-evaluation',
        fatal: stop.stop,
        attemptCount: requestRows.length,
        stop,
        rawStdout: stdout.rawStdout,
        text: stdout.text,
        apiText,
        apiTextMatchesStdout: apiText === stdout.text,
        assistantTextValid: assistantText.valid,
        assistantTextReason: assistantText.reason,
        metadata: {
          exitCode: stdout.exitCode,
          durationMs: stdout.durationMs,
          stdinErrorCode: stdout.stdinErrorCode,
          stdinPromptObserved,
          readback,
          apiWaitFailure,
          eventTypes: stdout.eventTypes,
          assistantOutcome,
          usageByCase,
          cliUsageByCase: stdout.usage,
          perMessageUsage,
          apiCostByCase,
          cliCostByCase,
          goUsageBefore,
          goUsageAfter,
          goUsageAfterStatus,
          assistantMessages: assistantMessages.map((message: any) => ({ finish: message.finish ?? null, cost: message.cost ?? null, tokens: message.tokens ?? null, time: message.time ?? null, error: message.error ? { name: message.error.name ?? null, status: message.error.status ?? null } : null })),
          requestBodySha256: requestRows[0]?.bodySha256 ?? null,
          requestBodyModel: requestRows[0]?.bodyModel ?? null,
          toolCount: requestRows[0]?.toolCount ?? null,
        },
        hookEvidence: hookRows,
      };
      await atomicCaseResult(caseFile, result);
      console.log(JSON.stringify({ caseID: id, status: result.status, fatal: result.fatal, durationMs: stdout.durationMs }));
      if (stop.stop) {
        const stoppedResults = [];
        for (const candidate of cases) {
          try {
            stoppedResults.push(JSON.parse(await readFile(path.join(caseDir, `${safeID(candidate.id)}.json`), 'utf8')));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        await finalizeStoppedRun(runDir, runID, cases.map((candidate) => candidate.id), stoppedResults, { ...stop, stoppedAfter: id });
        throw new Error(`real run stopped after ${id}: ${stop.category}`);
      }
      if (options.smokeOnly) {
        const smokeEvaluation = evaluateF2B0Attempts([{ id, raw: stdout.text }]);
        const parserResult = smokeEvaluation.results[id];
        const caseInput = item.input as { caseId?: unknown };
        const corpusId = typeof caseInput?.caseId === 'string' ? caseInput.caseId : null;
        const oracleResult = corpusId ? smokeEvaluation.evaluation.scenarios.find((row: any) => row.corpusId === corpusId) : undefined;
        const semanticVerdict = oracleResult?.verdict ?? 'INCONCLUSIVE';
        const tokenUsageObserved = (usageByCase.input.observed && usageByCase.output.observed)
          || (stdout.usage.input.observed && stdout.usage.output.observed);
        const observedCost = apiCostByCase.observed ? apiCostByCase : cliCostByCase;
        const noRetry = requestRows.length === 1 && !hookRows.some((event) => event.event === 'retry-decision' && event.retry === true);
        const smokeOutcome = evaluateGoSmoke({
          jsonValid: parserResult?.jsonValid === true,
          schemaValid: parserResult?.schemaValid === true,
          semanticVerdict,
          requestCount: requestRows.length,
          noRetry,
          tokensObserved: tokenUsageObserved,
          costObserved: observedCost.observed,
          costUSD: observedCost.value,
          quotaAfterStatus: goUsageAfterStatus,
          quotaAttested: options.quotaConfirmation,
          extraUsageDisabledAttested: options.extraUsageConfirmation,
        });
        const casePassed = smokeOutcome.casePassed;
        const terminalOutcome = (options.consumedSmokeCaseID !== undefined || (options as any).freshSmokeCaseID !== undefined) ? applyConsumedSmokeTerminalPolicy(smokeOutcome) : smokeOutcome;
        const continuationAllowed = terminalOutcome.continuationAllowed;
        const smokeReport = {
          schemaVersion: 'f2b0-go-single-smoke-v1',
          status: smokeOutcome.status,
          runID,
          caseID: id,
          providerID: REAL_MODEL.providerID,
          modelID: REAL_MODEL.modelID,
          endpoint: REAL_URL,
          physicalRequests: requestRows.length,
          retryObserved: hookRows.filter((event) => event.event === 'retry-decision').length,
          noRetry,
          stdinPromptObserved,
          jsonValid: parserResult?.jsonValid ?? false,
          schemaValid: parserResult?.schemaValid ?? false,
          semanticVerdict,
          oracleReasons: oracleResult?.reasons ?? [],
          responseText: stdout.text,
          tokens: { api: usageByCase, cli: stdout.usage },
          costUSD: { api: apiCostByCase, cli: cliCostByCase },
          costObserved: observedCost.observed,
          goUsageBefore,
          goUsageAfter,
          goUsageAfterStatus,
          extraUsageStatus: 'operator-attested-disabled',
          remainingCaseIDs: executionPlan.deferred,
          ...((options as any).freshSmokeCaseID !== undefined ? { freshSmoke: true, sourceMarker: AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER } : {}),
          continuationAllowed,
        };
        await atomicCreate(path.join(runDir, 'smoke-evaluation.json'), smokeReport);
        completed = casePassed;
        console.log(JSON.stringify(smokeReport, null, 2));
        if (!casePassed) throw new Error('first Go smoke failed parser/oracle or usage evidence; no further case sent');
        return;
      }
      if (goUsageAfterStatus !== null) {
        const isAttestedUnavailable = isRemaining22 && goUsageAfterStatus === 'go-usage-unavailable' && options.quotaConfirmation;
        if (!isAttestedUnavailable) {
          const stoppedResults = [];
          for (const candidate of cases) {
            try {
              stoppedResults.push(JSON.parse(await readFile(path.join(caseDir, `${safeID(candidate.id)}.json`), 'utf8')));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          await finalizeStoppedRun(runDir, runID, cases.map((candidate) => candidate.id), stoppedResults, { stop: true, category: 'go-usage-after-case', reason: goUsageAfterStatus, stoppedAfter: id });
          throw new Error(`real run stopped after ${id}: go usage readback ${goUsageAfterStatus}`);
        }
      }
    }

    if (isRemaining22) {
      const campaignSourceRunID = (options as any).remaining22RunID as string;
      const campaignResults = await Promise.all(executionPlan.run.map((caseID) => readFile(path.join(caseDir, `${safeID(caseID)}.json`), 'utf8').then((raw) => JSON.parse(raw))));
      if (campaignResults.length !== REMAINING22_EXPECTED_COUNT) throw new Error('remaining22 campaign requires exactly 22 completed campaign results');
      if (campaignResults.some((result) => result.fatal)) throw new Error('remaining22 campaign fatal result prevents composite evaluation');
      const sourceHistoric = JSON.parse(await readFile(path.join(OUTPUT_ROOT, campaignSourceRunID, 'cases', `${safeID(REMAINING22_EXCLUDED_CASE_ID)}.json`), 'utf8'));
      const compositeAttempts = [{ id: sourceHistoric.caseID, raw: sourceHistoric.text }, ...campaignResults.map((result: any) => ({ id: result.caseID, raw: result.text }))];
      const evaluation = evaluateF2B0Attempts(compositeAttempts, { requireComplete: true });
      if (!evaluation.complete || evaluation.missingIds.length > 0) throw new Error('remaining22 composite evaluation is incomplete');
      const attestation = buildRemaining22Attestation({ runID, sourceRunID: campaignSourceRunID, caseIDs: cases.map((item) => item.id), completedCaseIDs: campaignResults.map((result: any) => result.caseID), expectedCaseIDs: cases.map((item) => item.id), expectedCampaignCaseIDs: executionPlan.run });
      const runMetrics = summarizeRealRunMetrics(evaluation, [...campaignResults, { caseID: sourceHistoric.caseID, status: 'completed-for-evaluation', attemptCount: 1, metadata: sourceHistoric.metadata } as any], MAX_CASES);
      const report = { runID, campaign: 'remaining22', sourceRunID: campaignSourceRunID, providerID: REAL_MODEL.providerID, modelID: REAL_MODEL.modelID, attempts: compositeAttempts.length, denominator: MAX_CASES, complete: evaluation.complete, metrics: runMetrics, evaluation, attestation, provenance: { sourceRunID: campaignSourceRunID, historicCaseID: REMAINING22_EXCLUDED_CASE_ID, historicReservationPreserved: true } };
      await atomicCreate(path.join(runDir, 'evaluation.json'), report);
      await atomicCreate(path.join(runDir, 'remaining22-attestation.json'), attestation);
      completed = true;
      console.log(JSON.stringify({ runID, campaign: 'remaining22', complete: true, attempts: compositeAttempts.length }, null, 2));
      return;
    }

    const allResults = await Promise.all(cases.map((item) => readFile(path.join(caseDir, `${safeID(item.id)}.json`), 'utf8').then((raw) => JSON.parse(raw))));
    const attempts = [];
    for (const result of allResults) {
      if (isApprovedInfrastructureEndedCase(runID, result)) continue;
      if (result.fatal) throw new Error(`fatal result prevents evaluation/resume at ${result.caseID}`);
      attempts.push({ id: result.caseID, raw: result.text });
    }
    const infrastructureEndedCaseIDs = allResults.filter((result) => isApprovedInfrastructureEndedCase(runID, result)).map((result) => result.caseID);
    const evaluation = evaluateF2B0Attempts(attempts, { requireComplete: infrastructureEndedCaseIDs.length === 0 });
    const unexpectedMissing = evaluation.missingIds.filter((id) => !infrastructureEndedCaseIDs.includes(id));
    if (unexpectedMissing.length > 0 || infrastructureEndedCaseIDs.some((id) => !evaluation.missingIds.includes(id))) throw new Error('evaluation missing IDs do not match the explicitly approved infrastructure-ended case set');
    const runMetrics = summarizeRealRunMetrics(evaluation, allResults, MAX_CASES);
    const report = { runID, providerID: REAL_MODEL.providerID, modelID: REAL_MODEL.modelID, attempts: attempts.length, actualAttemptCount: runMetrics.actualAttemptCount, denominator: MAX_CASES, complete: evaluation.complete, metrics: runMetrics, evaluation };
    const evaluationFile = path.join(runDir, 'evaluation.json');
    try { await atomicCreate(evaluationFile, report); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || plan.run.length !== 0) throw error;
      const previous = JSON.parse(await readFile(evaluationFile, 'utf8'));
      if (previous.runID !== runID || previous.attempts !== MAX_CASES) throw error;
    }
    completed = true;
    console.log(JSON.stringify({ runID, complete: true, attempts: attempts.length, metrics: report.metrics }));
  } finally {
    await stopServer(server.child, server.childClosed);
    if (!completed) console.error(JSON.stringify({ runID, authMode: 'opencode-go-api-key-env', status: 'stopped-or-preflight-only' }));
  }
  } finally {
    await runLock.release();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`F2B0 runner stopped safely: ${redactPersistedOutput(error instanceof Error ? error.message : String(error), process.env.OPENCODE_GO_API_KEY)}`);
    process.exitCode = 1;
  });
}

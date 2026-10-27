import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/client';
import { evaluateF2B0Attempts, F2B0_CASE_IDS, getF2B0Cases } from '../f2b0-adapter.js';
import { createCaseReservation, createExclusiveRunLock, finalizeStoppedRun, listReservationIDs } from './real-storage.mjs';
import {
  aggregateObservedMetric,
  classifyLocalServerFailure,
  classifyProviderFailure,
  classifyAssistantOutcome,
  buildSafeStoppedReport,
  extractCliOutput,
  isTerminalAssistantFailure,
  isApprovedInfrastructureEndedCase,
  MAX_CASES,
  approvedProviderCredential,
  parseExecutionMode,
  planAttempts,
  normalizeTokenUsage,
  summarizeRealRunMetrics,
  summarizeStoppedRun,
  REAL_CONFIRMATION,
  REAL_MODEL,
  REAL_URL,
  validateCatalogCost,
  redactPersistedOutput,
} from './real-guard.mjs';

const ROOT = path.resolve(import.meta.dirname);
const OUTPUT_ROOT = path.join(ROOT, 'evidence', 'real');
const CLI = process.env.OPENCODE_EXE ?? 'C:/Users/walis/AppData/Roaming/npm/node_modules/@opencode/cli/node_modules/@opencode/cli-windows-x64-baseline/bin/opencode.exe';
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

const usage = () => {
  console.log([
    'F2B0 native real-run guard (does not run unless explicitly armed)',
    '  --preflight-only                       fetch catalog metadata and verify zero cost; no session prompt',
    '  --self-test-guard                      load native plugin and verify readiness; no session/prompt',
    `  --execute-real ${REAL_CONFIRMATION}   execute serially (maximum 23)`,
    '  --resume=<run-id>                      skip persisted cases; never replay completed IDs',
    '  --export-stopped-run=<run-id>          create one sanitized review artifact; no server/catalog/model call',
    'No flags means no model/catalog request. One global wx lock serializes all runs; stale locks/reservations require manual review and are never auto-cleared.',
    'This runner never reads auth files or global auth stores.',
  ].join('\n'));
};

function minimalEnvironment(runDir: string, runNonce: string, serverPassword: string, apiKey?: string) {
  const appData = path.join(runDir, 'private-appdata');
  const localAppData = path.join(runDir, 'private-localappdata');
  const home = path.join(runDir, 'private-home');
  const temp = path.join(runDir, 'private-temp');
  const config = path.join(runDir, 'private-config');
  const data = path.join(runDir, 'private-data');
  const cache = path.join(runDir, 'private-cache');
  const state = path.join(runDir, 'private-state');
  return {
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      HOME: home,
      TEMP: temp,
      TMP: temp,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_DATA_DIR: data,
      OPENCODE_CACHE_DIR: cache,
      OPENCODE_STATE_DIR: state,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_SERVER_PASSWORD: serverPassword,
      F2B0_REAL_NONCE: runNonce,
      F2B0_REAL_EVIDENCE: path.join(runDir, 'plugin-hooks.ndjson'),
      ...(apiKey ? { OPENCODE_API_KEY: apiKey } : {}),
    } as unknown as NodeJS.ProcessEnv,
    paths: { appData, localAppData, home, temp, config, data, cache, state },
  };
}

async function writeConfig(configDir: string, workDir: string, withPlugin: boolean, apiKeyAvailable: boolean) {
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
        settings: {
          transport: 'http',
          timeout: 90_000,
          headerTimeout: 30_000,
          chunkTimeout: 30_000,
          ...(apiKeyAvailable ? { apiKey: '{env:OPENCODE_API_KEY}' } : {}),
        },
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
        const readiness = classifyLocalServerFailure(error);
        if (readiness.fatal) {
          const status = 'status' in readiness ? ` HTTP ${readiness.status}` : '';
          throw new Error(`local OpenCode readiness failed closed (${readiness.category}${status})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    if (!info) throw new Error(`local OpenCode server readiness timeout: ${redactPersistedOutput(stderr, [env.OPENCODE_API_KEY, serverPassword].filter((value): value is string => typeof value === 'string'))}`);
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
  if (!model) throw new Error('target free model absent from fetched OpenCode model catalog');
  const cost = validateCatalogCost(model.cost);
  if (!cost.ok) throw new Error(`catalog cost gate failed closed: ${cost.reason}`);
  return {
    source: 'OpenCode Model.Info via loopback API',
    providerID: model.providerID,
    modelID: model.id,
    displayName: model.name,
    cost: model.cost.map((tier) => ({ tier: tier.tier ?? null, input: tier.input, output: tier.output, cache: { read: tier.cache.read, write: tier.cache.write } })),
    zeroCost: true,
    tiers: cost.tiers,
  };
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

async function captureCli(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, credentials: Array<string | undefined>) {
  const startedAt = Date.now();
  const child = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let oversized = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) { oversized = true; child.kill(); }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.on('error', (error) => { stderr += `SPAWN_ERROR:${error.message}`; });
  const childClosed: Promise<unknown[]> = once(child, 'close');
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
  const cases = options.selfTestGuard ? [] : getF2B0Cases();
  if (!options.selfTestGuard && (cases.length !== MAX_CASES || F2B0_CASE_IDS.length !== MAX_CASES)) throw new Error('F2B0 manifest changed: expected exactly 23 cases');
  const credential = approvedProviderCredential(process.env);
  const apiKey = credential.value;
  const providerCredentialAvailable = credential.available;
  const runID = options.resumeID ?? `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`;
  const runNonce = randomUUID();
  const serverPassword = randomBytes(32).toString('base64url');
  const runDir = path.join(OUTPUT_ROOT, runID);
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const envState = minimalEnvironment(runDir, runNonce, serverPassword, apiKey);
  const configDir = envState.paths.config;
  const workDir = path.join(runDir, 'work');
  await mkdir(runDir, { recursive: true });
  for (const directory of Object.values(envState.paths)) await mkdir(directory, { recursive: true });
  const runLock = await createExclusiveRunLock(path.join(OUTPUT_ROOT, '.f2b0-real-run.lock'), { runID, pid: process.pid });
  try {
  await writeConfig(configDir, workDir, !options.preflightOnly, providerCredentialAvailable);
  const evidenceFile = path.join(runDir, 'plugin-hooks.ndjson');
  await writeFile(evidenceFile, '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST' || !options.resumeID) throw error;
  });
  if (options.selfTestGuard) {
    const server = await startServer(runDir, envState.env, workDir, serverPassword);
    try {
      const catalog = await preflightCatalog(server.client, workDir);
      const readyEvents = await waitForPluginReady(evidenceFile, server.child, runNonce);
      const currentEvents = readyEvents.filter((event) => event.runNonce === runNonce);
      const ready = currentEvents.find((event) => event.event === 'plugin-ready');
      if (!ready || ready.model !== REAL_MODEL.modelID || ready.cost?.zero !== true || ready.mcpCount !== 0 || ready.skillCount !== 0 || ready.otherPluginCount !== 0) {
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
        mcpCount: ready.mcpCount,
        skillCount: ready.skillCount,
        otherPluginCount: ready.otherPluginCount,
        promptRequests: 0,
        inferenceRequests: 0,
        credentialAvailable: providerCredentialAvailable,
      };
      await atomicCreate(path.join(runDir, 'guard-self-test.json'), result);
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
    credentialAvailable: providerCredentialAvailable,
    createdAt: new Date().toISOString(),
    prompts: cases.map((item) => ({ id: item.id, input: item.input, prompt: item.prompt })),
  };
  if (options.resumeID) {
    const existing = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (existing.model !== REAL_MODEL.modelID || existing.credentialAvailable !== providerCredentialAvailable || JSON.stringify(existing.caseIDs) !== JSON.stringify(manifest.caseIDs) || JSON.stringify(existing.prompts) !== JSON.stringify(manifest.prompts)) throw new Error('resume manifest differs from this F2B0 model/case/credential-availability state');
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
  const plan = planAttempts(cases.map((item) => item.id), existingIDs, { resume: Boolean(options.resumeID), reservedIDs });
  if (plan.unresolvedReservations.length > 0) throw new Error(`reserved case has no durable result; refusing replay: ${plan.unresolvedReservations.join(',')}`);
  if (options.preflightOnly) {
    // The explicit preflight mode only reads the provider/model catalog API; it creates no session and sends no prompt.
    const server = await startServer(runDir, envState.env, workDir, serverPassword);
    try {
      const catalog = await preflightCatalog(server.client, workDir);
      const result = { mode: 'catalog-preflight-only', catalog, credentialAvailable: providerCredentialAvailable, inferenceRequests: 0 };
      await atomicCreate(path.join(runDir, 'preflight.json'), result);
      console.log(JSON.stringify(result, null, 2));
    } finally { await stopServer(server.child, server.childClosed); }
    return;
  }

  const server = await startServer(runDir, envState.env, workDir, serverPassword);
  let completed = false;
  try {
    const catalog = await preflightCatalog(server.client, workDir);
    const preflight = { catalog, credentialAvailable: providerCredentialAvailable, inferenceRequests: 0 };
    const preflightFile = path.join(runDir, 'catalog-preflight.json');
    if (!options.resumeID) await atomicCreate(preflightFile, preflight);
    else {
      const old = JSON.parse(await readFile(preflightFile, 'utf8'));
      if (old.catalog?.zeroCost !== true) throw new Error('stored resume preflight does not prove zero cost');
    }
    if (!options.execute) throw new Error('no inference attempted: use --execute-real plus exact confirmation after separate approval');

    for (const id of plan.run) {
      const item = cases.find((candidate) => candidate.id === id)!;
      const caseFile = path.join(caseDir, `${safeID(id)}.json`);
      const caseWorkDir = workDir;
      const reservationFile = await createCaseReservation(reservationDir, id, { runID, runNonce });
      const hookStart = jsonLines(await readFile(evidenceFile, 'utf8')).length;
      const session = await server.client.session.create({
        title: `F2B0 ${id}`,
        agent: 'build',
        model: { providerID: REAL_MODEL.providerID, id: REAL_MODEL.modelID },
        location: { directory: caseWorkDir },
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      });
      const readyEvents = await waitForPluginReady(evidenceFile, server.child, runNonce);
      if (!readyEvents.some((event) => event.runNonce === runNonce && event.event === 'plugin-ready' && event.model === REAL_MODEL.modelID && event.cost?.zero === true && event.mcpCount === 0 && event.skillCount === 0)) {
        throw new Error('plugin cost/skills/MCP readiness proof is incomplete; no prompt was sent');
      }
      const stdout = await captureCli(CLI, [
        'run', '--server', server.baseURL, '--session', session.id,
        '--model', `${REAL_MODEL.providerID}/${REAL_MODEL.modelID}`, '--agent', 'build', '--format', 'json', item.prompt,
      ], caseWorkDir, envState.env, [apiKey, serverPassword]);
      let apiWaitFailure: string | null = null;
      let assistantMessages: any[] = [];
      if (stdout.timedOut) {
        await server.client.session.interrupt({ sessionID: session.id }, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      }
      try {
        await server.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
        const messages = await server.client.message.list({ sessionID: session.id, type: 'assistant', limit: 20 }, { signal: AbortSignal.timeout(10_000) });
        assistantMessages = messages.data.filter((message: any) => message.type === 'assistant');
      } catch (error) {
        apiWaitFailure = redactPersistedOutput(String(error instanceof Error ? error.message : error), apiKey).slice(0, 240);
      }
      const apiText = assistantMessages.flatMap((message: any) => message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text)).join('');
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
      const terminalFailure = stdout.terminalErrors[0] ?? (stdout.exitCode === 0 ? null : { type: 'cli-runtime-error', message: stdout.stderr.slice(-240) });
      const stop = guardFailure
        ? { stop: true, category: 'route-guard', reason: guardFailure.reason }
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
                  : apiText !== stdout.text
                ? { stop: true, category: 'cli-api-output-mismatch' }
        : fatalResponse
          ? classifyProviderFailure({ status: fatalResponse.status, message: terminalFailure?.message })
          : terminalFailure
            ? classifyProviderFailure(terminalFailure)
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
        metadata: {
          exitCode: stdout.exitCode,
          durationMs: stdout.durationMs,
          apiWaitFailure,
          eventTypes: stdout.eventTypes,
          assistantOutcome,
          usageByCase,
          cliUsageByCase: stdout.usage,
          perMessageUsage,
          apiCostByCase,
          cliCostByCase,
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
    if (!completed) console.error(JSON.stringify({ runID, credentialAvailable: providerCredentialAvailable, status: 'stopped-or-preflight-only' }));
  }
  } finally {
    await runLock.release();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`F2B0 runner stopped safely: ${redactPersistedOutput(error instanceof Error ? error.message : String(error), process.env.OPENCODE_API_KEY)}`);
    process.exitCode = 1;
  });
}

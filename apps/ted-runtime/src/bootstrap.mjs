// TED runtime bootstrap — P1 product.
//
// Isolated OpenCode boot for ONE host identity: identity-scoped home dirs,
// BOM-free policy config (provider deny-all + tool deny shell/edit/write/
// subagent, agent `ted` deny-by-default with exact finance allowlist),
// explicit sqlite database.path so
// sessions persist across restarts of the same home, and NO network listener
// (embedded SDK only — the instance never leaves this process; the native
// plugin is the only product tool path the host keeps).
//
// Provider posture: the default `test` profile loads no configured provider
// credentials — the isolated env scrubs the credential variables enumerated
// in SCRUB_VARS BEFORE the SDK import (roots are captured at import time),
// and the policy denies provider.use. P1/P2 run WITHOUT paid provider
// execution: session.prompt is never invoked.
// The `live` profile (explicit opt-in via the runtime entrypoint only)
// preserves ONLY OPENCODE_GO_API_KEY from SCRUB_VARS; other variables in that
// list stay scrubbed (value never captured/logged here). Missing credentials
// are handled by native OpenCode itself — no custom preflight here.
//
// DEDICATED-PROCESS RULE (spike env.cjs caution): setupIsolation mutates
// process-wide state (env vars, no chdir since P1) that CANNOT isolate two
// hosts inside one process — a second host would reconfigure the first
// host's globals. Therefore ONE host identity per OS process: a second
// setupIsolation call with a different root/identity FAILS CLOSED instead
// of reconfiguring. Never call this from a shared server process; spawn one
// dedicated process per host (the host owner supervises the process set).

import fs from 'node:fs';
import path from 'node:path';

const SCRUB_VARS = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'DATABASE_URL',
  'SESSION_BEARER_FALLBACK_ENABLED', 'EVOLUTION_GO_API_KEY', 'ZAI_API_KEY',
];

// Native runtime profiles (TED_RUNTIME_PROFILE is read ONLY by the runtime
// entrypoint src/main.mjs, which forwards the resolved value explicitly):
// - `test` (default): product deny-all, no model selector, no provider
//   override; variables listed in SCRUB_VARS are scrubbed. Every helper below
//   defaults to `test` when no explicit value is passed, so ambient env
//   can never leak a live profile into tests.
// - `live`: explicit opt-in forwarded by main.mjs; native `model` selector
//   from the repo-owned template `src/live-model.json` (currently
//   `opencode-go/deepseek-v4.1-flash` — data, never a JS literal, changes
//   without code edits) + a specific `provider.use opencode-go allow`
//   AFTER the deny-all (only the opencode-go provider configured in the
//   isolated catalog or account may be selected — never a wildcard allow),
//   retaining every tool deny. A legitimate native model-only config
//   override applies without code changes. Preserves ONLY OPENCODE_GO_API_KEY
//   from the inherited environment (never captured/logged here); every other
//   variable in SCRUB_VARS stays scrubbed. No DB sharing/copying, no token
//   extraction.
// Unknown profiles fail closed. One host profile per OS process (see
// DEDICATED-PROCESS RULE below): reconfiguring between profiles is refused.
const RUNTIME_PROFILES = ['test', 'live'];
const PRESERVE_VARS_BY_PROFILE = { live: ['OPENCODE_GO_API_KEY'] };

export function resolveRuntimeProfile(explicit) {
  // NB: reads NO ambient env on purpose — only src/main.mjs reads
  // TED_RUNTIME_PROFILE and forwards it explicitly. Helpers default to
  // 'test' so tests can never inherit live accidentally.
  const raw = explicit ?? 'test';
  if (!RUNTIME_PROFILES.includes(raw)) {
    throw new Error(
      `unknown TED_RUNTIME_PROFILE '${String(raw).slice(0, 60)}' — expected one of: ${RUNTIME_PROFILES.join(', ')}`,
    );
  }
  return raw;
}

function resolveProfileArg(profileOrOpts) {
  if (typeof profileOrOpts === 'string') return resolveRuntimeProfile(profileOrOpts);
  if (profileOrOpts && typeof profileOrOpts === 'object' && 'profile' in profileOrOpts) {
    if (profileOrOpts.profile === undefined) return resolveRuntimeProfile(undefined);
    return resolveRuntimeProfile(profileOrOpts.profile);
  }
  if (profileOrOpts === undefined) return resolveRuntimeProfile(undefined);
  return resolveRuntimeProfile(profileOrOpts);
}

let configured = null; // { root, identity } — one host per process, fail closed on second host

// Identity charset: a single path segment, never traversal. Blocks
// `../evil`, absolute paths, separators, empty/dot names.
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertSafeIdentity(identity) {
  if (typeof identity !== 'string' || !IDENTITY_RE.test(identity)) {
    throw new Error(
      'setupIsolation: identity must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ (single path segment — traversal, absolute paths and separators refused)',
    );
  }
}

function assertSafeRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('setupIsolation: root (string, non-empty) is required');
  }
  if (!path.isAbsolute(root)) {
    throw new Error('setupIsolation: root must be absolute — never boot in a relative cwd with existing data');
  }
  if (path.parse(path.resolve(root)).root === path.resolve(root)) {
    throw new Error('setupIsolation: root must not be a filesystem root — never boot over an entire drive');
  }
  let st;
  try {
    st = fs.lstatSync(root);
  } catch (e) {
    if (e.code === 'ENOENT') return; // fresh root: created below via home dirs
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error('setupIsolation: root must not be a symlink — resolve the real path first');
  }
}

const HOST_MARKER = '.ted-host.json';

// Fail-closed component check shared by claimHostDir and writeTedConfig:
// no symlinks, junctions or mounts anywhere in the given dirs (lstat alone
// misses Windows junctions — a divergent realpath also refuses).
// Residual honesto: verificação best-effort (TOCTOU); proteção total contra
// raça exigiria privilégio do SO.
export function assertNoRedirectedComponents(dirs) {
  const norm = (s) => process.platform === 'win32' ? s.replace(/^\\\\\?\\/, '').toLowerCase() : s;
  for (const c of dirs) {
    let st;
    try {
      st = fs.lstatSync(c);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`setupIsolation: refusing symlinked component before any write: ${c}`);
    }
    let real;
    try {
      real = fs.realpathSync(c);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (norm(real) !== norm(path.resolve(c))) {
      throw new Error(`setupIsolation: refusing redirected component (junction/mount) before any write: ${c}`);
    }
  }
}

// Marker read with pre-read symlink refusal: a marker symlink pointing at
// an external JSON with a valid identity must NOT be accepted (it would
// bless data outside the claimed root). Used on first read AND on the
// EEXIST re-read after a raced 'wx' create (writeFileSync follows links).
function readMarkerFile(markerFile) {
  let st;
  try {
    st = fs.lstatSync(markerFile);
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'absent' };
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error('setupIsolation: home marker is a symlink — refusing to follow it');
  }
  let raw;
  try {
    raw = fs.readFileSync(markerFile, 'utf8');
  } catch (e) {
    throw new Error('setupIsolation: home marker unreadable — refusing to adopt or overwrite this home');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('setupIsolation: home marker unreadable — refusing to adopt or overwrite this home');
  }
  return { status: 'present', marker: parsed };
}

// Claims (or resumes) the identity-scoped home WITHOUT touching process
// globals: validates identity/root, creates dirs, and enforces the marker
// protocol. A non-empty home WITHOUT our marker is someone else's data —
// refused, never adopted. A marker for another identity is refused — never
// reconfigured. Exported for tests; setupIsolation adds the env/global layer.
export function claimHostDir(root, identity) {
  assertSafeIdentity(identity);
  assertSafeRoot(root);
  const home = path.join(path.resolve(root), `.ted-home-${identity}`);
  const dirs = {
    home,
    config: path.join(home, 'config'),
    data: path.join(home, 'data'),
    cache: path.join(home, 'cache'),
    state: path.join(home, 'state'),
    tmp: path.join(home, 'tmp'),
    workspace: path.join(home, 'workspace'),
    db: path.join(home, 'db', 'ted.db'),
  };
  const markerFile = path.join(home, HOST_MARKER);
  const found = readMarkerFile(markerFile);
  const marker = found.status === 'present' ? found.marker : null;
  if (marker !== null) {
    if (!marker || marker.identity !== identity) {
      throw new Error('setupIsolation: home marker belongs to another identity — refusing to reuse this home');
    }
    // Marker idêntico: resume SEM reescrever (mtime preservado; prova de
    // não-interferência). Residual honesto: verificação é best-effort
    // (TOCTOU entre lstat e escrita); symlink é checado abaixo antes de
    // qualquer mkdir, mas proteção total contra raça exige privilégio do SO.
  } else if (fs.existsSync(home)) {
    const entries = fs.readdirSync(home);
    if (entries.length > 0) {
      throw new Error('setupIsolation: home exists without our marker — refusing to boot over existing data');
    }
  }
  assertNoRedirectedComponents([home, dirs.config, dirs.data, dirs.cache, dirs.state, dirs.tmp, dirs.workspace, path.dirname(dirs.db)]);
  for (const d of [dirs.config, dirs.data, dirs.cache, dirs.state, dirs.tmp, dirs.workspace, path.dirname(dirs.db)]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (marker === null) {
    // Só escreve quando ausente (O_EXCL semântico via flag): concorrência
    // que criar primeiro vence; EEXIST com identidade igual = resume.
    try {
      fs.writeFileSync(markerFile, JSON.stringify({ identity, claimedAt: new Date().toISOString() }) + '\n', { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Releitura COM recusa de symlink (o 'wx' segue links): rival
      // linkado para fora é recusado, nunca adotado.
      const rivalFound = readMarkerFile(markerFile);
      const rival = rivalFound.status === 'present' ? rivalFound.marker : null;
      if (!rival || rival.identity !== identity) {
        throw new Error('setupIsolation: home marker belongs to another identity — refusing to reuse this home');
      }
    }
  }
  return { identity, home, dirs };
}

export function setupIsolation(root, identity, profileOrOpts) {
  // Validate BEFORE the configured check so invalid inputs always fail
  // with the validation error (never masked by isolation_already_configured).
  assertSafeIdentity(identity);
  assertSafeRoot(root);
  const profile = resolveProfileArg(profileOrOpts);
  if (configured) {
    if (configured.root === path.resolve(root) && configured.identity === identity && configured.profile === profile) return configured.result;
    throw new Error(
      `isolation_already_configured: process already isolated for identity '${configured.identity}' (profile '${configured.profile ?? 'test'}') — spawn a dedicated process per host, never reconfigure globals of a live host`,
    );
  }
  const claimed = claimHostDir(root, identity);
  const { home, dirs } = claimed;
  process.env.OPENCODE_TEST_HOME = home;
  process.env.XDG_CONFIG_HOME = dirs.config;
  process.env.XDG_DATA_HOME = dirs.data;
  process.env.XDG_CACHE_HOME = dirs.cache;
  process.env.XDG_STATE_HOME = dirs.state;
  process.env.TMPDIR = dirs.tmp;
  process.env.TEMP = dirs.tmp;
  process.env.TMP = dirs.tmp;
  process.env.OPENCODE_CONFIG_DIR = dirs.config;
  // Live profile preserves ONLY OPENCODE_GO_API_KEY from the inherited
  // environment (native OpenCode reads it; value never inspected here).
  const preserve = new Set(PRESERVE_VARS_BY_PROFILE[profile] ?? []);
  const scrubbed = [];
  for (const k of SCRUB_VARS) {
    if (preserve.has(k)) continue;
    if (process.env[k] !== undefined) {
      delete process.env[k];
      scrubbed.push(k);
    }
  }
  // NOTE: no process.chdir here (P1 correction) — chdir is process-global
  // and would move another service sharing the process. The SDK boots with
  // explicit config.directory + database.path, so no cwd dependence remains.
  const result = { identity, home, dirs, scrubbed, profile };
  configured = { root: path.resolve(root), identity, profile, result };
  return result;
}

export function tedConfig(profileOrOpts, { p3Writes = false } = {}) {
  const profile = profileOrOpts === undefined ? 'test' : resolveProfileArg(profileOrOpts);
  const base = {
    $schema: 'https://opencode.ai/config.json',
    // Sessions without an explicit agent resolve to ted (verified Config
    // schema key); the runtime still passes agent:'ted' explicitly on
    // create — belt and suspenders, never a bare default.
    default_agent: 'ted',
    agents: {
      ted: {
        mode: 'primary',
        description: 'TED product agent (read-only finance tools; no shell/edit/subagent)',
        // PR290 deny-by-default (native explicit allowlist, corrected against
        // official V2 + local 2.2.4 declarations): the agent base default is
        // `{action:'*',resource:'*',effect:'allow'}` (Agent.Info `default()`
        // in @opencode/schema 2.2.4 agent.js), so a new native action could
        // match that base wildcard allow. Unmatched checks using `ask` does
        // NOT save us. The first entry therefore denies everything; the only
        // allows are the namespaced custom action `ted.finance.read` with
        // EXACT resources for the current product read tools (V2 supports
        // plugin-defined permission action names). No wildcards on finance
        // resources, no broad allow. `policies.tool.use` hard denies below
        // stay as the immutable host/admin backstop.
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'ted.finance.read', resource: 'list_accounts', effect: 'allow' },
          { action: 'ted.finance.read', resource: 'get_month_summary', effect: 'allow' },
          { action: 'ted.finance.read', resource: 'list_categories', effect: 'allow' },
          // P3 local write slice: these permissions are only meaningful when
          // the plugin registers the proposal tools
          // (TED_OPENCODE_P3_WRITES_ENABLED=1, never production). Default
          // config stays exactly the P2 reads.
          ...(p3Writes
            ? [
                { action: 'ted.finance.read', resource: 'propose_expense', effect: 'allow' },
                { action: 'ted.finance.read', resource: 'propose_income', effect: 'allow' },
                { action: 'ted.finance.read', resource: 'propose_card_purchase', effect: 'allow' },
                { action: 'ted.finance.read', resource: 'propose_transfer', effect: 'allow' },
              ]
            : []),
        ],
      },
    },
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      // PR290 correction (official V2 + local 2.2.4): the removed claim that
      // "unmatched NEW SDK tools follow the native default `ask`" was false
      // as a safety argument, because the agent base default includes
      // `{action:'*',resource:'*',effect:'allow'}`. New tools are denied by
      // the TED agent wildcard deny above + the exact finance allowlist;
      // these `tool.use` entries are the immutable host/admin backstop
      // (exact hard denies, not default policy). Every SDK/catalog bump
      // still requires reviewing the observed `ctx.tool.list()` (see wiring
      // catalog seam + real-sdk catalog probe) before pinning new denies.
      // `write:*` vs `edit:*`/`patch:*` equivalence stays UNPROVEN locally,
      // so every pinned deny stays. Do not collapse or widen without local
      // SDK proof + catalog-gate test.
      { action: 'tool.use', resource: 'shell:*', effect: 'deny' },
      { action: 'tool.use', resource: 'edit:*', effect: 'deny' },
      { action: 'tool.use', resource: 'write:*', effect: 'deny' },
      { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
      // Pinned denies for the remaining native tools observed live in the
      // effective catalog (real-sdk catalog phase, 2.2.4): read-only finance
      // tools are the ONLY runnable surface. A future SDK adding tools does
      // NOT widen execution: unmatched actions hit the TED agent wildcard
      // deny above (deny-by-default + exact finance allowlist); still, every
      // SDK bump requires reviewing the observed `ctx.tool.list()` and
      // pinning new denies as needed.
      { action: 'tool.use', resource: 'glob:*', effect: 'deny' },
      { action: 'tool.use', resource: 'grep:*', effect: 'deny' },
      { action: 'tool.use', resource: 'read:*', effect: 'deny' },
      { action: 'tool.use', resource: 'patch:*', effect: 'deny' },
      { action: 'tool.use', resource: 'question:*', effect: 'deny' },
      { action: 'tool.use', resource: 'skill:*', effect: 'deny' },
      { action: 'tool.use', resource: 'webfetch:*', effect: 'deny' },
      { action: 'tool.use', resource: 'websearch:*', effect: 'deny' },
      { action: 'tool.use', resource: 'models:*', effect: 'deny' },
      { action: 'tool.use', resource: 'list_mcp_resources:*', effect: 'deny' },
      { action: 'tool.use', resource: 'read_mcp_resource:*', effect: 'deny' },
      { action: 'tool.use', resource: 'session_move:*', effect: 'deny' },
      { action: 'tool.use', resource: 'session_rename:*', effect: 'deny' },
      { action: 'tool.use', resource: 'worktree_create:*', effect: 'deny' },
      { action: 'tool.use', resource: 'worktree_list:*', effect: 'deny' },
      { action: 'tool.use', resource: 'worktree_remove:*', effect: 'deny' },
    ],
  };
  // Live-only delta: native `model` selector from the repo-owned template
  // `src/live-model.json` (never a JS literal, never user-config inheritance)
  // + specific provider allow APPENDED after the deny-all (findLast wins —
  // only the opencode-go provider available/configured in the isolated
  // catalog or account may be selected; never a wildcard allow), retaining
  // every tool deny. The template value changes without production-code
  // edits; a legitimate user model-only override applies without code
  // changes (see isModelOverrideCompatible + writeTedConfig preserve).
  if (profile === 'live') {
    return {
      ...base,
      model: loadLiveModelSelector(),
      policies: [
        ...base.policies,
        { action: 'provider.use', resource: 'opencode-go', effect: 'allow' },
      ],
    };
  }
  return base;
}

// Repo-owned native default for the live profile (outside JS logic): reads
// `src/live-model.json` (`{ "model": "provider/model" }`) at call time so
// the current default changes without production-code edits. Validates the
// shape strictly; missing/malformed template fails closed (never silent
// no-model). Test profile never calls this (stays model-free/isolated).
export function loadLiveModelSelector() {
  const tmplUrl = new URL('./live-model.json', import.meta.url);
  let raw;
  try {
    raw = fs.readFileSync(tmplUrl, 'utf8');
  } catch (e) {
    throw new Error(`live model template unreadable at src/live-model.json — refusing live boot without a pinned native default: ${String((e && e.code) || e).slice(0, 80)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('live model template is not valid JSON — refusing live boot without a pinned native default');
  }
  const model = parsed && typeof parsed === 'object' ? parsed.model : null;
  if (typeof model !== 'string' || model.trim().length === 0 || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model.trim())) {
    throw new Error('live model template must hold a non-empty "provider/model" string — refusing live boot without a pinned native default');
  }
  return model.trim();
}

// Returns true when an on-disk opencode.json is compatible with ours
// except for a legitimate native `model` selector override (non-empty string
// `provider/model`, e.g. a user-pinned native default). Policies, agents,
// default_agent and $schema must deep-match ours — the override never widens
// tools/providers, never touches denies, and never overwrites credentials.
// The `model` VALUE may differ (template default vs user override); any
// other top-level divergence (providers block included) stays a refusal.
// A compatible file is PRESERVED (returned untouched, never rewritten).
function isModelOverrideCompatible(currentText, wantedText) {
  let current;
  let wanted;
  try {
    current = JSON.parse(currentText);
    wanted = JSON.parse(wantedText);
  } catch {
    return false;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
  if (typeof current.model !== 'string' || current.model.trim().length === 0) return false;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(current.model.trim())) return false;
  if (typeof wanted.model !== 'string' || wanted.model.trim().length === 0) return false;
  for (const key of ['$schema', 'default_agent', 'agents', 'policies']) {
    if (JSON.stringify(current[key] ?? null) !== JSON.stringify(wanted[key] ?? null)) return false;
  }
  const currentKeys = Object.keys(current).sort();
  const wantedKeys = Object.keys(wanted).sort();
  // No extra top-level keys beyond ours (providers block included stays a
  // refusal — user work preserved, boot fails closed instead of silently
  // adopting an unknown catalog). The `model` value itself may differ;
  // byte-identical is handled before this function, so reaching here with
  // the same model but different whitespace still preserves (never rewrites).
  const extra = currentKeys.filter((k) => !wantedKeys.includes(k));
  if (extra.length !== 0) return false;
  const missing = wantedKeys.filter((k) => !currentKeys.includes(k));
  if (missing.length !== 0) return false;
  return true;
}

// No BOM on purpose: BOM-prefixed files are rejected by Config.parseInfo.
// NEVER overwrites: an existing opencode.json is returned untouched when
// byte-identical to ours (idempotent resume) or when it is our config plus
// a legitimate native `model` selector override (preserved, never rewritten);
// any other divergent file is the user's work and refused; a symlink is
// refused without following.
// The configDir itself is checked for redirection before any write.
export function writeTedConfig(configDir, profileOrOpts, { p3Writes = false } = {}) {
  // NB: defaults to 'test' — never reads ambient TED_RUNTIME_PROFILE, so
  // tests cannot inherit live accidentally. Live is forwarded explicitly.
  const profile = profileOrOpts === undefined ? 'test' : resolveProfileArg(profileOrOpts);
  assertNoRedirectedComponents([configDir]);
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, 'opencode.json');
  const wanted = JSON.stringify(tedConfig(profile, { p3Writes }), null, 2) + '\n';
  // The sibling flag state is OUR config too: switching the P3 local slice on
  // (or off) on an existing isolated home must not be mistaken for user work.
  const sibling = JSON.stringify(tedConfig(profile, { p3Writes: !p3Writes }), null, 2) + '\n';
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      throw new Error('writeTedConfig: opencode.json is a symlink — refusing to follow it');
    }
    const current = fs.readFileSync(file, 'utf8');
    if (current === wanted) return file; // byte-identical: our own config, resume
    if (current === sibling) { fs.writeFileSync(file, wanted, { encoding: 'utf8' }); return file; }
    if (isModelOverrideCompatible(current, wanted)) return file; // legitimate native model override: preserve, never rewrite
    throw new Error('writeTedConfig: opencode.json already exists with different content — refusing to overwrite user work');
  }
  fs.writeFileSync(file, wanted, { encoding: 'utf8' });
  return file;
}

// Registers the product plugin on a live OpenCode host. Pure and
// dependency-free (oc is injected): the ONLY registration path —
// `createTedEnvironment` below has no other way to expose finance tools to
// the prompt loop. Fails closed when the host has no plugin interface, so a
// boot can never silently run without the finance tools registered.
export async function wirePlugin(oc, pluginDef) {
  if (!oc || typeof oc.plugin !== 'function') {
    throw new Error('wirePlugin: oc.plugin (function) is required — plugin registration cannot be skipped silently');
  }
  if (!pluginDef || typeof pluginDef.id !== 'string' || pluginDef.id.length === 0) {
    throw new Error('wirePlugin: pluginDef with a string id is required');
  }
  return oc.plugin(pluginDef);
}

// Strict quiescence-shape gate for the pinned @opencode/client 2.2.4
// contract (installed declaration evidence, not rolling docs):
// - `RequestOptions.signal?: AbortSignal` (client.d.ts:7-12);
// - `session.active(requestOptions?) -> Promise<{[x:string]: SessionActive}>`
//   (client.d.ts:232+) — the DIRECT record map, already unwrapped;
// - `SessionActive = { type: 'running' }` (types.d.ts:98-100) and
//   `SessionActiveOutput = { data: { [x: SessionID]: SessionActive } }['data']`
//   (types.d.ts:4122-4126) — output is the record itself, never `{data:...}`.
// Non-null plain-object record only; empty `{}` is idle. Every own entry must
// be a plain object with `type:'running'`. Arrays, null, Set/Map, strings,
// `{data:...}`/`{sessions:...}` envelopes and non-`running` values are NOT
// proof of anything — never treated as idle.
export function isSessionActiveMap(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Set || value instanceof Map || value instanceof WeakSet || value instanceof WeakMap) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.keys(value)) {
    if (typeof key !== 'string' || key.length === 0) return false;
    const entry = value[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const eproto = Object.getPrototypeOf(entry);
    if (eproto !== Object.prototype && eproto !== null) return false;
    if (entry.type !== 'running') return false;
  }
  return true;
}

// Full boot. Dynamic SDK import keeps the pure modules (tool-defs,
// session-bindings, transport, plugin) importable without the
// dependency installed; only this function requires @opencode/sdk 2.2.4
// (declared exact in package.json; no inference is invoked by the boot).
// transportFactory: () => transport function for createToolExecutors.
// The factory MUST return a bare async function
//   ({ route, method, host, timeoutMs, signal, ... }) -> { statusCode, body }
// (e.g. `(args) => new HttpFinanceTransport({ baseUrl }).call(args)`);
// `HttpFinanceTransport.call` is constructor-bound, so passing the
// function reference is safe.
// deps.sdkModule (optional, test seam): injected { OpenCode } used INSTEAD
// of the dynamic import — lets unit tests prove the close guarantee with a
// fake host. Production never passes it.
// GUARANTEE: any failure after OpenCode.create (factory throw, bad shape,
// wirePlugin throw) closes the host before rethrowing — no SDK fibers or
// sqlite locks are left alive.
export async function createTedEnvironment({ root, identity = 'a', transportFactory, deps = {}, profile } = {}) {
  if (typeof transportFactory !== 'function') {
    throw new Error('createTedEnvironment: transportFactory (() => transport) is required');
  }
  // Profile resolves from the explicit arg only (default 'test'). Only
  // src/main.mjs reads TED_RUNTIME_PROFILE from the environment and
  // forwards it explicitly — helpers never inherit live accidentally.
  // Unknown profiles reject here before any env mutation. Live preserves
  // ONLY OPENCODE_GO_API_KEY (never inspected here); missing credentials
  // are handled by native OpenCode itself.
  const resolvedProfile = profile === undefined ? 'test' : resolveRuntimeProfile(profile);
  const iso = setupIsolation(root, identity, resolvedProfile);
  // P3 write slice is a LOCAL opt-in (never production); the config must carry
  // the exact propose_expense permission only when the plugin will register it.
  const { isP3WritesEnabled } = await import('./plugin.mjs');
  const p3Writes = isP3WritesEnabled(process.env);
  writeTedConfig(iso.dirs.config, resolvedProfile, { p3Writes });
  // No process.chdir: SDK boots with explicit config.directory +
  // database.path; chdir would move another service in a shared process.
  const sdkMod = deps.sdkModule ?? await import('@opencode/sdk');
  const { OpenCode } = sdkMod;
  const [{ defineTedFinancePlugin }] = await Promise.all([
    import('./plugin.mjs'),
  ]);
  const oc = await OpenCode.create({
    config: { directory: iso.dirs.config, project: false },
    database: { path: iso.dirs.db },
  });
  try {
    const transport = transportFactory();
    if (typeof transport !== 'function') {
      throw new Error('createTedEnvironment: transportFactory must return an async function (route, method, host, ...) -> {statusCode, body}');
    }
    // Registration BEFORE any session exists: no prompt-loop turn can run
    // without the finance tools natively registered.
    await wirePlugin(oc, defineTedFinancePlugin(() => transport));
    // Boot-time capability gate (fail-closed): session.active MUST exist and
    // return the exact 2.2.4 direct record map (probed once with an
    // AbortSignal per RequestOptions). Missing/unreachable/invalid shape
    // refuses boot — no host bind, no tool access. The outer catch closes
    // the SDK before rethrowing, so no fibers or sqlite locks leak.
    if (!oc.session || typeof oc.session.active !== 'function') {
      throw new Error('createTedEnvironment: oc.session.active (function) is required — activity probe unavailable, refusing boot (cannot prove quiescence)');
    }
    {
      const bootCtl = new AbortController();
      const BOOT_PROBE_TIMEOUT_MS = 5000;
      let bootTimer = null;
      let bootProbe;
      try {
        const raw = oc.session.active({ signal: bootCtl.signal });
        const pending = Promise.resolve(raw);
        // Mark handled so a late settlement after the race cannot surface
        // as an unhandled rejection; the race still observes it.
        pending.catch(() => {});
        bootProbe = await Promise.race([
          pending,
          new Promise((_, reject) => {
            bootTimer = setTimeout(() => {
              try { bootCtl.abort(); } catch { /* best-effort */ }
              reject(new Error('createTedEnvironment: oc.session.active probe timed out — refusing boot (cannot prove quiescence)'));
            }, BOOT_PROBE_TIMEOUT_MS);
            if (bootTimer.unref) bootTimer.unref();
          }),
        ]);
      } catch (e) {
        if (e && /refusing boot/.test(String(e.message || ''))) throw e;
        throw new Error(`createTedEnvironment: oc.session.active boot probe failed — refusing boot (cannot prove quiescence): ${String((e && e.message) || e).slice(0, 200)}`);
      } finally {
        if (bootTimer) clearTimeout(bootTimer);
      }
      if (!isSessionActiveMap(bootProbe)) {
        throw new Error('createTedEnvironment: oc.session.active returned an unexpected shape — refusing boot (cannot prove quiescence)');
      }
    }
    // Contained registry: revoke/clear ONLY. bind/resolve stay out of the
    // env — binding is a gateway (P2) authority. The test-only facade
    // helper (tests/helpers/facade.mjs) is NOT exposed here: the product
    // tool path is the native plugin above. Legacy tests import the helper
    // directly from tests/helpers/facade.mjs (never networked).
    const { bindSession, revokeSession, clearAll, quarantineSession, isQuarantined, rotateSessionBinding, getBinding, isSameHost } = await import('./session-bindings.mjs');
    const { createPromptHost } = await import('./prompt.mjs');
    // Per-native-session queue: serializes ALL native uses of one sessionID
    // (chat/tool loop, history, replay/raw-history) so a controlled rebinding
    // can never revoke/replace while a previous prompt/tool could still run.
    // Lock order everywhere is conversation-outer → session-inner; this queue
    // never calls back into the conversation store, so no deadlock.
    const sessionQueues = new Map();
    // Single bounded activity probe: the SDK receives the AbortSignal
    // (RequestOptions per pinned 2.2.4 client.d.ts:7-12) and the call is
    // raced against the REMAINING idle deadline — a hanging SDK promise can
    // never outlive the deadline, and its late settlement is already marked
    // handled so it cannot surface as an unhandled rejection.
    async function probeSessionActiveOnce(remainingMs) {
      const controller = new AbortController();
      let timer = null;
      try {
        const raw = oc.session.active({ signal: controller.signal });
        const pending = Promise.resolve(raw);
        pending.catch(() => {});
        try {
          return await Promise.race([
            pending,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                try { controller.abort(); } catch { /* best-effort */ }
                reject(Object.assign(
                  new Error('session.active probe timed out — cannot prove idle'),
                  { code: 'session_active_timeout' },
                ));
              }, Math.max(0, remainingMs));
              if (timer.unref) timer.unref();
            }),
          ]);
        } finally {
          if (timer) { clearTimeout(timer); timer = null; }
        }
      } catch (e) {
        try { controller.abort(); } catch { /* best-effort */ }
        throw e;
      }
    }
    async function waitForSessionIdle(sessionID, timeoutMs, pollMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let active;
        try {
          // Fail-closed: a missing probe proves nothing. The old path treated
          // absent oc.session.active as idle — that fabricated quiescence and
          // allowed unsafe rebind, so it now returns not-idle (the boot gate
          // above normally prevents reaching here without a probe).
          if (!oc.session || typeof oc.session.active !== 'function') {
            return false;
          }
          active = await probeSessionActiveOnce(remaining);
        } catch {
          return false; // stall/error: cannot prove idle — caller revokes+quarantines
        }
        // Unrecognized shapes (arrays, Set, {data:...}, non-running values)
        // are not proof of idle — fail closed, never rebind on uncertainty.
        if (!isSessionActiveMap(active)) {
          return false;
        }
        if (!Object.prototype.hasOwnProperty.call(active, sessionID)) return true;
        if (Date.now() >= deadline) return false;
        const wait = Math.min(pollMs, Math.max(0, deadline - Date.now()));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    function quarantinedError() {
      const e = new Error('session was quarantined after a busy timeout — it may still be running with a stale host; open a new conversation');
      e.code = 'host_binding_quarantined';
      return e;
    }
    // Server-only (the gateway path — never HTTP, never browser-reachable):
    // runs fn with the host bound for exactly the guarded window, proving
    // execution idle before rebinding/releasing. Never revokes/replaces while
    // a previous prompt/tool could still execute: entry and exit both wait
    // for oc.session.active() to drop the session id (bounded). On timeout
    // the binding is revoked AND the session quarantined for the rest of this
    // process — every later native prompt/read/rebind fails closed (a late
    // tool then has no host and fails closed; no other actor can rebind onto
    // the still-running session). On success the binding is revoked on exit
    // so no stale host survives the window. Secrets never enter errors/logs.
    async function withAuthenticatedSession(sessionID, host, fn, opts = {}) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) {
        throw new Error('withAuthenticatedSession: sessionID is required');
      }
      if (!host || typeof host !== 'object') {
        throw new Error('withAuthenticatedSession: host context is required');
      }
      if (typeof fn !== 'function') {
        throw new Error('withAuthenticatedSession: fn is required');
      }
      const o = opts || {};
      const rawTimeout = o.idleTimeoutMs ?? o.timeoutMs ?? 5000;
      const rawPoll = o.idlePollMs ?? o.pollIntervalMs ?? 25;
      const idleTimeoutMs = Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0 ? Math.floor(Number(rawTimeout)) : 5000;
      const idlePollMs = Number.isFinite(Number(rawPoll)) && Number(rawPoll) > 0 ? Math.floor(Number(rawPoll)) : 25;
      const execute = async () => {
        if (isQuarantined(sessionID)) throw quarantinedError();
        await oc.session.get({ sessionID }); // proves the native session exists before any bind
        if (isQuarantined(sessionID)) throw quarantinedError();
        const preIdle = await waitForSessionIdle(sessionID, idleTimeoutMs, idlePollMs);
        if (!preIdle) {
          quarantineSession(sessionID);
          throw quarantinedError();
        }
        if (isQuarantined(sessionID)) throw quarantinedError();
        let current = null;
        try {
          current = getBinding(sessionID) ?? null;
        } catch {
          current = null;
        }
        const live = current && !current.revoked && !(typeof current.expiresAt === 'number' && Date.now() > current.expiresAt)
          ? current
          : null;
        if (live) {
          if (!isSameHost(live.host, host)) {
            rotateSessionBinding(sessionID, host);
          }
        } else {
          bindSession(sessionID, host);
        }
        let result;
        try {
          result = await fn();
        } catch (fnErr) {
          const postIdle = await waitForSessionIdle(sessionID, idleTimeoutMs, idlePollMs);
          try {
            revokeSession(sessionID);
          } catch { /* revoke is best-effort */ }
          if (!postIdle) {
            quarantineSession(sessionID);
            throw quarantinedError();
          }
          throw fnErr;
        }
        const postIdle = await waitForSessionIdle(sessionID, idleTimeoutMs, idlePollMs);
        try {
          revokeSession(sessionID); // revoke on exit: no stale host survives the window
        } catch { /* revoke is best-effort */ }
        if (!postIdle) {
          quarantineSession(sessionID);
          throw quarantinedError();
        }
        return result;
      };
      const tail = sessionQueues.get(sessionID) ?? Promise.resolve();
      const run = tail.then(execute, execute);
      const settled = run.then(
        (value) => {
          if (sessionQueues.get(sessionID) === settled) sessionQueues.delete(sessionID);
          return value;
        },
        (e) => {
          if (sessionQueues.get(sessionID) === settled) sessionQueues.delete(sessionID);
          throw e;
        },
      );
      sessionQueues.set(sessionID, settled);
      settled.catch(() => {});
      return run;
    }
    // Server-only runtime operations (the gateway path — never HTTP): the
    // narrowest SDK-backed surface the listener needs. Raw `oc` is NEVER
    // exposed; sessions are created without prompting (no inference at boot
    // or at session creation — the prompt loop runs only per request).
    const serverOps = {
      // Proves the native session exists (oc.session.get) and THEN binds the
      // process-local tool host. Called AFTER gateway identity + conversation
      // metadata checks, BEFORE any native prompt/read.
      async bindAuthenticatedSession(sessionID, host) {
        if (typeof sessionID !== 'string' || sessionID.length === 0) {
          throw new Error('bindAuthenticatedSession: sessionID is required');
        }
        await oc.session.get({ sessionID });
        bindSession(sessionID, host);
        return true;
      },
      // Allocates a native session for a verified conversation (no prompt,
      // no inference — admission happens per request via the prompt host).
      // Sessions ALWAYS use agent 'ted' explicitly (least-privilege finance
      // agent); default_agent:'ted' in config is the backstop, never the path.
      async createNativeSession() {
        const s = await oc.session.create({ title: 'ted-finance', agent: 'ted' });
        return s.id;
      },
      // Per-request turn host bound to the SAME oc (never exposed).
      createPromptHost(opts = {}) {
        return createPromptHost({ oc, ...(opts || {}) });
      },
      withAuthenticatedSession,
    };
    return {
      identity,
      profile: resolvedProfile,
      dirs: iso.dirs,
      bindings: { revokeSession, clearAll },
      serverOps,
      async close() {
        await oc.close().catch(() => {});
      },
    };
  } catch (e) {
    // Close on EVERY post-create failure (factory throw, bad shape,
    // wirePlugin throw) — never leave SDK fibers or sqlite locks alive.
    await oc.close().catch(() => {});
    throw e;
  }
}

// G2-01 proof runner (spike 02): registers the TED finance plugin through the
// NATIVE 2.2.4 plugin mechanism and reports the effective catalog.
//
// Native mechanism (verified against installed 2.2.4 .d.ts):
//   Plugin.define({id, setup}) [plugin/dist/promise/plugin.d.ts] +
//   ctx.tool.transform(editor => editor.add(tool)) [plugin/dist/promise/tool.d.ts]
//   FILE:LINE citations live in reports/spike-02-results.md.
//
// Registration entrypoint used here: the embedded SDK's native plugin
// interface (oc.plugin(pluginObject), SDK Interface in sdk/dist/promise.d.ts).
// WHY NOT config-file discovery (<config>/plugin/ or `plugins: [dir]`):
// in this embedded Windows env every file-based local plugin — including a
// zero-import minimal `{id, setup(){}}` probe — stays in state "failed" with
// "Plugin failed to load" BEFORE setup() ever runs (no marker, no ctx), while
// the identical module via oc.plugin() reaches state "active" with both tools
// in the native catalog. Pre-setup file-pipeline failure (reload-hook / file
// watch backend unsupported in embedded env) => environmental BLOCKED for the
// discovery path; the registration mechanism itself (define/setup/transform/
// editor.add + native ctx.tool.list proof) is identical post-load.
//
// Usage: node run-finance-check.mjs [identity]
// Prints ONE JSON line: { identity, pluginListed, tedEntry, marker }.
// Exit non-zero on boot failure. No LLM, no network, synthetic only.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireHere = createRequire(path.join(HERE, 'run-identity.mjs'));

const identity = process.argv[2] || 'c';
if (!['a', 'b', 'c'].includes(identity)) {
  console.error('identity must be a, b or c');
  process.exit(2);
}

const { setupIsolation } = requireHere('./env.cjs');
const { writeTedConfig } = requireHere('./ted-config.cjs');
const iso = setupIsolation(identity);
writeTedConfig(iso.dirs.config);
process.chdir(iso.dirs.workspace);

const markerFile = path.join(iso.dirs.tmp, 'ted-finance-loaded.json');
try { fs.unlinkSync(markerFile); } catch { /* fresh proof per boot */ }
process.env.TED_FINANCE_MARKER_FILE = markerFile;

const { OpenCode } = await import('@opencode/sdk');
const oc = await OpenCode.create({
  config: { directory: iso.dirs.config, project: false },
  database: { path: iso.dirs.db },
});
try {
  const ted = (await import('./plugins/ted-finance/index.mjs')).default;
  await oc.plugin(ted);
  // Plugin init is async: poll the EFFECTIVE catalog until settled.
  let pluginListed = [];
  let tedEntry = null;
  let marker = null;
  for (let i = 0; i < 60; i++) {
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { marker = null; }
    const listed = await oc.plugin.list().catch(() => null);
    pluginListed = listed ? (listed.data || []).map((p) => p.id || p.name) : [];
    tedEntry = listed ? (listed.data || []).find((p) => (p.id || p.name) === 'ted-finance') || null : null;
    const ready = marker && tedEntry && tedEntry.state && tedEntry.state.status === 'active';
    if (ready) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(JSON.stringify({ identity, pluginListed, tedEntry, marker }));
  if (!marker || !tedEntry || tedEntry.state.status !== 'active') process.exitCode = 3;
} finally {
  await oc.close().catch(() => {});
}

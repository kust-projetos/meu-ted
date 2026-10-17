#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SPEC = 'docs/superpowers/specs/2026-07-28-project-recovery-product-architecture.md';
const ROADMAP_HTML = 'docs/superpowers/plans/2026-07-28-project-recovery-roadmap.html';
// Roadmap decision pair: docs/ROADMAP.md is the living roadmap; the 2026-07
// HTML snapshot stays accepted as the pair for historical diffs. Either one
// satisfies the roadmap side of the ADR + spec + roadmap trio.
const ROADMAP = 'docs/ROADMAP.md';
const PRODUCT = 'docs/PRODUCT.md';
const ARCHITECTURE = 'docs/ARCHITECTURE-CURRENT.md';
const ADR027 = 'docs/adr/ADR-027-workspace-plurality-lifecycle-views.md';

// Policy: an ADR-027 decision-header change is a decision change under the
// same trio rule as D01-D19 (ADR + spec + roadmap in the same diff). The
// edited ADR-027 file itself satisfies the ADR side; spec and roadmap must
// still accompany it. Orthographic edits elsewhere in the file do not match
// the header pattern and never trigger the gate.
export const PROTECTED_DECISION_FILES = [SPEC, ROADMAP_HTML, ROADMAP, PRODUCT, ARCHITECTURE, ADR027];

// A decision change is an ADDED decision-table row (`+| D01 | ...`, D01-D19)
// in a protected file, or an ADDED ADR-027 decision header (`## Decisão
// D1/D2/D3`, the exact header format of that file). Prose mentions, typo
// fixes and non-table edits never trigger the gate.
const DECISION_TABLE_ROW = /^\+\| D(0[1-9]|1[0-9]) \|/;
const ADR027_DECISION_HEADER = /^\+.*## Decisão D[123]\b/;

export function hasDecisionChange(decisionDiff, changedFiles = []) {
  const lines = decisionDiff.split(/\r?\n/);
  if (lines.some((line) => DECISION_TABLE_ROW.test(line))) return true;
  if (changedFiles.includes(ADR027) && lines.some((line) => ADR027_DECISION_HEADER.test(line))) return true;
  return false;
}

export const evaluateDecisionGovernance = ({ changedFiles, decisionDiff }) => {
  if (!hasDecisionChange(decisionDiff, changedFiles)) {
    return { ok: true, reason: 'no D01-D19 change detected' };
  }

  const hasAdr = changedFiles.some((file) => /^docs\/adr\/.*\.md$/.test(file) && !file.endsWith('/README.md'));
  const hasSpec = changedFiles.includes(SPEC);
  const hasRoadmap = changedFiles.includes(ROADMAP_HTML) || changedFiles.includes(ROADMAP);
  return {
    ok: hasAdr && hasSpec && hasRoadmap,
    reason: hasAdr && hasSpec && hasRoadmap
      ? 'ADR + spec + roadmap present'
      : 'D01-D19 changes require ADR + spec + roadmap in the same diff',
  };
};

const HEX40 = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0{40}$/;

export function validateBaseSha(value) {
  if (!value) return { ok: false, reason: 'governance base is empty' };
  if (!HEX40.test(value)) return { ok: false, reason: `governance base is not a 40-hex SHA: ${String(value).slice(0, 64)}` };
  if (ZERO_SHA.test(value)) return { ok: false, reason: 'governance base is the zero SHA' };
  return { ok: true };
}

export function resolveBase({ argv = process.argv, env = process.env } = {}) {
  const cliIndex = argv.indexOf('--base');
  if (cliIndex !== -1) return { base: argv[cliIndex + 1], source: 'cli' };
  const fromEnv = env.GITHUB_BASE_SHA || env.GITHUB_EVENT_BEFORE;
  if (fromEnv) return { base: fromEnv, source: 'env' };
  return { base: 'HEAD', source: 'local' };
}

export function resolveEvent({ argv = process.argv, env = process.env } = {}) {
  const cliIndex = argv.indexOf('--event');
  if (cliIndex !== -1) return argv[cliIndex + 1];
  return env.GITHUB_EVENT_NAME || 'unknown';
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lines = (value) => value.split(/\r?\n/).filter(Boolean);

export const collectState = ({ argv = process.argv, env = process.env, cwd = process.cwd() } = {}) => {
  const { base, source } = resolveBase({ argv, env });
  const ci = env.CI === 'true';
  if (source === 'local') {
    // Local mode (no --base, no CI env): keep working-tree behavior.
    if (ci) {
      throw new Error('Decision governance failed: governance base is missing in CI (fail-closed, no silent HEAD diff).');
    }
  } else {
    const validation = validateBaseSha(base);
    if (!validation.ok) {
      throw new Error(`Decision governance failed: ${validation.reason} (fail-closed, no silent HEAD diff).`);
    }
  }
  // Push `before` is an exact parent commit: two-dot range. Pull-request
  // bases are merge-base targets: three-dot range. Unknown events keep the
  // historical three-dot behavior.
  const event = resolveEvent({ argv, env });
  const separator = event === 'push' ? '..' : '...';
  const range = source === 'local' ? ['diff', '--unified=0', 'HEAD', '--'] : ['diff', '--unified=0', `${base}${separator}HEAD`, '--'];
  const changedArgs = source === 'local'
    ? ['diff', '--name-only', 'HEAD', '--']
    : ['diff', '--name-only', `${base}${separator}HEAD`, '--'];
  const changedFiles = new Set(lines(git(cwd, ...changedArgs)));
  lines(git(cwd, 'status', '--porcelain', '--untracked-files=all')).forEach((line) => {
    const file = line.slice(3).replace(/^"|"$/g, '');
    if (file) changedFiles.add(file);
  });

  const trackedDecisionFiles = PROTECTED_DECISION_FILES.filter((file) => {
    try { return Boolean(git(cwd, 'ls-files', '--error-unmatch', file).trim()); } catch { return false; }
  });
  let decisionDiff = trackedDecisionFiles.length > 0
    ? git(cwd, ...range, ...trackedDecisionFiles)
    : '';
  for (const file of PROTECTED_DECISION_FILES) {
    if (!trackedDecisionFiles.includes(file) && existsSync(`${cwd}/${file}`)) {
      decisionDiff += `\n${readFileSync(`${cwd}/${file}`, 'utf8').split(/\r?\n/).map((line) => `+${line}`).join('\n')}`;
    }
  }
  return { changedFiles: [...changedFiles], decisionDiff, base: source === 'local' ? 'HEAD' : base, source, event };
};

export const main = () => {
  try {
    const result = evaluateDecisionGovernance(collectState());
    if (!result.ok) {
      console.error(`Decision governance failed: ${result.reason}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Decision governance: ${result.reason}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

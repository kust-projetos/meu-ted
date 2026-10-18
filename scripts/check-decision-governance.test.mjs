import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateDecisionGovernance } from './check-decision-governance.mjs';

const spec = 'docs/superpowers/specs/2026-07-28-project-recovery-product-architecture.md';
const roadmap = 'docs/superpowers/plans/2026-07-28-project-recovery-roadmap.html';

test('rejects a D01-D19 change without ADR and paired docs', () => {
  const result = evaluateDecisionGovernance({
    changedFiles: [spec],
    decisionDiff: '+| D01 | changed decision |',
  });
  assert.equal(result.ok, false);
});

test('accepts a D01-D19 change with ADR, spec and roadmap', () => {
  const result = evaluateDecisionGovernance({
    changedFiles: ['docs/adr/002-change.md', spec, roadmap],
    decisionDiff: '+| D01 | changed decision |',
  });
  assert.equal(result.ok, true);
});

test('ignores prose mentions of decision IDs without a table row', () => {
  const result = evaluateDecisionGovernance({
    changedFiles: [spec],
    decisionDiff: '+ just mentions D05 in prose without changing any decision',
  });
  assert.equal(result.ok, true);
});

test('accepts docs/ROADMAP.md as the roadmap pair of a decision', () => {
  const result = evaluateDecisionGovernance({
    changedFiles: ['docs/adr/002-change.md', spec, 'docs/ROADMAP.md'],
    decisionDiff: '+| D02 | changed decision |',
  });
  assert.equal(result.ok, true);
});

test('requires the trio when an ADR-027 decision header changes', () => {
  const adr027 = 'docs/adr/ADR-027-workspace-plurality-lifecycle-views.md';
  const alone = evaluateDecisionGovernance({
    changedFiles: [adr027],
    decisionDiff: '+## Decisão D1 — N workspaces pessoais + compartilhados',
  });
  assert.equal(alone.ok, false);
  const complete = evaluateDecisionGovernance({
    changedFiles: [adr027, spec, 'docs/ROADMAP.md'],
    decisionDiff: '+## Decisão D1 — N workspaces pessoais + compartilhados',
  });
  assert.equal(complete.ok, true);
});

test('orthographic edits in protected files do not trigger the gate', () => {
  const result = evaluateDecisionGovernance({
    changedFiles: ['docs/PRODUCT.md'],
    decisionDiff: '+ fixed a typo in the product description',
  });
  assert.equal(result.ok, true);
});

test('rejects missing, zero and malformed bases when CI provides env', async () => {
  const { validateBaseSha, collectState } = await import('./check-decision-governance.mjs');
  assert.equal(validateBaseSha('').ok, false);
  assert.equal(validateBaseSha('0'.repeat(40)).ok, false);
  assert.equal(validateBaseSha('not-a-sha').ok, false);
  assert.equal(validateBaseSha('abc123').ok, false);
  assert.equal(validateBaseSha('e74045780dbbd585c66cbbf121e53cb7472d47db').ok, true);
  assert.throws(
    () => collectState({ argv: ['node', 'x'], env: { CI: 'true' }, cwd: process.cwd() }),
    /missing.*CI/i,
  );
  assert.throws(() =>
    collectState({ argv: ['node', 'x'], env: { CI: 'true', GITHUB_BASE_SHA: 'xyz' }, cwd: process.cwd() }),
  );
  assert.throws(() =>
    collectState({
      argv: ['node', 'x'],
      env: { CI: 'true', GITHUB_BASE_SHA: '0'.repeat(40) },
      cwd: process.cwd(),
    }),
  );
});

// ── Real-git fixtures: a disposable repo proves the gate reads an actual
// base..head diff instead of an empty checkout.
const SPEC = 'docs/superpowers/specs/2026-07-28-project-recovery-product-architecture.md';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initDecisionRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-fixture-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'gov-test@example.test');
  git(dir, 'config', 'user.name', 'gov-test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const specDir = path.join(dir, path.dirname(SPEC));
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(dir, SPEC), '# spec\n\n| D01 | base decision |\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() };
}

function cleanupDecisionRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('git fixture: decision change without ADR is rejected', async () => {
  const { collectState } = await import('./check-decision-governance.mjs');
  const { dir, base } = initDecisionRepo();
  try {
    fs.appendFileSync(path.join(dir, SPEC), '\n| D02 | new decision without ADR |\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'decision without ADR');
    const state = collectState({
      argv: ['node', 'x', '--base', base],
      env: {},
      cwd: dir,
    });
    const result = evaluateDecisionGovernance(state);
    assert.equal(result.ok, false);
  } finally {
    cleanupDecisionRepo(dir);
  }
});

test('git fixture: decision with ADR, spec and roadmap is accepted', async () => {
  const { collectState } = await import('./check-decision-governance.mjs');
  const { dir, base } = initDecisionRepo();
  try {
    fs.appendFileSync(path.join(dir, SPEC), '\n| D02 | new decision with trio |\n');
    fs.mkdirSync(path.join(dir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'adr', '003-trio.md'), '# ADR 003\n');
    fs.writeFileSync(path.join(dir, 'docs', 'ROADMAP.md'), '# roadmap\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'decision with trio');
    const state = collectState({
      argv: ['node', 'x', '--base', base],
      env: {},
      cwd: dir,
    });
    const result = evaluateDecisionGovernance(state);
    assert.equal(result.ok, true);
  } finally {
    cleanupDecisionRepo(dir);
  }
});

test('git fixture: non-decision edit in a protected file is accepted', async () => {
  const { collectState } = await import('./check-decision-governance.mjs');
  const { dir, base } = initDecisionRepo();
  try {
    fs.appendFileSync(path.join(dir, SPEC), '\nFixed an orthographic typo here.\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'typo fix');
    const state = collectState({
      argv: ['node', 'x', '--base', base],
      env: {},
      cwd: dir,
    });
    const result = evaluateDecisionGovernance(state);
    assert.equal(result.ok, true);
  } finally {
    cleanupDecisionRepo(dir);
  }
});

test('git fixture: push multi-commit range collects every commit', async () => {
  const { collectState } = await import('./check-decision-governance.mjs');
  const { dir, base } = initDecisionRepo();
  try {
    fs.writeFileSync(path.join(dir, 'first.txt'), 'first\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'first');
    fs.writeFileSync(path.join(dir, 'second.txt'), 'second\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'second');
    const state = collectState({
      argv: ['node', 'x', '--base', base, '--event', 'push'],
      env: {},
      cwd: dir,
    });
    assert.ok(state.changedFiles.includes('first.txt'), `missing first.txt: ${state.changedFiles}`);
    assert.ok(state.changedFiles.includes('second.txt'), `missing second.txt: ${state.changedFiles}`);
  } finally {
    cleanupDecisionRepo(dir);
  }
});

// ── ADR-027 real-collection pair for the manual-diff test above: the gate
// must collect the ADR-027 file itself, not just trust injected diffs.
const ADR027 = 'docs/adr/ADR-027-workspace-plurality-lifecycle-views.md';

function initAdr027Repo() {
  const { dir, base } = initDecisionRepo();
  const adrDir = path.join(dir, path.dirname(ADR027));
  fs.mkdirSync(adrDir, { recursive: true });
  fs.writeFileSync(path.join(dir, ADR027), '# ADR-027\n\n## Decisão D1 — N workspaces pessoais\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base with ADR-027');
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() };
}

test('git fixture: ADR-027 header change without spec/roadmap is rejected', async () => {
  const { collectState } = await import('./check-decision-governance.mjs');
  const { dir, base } = initAdr027Repo();
  try {
    const adr = fs.readFileSync(path.join(dir, ADR027), 'utf8');
    fs.writeFileSync(path.join(dir, ADR027), adr.replace('## Decisão D1 — N workspaces pessoais', '## Decisão D1 — N workspaces pessoais e compartilhados'));
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'reword ADR-027 D1 header');
    const state = collectState({
      argv: ['node', 'x', '--base', base],
      env: {},
      cwd: dir,
    });
    assert.ok(
      state.decisionDiff.includes('## Decisão D1'),
      `collector must include the ADR-027 header change, got: ${JSON.stringify(state.decisionDiff.slice(0, 300))}`,
    );
    const result = evaluateDecisionGovernance(state);
    assert.equal(result.ok, false);
  } finally {
    cleanupDecisionRepo(dir);
  }
});

test('git fixture: ADR-027 header change with spec and roadmap is accepted', async () => {
  const { collectState } = await import('./check-decision-governance.mjs');
  const { dir, base } = initAdr027Repo();
  try {
    const adr = fs.readFileSync(path.join(dir, ADR027), 'utf8');
    fs.writeFileSync(path.join(dir, ADR027), adr.replace('## Decisão D1 — N workspaces pessoais', '## Decisão D1 — N workspaces pessoais e compartilhados'));
    fs.appendFileSync(path.join(dir, SPEC), '\n| D02 | mirrors the ADR-027 D1 change |\n');
    fs.writeFileSync(path.join(dir, 'docs/ROADMAP.md'), '# roadmap\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'ADR-027 D1 with trio');
    const state = collectState({
      argv: ['node', 'x', '--base', base],
      env: {},
      cwd: dir,
    });
    const result = evaluateDecisionGovernance(state);
    assert.equal(result.ok, true);
  } finally {
    cleanupDecisionRepo(dir);
  }
});

test('ci.yml governance job resolves the base per event and fails closed', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const start = workflow.indexOf('\n  governance:');
  assert.notEqual(start, -1, 'governance job missing');
  const region = workflow.slice(start);
  assert.ok(
    region.includes('github.event.pull_request.base.sha'),
    'governance must resolve the pull_request base SHA',
  );
  assert.ok(region.includes('github.event.before'), 'governance must resolve the push before SHA');
  assert.ok(region.includes('GITHUB_BASE_SHA'), 'governance must inject GITHUB_BASE_SHA for the check');
  assert.ok(
    region.includes('governance:check -- --base'),
    'governance must run the check against the resolved base',
  );
  assert.ok(region.includes('exit 1'), 'governance base resolution must fail closed');
  assert.ok(!/run:\s*[|>]/m.test(region) || !region.includes('vars.'),
    'governance job must not interpolate vars.* into run: script text');
  for (const line of region.split('\n')) {
    if (/^\s*run:/.test(line)) assert.ok(!line.includes('vars.'), `vars.* in run:: ${line.trim()}`);
  }
});

/**
 * F2-A — frozen F1 artifacts, packaged byte-for-byte in `./frozen/`.
 *
 * Provenance: the three packaged files are exact copies of the blobs committed
 * at `FROZEN_ARTIFACT_COMMIT` (full 40-hex SHA), and `FROZEN_ARTIFACT_SHA256`
 * holds the SHA-256 of those committed bytes.
 *
 * Why packaged copies instead of `git show <commit>:<path>`: CI checks the
 * repository out shallow, so the pinned baseline commit is not reachable there
 * and the previous runtime lookup failed deterministically. The A-side oracle
 * only needs immutable bytes with a pinned digest, not Git ancestry. Every load
 * reads this directory and hash-checks the bytes against the pin; nothing here
 * claims that Git ancestry or commit existence is verified at runtime.
 *
 * The F1 generators rewrite `generatedAt` and `harnessElapsedMs` every run, so
 * the working tree copies of `evals/reports/*.json` are MUTABLE observations and
 * are never consulted. Refreshing the oracle means re-copying from the pinned
 * commit and re-pinning both the commit and the digests.
 *
 * Read-only: nothing in this module writes the index, the working tree or Git.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Directory holding the byte-exact packaged copies. */
const FROZEN_DIR = resolve(import.meta.dirname, 'frozen');

/** Baseline commit the packaged bytes were copied from (provenance only). */
export const FROZEN_ARTIFACT_COMMIT = 'ef12a8ee7e4ef6c215bffce755e1d7c68c89820e';

/** File name of each packaged copy inside `./frozen/`. */
export const FROZEN_ARTIFACT_PATHS = Object.freeze({
  scenarios: 'scenarios.json',
  journeys: 'journeys.json',
  baseline: 'baseline.json',
} as const);

/** Provenance: repository path each packaged copy came from at the pinned commit. */
export const FROZEN_ARTIFACT_SOURCE_PATHS = Object.freeze({
  scenarios: 'apps/agent/evals/ted-f1-scenarios.json',
  journeys: 'apps/agent/evals/reports/ted-f1-journeys.json',
  baseline: 'apps/agent/evals/reports/ted-f1-baseline.json',
} as const);

export type FrozenArtifactName = keyof typeof FROZEN_ARTIFACT_PATHS;

/** SHA-256 of the bytes as committed (verified on every load). */
export const FROZEN_ARTIFACT_SHA256: Readonly<Record<FrozenArtifactName, string>> = Object.freeze({
  scenarios: '7f36d008c6316666396d0747df2b6abc488a71a85afda4abf60e11b63f774726',
  journeys: '5bdc2be4eeb2ce099452544dd58ca7bb45015e3ca4288fe59fde97374a3c9f12',
  baseline: 'ca89250a7b7c0ca6d4c6ce376064677bd97cc0a8041e1ed3c2cedd087b046926',
});

/** Bytes of the packaged frozen artifact, hash-checked against the pin. */
export const readFrozenArtifactBytes = (name: FrozenArtifactName): Buffer => {
  const bytes = readFileSync(resolve(FROZEN_DIR, FROZEN_ARTIFACT_PATHS[name]));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const expected = FROZEN_ARTIFACT_SHA256[name];
  if (digest !== expected) {
    throw new Error(
      `frozen artifact hash mismatch for ${FROZEN_ARTIFACT_SOURCE_PATHS[name]} @ ${FROZEN_ARTIFACT_COMMIT}: expected=${expected} actual=${digest}`,
    );
  }
  return bytes;
};

/** Parsed JSON of the packaged frozen artifact. */
export const loadFrozenArtifact = <T>(name: FrozenArtifactName): T =>
  JSON.parse(readFrozenArtifactBytes(name).toString('utf8')) as T;

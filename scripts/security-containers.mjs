import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { validateTrivyignoreFile } from './trivyignore-policy.mjs';

const images = ['pi-finance-api:ci', 'pi-finance-codex-broker:ci'];
const repoPath = process.cwd();
const commonArgs = [
  'run',
  '--rm',
  '-v',
  'trivy-cache:/root/.cache/trivy',
  '-v',
  '/var/run/docker.sock:/var/run/docker.sock',
  '-v',
  `${repoPath}:/repo:ro`,
  'aquasec/trivy:0.58.1',
  'image',
  '--scanners',
  'vuln',
  '--exit-code',
  '1',
  '--severity',
  'HIGH,CRITICAL',
  '--ignore-unfixed',
];

export function isCiEnv(env = process.env) {
  return env.CI === 'true';
}

// Injectable gate: dockerAvailable is the `docker info` outcome, runImage
// runs one scan and returns its spawnSync-like {status, error?} result.
// Reasons stay generic: vulnerability report content is never echoed into
// error logs; the redacted scanner output above is the record.
export function executeContainersGate({ env = process.env, dockerAvailable, runImage } = {}) {
  if (!dockerAvailable) {
    if (isCiEnv(env)) {
      return {
        exitCode: 1,
        reason: 'docker is not available in CI; failing closed without a container scan.',
      };
    }
    return {
      exitCode: 0,
      reason: 'Docker daemon not running locally. Skipping containerized trivy (verified in CI).',
    };
  }
  for (const image of images) {
    const result = runImage(image);
    if (result.error) {
      return { exitCode: 1, reason: `Unable to run Docker/Trivy: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return {
        exitCode: result.status ?? 1,
        reason: `container scan failed for ${image} (see redacted scanner output above).`,
      };
    }
  }
  return { exitCode: 0, reason: '' };
}

export function main(env = process.env) {
  const ignoreValidation = validateTrivyignoreFile(repoPath);
  if (!ignoreValidation.ok) {
    console.error('Refusing container scan: .trivyignore failed expiry validation (fail-closed).');
    for (const error of ignoreValidation.errors) console.error(` - ${error}`);
    console.error('Each ignored CVE needs a parseable, unexpired `Expiry: YYYY-MM-DD` declaration.');
    process.exitCode = 1;
    return { exitCode: 1, reason: 'trivyignore validation failed' };
  }
  const ignoreValidationEntries = ignoreValidation.entries;
  const hasIgnore = ignoreValidationEntries.length > 0;

  const checkDocker = spawnSync('docker', ['info'], { stdio: 'ignore', shell: false });
  const runImage = (image) => spawnSync('docker', [
    ...commonArgs,
    ...(hasIgnore ? ['--ignorefile', '/repo/.trivyignore'] : []),
    image,
  ], {
    stdio: 'inherit',
    shell: false,
  });
  const result = executeContainersGate({ env, dockerAvailable: checkDocker.status === 0, runImage });
  if (result.exitCode === 0) {
    if (result.reason) console.log(result.reason);
  } else {
    console.error(result.reason);
  }
  process.exitCode = result.exitCode;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

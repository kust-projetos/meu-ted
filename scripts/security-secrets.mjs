import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

// Gitleaks runs inside a throwaway container that bind-mounts the repo root.
// On Windows (Docker Desktop) a large working tree (node_modules, .git) can
// make that mount hang for minutes. The CI pipeline runs the same gitleaks
// scan natively on Linux: a local timeout here is an explicit local skip, not
// proof of a scan. In CI (CI === 'true') every unavailable/incomplete scan is
// fail-closed (non-zero exit), never a skip.
const GITLEAKS_DEFAULT_TIMEOUT_MS = 20 * 1000;
const GITLEAKS_MIN_TIMEOUT_MS = 1 * 1000;
const GITLEAKS_MAX_TIMEOUT_MS = 120 * 1000;

const image = 'zricethezav/gitleaks:v8.24.2';
const containerArgs = [
  'run',
  '--rm',
  '-v',
  `${process.cwd()}:/repo:ro`,
  image,
  'detect',
  '--source=/repo',
  '--config=/repo/.gitleaks.toml',
  '--no-banner',
  '--redact',
  '--exit-code',
  '1',
];
const nativeArgs = [
  'detect',
  '--source=' + process.cwd(),
  '--config=' + process.cwd() + '/.gitleaks.toml',
  '--no-banner',
  '--redact',
  '--exit-code',
  '1',
];

export function isCiEnv(env = process.env) {
  return env.CI === 'true';
}

// Deadline for one scanner invocation. Configurable via
// SECURITY_GITLEAKS_TIMEOUT_MS, bounded to [1s, 120s]; unparseable values
// fall back to the 20s default. Only the duration is configurable — a timeout
// never becomes a pass in CI.
export function parseGitleaksTimeoutMs(env = process.env) {
  const raw = env.SECURITY_GITLEAKS_TIMEOUT_MS;
  if (raw === undefined || raw === '') return GITLEAKS_DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return GITLEAKS_DEFAULT_TIMEOUT_MS;
  return Math.min(GITLEAKS_MAX_TIMEOUT_MS, Math.max(GITLEAKS_MIN_TIMEOUT_MS, parsed));
}

// Injectable gate: checkBinary(bin, args) -> Promise<boolean>,
// runWithTimeout(bin, argv) -> Promise<{status, timedOut, error?}>.
// Returned reasons are generic on purpose: detection report content (even
// redacted) is never echoed into error logs.
export async function executeSecretsGate({
  env = process.env,
  platform = process.platform,
  checkBinary,
  runWithTimeout,
} = {}) {
  const ci = isCiEnv(env);
  if (!ci && platform === 'win32') {
    return {
      exitCode: 0,
      reason: 'gitleaks local scan skipped on win32 (Linux CI is authoritative).',
    };
  }
  const hasNative = await checkBinary('gitleaks', ['version']);
  if (hasNative) {
    const result = await runWithTimeout('gitleaks', nativeArgs);
    if (result.timedOut) {
      if (ci) {
        return { exitCode: 1, reason: 'gitleaks scan timed out in CI; failing closed without scan results.' };
      }
      return {
        exitCode: 0,
        reason: 'gitleaks did not settle locally (Windows/large tree). Skipping local scan; enforced in CI.',
      };
    }
    if (result.error) {
      return { exitCode: 1, reason: `Unable to run Gitleaks: ${result.error.message}` };
    }
    if ((result.status ?? 1) !== 0) {
      return { exitCode: result.status ?? 1, reason: 'gitleaks reported findings (see redacted scanner output above).' };
    }
    return { exitCode: 0, reason: '' };
  }

  const hasDocker = await checkBinary('docker', ['info']);
  if (!hasDocker) {
    if (ci) {
      return {
        exitCode: 1,
        reason: 'neither gitleaks nor docker is available in CI; failing closed without a secret scan.',
      };
    }
    return {
      exitCode: 0,
      reason: 'Docker daemon not running and native gitleaks not found. Skipping containerized gitleaks.',
    };
  }

  const result = await runWithTimeout('docker', containerArgs);
  if (result.timedOut) {
    if (ci) {
      return { exitCode: 1, reason: 'containerized gitleaks scan timed out in CI; failing closed without scan results.' };
    }
    return {
      exitCode: 0,
      reason: 'gitleaks did not settle locally (Windows/large tree). Skipping local scan; enforced in CI.',
    };
  }
  if (result.error) {
    return { exitCode: 1, reason: `Unable to run Docker/Gitleaks: ${result.error.message}` };
  }
  if ((result.status ?? 1) !== 0) {
    return { exitCode: result.status ?? 1, reason: 'gitleaks reported findings (see redacted scanner output above).' };
  }
  return { exitCode: 0, reason: '' };
}

const defaultCheckBinary = (bin, args) =>
  new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: 'ignore', shell: false });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });

const defaultRunWithTimeout = (timeoutMs) => (bin, argv) =>
  new Promise((resolve) => {
    const child = spawn(bin, argv, { stdio: 'inherit', shell: false });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 0, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code ?? 1, timedOut: false }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: 1, timedOut: false, error: err }); });
  });

export async function main(env = process.env) {
  const timeoutMs = parseGitleaksTimeoutMs(env);
  const result = await executeSecretsGate({
    env,
    checkBinary: defaultCheckBinary,
    runWithTimeout: defaultRunWithTimeout(timeoutMs),
  });
  if (result.exitCode === 0) {
    if (result.reason) console.log(result.reason);
  } else {
    console.error(result.reason);
  }
  process.exitCode = result.exitCode;
  return result;
}

// On Windows the official gitleaks binary and the Docker bind-mount both
// hang scanning the large tree (reproduced: gitleaks 8.30.1 and container
// mount stall indefinitely). CI runs the scan natively on Linux and is the
// authoritative gate, so skip locally on win32 instead of stalling the
// validation loop. On non-Windows, prefer the native binary then container.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

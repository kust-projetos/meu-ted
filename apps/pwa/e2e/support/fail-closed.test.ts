// @vitest-environment node
/**
 * Fail-closed E2E harness (behavioral).
 *
 * Never attaches to an alien server: with a squatter occupying the Next
 * port, the stack must refuse to run — no test may execute against the
 * squatter, and the squatter must survive untouched.
 *
 * Concurrency note: the squatter lives in-process while the child runs, so
 * the child is spawned ASYNC (never spawnSync — that would block the event
 * loop and the squatter could not answer during the run, producing a
 * false-positive readiness probe). A poller hits the squatter WHILE the
 * child executes; at least one during-run 200 proves the loop stayed free.
 * On timeout only OUR OWN child is killed — the alien is never touched.
 */

import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA_ROOT = path.resolve(HERE, "..", "..");
const SQUATTER_MARKER = "ALIEN-SQUATTER-NOT-OURS";
const COLLECTOR_CAP = 512 * 1024;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        reject(new Error("probe has no address"));
      }
    });
  });
}

async function startSquatter(port: number): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(SQUATTER_MARKER);
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  servers.push(server);
}

function fetchMarker(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () =>
        resolve(
          res.statusCode === 200
            ? Buffer.concat(chunks).toString("utf8")
            : null,
        ),
      );
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Successful squatter probes observed WHILE the child executed. */
  duringRunHits: number;
};

function appendBounded(current: string, chunk: string): string {
  if (current.length >= COLLECTOR_CAP) return current;
  return current + chunk.slice(0, COLLECTOR_CAP - current.length);
}

/**
 * Spawn OUR OWN child async; poll the alien squatter during execution.
 * Only the spawned child is ever signalled (on timeout); the squatter is
 * read-only probed, never killed.
 */
function runAsync(
  cmd: string,
  env: Record<string, string>,
  timeoutMs: number,
  squatterPort: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, {
        cwd: PWA_ROOT,
        env: { ...process.env, ...env },
        shell: true,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        status: null,
        stdout: "",
        stderr: String(err),
        timedOut: false,
        duringRunHits: 0,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let duringRunHits = 0;
    let settled = false;

    const poller = setInterval(() => {
      void fetchMarker(squatterPort).then((marker) => {
        if (marker === SQUATTER_MARKER) duringRunHits += 1;
      });
    }, 250);
    // Unblock the loop promptly even if the child exits before the first tick.
    void fetchMarker(squatterPort).then((marker) => {
      if (marker === SQUATTER_MARKER && !settled) duringRunHits += 1;
    });

    const finish = (result: Omit<RunResult, "duringRunHits">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      resolve({ ...result, duringRunHits });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout = appendBounded(stdout, d.toString("utf8"));
    });
    child.stderr?.on("data", (d) => {
      stderr = appendBounded(stderr, d.toString("utf8"));
    });
    child.on("error", (err) => {
      finish({ status: null, stdout, stderr: stderr + String(err), timedOut: false });
    });
    child.on("close", (code) => {
      finish({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

describe("fail-closed harness", () => {
  it(
    "fixture server refuses to bind over an alien server (EADDRINUSE) and leaves it alive",
    { timeout: 120000 },
    async () => {
      const port = await freePort();
      await startSquatter(port);

      const result = await runAsync(
        `pnpm exec tsx e2e/fixture-api/server.ts --port ${port}`,
        {},
        90000,
        port,
      );
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(1);
      expect(output).toMatch(/EADDRINUSE/i);
      expect(output).toContain(String(port));
      // Loop stayed free: the alien answered DURING the run, and still does.
      expect(result.duringRunHits).toBeGreaterThan(0);
      expect(await fetchMarker(port)).toBe(SQUATTER_MARKER);
    },
  );

  it(
    "Playwright runs zero tests against a Next-port squatter, even with legacy E2E_SERVERS_OWNED=1",
    { timeout: 295000 },
    async () => {
      const nextPort = await freePort();
      const fixturePort = await freePort();
      const harnessPort = await freePort();
      await startSquatter(nextPort);

      const result = await runAsync(
        "pnpm exec playwright test --config=e2e/playwright.config.ts " +
          "--project=functional-mobile e2e/specs/auth.spec.ts --workers=1 -g AUTH-02",
        {
          E2E_NEXT_PORT: String(nextPort),
          E2E_FIXTURE_PORT: String(fixturePort),
          E2E_HARNESS_PORT: String(harnessPort),
          // Legacy ownership claim: must NOT grant reuse of the squatter.
          E2E_SERVERS_OWNED: "1",
        },
        280000,
        nextPort,
      );
      const output = `${result.stdout}\n${result.stderr}`;

      // Fail fast: the run is rejected, never executed against the alien.
      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(1);
      expect(output).toMatch(/port/i);
      expect(output).toContain(String(nextPort));
      expect(output).not.toMatch(/running \d+ tests?/i);
      // Loop stayed free: the alien answered DURING the run, and still does.
      expect(result.duringRunHits).toBeGreaterThan(0);
      expect(await fetchMarker(nextPort)).toBe(SQUATTER_MARKER);
    },
  );
});

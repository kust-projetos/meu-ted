import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHealthPayload,
  parseArgs,
  runAgentReleaseSmoke,
} from "./agent-release-smoke.mjs";

// Fakes: fetchImpl/sleepImpl with no real I/O; sleep records delays.

const EXPECTED = "a".repeat(40);
const OLD = "b".repeat(40);
const OTHER = "c".repeat(40);
const URL = "https://agent.example.invalid";

function okResponse(body, status = 200) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function fakeFetch(script) {
  const calls = [];
  const inits = [];
  let index = 0;
  const impl = async (url, init) => {
    calls.push(url);
    inits.push(init);
    const step = script[Math.min(index++, script.length - 1)];
    if (step instanceof Error) throw step;
    if (step.invalidJson === true) {
      return {
        status: step.status ?? 200,
        async json() {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      };
    }
    return okResponse(step.body, step.status ?? 200);
  };
  return { impl, calls, inits };
}

function fakeSleep() {
  const delays = [];
  const impl = async (ms) => {
    delays.push(ms);
  };
  return { impl, delays };
}

function silent() {
  const lines = [];
  const log = (msg) => {
    lines.push(String(msg));
  };
  return { log, lines };
}

async function run(script, opts = {}) {
  const fetch = fakeFetch(script);
  const sleep = fakeSleep();
  const logger = silent();
  const result = await runAgentReleaseSmoke({
    url: URL,
    expectedSha: EXPECTED,
    fetchImpl: fetch.impl,
    sleepImpl: sleep.impl,
    log: logger.log,
    ...opts,
  });
  return { result, fetch, sleep, logger };
}

// ---- contract case 1: immediate pass ----

test("buildSha === expected on the first attempt passes with attempts 1", async () => {
  const { result, sleep, fetch } = await run([{ body: { status: "ready", buildSha: EXPECTED } }]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(sleep.delays, []);
  assert.ok(fetch.calls[0].endsWith("/health"), `smoke must fetch <origin>/health, got ${fetch.calls[0]}`);
});

// ---- contract cases 2/3: stale SHA converges, then never converges ----

test("stale SHA on attempts 1-2 and correct SHA on 3 passes with attempts 3 and fixed backoff delays", async () => {
  const { result, sleep } = await run([
    { body: { status: "ready", buildSha: OLD } },
    { body: { status: "ready", buildSha: OLD } },
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleep.delays, [5000, 5000]);
});

test("always-stale SHA fails after maxAttempts with the last observed buildSha", async () => {
  const { result, sleep } = await run([{ body: { status: "ready", buildSha: OLD } }], { maxAttempts: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 4);
  assert.equal(result.lastBuildSha, OLD);
  assert.match(result.reason ?? "", /exhausted 4 attempts/);
  assert.deepEqual(sleep.delays, [5000, 5000, 5000]);
});

test("distinct SHAs until exhaustion fail (never converges)", async () => {
  const { result } = await run(
    [
      { body: { status: "ready", buildSha: OLD } },
      { body: { status: "ready", buildSha: OTHER } },
    ],
    { maxAttempts: 2 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.lastBuildSha, OTHER);
});

// ---- contract case 4: ready without buildSha fails immediately ----

test("status ready without buildSha fails immediately without retries", async () => {
  const { result, sleep } = await run([{ body: { status: "ready" } }]);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.deepEqual(sleep.delays, []);
  assert.equal(result.lastBuildSha, undefined);
});

// ---- contract case 6: 404 fails immediately ----

test("HTTP 404 fails immediately without retries", async () => {
  const { result, sleep } = await run([{ status: 404, body: {} }]);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.deepEqual(sleep.delays, []);
});

// ---- transients: network errors, invalid JSON, non-ready status ----

test("network errors on the first 2 attempts then success passes", async () => {
  const { result } = await run([
    new Error("fetch failed"),
    new Error("socket hang up"),
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test("invalid JSON on early attempts then valid payload passes", async () => {
  const { result } = await run([
    { invalidJson: true },
    { invalidJson: true },
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test("status !== ready retries (transitional state)", async () => {
  const { result } = await run([
    { body: { status: "starting", buildSha: OLD } },
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("other 5xx statuses retry and eventual success passes", async () => {
  const { result } = await run([
    { status: 503, body: {} },
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

// ---- redirect & deadline contract (issue #96 review round 2) ----

test("HTTP redirect fails immediately and is never followed (endpoint drift, not propagation)", async () => {
  const { result, fetch, sleep } = await run([
    { status: 302, body: {} },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.match(result.reason, /redirect/);
  assert.equal(sleep.delays.length, 0);
  // The fetch must be issued with redirect: "manual" — the canonical origin
  // is proven, never a redirect target that could report the expected SHA.
  assert.equal(fetch.inits[0]?.redirect, "manual");
});

test("each attempt carries an abort signal (request deadline covers connect+headers+body)", async () => {
  const { fetch, result } = await run([
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  const signal = fetch.inits[0]?.signal;
  assert.ok(signal instanceof AbortSignal, "fetch must receive an AbortSignal deadline");
});

test("aborted/hung request (network error) retries and converges", async () => {
  const abortError = new Error("This operation was aborted");
  abortError.name = "AbortError";
  const { result } = await run([
    abortError,
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("slow body read is cancelled by the attempt deadline (signal aborts res.json)", async () => {
  // Simulates a fetch whose BODY never completes while headers arrived: the
  // json() promise only settles when the injected signal aborts — proving the
  // per-attempt deadline covers the body read, not just connect+headers.
  const fetchCalls = [];
  const fetchImpl = async (_url, init) => {
    fetchCalls.push(init);
    return {
      status: 200,
      async json() {
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { status: "ready", buildSha: EXPECTED };
      },
    };
  };
  const sleep = fakeSleep();
  const logger = silent();
  const result = await runAgentReleaseSmoke({
    url: URL,
    expectedSha: EXPECTED,
    fetchImpl,
    sleepImpl: sleep.impl,
    log: logger.log,
    maxAttempts: 2,
    baseDelayMs: 0,
    requestTimeoutMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.ok(logger.lines.some((l) => l.includes("deadline exceeded while reading body")), logger.lines.join("\n"));
});

test("parseArgs validates --request-timeout-ms (default, override, rejection)", () => {
  const base = parseArgs(["--url", URL, "--expected-sha", EXPECTED]);
  assert.equal(base.requestTimeoutMs, 5000);
  const custom = parseArgs(["--url", URL, "--expected-sha", EXPECTED, "--request-timeout-ms", "1500"]);
  assert.equal(custom.requestTimeoutMs, 1500);
  for (const bad of ["0", "-1", "abc", "1.5"]) {
    assert.throws(
      () => parseArgs(["--url", URL, "--expected-sha", EXPECTED, "--request-timeout-ms", bad]),
      /invalid --request-timeout-ms/,
    );
  }
});

// ---- log contract: one line per attempt plus explicit PASS/FAIL ----

test("logs one line per attempt and an explicit PASS/FAIL line", async () => {
  const { logger, result } = await run([
    { body: { status: "ready", buildSha: OLD } },
    { body: { status: "ready", buildSha: EXPECTED } },
  ]);
  assert.equal(result.ok, true);
  assert.ok(logger.lines.some((l) => l.includes("attempt 1/8") && l.includes("RETRY")), logger.lines.join("\n"));
  assert.ok(logger.lines.some((l) => l.includes("attempt 2/8") && l.includes("PASS")), logger.lines.join("\n"));
  assert.ok(logger.lines.at(-1).includes("PASS"), logger.lines.join("\n"));
});

// ---- CLI arg validation (fail-closed, no value echo) ----

test("parseArgs rejects non-hex/short SHAs", () => {
  for (const bad of ["zzz", "abc", "A".repeat(40), `${EXPECTED}x`, "", "0cb7a72"]) {
    assert.throws(() => parseArgs(["--url", URL, "--expected-sha", bad]), /invalid --expected-sha/);
  }
});

test("parseArgs rejects non-https URLs", () => {
  for (const bad of ["http://agent.example.invalid", "not-a-url", "", "ftp://agent.example.invalid"]) {
    assert.throws(() => parseArgs(["--url", bad, "--expected-sha", EXPECTED]), /invalid --url/);
  }
});

test("parseArgs error messages never echo the rejected value (truly invalid URL)", () => {
  const marker = "evil-marker-7q4z";
  // Review round 2 (LOW): the previous version fed a VALID https URL here, so
  // parseArgs never threw and the assert.fail below was caught by this very
  // catch — a false green. The URL must be genuinely unparseable.
  const invalidUrl = `https://${marker} .example (space breaks parsing)`;
  assert.throws(
    () => parseArgs(["--url", invalidUrl, "--expected-sha", EXPECTED]),
    (err) => /invalid --url/.test(err.message) && !err.message.includes(marker),
    "must throw invalid --url without echoing the value",
  );
  assert.throws(
    () => parseArgs(["--url", URL, "--expected-sha", `${marker}-not-a-sha`]),
    (err) => /invalid --expected-sha/.test(err.message) && !err.message.includes(marker),
    "must throw invalid --expected-sha without echoing the value",
  );
});

test("parseArgs accepts valid args with defaults and optional overrides", () => {
  const base = parseArgs(["--url", URL, "--expected-sha", EXPECTED]);
  assert.equal(base.maxAttempts, 8);
  assert.equal(base.baseDelayMs, 5000);
  const custom = parseArgs(["--url", URL, "--expected-sha", EXPECTED, "--max-attempts", "3", "--base-delay-ms", "100"]);
  assert.equal(custom.maxAttempts, 3);
  assert.equal(custom.baseDelayMs, 100);
  assert.throws(() => parseArgs(["--url", URL, "--expected-sha", EXPECTED, "--max-attempts", "0"]), /invalid --max-attempts/);
  assert.throws(() => parseArgs(["--url", URL, "--expected-sha", EXPECTED, "--nope", "1"]), /invalid argument/);
});

// ---- evaluateHealthPayload pure verdicts ----

test("evaluateHealthPayload returns each verdict for minimal typical payloads", () => {
  assert.deepEqual(evaluateHealthPayload({ status: "ready", buildSha: EXPECTED }, EXPECTED), { verdict: "pass" });
  assert.equal(evaluateHealthPayload({ status: "ready", buildSha: OLD }, EXPECTED).verdict, "retry");
  assert.equal(evaluateHealthPayload({ status: "ready" }, EXPECTED).verdict, "fail");
  assert.equal(evaluateHealthPayload({ status: "ready", buildSha: "" }, EXPECTED).verdict, "fail");
  assert.equal(evaluateHealthPayload({ status: "starting", buildSha: EXPECTED }, EXPECTED).verdict, "retry");
  assert.equal(evaluateHealthPayload(null, EXPECTED).verdict, "retry");
  assert.equal(evaluateHealthPayload("ready", EXPECTED).verdict, "retry");
  assert.equal(evaluateHealthPayload([{ status: "ready", buildSha: EXPECTED }], EXPECTED).verdict, "retry");
});

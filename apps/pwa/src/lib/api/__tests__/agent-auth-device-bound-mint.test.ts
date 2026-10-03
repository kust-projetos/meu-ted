/**
 * FIX-PWA-DEVICE-BOUND-MINT: the agent connection token mint must carry the
 * device token explicitly (T2.5 sanctioned channel — `apiFetch({ token })`)
 * so the API emits a device-bound JWT (`deviceId` claim, H-12). Without it
 * the Worker deletes `x-agent-device` and every approval/undo RPC 401s with
 * `agent.approval_context_required` for 100% of users.
 *
 * FIX-AGENT-MINT-SELF-HEAL: a cookie-only session (AuthGate boot path) leaves
 * `pi-finance:token` empty, so the mint silently degraded to deviceless. The
 * mint now self-heals by registering the device through the session once
 * (single-flight) and re-registers ONCE when a presented device token is
 * rejected with 401 (stale/revoked device).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import {
  fetchAgentConnectionToken,
  clearAgentConnectionTokenCache,
  clearAgentSession,
} from "../agent-auth";
import { getToken, setToken, clearToken } from "../../auth/token-store";
import { UNAUTHORIZED_EVENT } from "../client";
import { registerDeviceToken } from "../auth";

const ORIGINAL = "http://localhost:3000";

const DEVICE_REGISTER_PATH = "/auth/devices/register";
const MINT_PATH = "/auth/agent-token";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes the global fetch by path so register and mint calls stay distinguishable. */
const routeFetch = (route: (url: string) => Response | Promise<Response>): void => {
  fetchMock.mockImplementation(async (input: unknown) => route(String(input)));
};

const callIndexesFor = (path: string): number[] =>
  fetchMock.mock.calls
    .map((call, index) => ({ url: String(call[0]), index }))
    .filter(({ url }) => url.includes(path))
    .map(({ index }) => index);

const headersAt = (callIndex: number): Record<string, string> =>
  (fetchMock.mock.calls[callIndex]![1] as RequestInit).headers as Record<string, string>;

const deviceResponse = (token: string): Response =>
  jsonResponse({ token, deviceId: "dev-1", householdId: "hh-1" }, 201);

const mintResponse = (token: string): Response => jsonResponse({ token, expiresIn: 120 });

describe("FIX-PWA-DEVICE-BOUND-MINT — /auth/agent-token carries the device token explicitly", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
  });

  afterEach(() => {
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("attaches x-device-token on the mint when a device token is stored", async () => {
    setToken("device-token-abc");
    expect(getToken()).toBe("device-token-abc");
    fetchMock.mockResolvedValue(mintResponse("conn-jwt"));

    const token = await fetchAgentConnectionToken("ws-1", true);

    expect(token).toBe("conn-jwt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-device-token"]).toBe("device-token-abc");
    expect(headers["X-Workspace-Id"]).toBe("ws-1");
  });

  it("does NOT register a device when one is already stored (zero registration calls)", async () => {
    setToken("device-token-abc");
    routeFetch(() => mintResponse("conn-jwt"));

    await fetchAgentConnectionToken("ws-1", true);

    expect(callIndexesFor(DEVICE_REGISTER_PATH)).toHaveLength(0);
    expect(callIndexesFor(MINT_PATH)).toHaveLength(1);
  });
});

describe("FIX-AGENT-MINT-SELF-HEAL — empty device store registers once and mints device-bound", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
  });

  afterEach(() => {
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers the device once with an empty store and mints WITH x-device-token", async () => {
    clearToken();
    expect(getToken()).toBeNull();
    let registerCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        registerCalls += 1;
        return deviceResponse("device-fresh");
      }
      return mintResponse("conn-jwt");
    });

    const token = await fetchAgentConnectionToken("ws-1", true);

    expect(token).toBe("conn-jwt");
    expect(registerCalls).toBe(1);
    // The freshly issued device token is persisted for the next mint.
    expect(getToken()).toBe("device-fresh");
    const mintCalls = callIndexesFor(MINT_PATH);
    expect(mintCalls).toHaveLength(1);
    expect(headersAt(mintCalls[0]!)["x-device-token"]).toBe("device-fresh");
  });

  it("concurrent mints on an empty store register the device exactly once (single-flight)", async () => {
    clearToken();
    let registerCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        registerCalls += 1;
        return deviceResponse("device-fresh");
      }
      return mintResponse("conn-jwt");
    });

    const [first, second] = await Promise.all([
      fetchAgentConnectionToken("ws-1", true),
      fetchAgentConnectionToken("ws-1", true),
    ]);

    expect(registerCalls).toBe(1);
    expect(first).toBe("conn-jwt");
    expect(second).toBe("conn-jwt");
    const mintCalls = callIndexesFor(MINT_PATH);
    expect(mintCalls).toHaveLength(2);
    for (const callIndex of mintCalls) {
      expect(headersAt(callIndex)["x-device-token"]).toBe("device-fresh");
    }
  });

  it("falls back to a deviceless mint (no throw) when the device registration fails", async () => {
    clearToken();
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        return jsonResponse({ code: "auth.device_registration_failed", message: "registro indisponível" }, 500);
      }
      return mintResponse("conn-jwt");
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).resolves.toBe("conn-jwt");

    const mintCalls = callIndexesFor(MINT_PATH);
    expect(mintCalls).toHaveLength(1);
    expect(headersAt(mintCalls[0]!)["x-device-token"]).toBeUndefined();
  });
});

/**
 * FINDING 1 (review): the in-flight self-heal must not survive a session
 * cleanup. A late `setToken` could repopulate the device store AFTER
 * logout/workspace switch, and the single-flight promise could carry a device
 * registration across session generations. `clearAgentSession` bumps a
 * generation counter; a registration that resolves under a stale generation
 * writes nothing and resolves `null` (caller falls back to the deviceless
 * mint), and the next mint registers fresh.
 */
describe("FIX-AGENT-MINT-SELF-HEAL — session cleanup invalidates the in-flight registration", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
    // A clean generation baseline for every case (increments are cumulative).
    clearAgentSession();
  });

  afterEach(() => {
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does NOT persist a device token when the registration resolves AFTER clearAgentSession", async () => {
    clearToken();
    let releaseRegister!: (value: Response) => void;
    const registerGate = new Promise<Response>((resolve) => {
      releaseRegister = resolve;
    });
    let registerCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        registerCalls += 1;
        return registerGate;
      }
      return mintResponse("conn-jwt");
    });

    const flight = fetchAgentConnectionToken("ws-1", true);
    await vi.waitFor(() => expect(registerCalls).toBe(1));

    // Logout/workspace switch while the registration is still in flight.
    clearAgentSession();
    releaseRegister(deviceResponse("device-too-late"));

    // The mint completes deviceless instead of throwing, and the late
    // registration must NOT repopulate the store.
    await expect(flight).resolves.toBe("conn-jwt");
    expect(getToken()).toBeNull();
    const mintCalls = callIndexesFor(MINT_PATH);
    expect(headersAt(mintCalls[0]!)["x-device-token"]).toBeUndefined();
  });

  it("registers a FRESH device after a cleanup (single-flight does not leak across generations)", async () => {
    clearToken();
    const issued: string[] = [];
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        const token = `device-gen-${issued.length + 1}`;
        issued.push(token);
        return deviceResponse(token);
      }
      return mintResponse("conn-jwt");
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).resolves.toBe("conn-jwt");
    expect(issued).toEqual(["device-gen-1"]);
    expect(getToken()).toBe("device-gen-1");

    // Cleanup wipes the store; the next mint cannot reuse the previous
    // generation's single-flight promise.
    clearAgentSession();
    clearToken();
    await expect(fetchAgentConnectionToken("ws-1", true)).resolves.toBe("conn-jwt");
    expect(issued).toEqual(["device-gen-1", "device-gen-2"]);
    expect(getToken()).toBe("device-gen-2");
    expect(headersAt(callIndexesFor(MINT_PATH)[1]!)["x-device-token"]).toBe("device-gen-2");
  });

  it("persists the device token normally when no cleanup happens", async () => {
    clearToken();
    routeFetch((url) =>
      url.includes(DEVICE_REGISTER_PATH) ? deviceResponse("device-normal") : mintResponse("conn-jwt"),
    );

    await expect(fetchAgentConnectionToken("ws-1", true)).resolves.toBe("conn-jwt");

    expect(getToken()).toBe("device-normal");
    expect(headersAt(callIndexesFor(MINT_PATH)[0]!)["x-device-token"]).toBe("device-normal");
  });
});

/**
 * FINDING 2 (review): a mint 401 must NOT fire the global
 * `UNAUTHORIZED_EVENT` — that event runs `expireSession` (credential purge +
 * connection abort) and would kill the very retry the caller performs.
 *
 * FINDING 3 (review, round 3) refined this: the self-heal register is also
 * suppression-aware (its 401 may belong to a dead session), so the expiry is
 * announced by the MINT once its retry is exhausted — exactly once, never
 * zero. These cases pin that split; the generation-specific rules live in the
 * FINDING 1+2 and FINDING 3 suites below.
 */
describe("FINDING 2 — mint 401 does not expire the session; the register still does", () => {
  let unauthorizedEvents = 0;
  const countUnauthorized = () => {
    unauthorizedEvents += 1;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
    clearAgentSession();
    unauthorizedEvents = 0;
    window.addEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
  });

  afterEach(() => {
    // Removed explicitly: `window` outlives the test, and a leaked listener
    // would keep counting into a later case's fresh counter.
    window.removeEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const unauthorized401 = (): Response =>
    jsonResponse({ code: "auth.session_required", message: "Token de autenticação inválido ou expirado." }, 401);

  it("stays SILENT while the recovery is still pending, then announces the definitive 401", async () => {
    setToken("device-stale");
    let releaseRetry!: (value: Response) => void;
    let mintCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) return deviceResponse("device-fresh");
      mintCalls += 1;
      // First mint denied (stale device); the retry stays in flight.
      return mintCalls === 1 ? unauthorized401() : new Promise<Response>((resolve) => { releaseRetry = resolve; });
    });

    const flight = fetchAgentConnectionToken("ws-1", true);
    await vi.waitFor(() => expect(mintCalls).toBe(2));

    // Recovery is still in progress: the session must NOT be torn down yet.
    expect(unauthorizedEvents).toBe(0);

    // The retry is denied too — now it is definitive (FINDING 3).
    releaseRetry(unauthorized401());
    await expect(flight).rejects.toMatchObject({ status: 401 });
    expect(unauthorizedEvents).toBe(1);
  });

  it("a denied self-heal register no longer fires directly; the definitive mint 401 announces once", async () => {
    clearToken();
    // The register 401 is now handled LOCALLY (it may belong to a session this
    // generation no longer owns). The deviceless mint that follows is denied
    // too, and THAT is the definitive signal — exactly once, never duplicated.
    routeFetch((url) => (url.includes(DEVICE_REGISTER_PATH) ? unauthorized401() : unauthorized401()));

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toMatchObject({ status: 401 });

    expect(unauthorizedEvents).toBe(1);
  });

  it("full recovery flow: mint 401 → re-register (401) expires the session exactly ONCE", async () => {
    setToken("device-stale");
    let registerCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        registerCalls += 1;
        // The session is genuinely expired: the register denies it.
        return unauthorized401();
      }
      return unauthorized401();
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toMatchObject({ status: 401 });

    expect(registerCalls).toBe(1);
    // Two 401s happened (mint + register); only the register expired the session.
    expect(unauthorizedEvents).toBe(1);
  });

  it("recoverable flow: mint 401 → re-register → retried mint succeeds with no expiry", async () => {
    setToken("device-stale");
    let mintCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) return deviceResponse("device-fresh");
      mintCalls += 1;
      return mintCalls === 1 ? unauthorized401() : mintResponse("conn-jwt");
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).resolves.toBe("conn-jwt");

    expect(unauthorizedEvents).toBe(0);
  });
});

/**
 * FINDING (review, final round): only a 401 may announce a session expiry.
 * The retried mint can fail for reasons that say nothing about the session —
 * a 500 from the API, a 408 timeout, a dropped connection — and those were
 * being announced as an expiry, which purges credentials and logs the user
 * out over a transient outage. Reproducible: mint 401 (stale device) →
 * re-register OK (session provably valid) → retry mint 500 → logout.
 */
describe("FINDING — a NON-401 retry failure never announces a session expiry", () => {
  let unauthorizedEvents = 0;
  const countUnauthorized = () => {
    unauthorizedEvents += 1;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
    clearAgentSession();
    unauthorizedEvents = 0;
    window.addEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
  });

  afterEach(() => {
    window.removeEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const unauthorized401 = (): Response =>
    jsonResponse({ code: "auth.session_required", message: "Token de autenticação inválido ou expirado." }, 401);

  /** First mint denied (stale device), re-register succeeds, retry per `retryOutcome`. */
  const routeWithRetryOutcome = (retryOutcome: () => Response | Promise<Response>): void => {
    setToken("device-stale");
    let mintCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) return deviceResponse("device-fresh");
      mintCalls += 1;
      return mintCalls === 1 ? unauthorized401() : retryOutcome();
    });
  };

  it("retry mint failing with 500 propagates the original error and announces NOTHING", async () => {
    routeWithRetryOutcome(() => jsonResponse({ code: "error", message: "boom" }, 500));

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toMatchObject({ status: 500 });

    // The session was provably alive (the register just succeeded): a 500 must
    // not purge credentials or log the user out.
    expect(unauthorizedEvents).toBe(0);
  });

  it("retry mint failing with 408 propagates and announces NOTHING", async () => {
    routeWithRetryOutcome(() => jsonResponse({ code: "network.timeout", message: "timeout" }, 408));

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toMatchObject({ status: 408 });

    expect(unauthorizedEvents).toBe(0);
  });

  it("retry mint failing at the transport level (TypeError) propagates and announces NOTHING", async () => {
    const transportError = new TypeError("fetch failed");
    routeWithRetryOutcome(() => {
      throw transportError;
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toBe(transportError);

    expect(unauthorizedEvents).toBe(0);
  });

  it("retry mint aborted (AbortError) propagates and announces NOTHING", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    routeWithRetryOutcome(() => {
      throw abortError;
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toBe(abortError);

    expect(unauthorizedEvents).toBe(0);
  });

  it("retry mint denied with 401 still announces the expiry exactly once", async () => {
    // Regression guard: the 401 case must keep expiring the session.
    routeWithRetryOutcome(() => unauthorized401());

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toMatchObject({ status: 401 });

    expect(unauthorizedEvents).toBe(1);
  });
});

/**
 * FINDING 1 (review, round 3): the generation guard protected only `setToken`.
 * A registration issued under the OLD generation that answers 401 AFTER
 * logout + login of another user still broadcast the global
 * `UNAUTHORIZED_EVENT`, tearing down the NEW session. The self-heal register
 * must therefore suppress the signal and treat a 401 locally.
 *
 * FINDING 2 (review, round 3): the stale `finally` could null out the
 * single-flight slot owned by a NEWER generation's registration, causing a
 * third registration in the same generation as B.
 */
describe("FINDING 1 + 2 — stale-generation register is inert; single-flight slot is generation-safe", () => {
  let unauthorizedEvents = 0;
  const countUnauthorized = () => {
    unauthorizedEvents += 1;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
    clearAgentSession();
    unauthorizedEvents = 0;
    window.addEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
  });

  afterEach(() => {
    window.removeEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const unauthorized401 = (): Response =>
    jsonResponse({ code: "auth.session_required", message: "Token de autenticação inválido ou expirado." }, 401);

  it("a stale-generation register answering 401 does NOT expire the NEW session", async () => {
    clearToken();
    let releaseRegister!: (value: Response) => void;
    const registerGate = new Promise<Response>((resolve) => {
      releaseRegister = resolve;
    });
    routeFetch((url) => (url.includes(DEVICE_REGISTER_PATH) ? registerGate : mintResponse("conn-jwt")));

    const flight = fetchAgentConnectionToken("ws-1", true);
    await vi.waitFor(() => expect(callIndexesFor(DEVICE_REGISTER_PATH)).toHaveLength(1));

    // Logout, then login of ANOTHER user, both before the register answers.
    clearAgentSession();
    setToken("device-of-the-new-user");

    // The old generation's registration now fails — that failure belongs to
    // the dead session and must not expire the live one.
    releaseRegister(unauthorized401());

    await expect(flight).resolves.toBe("conn-jwt");
    expect(unauthorizedEvents).toBe(0);
    // The new user's own device token was untouched.
    expect(getToken()).toBe("device-of-the-new-user");
  });

  it("the AuthGate-style register call (default) KEEPS the 401 expiry event", async () => {
    // Same endpoint, default options: the login/boot path must keep expiring.
    routeFetch(() => unauthorized401());

    await expect(registerDeviceToken()).rejects.toMatchObject({ status: 401 });

    expect(unauthorizedEvents).toBe(1);
  });

  it("the single-flight slot survives a stale registration settling (no third register)", async () => {
    clearToken();
    const gates: ((value: Response) => void)[] = [];
    let registerCalls = 0;
    routeFetch((url) => {
      if (!url.includes(DEVICE_REGISTER_PATH)) return mintResponse("conn-jwt");
      registerCalls += 1;
      return new Promise<Response>((resolve) => {
        gates.push(resolve);
      });
    });

    // Generation A: a registration left pending.
    const flightA = fetchAgentConnectionToken("ws-1", true);
    await vi.waitFor(() => expect(registerCalls).toBe(1));

    // Cleanup bumps the generation and frees the slot.
    clearAgentSession();
    clearToken();

    // Generation B: a second registration takes the slot.
    const flightB = fetchAgentConnectionToken("ws-1", true);
    await vi.waitFor(() => expect(registerCalls).toBe(2));

    // Generation C: must JOIN B, not start a third registration.
    const flightC = fetchAgentConnectionToken("ws-1", true);
    await Promise.resolve();
    expect(registerCalls).toBe(2);

    // A settles last — its `finally` must not null out B's slot.
    gates[1]!(deviceResponse("device-gen-b"));
    await vi.waitFor(() => expect(getToken()).toBe("device-gen-b"));
    gates[0]!(deviceResponse("device-gen-a"));
    await expect(flightA).resolves.toBe("conn-jwt");
    await expect(flightB).resolves.toBe("conn-jwt");
    await expect(flightC).resolves.toBe("conn-jwt");

    // A's token (stale generation) is not written; B's survives.
    expect(getToken()).toBe("device-gen-b");
    expect(registerCalls).toBe(2);
  });
});

/**
 * FINDING 3 (review, round 3): suppression must not silence a DEFINITIVE
 * session failure. The retry is still available, so the 401 stays quiet; once
 * it is exhausted, the caller announces the expiry itself — but only while the
 * session generation is still the one that observed the 401. A definitive 401
 * belonging to an already-replaced session must not expire the new one.
 */
describe("FINDING 3 — a definitive mint 401 announces expiry only in the current generation", () => {
  let unauthorizedEvents = 0;
  const countUnauthorized = () => {
    unauthorizedEvents += 1;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
    clearAgentSession();
    unauthorizedEvents = 0;
    window.addEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
  });

  afterEach(() => {
    window.removeEventListener(UNAUTHORIZED_EVENT, countUnauthorized);
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const unauthorized401 = (): Response =>
    jsonResponse({ code: "auth.session_required", message: "Token de autenticação inválido ou expirado." }, 401);

  it("definitive 401 in the CURRENT generation announces expiry exactly once", async () => {
    setToken("device-stale");
    routeFetch((url) => (url.includes(DEVICE_REGISTER_PATH) ? deviceResponse("device-fresh") : unauthorized401()));

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toMatchObject({ status: 401 });

    // The register succeeded (session alive at that point) and both mints were
    // denied: the session is definitively gone and must be announced once.
    expect(unauthorizedEvents).toBe(1);
  });

  it("definitive 401 observed under an OLD generation does NOT expire the new session", async () => {
    setToken("device-stale");
    let releaseRetry!: (value: Response) => void;
    let mintCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) return deviceResponse("device-fresh");
      mintCalls += 1;
      if (mintCalls === 1) return unauthorized401();
      return new Promise<Response>((resolve) => {
        releaseRetry = resolve;
      });
    });

    const flight = fetchAgentConnectionToken("ws-1", true);
    await vi.waitFor(() => expect(mintCalls).toBe(2));

    // The session is replaced while the retry is in flight.
    clearAgentSession();
    setToken("device-of-the-new-user");
    releaseRetry(unauthorized401());

    await expect(flight).rejects.toMatchObject({ status: 401 });
    expect(unauthorizedEvents).toBe(0);
    expect(getToken()).toBe("device-of-the-new-user");
  });

  it("successful recovery stays silent (no expiry announced)", async () => {
    setToken("device-stale");
    let mintCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) return deviceResponse("device-fresh");
      mintCalls += 1;
      return mintCalls === 1 ? unauthorized401() : mintResponse("conn-jwt");
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).resolves.toBe("conn-jwt");

    expect(unauthorizedEvents).toBe(0);
  });
});

describe("FIX-AGENT-MINT-SELF-HEAL — 401 with a presented device token re-registers once", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGINAL);
    clearAgentConnectionTokenCache();
  });

  afterEach(() => {
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("re-registers once and repeats the mint with the new device token", async () => {
    setToken("device-stale");
    let registerCalls = 0;
    let mintCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        registerCalls += 1;
        return deviceResponse("device-fresh");
      }
      mintCalls += 1;
      if (mintCalls === 1) {
        // API: presented-but-invalid/revoked device denies the mint with 401.
        return jsonResponse(
          { code: "auth.session_required", message: "Token de autenticação inválido ou expirado." },
          401,
        );
      }
      return mintResponse("conn-jwt-2");
    });

    const token = await fetchAgentConnectionToken("ws-1", true);

    expect(token).toBe("conn-jwt-2");
    expect(registerCalls).toBe(1);
    expect(mintCalls).toBe(2);
    expect(getToken()).toBe("device-fresh");
    const mintIndexes = callIndexesFor(MINT_PATH);
    expect(headersAt(mintIndexes[0]!)["x-device-token"]).toBe("device-stale");
    expect(headersAt(mintIndexes[1]!)["x-device-token"]).toBe("device-fresh");
  });

  it("propagates the 401 after a single retry (max 1 re-registration)", async () => {
    setToken("device-stale");
    let registerCalls = 0;
    let mintCalls = 0;
    routeFetch((url) => {
      if (url.includes(DEVICE_REGISTER_PATH)) {
        registerCalls += 1;
        return deviceResponse("device-fresh");
      }
      mintCalls += 1;
      return jsonResponse(
        { code: "auth.session_required", message: "Token de autenticação inválido ou expirado." },
        401,
      );
    });

    await expect(fetchAgentConnectionToken("ws-1", true)).rejects.toMatchObject({ status: 401 });

    // Exactly one retry: no registration storm, no second device-bound attempt.
    expect(registerCalls).toBe(1);
    expect(mintCalls).toBe(2);
  });
});

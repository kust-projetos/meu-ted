/**
 * FIX-PWA-DEVICE-BOUND-MINT: the agent connection token mint must carry the
 * device token explicitly (T2.5 sanctioned channel — `apiFetch({ token })`)
 * so the API emits a device-bound JWT (`deviceId` claim, H-12). Without it
 * the Worker deletes `x-agent-device` and every approval/undo RPC 401s with
 * `agent.approval_context_required` for 100% of users.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import { fetchAgentConnectionToken, clearAgentConnectionTokenCache } from "../agent-auth";
import { getToken, setToken, clearToken } from "../../auth/token-store";

const ORIGINAL = "http://localhost:3000";

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
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ token: "conn-jwt", expiresIn: 120 }), { status: 200 }),
    );

    const token = await fetchAgentConnectionToken("ws-1", true);

    expect(token).toBe("conn-jwt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-device-token"]).toBe("device-token-abc");
    expect(headers["X-Workspace-Id"]).toBe("ws-1");
  });

  it("mints deviceless (no x-device-token) when no device token is stored", async () => {
    clearToken();
    expect(getToken()).toBeNull();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ token: "conn-jwt", expiresIn: 120 }), { status: 200 }),
    );

    await fetchAgentConnectionToken("ws-1", true);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-device-token"]).toBeUndefined();
  });
});

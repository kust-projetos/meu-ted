import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAgentConnectionToken, clearAgentConnectionTokenCache } from "./agent-auth";
import * as client from "./client";
import { setToken, clearToken } from "../auth/token-store";

describe("agent-auth", () => {
  afterEach(() => {
    clearAgentConnectionTokenCache();
    clearToken();
    vi.restoreAllMocks();
  });

  it("sends explicit X-Workspace-Id header when requesting connection token", async () => {
    // Seeded device token so the mint exercises the device-bound path
    // (FIX-AGENT-MINT-SELF-HEAL) without a preceding registration call.
    setToken("device-token-xyz");
    const apiFetchSpy = vi.spyOn(client, "apiFetch").mockResolvedValue({
      token: "signed-connection-token-xyz",
      expiresIn: 120,
    });

    const token = await fetchAgentConnectionToken("workspace-test-123");

    expect(token).toBe("signed-connection-token-xyz");
    // H-13: the mint flight carries a tracked AbortSignal (session clears
    // abort it); the workspace header contract is unchanged.
    // FINDING 2: the mint alone opts out of the global 401 session-expiry
    // signal so its own re-register retry is not aborted from under itself.
    expect(apiFetchSpy).toHaveBeenCalledWith("/auth/agent-token", {
      method: "POST",
      headers: {
        "X-Workspace-Id": "workspace-test-123",
      },
      token: "device-token-xyz",
      skipUnauthorizedEvent: true,
      signal: expect.any(AbortSignal),
    });
  });
});

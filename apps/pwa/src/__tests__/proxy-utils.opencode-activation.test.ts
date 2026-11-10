/**
 * Deployment activation — explicit flags, production HTTPS gateway origin and
 * the rollback kill switch.
 *
 * Replaces the old NODE_ENV shortcut: selection is now driven by operator
 * configuration (`TED_OPENCODE_RUNTIME_ENABLED`), and the kill switch wins
 * over everything so a rollback also covers `opencode.*`-pinned conversations.
 */
import { describe, expect, it } from "vitest";
import {
  isTedOpencodeKillSwitchOn,
  isTedOpencodeRuntimeEnabled,
  resolveTedGatewayOrigin,
  selectTedRuntimeTarget,
  serializeTedRuntimePinClear,
} from "@/proxy-utils";

describe("resolveTedGatewayOrigin (explicit activation)", () => {
  it("accepts a bare HTTPS origin in production without NODE_ENV shortcuts", () => {
    expect(
      resolveTedGatewayOrigin({
        NODE_ENV: "production",
        TED_OPENCODE_GATEWAY_ORIGIN: "https://ted-gateway.synkroo.com.br",
      }),
    ).toBe("https://ted-gateway.synkroo.com.br");
  });

  it("refuses http, credentials, paths and query in the HTTPS form", () => {
    expect(resolveTedGatewayOrigin({ TED_OPENCODE_GATEWAY_ORIGIN: "http://ted-gateway.synkroo.com.br" })).toBeNull();
    expect(
      resolveTedGatewayOrigin({ TED_OPENCODE_GATEWAY_ORIGIN: "https://user:pass@ted-gateway.synkroo.com.br" }),
    ).toBeNull();
    expect(
      resolveTedGatewayOrigin({ TED_OPENCODE_GATEWAY_ORIGIN: "https://ted-gateway.synkroo.com.br/api" }),
    ).toBeNull();
    expect(
      resolveTedGatewayOrigin({ TED_OPENCODE_GATEWAY_ORIGIN: "https://ted-gateway.synkroo.com.br?x=1" }),
    ).toBeNull();
  });

  it("keeps the loopback form gated to development/test with the local bypass", () => {
    const base = { TED_OPENCODE_GATEWAY_ORIGIN: "http://127.0.0.1:3101" };
    expect(resolveTedGatewayOrigin({ ...base, NODE_ENV: "development", ALLOW_LOCAL_ORIGIN: "1" })).toBe(
      "http://127.0.0.1:3101",
    );
    expect(resolveTedGatewayOrigin({ ...base, NODE_ENV: "development" })).toBeNull();
    expect(resolveTedGatewayOrigin({ ...base, NODE_ENV: "production", ALLOW_LOCAL_ORIGIN: "1" })).toBeNull();
  });

  it("missing origin resolves to null (A0 stays the default)", () => {
    expect(resolveTedGatewayOrigin({})).toBeNull();
  });
});

describe("activation and rollback switches", () => {
  it("is enabled by the explicit flag only", () => {
    expect(isTedOpencodeRuntimeEnabled({})).toBe(false);
    expect(isTedOpencodeRuntimeEnabled({ TED_OPENCODE_RUNTIME_ENABLED: "0" })).toBe(false);
    expect(isTedOpencodeRuntimeEnabled({ TED_OPENCODE_RUNTIME_ENABLED: "1" })).toBe(true);
    expect(isTedOpencodeRuntimeEnabled({ TED_OPENCODE_RUNTIME_ENABLED: "1", NODE_ENV: "production" })).toBe(true);
  });

  it("the kill switch wins over the activation flag", () => {
    const env = { TED_OPENCODE_RUNTIME_ENABLED: "1", TED_OPENCODE_RUNTIME_KILL_SWITCH: "1" };
    expect(isTedOpencodeKillSwitchOn(env)).toBe(true);
    expect(isTedOpencodeRuntimeEnabled(env)).toBe(false);
  });

  it("kill switch routes even an opencode pin back to A0", () => {
    const pin = { pin: "b" as const, conversationId: "11111111-1111-4111-8111-111111111111" };
    expect(selectTedRuntimeTarget(pin, { isP2: true, flagOn: true, killSwitch: true })).toBe("A0");
    expect(selectTedRuntimeTarget(pin, { isP2: true, flagOn: true })).toBe("B");
  });

  it("non-P2 paths stay on A0 regardless of switches", () => {
    expect(
      selectTedRuntimeTarget({ pin: "b", conversationId: "11111111-1111-4111-8111-111111111111" }, { isP2: false, flagOn: true, killSwitch: false }),
    ).toBe("A0");
  });

  it("pin clear expires the scoped cookie only", () => {
    const clear = serializeTedRuntimePinClear("ws-1");
    expect(clear).toContain("ted-runtime-conversation=;");
    expect(clear).toContain("Path=/api/agent/agents/finance-chat-agent/ws-1/rpc");
    expect(clear).toContain("Max-Age=0");
  });
});

/** Gateway-origin resolution remains allowlisted; runtime switching is retired. */
import { describe, expect, it } from "vitest";
import { resolveTedGatewayOrigin } from "@/proxy-utils";

describe("resolveTedGatewayOrigin (explicit activation)", () => {
  it("accepts a bare HTTPS origin in production when it is explicitly allowlisted", () => {
    expect(
      resolveTedGatewayOrigin({
        NODE_ENV: "production",
        TED_OPENCODE_GATEWAY_ORIGIN: "https://ted-gateway.synkroo.com.br",
        TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: "https://ted-gateway.synkroo.com.br",
      }),
    ).toBe("https://ted-gateway.synkroo.com.br");
  });

  it("accepts an allowlisted HTTPS origin with a single path prefix (reverse-proxy mount)", () => {
    expect(
      resolveTedGatewayOrigin({
        NODE_ENV: "production",
        TED_OPENCODE_GATEWAY_ORIGIN: "https://api.synkroo.com.br/ted-runtime",
        TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: "https://api.synkroo.com.br/ted-runtime",
      }),
    ).toBe("https://api.synkroo.com.br/ted-runtime");
    // The prefix must match exactly — a trailing slash or a deeper path is refused.
    expect(
      resolveTedGatewayOrigin({
        TED_OPENCODE_GATEWAY_ORIGIN: "https://api.synkroo.com.br/ted-runtime/",
        TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: "https://api.synkroo.com.br/ted-runtime/",
      }),
    ).toBeNull();
  });

  it("refuses an HTTPS origin that is not allowlisted (no arbitrary host)", () => {
    expect(
      resolveTedGatewayOrigin({
        NODE_ENV: "production",
        TED_OPENCODE_GATEWAY_ORIGIN: "https://gateway.attacker.example",
      }),
    ).toBeNull();
    expect(
      resolveTedGatewayOrigin({
        NODE_ENV: "production",
        TED_OPENCODE_GATEWAY_ORIGIN: "https://gateway.attacker.example",
        TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: "https://ted-gateway.synkroo.com.br",
      }),
    ).toBeNull();
  });

  it("refuses http, credentials, paths and query in the HTTPS form", () => {
    const allow = "https://ted-gateway.synkroo.com.br,https://user:pass@ted-gateway.synkroo.com.br";
    expect(
      resolveTedGatewayOrigin({ TED_OPENCODE_GATEWAY_ORIGIN: "http://ted-gateway.synkroo.com.br" }),
    ).toBeNull();
    expect(
      resolveTedGatewayOrigin({
        TED_OPENCODE_GATEWAY_ORIGIN: "https://user:pass@ted-gateway.synkroo.com.br",
        TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: allow,
      }),
    ).toBeNull();
    expect(
      resolveTedGatewayOrigin({
        TED_OPENCODE_GATEWAY_ORIGIN: "https://ted-gateway.synkroo.com.br/api",
        TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: allow,
      }),
    ).toBeNull();
    expect(
      resolveTedGatewayOrigin({
        TED_OPENCODE_GATEWAY_ORIGIN: "https://ted-gateway.synkroo.com.br?x=1",
        TED_OPENCODE_GATEWAY_ALLOWED_ORIGINS: allow,
      }),
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



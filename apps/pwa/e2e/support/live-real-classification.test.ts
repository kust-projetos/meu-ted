// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  classifyLiveRealRequest,
  classifyGuardReason,
  isFunctionalBlockage,
  validateLiveRealEgress,
} from "./live-real-classification";

describe("live-real request classification", () => {
  it("classifies guard reason codes: destination is unidentified, auxiliary needs evidence, others functional", () => {
    expect(classifyGuardReason("destination")).toBe("unidentified");
    expect(classifyGuardReason("telemetry")).toBe("auxiliary");
    expect(classifyGuardReason("analytics")).toBe("auxiliary");
    expect(classifyGuardReason("csp")).toBe("auxiliary");
    expect(classifyGuardReason("api_method_path")).toBe("functional");
    expect(classifyGuardReason("inference_model")).toBe("functional");
    expect(classifyGuardReason("not_https")).toBe("functional");
    expect(classifyGuardReason(undefined)).toBe("unidentified");
    expect(classifyGuardReason("")).toBe("unidentified");
    expect(classifyGuardReason(null)).toBe("unidentified");
  });

  it("classifies inference and financial API requests as functional via guard", () => {
    expect(
      classifyLiveRealRequest({ url: "https://opencode.ai/inference/go/v1/chat/completions", method: "POST", blocked: true }),
    ).toBe("functional");
    expect(
      classifyLiveRealRequest({ reason: "api", blocked: true }),
    ).toBe("functional");
    expect(
      classifyLiveRealRequest({ reason: "inference", blocked: true }),
    ).toBe("functional");
  });

  it("classifies an auxiliary destination only with explicit evidence (telemetry reason)", () => {
    expect(
      classifyLiveRealRequest({ reason: "telemetry", blocked: true }),
    ).toBe("auxiliary");
    // A bare "destination" is NOT assumed telemetry.
    expect(
      classifyLiveRealRequest({ reason: "destination", blocked: true }),
    ).toBe("unidentified");
  });

  it("classifies blockages without a reason as unidentified (not auxiliary)", () => {
    const result = validateLiveRealEgress([
      { blocked: true }, // no reason, no url
    ]);
    expect(result.unidentifiedBlocked).toBe(1);
    expect(result.auxiliaryBlocked).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("RED: auxiliary blockage wrongly fails generic guard.blocked === 0 validation", () => {
    const requests = [{ reason: "destination", blocked: true }];
    const genericBlocked = requests.filter((r) => r.blocked).length;
    expect(genericBlocked).toBeGreaterThan(0);
  });

  it("GREEN: auxiliary blockage with evidence is recorded without invalidating the result", () => {
    const requests = [
      { reason: "telemetry", blocked: true },
      { reason: "api", blocked: false },
    ];
    const result = validateLiveRealEgress(requests);
    expect(result.auxiliaryBlocked).toBe(1);
    expect(result.functionalBlocked).toBe(0);
    expect(result.unidentifiedBlocked).toBe(0);
    expect(result.passed).toBe(true);
  });

  it("functional blockage still fails validation", () => {
    const requests = [{ reason: "api_method_path", blocked: true }];
    const result = validateLiveRealEgress(requests);
    expect(result.functionalBlocked).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("unidentified blockage fails validation (not assumed auxiliary)", () => {
    const requests = [{ blocked: true }];
    const result = validateLiveRealEgress(requests);
    expect(result.unidentifiedBlocked).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("isFunctionalBlockage returns true only for functional blocked requests", () => {
    expect(isFunctionalBlockage({ reason: "api_method_path", blocked: true })).toBe(true);
    expect(isFunctionalBlockage({ reason: "destination", blocked: true })).toBe(false);
    expect(isFunctionalBlockage({ reason: "api_method_path", blocked: false })).toBe(false);
    expect(isFunctionalBlockage({ blocked: true })).toBe(false);
  });

  it("uses guard classify from url when reason absent", () => {
    // non-allowlist host → destination → unidentified (not assumed auxiliary)
    expect(
      classifyLiveRealRequest({ url: "https://analytics.example.com/collect", blocked: true }),
    ).toBe("unidentified");
    expect(
      classifyLiveRealRequest({ url: "https://evil.example.com/x", blocked: true }),
    ).toBe("unidentified");
  });
});

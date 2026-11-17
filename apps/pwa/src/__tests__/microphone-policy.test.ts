import { describe, it, expect } from "vitest";
import { buildPermissionsPolicy } from "../proxy-utils";

describe("microphone Permissions-Policy", () => {
  it("denies microphone access unconditionally", () => {
    expect(buildPermissionsPolicy(false)).toContain("microphone=()");
    expect(buildPermissionsPolicy(false)).not.toContain("microphone=(self)");
  });

  it("keeps camera and geolocation blocked", () => {
    const policy = buildPermissionsPolicy(false);
    expect(policy).toContain("camera=()");
    expect(policy).toContain("geolocation=()");
  });
});

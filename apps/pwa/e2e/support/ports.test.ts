// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIXTURE_PORT,
  DEFAULT_HARNESS_PORT,
  DEFAULT_NEXT_PORT,
  fixtureUrlFor,
  harnessOrigin,
  harnessUrlFor,
  resolveE2ePorts,
} from "./ports";

describe("e2e port overrides", () => {
  it("keeps current defaults (4010/3001/3000)", () => {
    expect(DEFAULT_FIXTURE_PORT).toBe(4010);
    expect(DEFAULT_NEXT_PORT).toBe(3001);
    expect(DEFAULT_HARNESS_PORT).toBe(3000);
    expect(resolveE2ePorts({})).toEqual({
      fixturePort: 4010,
      nextPort: 3001,
      harnessPort: 3000,
    });
  });

  it("honours E2E_FIXTURE_PORT/E2E_NEXT_PORT/E2E_HARNESS_PORT", () => {
    expect(
      resolveE2ePorts({
        E2E_FIXTURE_PORT: "4021",
        E2E_NEXT_PORT: "3101",
        E2E_HARNESS_PORT: "3100",
      }),
    ).toEqual({ fixturePort: 4021, nextPort: 3101, harnessPort: 3100 });
    expect(
      fixtureUrlFor(
        resolveE2ePorts({ E2E_FIXTURE_PORT: "4021" }).fixturePort,
      ),
    ).toBe("http://127.0.0.1:4021");
  });

  it("derives the harness page origin from E2E_HARNESS_PORT", () => {
    expect(harnessOrigin({})).toBe("http://127.0.0.1:3000");
    expect(harnessOrigin({ E2E_HARNESS_PORT: "3100" })).toBe(
      "http://127.0.0.1:3100",
    );
    expect(harnessUrlFor(3000)).toBe("http://127.0.0.1:3000");
  });

  it("rejects invalid port overrides fail-closed", () => {
    expect(() => resolveE2ePorts({ E2E_NEXT_PORT: "abc" })).toThrow();
    expect(() => resolveE2ePorts({ E2E_NEXT_PORT: "0" })).toThrow();
    expect(() => resolveE2ePorts({ E2E_HARNESS_PORT: "99999" })).toThrow();
    expect(() => harnessOrigin({ E2E_HARNESS_PORT: "nope" })).toThrow();
  });
});

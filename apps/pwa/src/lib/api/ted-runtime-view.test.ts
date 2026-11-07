import { beforeEach, describe, expect, it } from "vitest";
import { clearAgentSession } from "./agent-auth";
import {
  clearTedRuntimeViews,
  getTedRuntimeView,
  noteTedRuntimeView,
} from "./ted-runtime-view";

beforeEach(() => {
  clearTedRuntimeViews();
});

describe("ted-runtime-view — per-workspace server-confirmed runtime", () => {
  it("starts unknown until a P2 response reveals the runtime", () => {
    expect(getTedRuntimeView("ws-1")).toBe("unknown");
  });

  it("records opencode/agent headers, scoped per workspace", () => {
    expect(noteTedRuntimeView("ws-1", "opencode")).toBe("opencode");
    expect(getTedRuntimeView("ws-1")).toBe("opencode");
    expect(getTedRuntimeView("ws-2")).toBe("unknown");
    noteTedRuntimeView("ws-1", "agent");
    expect(getTedRuntimeView("ws-1")).toBe("agent");
  });

  it("ignores unknown/foreign/empty header values (never overwrites, never invents)", () => {
    expect(noteTedRuntimeView("ws-1", null)).toBe("unknown");
    expect(noteTedRuntimeView("ws-1", "")).toBe("unknown");
    expect(noteTedRuntimeView("ws-1", "native-session-id")).toBe("unknown");
    noteTedRuntimeView("ws-1", "opencode");
    expect(noteTedRuntimeView("ws-1", "garbage")).toBe("opencode");
    expect(noteTedRuntimeView("ws-1", undefined)).toBe("opencode");
  });

  it("clears one workspace or all", () => {
    noteTedRuntimeView("ws-1", "opencode");
    noteTedRuntimeView("ws-2", "agent");
    clearTedRuntimeViews("ws-1");
    expect(getTedRuntimeView("ws-1")).toBe("unknown");
    expect(getTedRuntimeView("ws-2")).toBe("agent");
    clearTedRuntimeViews();
    expect(getTedRuntimeView("ws-2")).toBe("unknown");
  });

  it("session teardown purges runtime beliefs (no stale cancel across logins)", () => {
    noteTedRuntimeView("ws-1", "opencode");
    noteTedRuntimeView("ws-2", "opencode");
    clearAgentSession();
    expect(getTedRuntimeView("ws-1")).toBe("unknown");
    expect(getTedRuntimeView("ws-2")).toBe("unknown");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@/lib/test-utils";
import { TedChat } from "../TedChat";
import * as agentAuth from "@/lib/api/agent-auth";

const wsState = vi.hoisted(() => ({ activeId: "ws-1", cache: {} as Record<string, unknown> }));

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const build = (id: string) => ({
    workspaces: [{ id, name: `WS ${id}`, kind: "shared" as const, role: "owner" }],
    activeWorkspace: { id, name: `WS ${id}`, kind: "shared" as const, role: "owner" },
    members: [{ userId: "user-1", name: "Walisson", email: "a@example.com", role: "owner" }],
    loading: false,
    membersLoading: false,
    error: null,
    selectWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
    refreshMembers: vi.fn(),
    createWorkspace: vi.fn(),
    inviteMember: vi.fn(),
    acceptInvite: vi.fn(),
    removeMember: vi.fn(),
    leave: vi.fn(),
  });
  const forId = (id: string) => {
    if (!wsState.cache[id]) wsState.cache[id] = build(id);
    return wsState.cache[id];
  };
  return { ...actual, useWorkspace: () => forId(wsState.activeId), useWorkspaceSafe: () => forId(wsState.activeId) };
});

vi.mock("@/lib/api/agent-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-client")>();
  return {
    ...actual,
    fetchAgentHistory: vi.fn().mockResolvedValue([]),
    sendAgentMessage: vi.fn().mockResolvedValue({ turnId: "t", status: "completed" }),
    renewAgentSession: vi.fn().mockResolvedValue({ ok: true, sessionId: "s2" }),
  };
});

/**
 * T1.1 (SPEC §7 A2, INV-08): the record button is rendered ONLY when the
 * microphone capability is on. When off it is absent from the render —
 * not disabled — so header and UI can never diverge.
 */
describe("TedChat – microphone capability gate (T1.1, INV-08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsState.activeId = "ws-1";
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("mock-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caps.microphone=false -> record button is ABSENT from the render", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_MICROPHONE", "");
    render(<TedChat />);
    await screen.findByRole("button", { name: /enviar mensagem/i });
    expect(screen.queryByRole("button", { name: /gravar áudio/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /parar gravação/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /solicitando permissão de microfone/i }),
    ).toBeNull();
  });

  it("caps.microphone=true -> record button is present", async () => {
    vi.stubEnv("NEXT_PUBLIC_TED_MICROPHONE", "true");
    render(<TedChat />);
    expect(await screen.findByRole("button", { name: /gravar áudio/i })).toBeInTheDocument();
  });
});

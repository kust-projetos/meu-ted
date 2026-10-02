import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChatLauncher, OPEN_TED_CHAT_EVENT } from "@/features/ted/TedChatLauncher";
import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
  bodyScrollLockCount,
} from "@/lib/ui/overlay-a11y";

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" }],
    activeWorkspace: { id: "ws-1", name: "Minhas Finanças", kind: "personal" as const, role: "owner" },
    members: [],
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
  };
  return {
    ...actual,
    useWorkspace: () => mockWs,
    useWorkspaceSafe: () => mockWs,
  };
});

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  usePathname: () => navigation.pathname,
}));

describe("TedChatLauncher Component (page navigation)", () => {
  beforeEach(() => {
    navigation.push.mockClear();
    navigation.pathname = "/";
  });

  it("renders floating launcher button and navigates to /ted when clicked", async () => {
    const user = userEvent.setup();

    render(<TedChatLauncher />);

    const launcher = screen.getByRole("button", { name: /abrir assistente ted/i });
    expect(launcher).toBeInTheDocument();
    expect(launcher).not.toHaveAttribute("aria-haspopup");
    expect(launcher).not.toHaveAttribute("aria-expanded");

    // Click launcher
    await user.click(launcher);
    expect(navigation.push).toHaveBeenCalledWith("/ted");
  });

  it("navigates to /ted when the public open event fires (empty Insights CTA)", async () => {
    render(<TedChatLauncher />);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_TED_CHAT_EVENT));
    });
    expect(navigation.push).toHaveBeenCalledWith("/ted");
  });

  it("navigates to /ted?operationId= when the event carries an operationId", async () => {
    render(<TedChatLauncher />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_TED_CHAT_EVENT, { detail: { operationId: "op-9" } }),
      );
    });
    expect(navigation.push).toHaveBeenCalledWith("/ted?operationId=op-9");
  });

  it("hides the FAB on /ted", () => {
    navigation.pathname = "/ted";
    const { container } = render(<TedChatLauncher />);
    expect(container.firstChild).toBeNull();
  });

  describe("overlay hiding (v2 A1)", () => {
    afterEach(() => {
      while (bodyScrollLockCount() > 0) releaseBodyScrollLock();
    });

    it("hides the FAB while an overlay holds the lock and restores it after", async () => {
      render(<TedChatLauncher />);
      expect(screen.getByRole("button", { name: /abrir assistente ted/i })).toBeInTheDocument();

      await act(async () => {
        acquireBodyScrollLock();
      });
      const hiddenFab = screen.getByRole("button", { name: /abrir assistente ted/i });
      expect(hiddenFab).toHaveClass("pointer-events-none", "opacity-0");
      expect(hiddenFab).toHaveAttribute("tabindex", "-1");

      await act(async () => {
        releaseBodyScrollLock();
      });
      const restoredFab = screen.getByRole("button", { name: /abrir assistente ted/i });
      expect(restoredFab).not.toHaveClass("pointer-events-none", "opacity-0");
      expect(restoredFab).not.toHaveAttribute("tabindex");
    });
  });

  describe("responsive positioning (tablet BottomNav clearance)", () => {
    it("keeps FAB above BottomNav below lg and docks bottom-right only on lg+", () => {
      render(<TedChatLauncher />);
      const launcher = screen.getByRole("button", { name: /abrir assistente ted/i });
      // Base (mobile + tablet 640-1023px): clearance above BottomNav
      expect(launcher).toHaveClass("bottom-[88px]", "right-4", "lg:bottom-6", "lg:right-6");
      // Must not dock early on sm (would overlap BottomNav on tablets)
      expect(launcher.className).not.toMatch(/(?:^|\s)sm:bottom-6(?:\s|$)/);
      expect(launcher.className).not.toMatch(/(?:^|\s)sm:right-6(?:\s|$)/);
    });
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TedChatLauncher, OPEN_TED_CHAT_EVENT } from "../TedChatLauncher";

// Overlay store is module-level (useSyncExternalStore); drive it with a
// mutable flag so tests can simulate sheets/dialogs being open.
const overlay = vi.hoisted(() => ({ open: false }));

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/",
}));

vi.mock("@/lib/ui/overlay-a11y", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ui/overlay-a11y")>();
  return { ...actual, useIsOverlayOpen: () => overlay.open };
});

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  usePathname: () => navigation.pathname,
}));

describe("TedChatLauncher (page navigation)", () => {
  beforeEach(() => {
    overlay.open = false;
    navigation.push.mockClear();
    navigation.pathname = "/";
  });

  it("renders the FAB as navigation without dialog disclosure semantics", () => {
    render(<TedChatLauncher />);
    const fab = screen.getByRole("button", { name: "Abrir assistente TED" });
    expect(fab).not.toHaveAttribute("aria-haspopup");
    expect(fab).not.toHaveAttribute("aria-expanded");
  });

  it("keeps a >= 44px touch target (56px FAB)", () => {
    render(<TedChatLauncher />);
    const fab = screen.getByRole("button", { name: "Abrir assistente TED" });
    expect(fab.className).toMatch(/h-14/);
    expect(fab.className).toMatch(/w-14/);
  });

  it("navigates to /ted when the FAB is activated", async () => {
    const user = userEvent.setup();
    render(<TedChatLauncher />);
    await user.click(screen.getByRole("button", { name: "Abrir assistente TED" }));
    expect(navigation.push).toHaveBeenCalledWith("/ted");
  });

  it("navigates to /ted?operationId= on openTedChat({ operationId })", async () => {
    render(<TedChatLauncher />);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_TED_CHAT_EVENT, { detail: { operationId: "op-9" } }),
      );
    });
    expect(navigation.push).toHaveBeenCalledWith("/ted?operationId=op-9");
    expect(OPEN_TED_CHAT_EVENT).toBe("pwa:open-ted");
  });

  it("navigates to /ted on openTedChat() without options", async () => {
    render(<TedChatLauncher />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_TED_CHAT_EVENT));
    });
    expect(navigation.push).toHaveBeenCalledWith("/ted");
  });

  it("hides the FAB on the /ted page itself", () => {
    navigation.pathname = "/ted";
    const { container } = render(<TedChatLauncher />);
    expect(container.firstChild).toBeNull();
  });

  it("hides the FAB while any overlay is open (A1)", () => {
    overlay.open = true;
    render(<TedChatLauncher />);
    const hiddenFab = screen.getByRole("button", { name: "Abrir assistente TED" });
    expect(hiddenFab).toHaveClass("pointer-events-none", "opacity-0");
    expect(hiddenFab).toHaveAttribute("tabindex", "-1");
  });
});

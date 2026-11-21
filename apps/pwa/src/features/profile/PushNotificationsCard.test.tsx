import { fireEvent, render, screen } from "@/lib/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PushNotificationsCard from "./PushNotificationsCard";
import * as pushClient from "@/lib/api/push-client";

vi.mock("@/lib/api/push-client", () => ({
  getPushState: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));

const mocked = vi.mocked(pushClient);

describe("PushNotificationsCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explains iOS installation before offering permission", async () => {
    mocked.getPushState.mockResolvedValue("install-required");
    render(<PushNotificationsCard workspaceId="workspace-a" />);

    expect(await screen.findByText(/Adicionar à Tela de Início/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ativar notificações/i })).not.toBeInTheDocument();
    expect(mocked.enablePush).not.toHaveBeenCalled();
  });

  it("asks for permission only after the explicit activation click", async () => {
    mocked.getPushState.mockResolvedValue("ready");
    mocked.enablePush.mockResolvedValue({ id: "sub-1", endpoint: "https://push.example.test/a", active: true, updatedAt: "now" });
    render(<PushNotificationsCard workspaceId="workspace-a" />);

    const activate = await screen.findByRole("button", { name: /Ativar notificações/i });
    expect(mocked.enablePush).not.toHaveBeenCalled();
    fireEvent.click(activate);
    expect(await screen.findByText(/Notificações ativas/i)).toBeInTheDocument();
  });

  it("hides the top panel completely once active when hideWhenActive is true", async () => {
    mocked.getPushState.mockResolvedValue("ready");
    mocked.enablePush.mockResolvedValue({ id: "sub-2", endpoint: "https://push.example.test/b", active: true, updatedAt: "now" });
    render(<PushNotificationsCard workspaceId="workspace-a" hideWhenActive />);

    const activate = await screen.findByRole("button", { name: /Ativar notificações/i });
    fireEvent.click(activate);
    await screen.findByText(/Notificações ativas/i).catch(() => null);
    expect(screen.queryByLabelText("Notificações no dispositivo")).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthGate } from "../AuthGate";
import { useSession } from "@/lib/auth/session-context";

// ─── localStorage mock ──────────────────────────────────────────────────────
const store: Record<string, string> = {};
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  vi.spyOn(window.localStorage, "getItem").mockImplementation(
    (k) => store[String(k)] ?? null,
  );
  vi.spyOn(window.localStorage, "setItem").mockImplementation((k, v) => {
    store[String(k)] = String(v);
  });
  vi.spyOn(window.localStorage, "removeItem").mockImplementation((k) => {
    delete store[String(k)];
  });
});


// ─── crypto mock (subtle + getRandomValues) ────────────────────────────────
beforeEach(() => {
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    getRandomValues: (arr: Uint8Array) =>
      arr.forEach((_, i) => {
        arr[i] = i + 1;
      }),
    subtle: {
      importKey: vi.fn().mockResolvedValue({}),
      deriveBits: vi
        .fn()
        .mockResolvedValue(new Uint8Array(32).fill(0xaa)),
    },
  });
});

// ─── fetch mock ─────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3333");
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ deviceId: "d1", householdId: "h1" }),
  } as Response);
});


afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthGate", () => {
  it("shows login screen when no token exists", async () => {
    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );
    // Wait for loading → login transition
    const emailInput = await screen.findByPlaceholderText(
      /seu\.email@exemplo\.com/,
      {},
      { timeout: 3000 },
    );
    expect(emailInput).toBeInTheDocument();
    const passInput = screen.getByPlaceholderText(/••••••••/);
    expect(passInput).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Exibir caracteres" }));
    expect(passInput).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar caracteres" }));
    expect(passInput).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /Entrar/i })).toBeInTheDocument();
  });

  it("brands the login screen as Meu Ted with logo and tagline", async () => {
    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );
    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(screen.getByRole("heading", { level: 1, name: "Meu Ted" })).toBeInTheDocument();
    expect(screen.getByText("tudo em dia.")).toBeInTheDocument();
    expect(screen.getByAltText("Meu Ted")).toHaveAttribute("src", "/logo.svg");
  });

  it("shows app content when token exists and is valid", async () => {
    store["pi-finance:token"] = "valid-token";
    vi.mocked(fetch)
      // 0. Cookie-first session probe: valid cookie session.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "u1", email: "walis@example.com", name: "W" } }),
      } as Response)
      // 1. Scoped device verification: valid.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ deviceId: "d1", householdId: "h1" }),
      } as Response);

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    const app = await screen.findByTestId("app", {}, { timeout: 3000 });
    expect(app).toBeInTheDocument();
  });

  it("shows login screen with expired msg when token returns 401", async () => {
    store["pi-finance:token"] = "expired-token";
    vi.mocked(fetch)
      // 0. Cookie-first session probe: no valid cookie session.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: null }),
      } as Response)
      // 1. Scoped device verification: expired/rotated/revoked.
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ code: "auth.invalid_token" }),
      } as Response);

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    const txt = await screen.findByText(
      /Sessão antiga expirada/,
      {},
      { timeout: 3000 },
    );
    expect(txt).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/seu\.email@exemplo\.com/),
    ).toBeInTheDocument();
  });
});

function SessionProbe() {
  const { expireSession } = useSession();
  return (
    <>
      <div data-testid="app">App Content</div>
      <button type="button" onClick={() => expireSession("Sessão expirada pelo teste.")}>
        Expire
      </button>
    </>
  );
}

describe("AuthGate login + session flows", () => {
  it("logs in with email/password, registers device token, and shows app on submit", async () => {
    vi.mocked(fetch)
      // 0. Boot session probe (no device token stored → GET /auth/session, no session).
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: null }),
      } as Response)
      // 1. POST /auth/sign-in/email
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { email: "walis@example.com" } }),
      } as Response)
      // 2. POST /auth/devices/register
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ token: "new-device-token", deviceId: "d1", householdId: "h1" }),
      } as Response)
      // 3. Post-login session probe: server-confirmed identity (W1 item 2 —
      // o unlock exige usuário validado no probe, nunca fallback por e-mail).
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "u1", email: "walis@example.com", name: "W" } }),
      } as Response);

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    const emailInput = await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    const passInput = screen.getByPlaceholderText(/••••••••/);

    fireEvent.change(emailInput, { target: { value: "walis@example.com" } });
    fireEvent.change(passInput, { target: { value: "password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Entrar/i }));

    const app = await screen.findByTestId("app", {}, { timeout: 3000 });
    expect(app).toBeInTheDocument();
    expect(store["pi-finance:token"]).toBe("new-device-token");
    // Ensure it doesn't revert to login screen with expired message
    expect(screen.queryByText(/Sessão expirada/i)).not.toBeInTheDocument();
  });

  it("submits via Enter key on password input and persists token without clearing", async () => {
    vi.mocked(fetch)
      // 0. Boot session probe (no device token stored → GET /auth/session, no session).
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: null }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { email: "enter@synkroo.com.br" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ token: "enter-key-token-12345", deviceId: "d-enter", householdId: "h-enter" }),
      } as Response)
      // 3. Post-login session probe: server-confirmed identity.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "u-enter", email: "enter@synkroo.com.br", name: "E" } }),
      } as Response);

    render(
      <AuthGate>
        <div data-testid="enter-app">Enter Key App</div>
      </AuthGate>,
    );

    const emailInput = await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    const passInput = screen.getByPlaceholderText(/••••••••/);

    fireEvent.change(emailInput, { target: { value: "enter@synkroo.com.br" } });
    fireEvent.change(passInput, { target: { value: "my-secure-password" } });
    fireEvent.keyDown(passInput, { key: "Enter", code: "Enter" });

    const app = await screen.findByTestId("enter-app", {}, { timeout: 3000 });
    expect(app).toBeInTheDocument();
    expect(store["pi-finance:token"]).toBe("enter-key-token-12345");
  });

  it("persists device token before unlocking and stays unlocked", async () => {
    vi.mocked(fetch)
      // 0. Boot session probe (no device token stored → GET /auth/session, no session).
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: null }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { email: "admin@synkroo.com.br" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ token: "550e8400-e29b-41d4-a716-446655440000", deviceId: "d2", householdId: "h2" }),
      } as Response)
      // 3. Post-login session probe: server-confirmed identity.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "u-admin", email: "admin@synkroo.com.br", name: "A" } }),
      } as Response);

    render(
      <AuthGate>
        <div data-testid="authenticated-dashboard">Dashboard Loaded</div>
      </AuthGate>,
    );

    const emailInput = await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    fireEvent.change(emailInput, { target: { value: "admin@synkroo.com.br" } });
    fireEvent.change(screen.getByPlaceholderText(/••••••••/), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /Entrar/i }));

    expect(await screen.findByTestId("authenticated-dashboard", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(store["pi-finance:token"]).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("shows error when login fails with 401 (invalid credentials)", async () => {
    vi.mocked(fetch)
      // 0. Boot session probe (no device token stored → GET /auth/session, no session).
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: null }),
      } as Response)
      .mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: "auth.invalid_credentials", message: "Invalid password" }),
    } as Response);

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    const emailInput = await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    const passInput = screen.getByPlaceholderText(/••••••••/);

    fireEvent.change(emailInput, { target: { value: "walis@example.com" } });
    fireEvent.change(passInput, { target: { value: "wrongPass" } });
    fireEvent.click(screen.getByRole("button", { name: /Entrar/i }));

    const err = await screen.findByText(/E-mail ou senha incorretos/i, {}, { timeout: 3000 });
    expect(err).toBeInTheDocument();
    expect(store["pi-finance:token"]).toBeUndefined();
  });

  it("shows default error when login fails (network)", async () => {
    vi.mocked(fetch)
      // 0. Boot session probe (no device token stored → GET /auth/session, no session).
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: null }),
      } as Response)
      .mockRejectedValueOnce(new Error("network down"));

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    const emailInput = await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    const passInput = screen.getByPlaceholderText(/••••••••/);

    fireEvent.change(emailInput, { target: { value: "walis@example.com" } });
    fireEvent.change(passInput, { target: { value: "password123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Entrar/i }));

    const err = await screen.findByText(/network down/i, {}, { timeout: 3000 });
    expect(err).toBeInTheDocument();
    expect(store["pi-finance:token"]).toBeUndefined();
  });

  it("expires session via context and returns to login screen", async () => {
    store["pi-finance:token"] = "valid-token";
    vi.mocked(fetch)
      // 0. Cookie-first session probe: valid cookie session.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "u1", email: "walis@example.com", name: "W" } }),
      } as Response)
      // 1. Scoped device verification: valid.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ deviceId: "d1", householdId: "h1" }),
      } as Response);
    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );
    expect(await screen.findByTestId("app", {}, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Expire"));
    expect(await screen.findByText(/Sessão expirada pelo teste/i, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(store["pi-finance:token"]).toBeUndefined();
  });
});

describe("AuthGate session-first boot (T2.5-client, ADR-015 Opção C)", () => {
  it("unlocks via cookie session when no device token is stored", async () => {
    // No device token in store; GET /auth/session proves a valid cookie session.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: "u1", email: "walis@example.com", name: "W" } }),
    } as Response);

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("app", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/auth/session"),
      expect.anything(),
    );
  });

  it("shows login when neither device token nor session exists (fail-closed)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: null }),
    } as Response);

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    await screen.findByPlaceholderText(/seu\.email@exemplo\.com/, {}, { timeout: 3000 });
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
  });

  it("keeps a valid cookie session unlocked when the stored device token expired (401)", async () => {
    // FIX-FINAL-2 FINDING 1 (RED): cookie-first boot — a valid cookie session
    // must survive an expired/rotated/revoked device token. Only the device
    // token is dropped; the cookie session is never cleared.
    store["pi-finance:token"] = "expired-device-token";
    vi.mocked(fetch)
      // 0. Cookie-first session probe: valid cookie session.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "u1", email: "walis@example.com", name: "W" } }),
      } as Response)
      // 1. Scoped device verification: expired/rotated/revoked.
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ code: "auth.invalid_token" }),
      } as Response);

    render(
      <AuthGate>
        <div data-testid="app">App Content</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("app", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(store["pi-finance:token"]).toBeUndefined();
    expect(screen.queryByText(/Sessão antiga expirada/)).not.toBeInTheDocument();
  });

  it("unlocks via cookie session with compat OFF and zero storage bearers", async () => {
    // V4.1 Closure AUTH-T01 (metade AuthGate): com
    // NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off a leitura de bearer é removida e
    // nenhum token é persistido — só a sessão cookie destrava o gate.
    vi.stubEnv("NEXT_PUBLIC_LEGACY_BEARER_COMPAT", "off");
    try {
      expect(store["pi-finance:token"] ?? null).toBeNull();
      expect(store["pi-finance:session-token"] ?? null).toBeNull();
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: "u1", email: "walis@example.com", name: "W" } }),
      } as Response);

      render(
        <AuthGate>
          <div data-testid="app">App Content</div>
        </AuthGate>,
      );

      expect(await screen.findByTestId("app", {}, { timeout: 3000 })).toBeInTheDocument();
      expect(store["pi-finance:token"] ?? null).toBeNull();
      expect(store["pi-finance:session-token"] ?? null).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

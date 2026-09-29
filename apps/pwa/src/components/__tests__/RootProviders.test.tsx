import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RootProviders } from "../RootProviders";
import { reloadAdapter } from "@/lib/sw-coordinator";

let mockPathname: string | null = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));
// Passthrough mocks keep the branch test focused on coordinator identity:
// AuthGate/Theme/UnsavedChanges/SWCoordinator stay real; these providers
// only forward children so no downstream fetch noise affects the count.
vi.mock("@/lib/auth/workspace-context", () => ({
  WorkspaceProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/state/app-state-context", () => ({
  AppStateProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/sheet-context", () => ({
  SheetProvider: ({ children }: { children: unknown }) => children,
}));

function installServiceWorkerMock() {
  const postMessage = vi.fn();
  const waiting = { postMessage };
  const swAddEventListener = vi.fn();
  const swRemoveEventListener = vi.fn();
  const register = vi.fn().mockResolvedValue({
    waiting,
    installing: null,
    active: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
  });
  // Keep a handle to restore whatever the environment provided before, so
  // this mock never leaks into later tests.
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "serviceWorker",
  );
  const hadOwnServiceWorker = Object.prototype.hasOwnProperty.call(
    globalThis.navigator,
    "serviceWorker",
  );
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: {
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      register,
      addEventListener: swAddEventListener,
      removeEventListener: swRemoveEventListener,
    },
    configurable: true,
    writable: true,
  });
  const restoreServiceWorker = () => {
    if (originalDescriptor) {
      Object.defineProperty(
        globalThis.navigator,
        "serviceWorker",
        originalDescriptor,
      );
    } else if (!hadOwnServiceWorker) {
      delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  };
  return { register, postMessage, swAddEventListener, restoreServiceWorker };
}

beforeEach(() => {
  mockPathname = "/";
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", undefined as unknown as string);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("RootProviders — no API env (V4.1 same-origin default, SPEC §12.6)", () => {
  it("renders the AuthGate login instead of the unconfigured screen (browser defaults to /api/backend)", async () => {
    // T2.5 session-first boot probes GET /auth/session (no device token stored).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
    render(
      <RootProviders>
        <div data-testid="mock-app">Mock App Content</div>
      </RootProviders>,
    );

    expect(await screen.findByRole("button", { name: /Entrar/i }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByTestId("api-unconfigured-screen")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-app")).not.toBeInTheDocument();
  });

  it("renders no mock workspace data in same-origin mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
    render(
      <RootProviders>
        <div data-testid="mock-app">Mock App Content</div>
      </RootProviders>,
    );

    await screen.findByRole("button", { name: /Entrar/i }, { timeout: 3000 });
    expect(screen.queryByText(/Workspace pessoal/i)).not.toBeInTheDocument();
  });

  it("probes the session through the same-origin proxy (no direct host)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );

    render(
      <RootProviders>
        <div>App</div>
      </RootProviders>,
    );

    await screen.findByRole("button", { name: /Entrar/i }, { timeout: 3000 });

    expect(fetchSpy).toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("api.synkroo.com.br");
    }
  });
});

describe("RootProviders — RUM storage failure never breaks boot (fail-closed, default OFF)", () => {
  it("still reaches the same-origin AuthGate login when localStorage throws", async () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ user: null }), { status: 200 }),
      );
      render(
        <RootProviders>
          <div data-testid="rum-fail-app">App</div>
        </RootProviders>,
      );
      expect(
        await screen.findByRole("button", { name: /Entrar/i }, { timeout: 3000 }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("api-unconfigured-screen")).not.toBeInTheDocument();
      // No React error from the RUM boot path (isRUMEnabled fail-closed).
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      getItemSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
describe("RootProviders — API env configured", () => {
  it("wraps content in AuthGate when API configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    // T2.5 session-first boot probes GET /auth/session (no device token stored).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
    render(
      <RootProviders>
        <div data-testid="cfg-app">Cfg App</div>
      </RootProviders>,
    );
    // API configured → AuthGate path renders (login UI after the session probe, children gated)
    expect(await screen.findByRole("button", { name: /Entrar/i }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByTestId("cfg-app")).not.toBeInTheDocument();
  });
});

describe("RootProviders — forced empty env (V4.1 same-origin default, SPEC §12.6)", () => {
  it("still boots through the same-origin proxy when API env is an empty string", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
    render(
      <RootProviders>
        <div data-testid="nocfg-app">NoCfg App</div>
      </RootProviders>,
    );
    await screen.findByRole("button", { name: /Entrar/i }, { timeout: 3000 });
    expect(screen.queryByTestId("nocfg-app")).not.toBeInTheDocument();
  });
});

describe("RootProviders — SSR prerender without env (item 7, no false-unconfigured flash)", () => {
  it("hydrateRoot hydrates actual server HTML: neutral first paint, then login via /api/backend with no mismatch", async () => {
    // Next docs (01-app/02-guides/preventing-flash-before-hydration.md +
    // 01-getting-started/05-server-and-client-components.md): Client
    // Components prerender HTML on the server (window absent) then hydrate
    // in the browser. This test hydrates the REAL renderToString HTML via
    // React hydrateRoot — not a separate render — so a hydration mismatch
    // would surface as console.error + DOM replacement.
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "");
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { waitFor } = await import("@testing-library/react");
    const realWindow = globalThis.window;
    vi.stubGlobal("window", undefined);
    let html: string;
    try {
      html = renderToString(
        <RootProviders>
          <div data-testid="ssr-app">SSR App Content</div>
        </RootProviders>,
      );
    } finally {
      vi.stubGlobal("window", realWindow);
    }
    // Server HTML (no window, no env) must NOT flash the fail-closed screen:
    // hydration in the browser resolves login through the same-origin proxy.
    expect(html).not.toContain("api-unconfigured-screen");
    expect(html).toContain("root-boot-placeholder");
    // No app content, no auth surface, no mock data in the prerender.
    expect(html).not.toContain("ssr-app");
    expect(html).not.toContain("Entrar");
    expect(html).not.toContain("Workspace pessoal");

    // Hydrate the ACTUAL server HTML in the browser (same empty env): the
    // session probe goes through the same-origin proxy, never a direct host.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = html;
    // First paint (pre-hydration DOM): neutral placeholder only.
    expect(
      container.querySelector('[data-testid="root-boot-placeholder"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="ssr-app"]')).toBeNull();
    expect(container.textContent).not.toContain("Entrar");
    expect(
      container.querySelector('[data-testid="api-unconfigured-screen"]'),
    ).toBeNull();

    const rootRef: { current: ReturnType<typeof hydrateRoot> | null } = {
      current: null,
    };
    try {
      await act(async () => {
        rootRef.current = hydrateRoot(
          container,
          // No StrictMode: avoid dev double-effect noise around hydration;
          // the placeholder→login transition is effect-driven either way.
          <RootProviders>
            <div data-testid="ssr-app">SSR App Content</div>
          </RootProviders>,
        );
      });
      // Post-effect: the boot placeholder resolves to login (children stay
      // gated behind AuthGate), proving hydration completed client-side.
      await waitFor(
        () => {
          const loginBtn = Array.from(
            container.querySelectorAll("button"),
          ).find((b) => /entrar/i.test(b.textContent ?? ""));
          expect(loginBtn).toBeTruthy();
        },
        { timeout: 3000 },
      );
      expect(
        container.querySelector('[data-testid="api-unconfigured-screen"]'),
      ).toBeNull();
      expect(container.textContent).not.toContain("Workspace pessoal");
      // No React hydration mismatch warnings on the real SSR→hydrate path.
      const hydrationWarnings = consoleErrorSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").toLowerCase().includes("hydrat"),
      );
      expect(hydrationWarnings).toHaveLength(0);
      // Same-origin contract: the session probe goes to the exact
      // same-origin proxy endpoint — never a direct production origin
      // and never an absolute http(s) URL.
      expect(fetchSpy).toHaveBeenCalled();
      const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain("/api/backend/auth/session");
      for (const url of urls) {
        expect(url).not.toContain("api.synkroo.com.br");
        expect(url.startsWith("http")).toBe(false);
      }
    } finally {
      try {
        rootRef.current?.unmount();
      } catch {
        /* noop */
      }
      container.remove();
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("RootProviders — SWCoordinator stays mounted across /convite branch changes", () => {
  it("switching / ↔ /convite registers the service worker once and keeps invite public", async () => {
    const { register, postMessage, swAddEventListener, restoreServiceWorker } =
      installServiceWorkerMock();
    const reloadSpy = vi
      .spyOn(reloadAdapter, "reload")
      .mockImplementation(() => {});
    // Authenticated cookie session so AuthGate unlocks and mounts the
    // coordinator on the ordinary route; /pwa-control keeps SW enabled.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/auth/session")) {
        return new Response(
          JSON.stringify({
            user: { id: "u1", email: "a@b.c", name: "T" },
            session: {},
          }),
          { status: 200 },
        );
      }
      if (url.includes("/pwa-control")) {
        return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    mockPathname = "/";
    const view = render(
      <RootProviders>
        <div data-testid="route-child">Route Child</div>
      </RootProviders>,
    );

    try {
      // Ordinary route (authenticated): AuthGate unlocks, children visible, no login.
      expect(await screen.findByTestId("route-child", {}, { timeout: 3000 })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Entrar/i })).not.toBeInTheDocument();
      await waitFor(
        () => expect(register).toHaveBeenCalledWith("/sw.js"),
        { timeout: 3000 },
      );
      expect(register).toHaveBeenCalledTimes(1);
      // Waiting worker is activated with the single canonical message.
      await waitFor(
        () => expect(postMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" }),
        { timeout: 3000 },
      );
      expect(postMessage).toHaveBeenCalledTimes(1);

      // Capture the persistent controllerchange listener BEFORE any route
      // change: it must survive the branch swaps below.
      const controllerHandlers = swAddEventListener.mock.calls
        .filter((call) => call[0] === "controllerchange")
        .map((call) => call[1] as () => void);
      expect(controllerHandlers).toHaveLength(1);
      const onControllerChange = controllerHandlers[0]!;

      // Switch to the public invite route (usePathname has no query string):
      // children render with no login gate and no session probe (AuthGate bypassed).
      mockPathname = "/convite";
      view.rerender(
        <RootProviders>
          <div data-testid="route-child">Route Child</div>
        </RootProviders>,
      );
      expect(await screen.findByTestId("route-child", {}, { timeout: 3000 })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Entrar/i })).not.toBeInTheDocument();

      // Switch back: AuthGate contract returns, coordinator never remounted.
      mockPathname = "/";
      view.rerender(
        <RootProviders>
          <div data-testid="route-child">Route Child</div>
        </RootProviders>,
      );
      expect(await screen.findByTestId("route-child", {}, { timeout: 3000 })).toBeInTheDocument();

      // Allow any remount-driven re-registration microtask to flush, then
      // assert once: no remount, no duplicate activation.
      await waitFor(
        () => expect(register).toHaveBeenCalledWith("/sw.js"),
        { timeout: 3000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(register).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledTimes(1);
      // No extra controllerchange listener was attached across the swaps.
      expect(
        swAddEventListener.mock.calls.filter((call) => call[0] === "controllerchange"),
      ).toHaveLength(1);

      // Observer continuity: the handler captured before the swaps still
      // drives exactly one reload afterward (state was never lost/remounted).
      onControllerChange();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      reloadSpy.mockRestore();
      restoreServiceWorker();
    }
  });

  it("keeps the /convites prefix-sibling behind AuthGate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
    mockPathname = "/convites";
    const view = render(
      <RootProviders>
        <div data-testid="convites-child">Convites Child</div>
      </RootProviders>,
    );
    try {
      // Not the exact invite pathname → AuthGate stays: login renders, children gated.
      expect(await screen.findByRole("button", { name: /Entrar/i }, { timeout: 3000 })).toBeInTheDocument();
      expect(screen.queryByTestId("convites-child")).not.toBeInTheDocument();
    } finally {
      view.unmount();
    }
  });
});

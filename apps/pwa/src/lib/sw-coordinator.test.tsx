import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as React from "react";
import { renderHook, render, waitFor, act } from "@testing-library/react";
import { UnsavedChangesProvider, useUnsavedChanges } from "@/lib/unsaved-changes";
import {
  useSWCoordinator,
  SWCoordinator,
  activateWaitingIfClean,
  resolveControllerChange,
  resolveBecameClean,
  reloadAdapter,
} from "./sw-coordinator";

function installMocks(enabled: boolean | undefined) {
  const regs = [{ unregister: vi.fn().mockResolvedValue(true) }];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ enabled }) }),
  );
  // @ts-expect-error test mock
  navigator.serviceWorker = {
    getRegistrations: vi.fn().mockResolvedValue(regs),
    getRegistration: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue({
      waiting: null,
      installing: null,
      active: {},
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const names = ["pi-finance-a", "other-b"];
  // @ts-expect-error test mock
  globalThis.caches = {
    keys: vi.fn().mockResolvedValue(names),
    delete: vi.fn().mockResolvedValue(true),
  };
  return { regs };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
);

describe("useSWCoordinator", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error delete mock
    delete navigator.serviceWorker;
    // @ts-expect-error delete mock
    delete globalThis.caches;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("exposes isDirty from useUnsavedChanges", () => {
    const { result } = renderHook(() => useSWCoordinator(), { wrapper });
    expect(result.current).toHaveProperty("isDirty");
    expect(result.current.isDirty).toBe(false);
  });
});

describe("activateWaitingIfClean", () => {
  it("returns false when no waiting worker", () => {
    const reg = { waiting: null } as unknown as ServiceWorkerRegistration;
    expect(activateWaitingIfClean(reg, false)).toBe(false);
  });

  it("returns false when dirty even if waiting", () => {
    const postMessage = vi.fn();
    const reg = {
      waiting: { postMessage },
    } as unknown as ServiceWorkerRegistration;
    expect(activateWaitingIfClean(reg, true)).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts single canonical CLEAN_UPDATE when clean and waiting", () => {
    const postMessage = vi.fn();
    const reg = {
      waiting: { postMessage },
    } as unknown as ServiceWorkerRegistration;
    expect(activateWaitingIfClean(reg, false)).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" });
  });

  it("returns false for missing registration without throwing (serviceWorkers:block)", () => {
    expect(activateWaitingIfClean(undefined, false)).toBe(false);
    expect(activateWaitingIfClean(null, false)).toBe(false);
  });
});

describe("SWCoordinator", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers /sw.js on mount", async () => {
    installMocks(true);
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <div>child</div>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() =>
      expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js"),
    );
  });

  it("fetches /pwa-control with no-store", async () => {
    installMocks(true);
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>x</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/pwa-control", { cache: "no-store" }),
    );
  });

  it("unregisters SW and clears only pi-finance caches when disabled", async () => {
    const { regs } = installMocks(false);
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>x</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(regs[0].unregister).toHaveBeenCalled());
    await waitFor(() =>
      expect(globalThis.caches.delete).toHaveBeenCalledWith("pi-finance-a"),
    );
    expect(globalThis.caches.delete).not.toHaveBeenCalledWith("other-b");
  });

  it("ignores fetch errors without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockRejectedValue(new Error("no sw")),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    expect(() =>
      render(
        <UnsavedChangesProvider>
          <SWCoordinator>
            <span>x</span>
          </SWCoordinator>
        </UnsavedChangesProvider>,
      ),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
  });

  it("tolerates register resolving undefined (Playwright serviceWorkers:block) without page error", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const register = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    try {
      const { getByText } = render(
        <UnsavedChangesProvider>
          <SWCoordinator>
            <span>child-ok</span>
          </SWCoordinator>
        </UnsavedChangesProvider>,
      );
      expect(getByText("child-ok")).toBeInTheDocument();
      await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js"));
      await new Promise((r) => setTimeout(r, 30));
      expect(rejections).toEqual([]);
      expect(navigator.serviceWorker.addEventListener).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("tolerates register returning undefined synchronously (blocked stub) without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const register = vi.fn().mockReturnValue(undefined);
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    let getByText: ((text: string) => HTMLElement) | undefined;
    expect(() => {
      const rendered = render(
        <UnsavedChangesProvider>
          <SWCoordinator>
            <span>child-sync-ok</span>
          </SWCoordinator>
        </UnsavedChangesProvider>,
      );
      getByText = rendered.getByText;
    }).not.toThrow();
    expect(getByText!("child-sync-ok")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("does not attach listeners or update when unmounted before register resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    let resolveRegister!: (reg: unknown) => void;
    const register = vi
      .fn()
      .mockReturnValue(
        new Promise((resolve) => {
          resolveRegister = resolve;
        }),
      );
    const swAddEventListener = vi.fn();
    const swRemoveEventListener = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: swAddEventListener,
      removeEventListener: swRemoveEventListener,
    };
    const { unmount } = render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>child-cancel</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js"));
    // Single persistent controllerchange listener is attached on mount.
    expect(
      swAddEventListener.mock.calls.filter((c) => c[0] === "controllerchange"),
    ).toHaveLength(1);
    const persistentHandler = swAddEventListener.mock.calls.find(
      (c) => c[0] === "controllerchange",
    )![1];
    unmount();
    // Cleanup removes the persistent listener.
    expect(swRemoveEventListener).toHaveBeenCalledWith(
      "controllerchange",
      persistentHandler,
    );
    const postMessage = vi.fn();
    const regAddEventListener = vi.fn();
    const regUpdate = vi.fn().mockResolvedValue(undefined);
    resolveRegister({
      waiting: { postMessage },
      installing: null,
      addEventListener: regAddEventListener,
      removeEventListener: vi.fn(),
      update: regUpdate,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(regAddEventListener).not.toHaveBeenCalled();
    expect(regUpdate).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    // No additional controllerchange attach after unmount.
    expect(
      swAddEventListener.mock.calls.filter((c) => c[0] === "controllerchange"),
    ).toHaveLength(1);
  });

  it("does not activate when getRegistration resolves after form becomes dirty (race)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    let resolveGetReg!: (reg: unknown) => void;
    const getRegistration = vi
      .fn()
      .mockReturnValue(
        new Promise((resolve) => {
          resolveGetReg = resolve;
        }),
      );
    const register = vi.fn().mockResolvedValue({
      waiting: null,
      installing: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    });
    const swAddEventListener = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration,
      addEventListener: swAddEventListener,
      removeEventListener: vi.fn(),
    };
    const token = Symbol("race-form");
    const { useUnsavedChanges } = await import("@/lib/unsaved-changes");
    function DirtyButton() {
      const { markDirty } = useUnsavedChanges();
      return <button onClick={() => markDirty(token)}>make-dirty</button>;
    }
    const { getByText } = render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>race-child</span>
        </SWCoordinator>
        <DirtyButton />
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(getRegistration).toHaveBeenCalled());
    // Form becomes dirty while getRegistration is still pending.
    getByText("make-dirty").click();
    const postMessage = vi.fn();
    resolveGetReg({ waiting: { postMessage } });
    await new Promise((r) => setTimeout(r, 30));
    expect(postMessage).not.toHaveBeenCalled();
    // Persistent listener is attached on mount (shared by both activation
    // paths) and is not removed by the dirty transition — the late
    // getRegistration resolution simply never activates.
    expect(
      swAddEventListener.mock.calls.filter((c) => c[0] === "controllerchange"),
    ).toHaveLength(1);
  });

  it("does not activate or attach listeners when unmounted before getRegistration resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    let resolveGetReg!: (reg: unknown) => void;
    const getRegistration = vi
      .fn()
      .mockReturnValue(
        new Promise((resolve) => {
          resolveGetReg = resolve;
        }),
      );
    const register = vi.fn().mockResolvedValue({
      waiting: null,
      installing: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    });
    const swAddEventListener = vi.fn();
    const swRemoveEventListener = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration,
      addEventListener: swAddEventListener,
      removeEventListener: swRemoveEventListener,
    };
    const { unmount } = render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>unmount-race-child</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(getRegistration).toHaveBeenCalled());
    unmount();
    const postMessage = vi.fn();
    resolveGetReg({ waiting: { postMessage } });
    await new Promise((r) => setTimeout(r, 30));
    expect(postMessage).not.toHaveBeenCalled();
    // Persistent listener was attached once on mount and removed on unmount;
    // the late resolution adds no new listener and no activation.
    expect(
      swAddEventListener.mock.calls.filter((c) => c[0] === "controllerchange"),
    ).toHaveLength(1);
    expect(swRemoveEventListener).toHaveBeenCalledWith(
      "controllerchange",
      expect.any(Function),
    );
  });

  it("cancels updatefound/statechange chain on unmount without activation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const installingAddEventListener = vi.fn();
    const installingRemoveEventListener = vi.fn();
    const installing = {
      state: "installing",
      addEventListener: installingAddEventListener,
      removeEventListener: installingRemoveEventListener,
    };
    const postMessage = vi.fn();
    const regAddEventListener = vi.fn();
    const regRemoveEventListener = vi.fn();
    const regUpdate = vi.fn().mockResolvedValue(undefined);
    const fakeReg = {
      waiting: { postMessage },
      installing,
      addEventListener: regAddEventListener,
      removeEventListener: regRemoveEventListener,
      update: regUpdate,
    };
    const register = vi.fn().mockResolvedValue(fakeReg);
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const { unmount } = render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>statechange-child</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js"));
    await waitFor(() =>
      expect(regAddEventListener).toHaveBeenCalledWith(
        "updatefound",
        expect.any(Function),
      ),
    );
    const onUpdateFound = regAddEventListener.mock.calls.find(
      (c) => c[0] === "updatefound",
    )![1] as () => void;
    onUpdateFound();
    expect(installingAddEventListener).toHaveBeenCalledWith(
      "statechange",
      expect.any(Function),
    );
    const onStateChange = installingAddEventListener.mock.calls.find(
      (c) => c[0] === "statechange",
    )![1] as () => void;
    unmount();
    expect(installingRemoveEventListener).toHaveBeenCalledWith(
      "statechange",
      onStateChange,
    );
    // Late installing->installed transition must not activate after unmount.
    installing.state = "installed";
    postMessage.mockClear();
    onStateChange();
    await new Promise((r) => setTimeout(r, 10));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("StrictMode setup/cleanup/setup registers active path and ignores stale first resolution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    let resolveFirst!: (reg: unknown) => void;
    const firstPending = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const stalePostMessage = vi.fn();
    const staleAddEventListener = vi.fn();
    const staleUpdate = vi.fn().mockResolvedValue(undefined);
    const activePostMessage = vi.fn();
    const activeAddEventListener = vi.fn();
    const activeUpdate = vi.fn().mockResolvedValue(undefined);
    const register = vi
      .fn()
      .mockReturnValueOnce(firstPending)
      .mockResolvedValue({
        waiting: { postMessage: activePostMessage },
        installing: null,
        addEventListener: activeAddEventListener,
        removeEventListener: vi.fn(),
        update: activeUpdate,
      });
    const swAddEventListener = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: swAddEventListener,
      removeEventListener: vi.fn(),
    };
    render(
      <React.StrictMode>
        <UnsavedChangesProvider>
          <SWCoordinator>
            <span>strict-child</span>
          </SWCoordinator>
        </UnsavedChangesProvider>
      </React.StrictMode>,
    );
    await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    // Active (second) registration path must install updatefound + update.
    await waitFor(() =>
      expect(activeAddEventListener).toHaveBeenCalledWith(
        "updatefound",
        expect.any(Function),
      ),
    );
    await waitFor(() => expect(activeUpdate).toHaveBeenCalled());
    // Stale first resolution must have no effects.
    resolveFirst({
      waiting: { postMessage: stalePostMessage },
      installing: null,
      addEventListener: staleAddEventListener,
      removeEventListener: vi.fn(),
      update: staleUpdate,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(stalePostMessage).not.toHaveBeenCalled();
    expect(staleAddEventListener).not.toHaveBeenCalled();
    expect(staleUpdate).not.toHaveBeenCalled();
  });

  it("attaches updatefound listener and calls update for valid registration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const regAddEventListener = vi.fn();
    const regUpdate = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({
      waiting: null,
      installing: null,
      addEventListener: regAddEventListener,
      removeEventListener: vi.fn(),
      update: regUpdate,
    });
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register,
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>child-valid</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js"));
    await waitFor(() =>
      expect(regAddEventListener).toHaveBeenCalledWith(
        "updatefound",
        expect.any(Function),
      ),
    );
    await waitFor(() => expect(regUpdate).toHaveBeenCalled());
  });
});

describe("controllerchange dirty-reload guard", () => {
  it("controllerchange while clean reloads immediately", () => {
    const { next, shouldReload } = resolveControllerChange(
      { reloaded: false, pendingReload: false },
      false,
    );
    expect(shouldReload).toBe(true);
    expect(next).toEqual({ reloaded: true, pendingReload: false });
  });

  it("controllerchange while dirty defers reload (pending, no reload)", () => {
    const { next, shouldReload } = resolveControllerChange(
      { reloaded: false, pendingReload: false },
      true,
    );
    expect(shouldReload).toBe(false);
    expect(next).toEqual({ reloaded: false, pendingReload: true });
  });

  it("pending reload fires exactly once when the form becomes clean", () => {
    const { next, shouldReload } = resolveBecameClean({
      reloaded: false,
      pendingReload: true,
    });
    expect(shouldReload).toBe(true);
    expect(next).toEqual({ reloaded: true, pendingReload: false });
  });

  it("never reloads twice once already reloaded", () => {
    expect(
      resolveControllerChange({ reloaded: true, pendingReload: false }, false),
    ).toEqual({
      next: { reloaded: true, pendingReload: false },
      shouldReload: false,
    });
    expect(
      resolveControllerChange({ reloaded: true, pendingReload: false }, true),
    ).toEqual({
      next: { reloaded: true, pendingReload: false },
      shouldReload: false,
    });
    expect(
      resolveBecameClean({ reloaded: true, pendingReload: false }),
    ).toEqual({
      next: { reloaded: true, pendingReload: false },
      shouldReload: false,
    });
  });

  it("becoming clean without a pending reload does nothing", () => {
    expect(
      resolveBecameClean({ reloaded: false, pendingReload: false }),
    ).toEqual({
      next: { reloaded: false, pendingReload: false },
      shouldReload: false,
    });
  });
});

describe("sw-sync-dirty-state-controllerchange", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubReload() {
    // Reload is observed through the injectable reloadAdapter (jsdom's
    // Location#reload is not mockable — it throws "Not implemented:
    // navigation"). Production still calls window.location.reload().
    const reload = vi.fn();
    vi.spyOn(reloadAdapter, "reload").mockImplementation(reload);
    return reload;
  }

  function controllerHandlers(swAdd: ReturnType<typeof vi.fn>) {
    return swAdd.mock.calls
      .filter((c) => c[0] === "controllerchange")
      .map((c) => c[1] as () => void);
  }

  it("attaches exactly one persistent controllerchange listener and removes on unmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const swAdd = vi.fn();
    const swRemove = vi.fn();
    // No waiting anywhere: no activation, but the persistent listener must exist.
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockResolvedValue({
        waiting: null,
        installing: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: swAdd,
      removeEventListener: swRemove,
    };
    const { unmount } = render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>persistent-child</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(controllerHandlers(swAdd)).toHaveLength(1);
    unmount();
    expect(swRemove).toHaveBeenCalledWith(
      "controllerchange",
      controllerHandlers(swAdd)[0],
    );
  });

  it("controllerchange without activation does nothing while clean", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const reload = stubReload();
    const swAdd = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockResolvedValue({
        waiting: null,
        installing: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: swAdd,
      removeEventListener: vi.fn(),
    };
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>no-activation-child</span>
        </SWCoordinator>
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    const handlers = controllerHandlers(swAdd);
    expect(handlers).toHaveLength(1);
    handlers[0]!();
    expect(reload).not.toHaveBeenCalled();
  });

  it("immediate markDirty before effect flush guards controllerchange (sync read)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const reload = stubReload();
    const postMessage = vi.fn();
    const swAdd = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockResolvedValue({
        waiting: { postMessage },
        installing: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: swAdd,
      removeEventListener: vi.fn(),
    };
    const token = Symbol("sync-guard-form");
    function DirtyProbe() {
      const ctx = useUnsavedChanges();
      (DirtyProbe as unknown as { ctx?: typeof ctx }).ctx = ctx;
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>sync-guard-child</span>
        </SWCoordinator>
        <DirtyProbe />
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" }));
    const handlers = controllerHandlers(swAdd);
    expect(handlers).toHaveLength(1);
    const ctx = (DirtyProbe as unknown as { ctx: ReturnType<typeof useUnsavedChanges> }).ctx;
    // markDirty + controllerchange in the SAME act, before the coordinator's
    // passive isDirty effect can flush the stale ref. A synchronous dirty
    // query must see dirty and defer (no reload).
    act(() => {
      ctx.markDirty(token);
      handlers[0]!();
    });
    expect(reload).not.toHaveBeenCalled();
    // Becoming clean later performs exactly one reload.
    act(() => {
      ctx.markClean(token);
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("getRegistration-driven activation persists listener through dirty->clean with exactly one reload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const reload = stubReload();
    const postMessage = vi.fn();
    const swAdd = vi.fn();
    const swRemove = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockResolvedValue({
        waiting: null,
        installing: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue({ waiting: { postMessage } }),
      addEventListener: swAdd,
      removeEventListener: swRemove,
    };
    const token = Symbol("getreg-form");
    function DirtyProbe() {
      const ctx = useUnsavedChanges();
      (DirtyProbe as unknown as { ctx?: typeof ctx }).ctx = ctx;
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>getreg-child</span>
        </SWCoordinator>
        <DirtyProbe />
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" }));
    await new Promise((r) => setTimeout(r, 20));
    // Exactly one shared listener, even though activation came from getRegistration.
    expect(controllerHandlers(swAdd)).toHaveLength(1);
    const handler = controllerHandlers(swAdd)[0]!;
    const ctx = (DirtyProbe as unknown as { ctx: ReturnType<typeof useUnsavedChanges> }).ctx;
    act(() => {
      ctx.markDirty(token);
    });
    // Listener must persist through the dirty transition (no removal).
    expect(
      swRemove.mock.calls.filter((c) => c[0] === "controllerchange"),
    ).toHaveLength(0);
    handler();
    expect(reload).not.toHaveBeenCalled();
    act(() => {
      ctx.markClean(token);
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Still exactly one listener, exactly one reload total.
    expect(controllerHandlers(swAdd)).toHaveLength(1);
    handler();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("batched dirty→controllerchange→clean in one act drains pending reload exactly once", async () => {    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const reload = stubReload();
    const postMessage = vi.fn();
    const swAdd = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockResolvedValue({
        waiting: { postMessage },
        installing: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      addEventListener: swAdd,
      removeEventListener: vi.fn(),
    };
    const token = Symbol("batched-dirty-clean-form");
    function DirtyProbe() {
      const ctx = useUnsavedChanges();
      (DirtyProbe as unknown as { ctx?: typeof ctx }).ctx = ctx;
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>batched-child</span>
        </SWCoordinator>
        <DirtyProbe />
      </UnsavedChangesProvider>,
    );
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" }));
    const handlers = controllerHandlers(swAdd);
    expect(handlers).toHaveLength(1);
    const ctx = (DirtyProbe as unknown as { ctx: ReturnType<typeof useUnsavedChanges> }).ctx;
    // Single React batch: dirty → controllerchange (defers) → clean.
    // isDirty starts/ends false so the [isDirty] effect alone would not
    // rerun; the dirty revision must trigger the drain.
    act(() => {
      ctx.markDirty(token);
      handlers[0]!();
      ctx.markClean(token);
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("deduplicates CLEAN_UPDATE by waiting-worker identity across register + getRegistration and dirty→clean cycles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const postMessage = vi.fn();
    const waitingWorker = { postMessage };
    const swAdd = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockResolvedValue({
        waiting: waitingWorker,
        installing: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration: vi.fn().mockResolvedValue({ waiting: waitingWorker }),
      addEventListener: swAdd,
      removeEventListener: vi.fn(),
    };
    const token = Symbol("dedupe-form");
    function DirtyProbe() {
      const ctx = useUnsavedChanges();
      (DirtyProbe as unknown as { ctx?: typeof ctx }).ctx = ctx;
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>dedupe-child</span>
        </SWCoordinator>
        <DirtyProbe />
      </UnsavedChangesProvider>,
    );
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const ctx = (DirtyProbe as unknown as { ctx: ReturnType<typeof useUnsavedChanges> }).ctx;
    act(() => {
      ctx.markDirty(token);
    });
    act(() => {
      ctx.markClean(token);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" });
  });

  it("activates a distinct waiting worker after the first unless reload already happened or is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
    );
    const reload = stubReload();
    const firstPostMessage = vi.fn();
    const firstWorker = { postMessage: firstPostMessage };
    const secondPostMessage = vi.fn();
    const secondWorker = { postMessage: secondPostMessage };
    const getRegistration = vi
      .fn()
      .mockResolvedValueOnce({ waiting: firstWorker });
    const swAdd = vi.fn();
    // @ts-expect-error mock
    navigator.serviceWorker = {
      register: vi.fn().mockResolvedValue({
        waiting: null,
        installing: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getRegistrations: vi.fn().mockResolvedValue([]),
      getRegistration,
      addEventListener: swAdd,
      removeEventListener: vi.fn(),
    };
    const token = Symbol("distinct-worker-form");
    function DirtyProbe() {
      const ctx = useUnsavedChanges();
      (DirtyProbe as unknown as { ctx?: typeof ctx }).ctx = ctx;
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <SWCoordinator>
          <span>distinct-child</span>
        </SWCoordinator>
        <DirtyProbe />
      </UnsavedChangesProvider>,
    );
    await waitFor(() =>
      expect(firstPostMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" }),
    );
    expect(firstPostMessage).toHaveBeenCalledTimes(1);
    // A new version (distinct waiting worker) must still be activatable.
    getRegistration.mockResolvedValue({ waiting: secondWorker });
    const ctx = (DirtyProbe as unknown as { ctx: ReturnType<typeof useUnsavedChanges> }).ctx;
    act(() => {
      ctx.markDirty(token);
    });
    act(() => {
      ctx.markClean(token);
    });
    await waitFor(() =>
      expect(secondPostMessage).toHaveBeenCalledWith({ type: "CLEAN_UPDATE" }),
    );
    expect(secondPostMessage).toHaveBeenCalledTimes(1);
    // After the reload fires, no further worker receives activation.
    const handlers = controllerHandlers(swAdd);
    expect(handlers).toHaveLength(1);
    handlers[0]!();
    expect(reload).toHaveBeenCalledTimes(1);
    const thirdPostMessage = vi.fn();
    getRegistration.mockResolvedValue({ waiting: { postMessage: thirdPostMessage } });
    act(() => {
      ctx.markDirty(token);
    });
    act(() => {
      ctx.markClean(token);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(thirdPostMessage).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from "vitest";
import * as React from "react";
import { render, renderHook, act } from "@testing-library/react";
import {
  UnsavedChangesProvider,
  useFormDirtySafe,
  useUnsavedChanges,
} from "./unsaved-changes";

describe("UnsavedChangesContext", () => {
  it("starts clean (not dirty)", () => {
    const { result } = renderHook(() => useUnsavedChanges(), {
      wrapper: UnsavedChangesProvider,
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("trackWrite returns cleanup that marks clean after dirty", () => {
    const { result } = renderHook(() => useUnsavedChanges(), {
      wrapper: UnsavedChangesProvider,
    });
    let cleanup: () => void;
    act(() => {
      cleanup = result.current.trackWrite();
    });
    expect(result.current.isDirty).toBe(true);

    act(() => {
      cleanup!();
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("multiple concurrent writes tracked independently", () => {
    const { result } = renderHook(() => useUnsavedChanges(), {
      wrapper: UnsavedChangesProvider,
    });
    let c1: () => void, c2: () => void;
    act(() => { c1 = result.current.trackWrite(); });
    act(() => { c2 = result.current.trackWrite(); });
    expect(result.current.isDirty).toBe(true);

    act(() => { c1(); });
    expect(result.current.isDirty).toBe(true);

    act(() => { c2(); });
    expect(result.current.isDirty).toBe(false);
  });

  it("cleanup is idempotent (calling twice does not double-clean)", () => {
    const { result } = renderHook(() => useUnsavedChanges(), {
      wrapper: UnsavedChangesProvider,
    });
    let cleanup: () => void;
    act(() => { cleanup = result.current.trackWrite(); });
    expect(result.current.isDirty).toBe(true);

    act(() => { cleanup(); });
    expect(result.current.isDirty).toBe(false);

    act(() => { cleanup(); });
    expect(result.current.isDirty).toBe(false);
  });
});

describe("UnsavedChangesContext synchronous query", () => {
  it("reflects markDirty/markClean immediately in the same act via isDirtyNow", () => {
    const api: { current?: ReturnType<typeof useUnsavedChanges> } = {};
    function Probe() {
      api.current = useUnsavedChanges();
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <Probe />
      </UnsavedChangesProvider>,
    );
    const token = Symbol("sync-dirty");
    act(() => {
      api.current!.markDirty(token);
      expect(api.current!.isDirtyNow()).toBe(true);
    });
    expect(api.current!.isDirty).toBe(true);
    act(() => {
      api.current!.markClean(token);
      expect(api.current!.isDirtyNow()).toBe(false);
    });
    expect(api.current!.isDirty).toBe(false);
  });

  it("reflects trackWrite/release immediately in the same act via isDirtyNow", () => {
    const api: { current?: ReturnType<typeof useUnsavedChanges> } = {};
    function Probe() {
      api.current = useUnsavedChanges();
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <Probe />
      </UnsavedChangesProvider>,
    );
    let cleanup: (() => void) | undefined;
    act(() => {
      cleanup = api.current!.trackWrite();
      expect(api.current!.isDirtyNow()).toBe(true);
    });
    expect(api.current!.isDirty).toBe(true);
    act(() => {
      cleanup!();
      expect(api.current!.isDirtyNow()).toBe(false);
    });
    expect(api.current!.isDirty).toBe(false);
  });
});

describe("useFormDirtySafe — provider lifecycle edge cases", () => {
  it("keeps stable markDirty/markClean identities across dirty cycles", () => {
    const { result } = renderHook(() => useFormDirtySafe(), {
      wrapper: UnsavedChangesProvider,
    });
    const { markDirty, markClean } = result.current;
    expect(result.current.isDirty).toBe(false);

    act(() => {
      markDirty();
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.markDirty).toBe(markDirty);
    expect(result.current.markClean).toBe(markClean);

    act(() => {
      markClean();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.markDirty).toBe(markDirty);
    expect(result.current.markClean).toBe(markClean);
  });

  it("operates as a local stub without a provider (no throw, stable identities)", () => {
    // Documented contract: safe to call outside an UnsavedChangesProvider
    // (isolated tests). Dirt lives in a local flag; nothing global changes.
    const { result } = renderHook(() => useFormDirtySafe());
    const markDirty = result.current.markDirty;
    const markClean = result.current.markClean;
    expect(result.current.isDirty).toBe(false);

    act(() => {
      markDirty();
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.markDirty).toBe(markDirty);
    expect(result.current.markClean).toBe(markClean);

    act(() => {
      markClean();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.markDirty).toBe(markDirty);
    expect(result.current.markClean).toBe(markClean);
  });

  it("cleans its token on unmount so siblings and global state recover", () => {
    const api: {
      first?: ReturnType<typeof useFormDirtySafe>;
      second?: ReturnType<typeof useFormDirtySafe>;
      global?: boolean;
    } = {};
    function Form({ id }: { id: "first" | "second" }) {
      api[id] = useFormDirtySafe();
      return null;
    }
    function GlobalProbe() {
      api.global = useUnsavedChanges().isDirty;
      return null;
    }
    const { rerender } = render(
      <UnsavedChangesProvider>
        <Form key="first" id="first" />
        <Form key="second" id="second" />
        <GlobalProbe key="global" />
      </UnsavedChangesProvider>,
    );
    const secondDirty = api.second!.markDirty;
    const secondClean = api.second!.markClean;

    // Dirty the first form only: global flips, sibling token stays clean.
    act(() => {
      api.first!.markDirty();
    });
    expect(api.global).toBe(true);
    expect(api.second!.isDirty).toBe(false);

    // Unmount the dirty first form (keys pin each instance, so exactly the
    // dirty one unmounts): its cleanup clears the token, global recovers,
    // and the sibling's helper identities never changed.
    rerender(
      <UnsavedChangesProvider>
        <Form key="second" id="second" />
        <GlobalProbe key="global" />
      </UnsavedChangesProvider>,
    );
    expect(api.global).toBe(false);
    expect(api.second!.isDirty).toBe(false);
    expect(api.second!.markDirty).toBe(secondDirty);
    expect(api.second!.markClean).toBe(secondClean);
  });
});

describe("UnsavedChangesContext dirtyVersion", () => {
  it("defaults to 0 and preserves isDirty contract", () => {
    const { result } = renderHook(() => useUnsavedChanges(), {
      wrapper: UnsavedChangesProvider,
    });
    expect(result.current.dirtyVersion).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it("increments only on real transitions (idempotent no-ops do not bump)", () => {
    const api: { current?: ReturnType<typeof useUnsavedChanges> } = {};
    function Probe() {
      api.current = useUnsavedChanges();
      return null;
    }
    render(
      <UnsavedChangesProvider>
        <Probe />
      </UnsavedChangesProvider>,
    );
    const token = Symbol("version-token");
    expect(api.current!.dirtyVersion).toBe(0);
    act(() => {
      api.current!.markDirty(token);
    });
    const v1 = api.current!.dirtyVersion;
    expect(v1).toBeGreaterThan(0);
    expect(api.current!.isDirty).toBe(true);
    // Duplicate markDirty is a no-op: version stays.
    act(() => {
      api.current!.markDirty(token);
    });
    expect(api.current!.dirtyVersion).toBe(v1);
    act(() => {
      api.current!.markClean(token);
    });
    expect(api.current!.dirtyVersion).toBeGreaterThan(v1);
    expect(api.current!.isDirty).toBe(false);
    // Cleaning an unknown token is a no-op: version stays.
    const v2 = api.current!.dirtyVersion;
    act(() => {
      api.current!.markClean(Symbol("unknown"));
    });
    expect(api.current!.dirtyVersion).toBe(v2);
  });

  it("bumps on trackWrite acquire and release", () => {
    const { result } = renderHook(() => useUnsavedChanges(), {
      wrapper: UnsavedChangesProvider,
    });
    expect(result.current.dirtyVersion).toBe(0);
    let cleanup: () => void;
    act(() => {
      cleanup = result.current.trackWrite();
    });
    const v1 = result.current.dirtyVersion;
    expect(v1).toBeGreaterThan(0);
    act(() => {
      cleanup!();
    });
    expect(result.current.dirtyVersion).toBeGreaterThan(v1);
    expect(result.current.isDirty).toBe(false);
  });
});

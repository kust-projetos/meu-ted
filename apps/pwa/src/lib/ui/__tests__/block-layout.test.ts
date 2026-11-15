import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@/lib/test-utils";
import { clampLayout, layoutStorageKey, moveBlock, reorderBlock } from "../block-layout";
import { useBlockLayout } from "../use-block-layout";

const schema = { all: ["a", "b", "c"], essentialDefaultHidden: ["c"] };
const options = (workspaceId: string, surface: "home" | "reports" = "home") => ({ workspaceId, surface, schema });

describe("block layout storage and normalization", () => {
  beforeEach(() => localStorage.clear());
  it("isolates workspaces and surfaces in the key", () => {
    expect(layoutStorageKey(options("one"))).not.toBe(layoutStorageKey(options("two")));
    expect(layoutStorageKey(options("one", "home"))).not.toBe(layoutStorageKey(options("one", "reports")));
  });
  it("drops unknown ids, appends additions, and resolves mode presets with overrides", () => {
    expect(clampLayout({ order: ["b", "x"], overrides: { c: "shown", x: "hidden" } }, schema, "essential")).toEqual({
      order: ["b", "a", "c"], hidden: [], mode: "essential", overrides: { c: "shown" },
    });
    expect(clampLayout({ overrides: { a: "hidden" } }, schema, "essential").hidden).toEqual(["a", "c"]);
    expect(clampLayout({ overrides: { a: "hidden" } }, schema, "complete").hidden).toEqual(["a"]);
  });
  it("imports the global legacy layout once for reports only, retaining the legacy key", () => {
    localStorage.setItem("meu-ted:report-blocks", JSON.stringify({ order: ["b"], hidden: ["a"] }));
    const home = renderHook(() => useBlockLayout(options("first", "home")));
    expect(home.result.current.visible).toEqual(["a", "b", "c"]);
    home.unmount();
    const reports = renderHook(() => useBlockLayout(options("first", "reports")));
    expect(reports.result.current.visible).toEqual(["b", "c"]);
    expect(localStorage.getItem("meu-ted:report-blocks")).not.toBeNull();
    reports.unmount();
    const second = renderHook(() => useBlockLayout(options("second", "reports")));
    expect(second.result.current.visible).toEqual(["a", "b", "c"]);
  });
  it("supports mode changes and explicit visibility overrides", () => {
    const { result } = renderHook(() => useBlockLayout(options("mode")));
    act(() => result.current.setMode("essential"));
    expect(result.current.visible).toEqual(["a", "b"]);
    act(() => result.current.toggle("c"));
    act(() => result.current.setMode("complete"));
    expect(result.current.visible).toEqual(["a", "b", "c"]);
  });
  it("does not throw for corrupt JSON or unavailable storage", () => {
    localStorage.setItem(layoutStorageKey(options("bad")), "{");
    expect(() => renderHook(() => useBlockLayout(options("bad")))).not.toThrow();
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    try { expect(() => renderHook(() => useBlockLayout(options("blocked")))).not.toThrow(); }
    finally { Storage.prototype.getItem = original; }
  });
});

describe("block reorder helpers", () => {
  it("moves with boundary and unknown-id handling", () => {
    expect(moveBlock(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveBlock(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveBlock(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveBlock(["a"], "missing", 1)).toEqual(["a"]);
  });
  it("reorders indices and leaves out-of-range input unchanged", () => {
    expect(reorderBlock(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderBlock(["a", "b"], -1, 1)).toEqual(["a", "b"]);
    expect(reorderBlock(["a", "b"], 0, 9)).toEqual(["a", "b"]);
  });
});

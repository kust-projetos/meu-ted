import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@/lib/test-utils";
import BottomSheet from "../ui/BottomSheet";

describe("BottomSheet virtual keyboard", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("caps height and lifts the sheet by the visual viewport inset, then removes listeners", () => {
    const viewport = new EventTarget() as VisualViewport;
    Object.defineProperties(viewport, {
      height: { configurable: true, value: 500 },
      offsetTop: { configurable: true, value: 0 },
    });
    const add = vi.spyOn(viewport, "addEventListener");
    const remove = vi.spyOn(viewport, "removeEventListener");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
      matches: true, media: "(pointer: coarse)", onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }) });
    const view = render(<BottomSheet open onClose={vi.fn()} title="Teste"><input /></BottomSheet>);
    const panel = screen.getByTestId("bottom-sheet-panel");
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect(panel.style.maxHeight).toBe("460px");
    expect(panel.style.translate).toBe(`0 -${window.innerHeight - 500}px`);
    view.unmount();
    expect(add).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(add).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("does not crash or set a viewport cap when visualViewport is unavailable", () => {
    Reflect.deleteProperty(window, "visualViewport");
    render(<BottomSheet open onClose={vi.fn()} title="Teste"><input /></BottomSheet>);
    const panel = screen.getByTestId("bottom-sheet-panel");
    expect(panel.style.maxHeight).toBe("");
    expect(panel.style.translate).toBe("");
  });
});

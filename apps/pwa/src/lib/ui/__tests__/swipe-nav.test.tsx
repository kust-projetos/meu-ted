import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@/lib/test-utils";
import { SheetProvider, useSheet } from "@/lib/sheet-context";
import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
  bodyScrollLockCount,
} from "../overlay-a11y";
import { SwipeNav, targetRouteForSwipe, shouldSwipeBack } from "../swipe-nav";

let mockPath = "/";
const pushMock = vi.fn();
const backMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, back: backMock }),
  usePathname: () => mockPath,
}));

let reduceMotion = false;

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches:
        query === "(prefers-reduced-motion: reduce)"
          ? reduceMotion
          : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => false,
    }),
  });
}

function setViewportWidth(px: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: px,
  });
}

function swipe(el: HTMLElement, fromX: number, toX: number) {
  fireEvent.touchStart(el, {
    touches: [{ identifier: 0, clientX: fromX, clientY: 200 }],
    changedTouches: [{ identifier: 0, clientX: fromX, clientY: 200 }],
  });
  fireEvent.touchEnd(el, {
    changedTouches: [{ identifier: 0, clientX: toX, clientY: 200 }],
  });
}

function renderSwipe(children?: React.ReactNode) {
  return render(
    <SwipeNav>
      <div data-testid="page">{children ?? "page"}</div>
    </SwipeNav>,
  );
}

describe("targetRouteForSwipe (pure)", () => {
  it("moves left=next and right=previous along the canonical BottomNav order", () => {
    expect(targetRouteForSwipe("/", -80)).toBe("/registros");
    expect(targetRouteForSwipe("/registros", -80)).toBe("/hub/patrimonio?aba=cartoes");
    expect(targetRouteForSwipe("/registros", 80)).toBe("/");
    expect(targetRouteForSwipe("/hub/patrimonio", 80, "?aba=cartoes")).toBe("/registros");
    expect(targetRouteForSwipe("/hub/patrimonio", -80, "?aba=cartoes")).toBe("/hub/relatorios");
    expect(targetRouteForSwipe("/hub/relatorios", 80)).toBe("/hub/patrimonio?aba=cartoes");
  });

  it("stays put at the ends of the order", () => {
    expect(targetRouteForSwipe("/", 80)).toBeNull();
    expect(targetRouteForSwipe("/hub/relatorios", -80)).toBeNull();
  });

  it("ignores non-root routes, non-cartoes patrimonio tabs, and missing pathnames", () => {
    expect(targetRouteForSwipe("/hub/patrimonio", -200, "?aba=contas")).toBeNull();
    expect(targetRouteForSwipe("/hub/planejamento", -200)).toBeNull();
    expect(targetRouteForSwipe(null, -200)).toBeNull();
  });
});

describe("shouldSwipeBack (pure, Onda 5)", () => {
  it("backs on right swipe in non-root subpages", () => {
    expect(shouldSwipeBack("/hub/patrimonio", 80, "?aba=contas")).toBe(true);
    expect(shouldSwipeBack("/hub/planejamento", 80)).toBe(true);
    expect(shouldSwipeBack("/hub/alertas", 200)).toBe(true);
    expect(shouldSwipeBack("/workspaces", 200)).toBe(true);
  });

  it("never backs on root routes (cyclic swipe stays intact)", () => {
    expect(shouldSwipeBack("/", 80)).toBe(false);
    expect(shouldSwipeBack("/registros", 80)).toBe(false);
    expect(shouldSwipeBack("/hub/patrimonio", 200, "?aba=cartoes")).toBe(false);
    expect(shouldSwipeBack("/hub/relatorios", 200)).toBe(false);
  });

  it("ignores left swipes and missing pathnames", () => {
    expect(shouldSwipeBack("/hub/planejamento", -200)).toBe(false);
    expect(shouldSwipeBack("/hub/planejamento", 0)).toBe(false);
    expect(shouldSwipeBack(null, 200)).toBe(false);
  });
});

describe("SwipeNav gestures (v2 F1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPath = "/";
    pushMock.mockClear();
    backMock.mockClear();
    reduceMotion = false;
    installMatchMedia();
    setViewportWidth(390);
    window.history.replaceState({}, "", "/");
    while (bodyScrollLockCount() > 0) releaseBodyScrollLock();
  });

  afterEach(() => {
    while (bodyScrollLockCount() > 0) releaseBodyScrollLock();
  });

  it("swipe left on / navigates to /registros", () => {
    renderSwipe();
    swipe(screen.getByTestId("page"), 300, 150);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/registros");
  });

  it("swipe right on /registros navigates back to /", () => {
    mockPath = "/registros";
    renderSwipe();
    swipe(screen.getByTestId("page"), 100, 260);
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("swipe left on /registros navigates to /hub/patrimonio?aba=cartoes", () => {
    mockPath = "/registros";
    renderSwipe();
    swipe(screen.getByTestId("page"), 300, 150);
    expect(pushMock).toHaveBeenCalledWith("/hub/patrimonio?aba=cartoes");
  });

  it("supports horizontal mouse pointer drag on mobile viewports (<860px)", () => {
    renderSwipe();
    const el = screen.getByTestId("page");
    fireEvent.pointerDown(el, { pointerType: "mouse", button: 0, pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(el, { pointerType: "mouse", button: 0, pointerId: 1, clientX: 120, clientY: 200 });
    expect(pushMock).toHaveBeenCalledWith("/registros");
  });

  it("ignores pointer drag inside inputs or textareas", () => {
    render(
      <SwipeNav>
        <input data-testid="text-field" defaultValue="abc" />
      </SwipeNav>,
    );
    const input = screen.getByTestId("text-field");
    fireEvent.pointerDown(input, { pointerType: "mouse", button: 0, pointerId: 2, clientX: 250, clientY: 200 });
    fireEvent.pointerUp(input, { pointerType: "mouse", button: 0, pointerId: 2, clientX: 80, clientY: 200 });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores swipes below the distance threshold", () => {
    renderSwipe();
    swipe(screen.getByTestId("page"), 200, 160);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores vertically-dominant gestures", () => {
    renderSwipe();
    const el = screen.getByTestId("page");
    fireEvent.touchStart(el, {
      touches: [{ identifier: 0, clientX: 200, clientY: 100 }],
      changedTouches: [{ identifier: 0, clientX: 200, clientY: 100 }],
    });
    fireEvent.touchEnd(el, {
      changedTouches: [{ identifier: 0, clientX: 120, clientY: 400 }],
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores gestures starting inside [data-no-swipe]", () => {
    render(
      <SwipeNav>
        <div data-testid="carousel" data-no-swipe>
          carousel
        </div>
      </SwipeNav>,
    );
    swipe(screen.getByTestId("carousel"), 300, 100);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores gestures starting inside a horizontal scroller", () => {
    render(
      <SwipeNav>
        <div data-testid="chips" style={{ overflowX: "auto" }}>
          chips
        </div>
      </SwipeNav>,
    );
    const chips = screen.getByTestId("chips");
    Object.defineProperty(chips, "scrollWidth", { configurable: true, value: 600 });
    Object.defineProperty(chips, "clientWidth", { configurable: true, value: 300 });
    swipe(chips, 300, 100);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores gestures starting in a nested child of a horizontal scroller", () => {
    render(
      <SwipeNav>
        <div data-testid="chips" style={{ overflowX: "auto" }}>
          <span data-testid="chip">chip</span>
        </div>
      </SwipeNav>,
    );
    const chips = screen.getByTestId("chips");
    Object.defineProperty(chips, "scrollWidth", { configurable: true, value: 600 });
    Object.defineProperty(chips, "clientWidth", { configurable: true, value: 300 });
    swipe(screen.getByTestId("chip"), 300, 100);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not mistake a vertical scroller for a horizontal zone", () => {
    render(
      <SwipeNav>
        <div data-testid="list" style={{ overflowY: "auto" }}>
          list
        </div>
      </SwipeNav>,
    );
    const list = screen.getByTestId("list");
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 600 });
    swipe(list, 300, 100);
    expect(pushMock).toHaveBeenCalledWith("/registros");
  });

  it("does not navigate while an overlay is open", () => {
    renderSwipe();
    act(() => acquireBodyScrollLock());
    swipe(screen.getByTestId("page"), 300, 100);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not navigate while a transaction sheet is open", () => {
    function SheetOpener() {
      const { openSheet } = useSheet();
      return (
        <button type="button" onClick={() => openSheet("expense")}>
          open sheet
        </button>
      );
    }
    render(
      <SheetProvider>
        <SwipeNav>
          <div data-testid="page">page</div>
        </SwipeNav>
        <SheetOpener />
      </SheetProvider>,
    );
    fireEvent.click(screen.getByText("open sheet"));
    swipe(screen.getByTestId("page"), 300, 100);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not navigate left off non-root subpages", () => {
    mockPath = "/hub/planejamento";
    renderSwipe();
    swipe(screen.getByTestId("page"), 300, 100);
    expect(pushMock).not.toHaveBeenCalled();
    expect(backMock).not.toHaveBeenCalled();
  });

  it("is inactive on desktop viewports (>=860px)", () => {
    setViewportWidth(1280);
    renderSwipe();
    swipe(screen.getByTestId("page"), 300, 100);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("navigates instantly under reduced motion but skips the entry animation", () => {
    reduceMotion = true;
    const animateSpy = vi.fn();
    window.HTMLElement.prototype.animate = animateSpy as unknown as typeof window.HTMLElement.prototype.animate;
    mockPath = "/";
    const view = renderSwipe();
    swipe(screen.getByTestId("page"), 300, 100);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/registros");

    mockPath = "/registros";
    view.rerender(
      <SwipeNav>
        <div data-testid="page">page</div>
      </SwipeNav>,
    );
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("skips the entry animation for non-gesture navigation under reduced motion", () => {
    reduceMotion = true;
    const animateSpy = vi.fn();
    window.HTMLElement.prototype.animate = animateSpy as unknown as typeof window.HTMLElement.prototype.animate;
    mockPath = "/";
    const view = renderSwipe();

    mockPath = "/registros";
    view.rerender(
      <SwipeNav>
        <div data-testid="page">page</div>
      </SwipeNav>,
    );
    expect(pushMock).not.toHaveBeenCalled();
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("plays the entry animation on route change when motion is allowed", () => {
    const animateSpy = vi.fn();
    window.HTMLElement.prototype.animate = animateSpy as unknown as typeof window.HTMLElement.prototype.animate;
    mockPath = "/";
    const view = renderSwipe();
    expect(animateSpy).not.toHaveBeenCalled();

    mockPath = "/registros";
    view.rerender(
      <SwipeNav>
        <div data-testid="page">page</div>
      </SwipeNav>,
    );
    expect(animateSpy).toHaveBeenCalledTimes(1);
  });

  describe("swipe-back on Hub and child subpages (Onda 5)", () => {
    it("swipe right on /hub/patrimonio?aba=contas goes back exactly once (no push)", () => {
      mockPath = "/hub/patrimonio";
      window.history.replaceState({}, "", "/hub/patrimonio?aba=contas");
      renderSwipe();
      swipe(screen.getByTestId("page"), 100, 260);
      expect(backMock).toHaveBeenCalledTimes(1);
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("swipe right on /hub/planejamento goes back", () => {
      mockPath = "/hub/planejamento";
      renderSwipe();
      swipe(screen.getByTestId("page"), 80, 300);
      expect(backMock).toHaveBeenCalledTimes(1);
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("swipe right on / (root edge) does not go back", () => {
      mockPath = "/";
      renderSwipe();
      swipe(screen.getByTestId("page"), 100, 260);
      expect(backMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("ignores short right swipes on subpages (threshold applies)", () => {
      mockPath = "/hub/planejamento";
      renderSwipe();
      swipe(screen.getByTestId("page"), 200, 160);
      expect(backMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("does not go back while an overlay is open", () => {
      mockPath = "/hub/planejamento";
      renderSwipe();
      act(() => acquireBodyScrollLock());
      swipe(screen.getByTestId("page"), 100, 260);
      expect(backMock).not.toHaveBeenCalled();
    });

    it("does not go back from [data-no-swipe] zones", () => {
      mockPath = "/hub/planejamento";
      render(
        <SwipeNav>
          <div data-testid="carousel" data-no-swipe>
            carousel
          </div>
        </SwipeNav>,
      );
      swipe(screen.getByTestId("carousel"), 100, 300);
      expect(backMock).not.toHaveBeenCalled();
    });

    it("does not go back on desktop viewports (>=860px)", () => {
      mockPath = "/hub/categorias";
      setViewportWidth(1280);
      renderSwipe();
      swipe(screen.getByTestId("page"), 100, 260);
      expect(backMock).not.toHaveBeenCalled();
    });

    it("plays no entry animation when arriving via swipe-back", () => {
      const animateSpy = vi.fn();
      window.HTMLElement.prototype.animate = animateSpy as unknown as typeof window.HTMLElement.prototype.animate;
      mockPath = "/workspaces";
      const view = renderSwipe();
      swipe(screen.getByTestId("page"), 100, 260);
      expect(backMock).toHaveBeenCalledTimes(1);

      mockPath = "/";
      view.rerender(
        <SwipeNav>
          <div data-testid="page">page</div>
        </SwipeNav>,
      );
      expect(animateSpy).not.toHaveBeenCalled();
    });

    it("goes back instantly under reduced motion (no animation by construction)", () => {
      reduceMotion = true;
      const animateSpy = vi.fn();
      window.HTMLElement.prototype.animate = animateSpy as unknown as typeof window.HTMLElement.prototype.animate;
      mockPath = "/hub/alertas";
      const view = renderSwipe();
      swipe(screen.getByTestId("page"), 100, 260);
      expect(backMock).toHaveBeenCalledTimes(1);

      mockPath = "/";
      view.rerender(
        <SwipeNav>
          <div data-testid="page">page</div>
        </SwipeNav>,
      );
      expect(animateSpy).not.toHaveBeenCalled();
    });
  });
});

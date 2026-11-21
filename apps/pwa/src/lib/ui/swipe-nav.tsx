"use client";

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useIsOverlayOpen } from "./overlay-a11y";
import { useSheet } from "@/lib/sheet-context";

/**
 * F1 — swipe horizontal entre as telas raiz da IA canônica
 * (Início ↔ Extrato ↔ Cartões ↔ Relatórios).
 *
 * Sem scroll-snap pager (preserva fetch por rota, deep-link e SW precache).
 * Suporta toque em qualquer dispositivo mobile (< 860px) e arraste com
 * ponteiro em viewports estreitos (incluindo WebViews/desktop estreito).
 * Nenhum `preventDefault()` é chamado durante o gesto para preservar 100%
 * a rolagem vertical nativa.
 */

export const SWIPE_ROUTES = [
  "/",
  "/registros",
  "/hub/patrimonio?aba=cartoes",
  "/hub/relatorios",
] as const;

const SWIPE_LABELS: Record<string, string> = {
  "/": "Início",
  "/registros": "Extrato",
  "/hub/patrimonio?aba=cartoes": "Cartões",
  "/hub/relatorios": "Relatórios",
};

export const SWIPE_THRESHOLD_PX = 56;
export const SWIPE_MIN_VELOCITY_PX_MS = 0.22;
export const SWIPE_LONG_DRAG_PX = 110;
export const SWIPE_DOMINANCE_RATIO = 1.2;
export const SWIPE_DESKTOP_BREAKPOINT_PX = 860;
export const SWIPE_ENTER_ANIMATION_MS = 260;

/**
 * Resolve o índice da rota atual na ordem horizontal da BottomNav.
 * `/hub/patrimonio` conta como a aba Cartões somente quando `?aba=cartoes`
 * (ou sem parâmetro `aba`); outras abas como `contas` ou `patrimonio` são
 * tratadas como subpáginas e suportam swipe-back para a direita.
 */
export function resolveSwipeRootIndex(
  pathname: string | null | undefined,
  search = "",
): number {
  if (!pathname) return -1;
  if (pathname === "/") return 0;
  if (pathname === "/registros") return 1;
  if (pathname === "/hub/relatorios") return 3;
  if (pathname === "/hub/patrimonio") {
    const cleanSearch = search.startsWith("?") ? search.slice(1) : search;
    const aba = cleanSearch ? new URLSearchParams(cleanSearch).get("aba") : null;
    if (aba === null || aba === "cartoes") return 2;
    return -1;
  }
  return -1;
}

/** Destino do swipe dado o pathname atual e o deslocamento horizontal. */
export function targetRouteForSwipe(
  pathname: string | null | undefined,
  dx: number,
  search = "",
): string | null {
  if (!pathname) return null;
  const idx = resolveSwipeRootIndex(pathname, search);
  if (idx < 0) return null;
  if (dx < 0 && idx < SWIPE_ROUTES.length - 1) return SWIPE_ROUTES[idx + 1]!;
  if (dx > 0 && idx > 0) return SWIPE_ROUTES[idx - 1]!;
  return null;
}

/**
 * Onda 5 — volta por gesto nas subpáginas: em rota NÃO-raiz, um gesto
 * horizontal dominante para a DIREITA (dx positivo) volta uma entrada no
 * histórico. Rotas raiz nunca voltam por aqui e gesto para a esquerda em
 * subpágina não faz nada.
 */
export function shouldSwipeBack(
  pathname: string | null | undefined,
  dx: number,
  search = "",
): boolean {
  if (!pathname) return false;
  if (dx <= 0) return false;
  return resolveSwipeRootIndex(pathname, search) < 0;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function wideViewport(): boolean {
  if (typeof window === "undefined") return true;
  return window.innerWidth >= SWIPE_DESKTOP_BREAKPOINT_PX;
}

function currentSearch(): string {
  return typeof window !== "undefined" ? window.location.search : "";
}

/** Easing do token de design, com fallback idêntico para jsdom/SSR. */
function enterEasing(el: HTMLElement): string {
  const token =
    typeof window !== "undefined" && typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(el).getPropertyValue("--easing-standard").trim()
      : "";
  return token || "cubic-bezier(.2,.8,.2,1)";
}

/**
 * True quando o gesto nasce numa zona de rolagem horizontal ou elemento
 * interativo de texto/controle (evita conflitar com inputs, textareas,
 * carrosséis e trilhas de chips).
 */
export function startsInHorizontalZone(
  el: HTMLElement | null,
  root: HTMLElement | null,
): boolean {
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    if (node.nodeType === 1) {
      const tag = node.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      if (
        node.isContentEditable ||
        node.getAttribute?.("contenteditable") === "true"
      ) {
        return true;
      }
      if (typeof node.hasAttribute === "function" && node.hasAttribute("data-no-swipe"))
        return true;
      const overflowX =
        window.getComputedStyle(node).overflowX || node.style.overflowX;
      if (
        (overflowX === "auto" || overflowX === "scroll") &&
        node.scrollWidth > node.clientWidth + 1
      )
        return true;
    }
    node = node.parentElement;
  }
  return false;
}

interface GestureMark {
  x: number;
  y: number;
  t: number;
  el: HTMLElement | null;
  kind: "touch" | "pointer";
  pointerId?: number;
}

interface SwipeHint {
  direction: "left" | "right";
  label: string;
}

export function SwipeNav({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const overlayOpen = useIsOverlayOpen();
  const { sheetKind } = useSheet();
  const wrapRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<GestureMark | null>(null);
  const suppressNextClickRef = useRef(false);
  const directionRef = useRef<1 | -1>(1);
  const mountedRef = useRef(false);
  const animateArrivalRef = useRef(true);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  const [swipeHint, setSwipeHint] = useState<SwipeHint | null>(null);

  const stateRef = useRef({ overlayOpen, sheetKind, pathname });
  useEffect(() => {
    stateRef.current = { overlayOpen, sheetKind, pathname };
  });

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const animateArrival = animateArrivalRef.current;
    animateArrivalRef.current = true;
    if (!animateArrival || prefersReducedMotion()) return;
    const el = wrapRef.current;
    if (!el) return;
    const animate = el.animate?.bind(el);
    if (!animate) return;
    const fromX = directionRef.current < 0 ? "16px" : "-16px";
    animate(
      [
        { opacity: 0, transform: `translateX(${fromX})` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      {
        duration: SWIPE_ENTER_ANIMATION_MS,
        easing: enterEasing(el),
      },
    );
  }, [pathname]);

  function resetVisualDrag() {
    setDragOffsetPx(0);
    setSwipeHint(null);
  }

  function updateVisualDrag(dx: number, dy: number, startEl: HTMLElement | null) {
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx <= 18 || absDx <= absDy * SWIPE_DOMINANCE_RATIO) {
      resetVisualDrag();
      return;
    }
    const { overlayOpen: locked, sheetKind: sheet, pathname: path } = stateRef.current;
    if (locked || sheet !== null || wideViewport()) {
      resetVisualDrag();
      return;
    }
    if (startsInHorizontalZone(startEl, wrapRef.current)) {
      resetVisualDrag();
      return;
    }
    const search = currentSearch();
    const dest = targetRouteForSwipe(path, dx, search);
    const back = !dest && shouldSwipeBack(path, dx, search);
    if (!dest && !back) {
      resetVisualDrag();
      return;
    }
    if (!prefersReducedMotion()) {
      setDragOffsetPx(Math.sign(dx) * Math.min(26, (absDx - 18) * 0.24));
    }
    setSwipeHint({
      direction: dx < 0 ? "left" : "right",
      label: dest ? (SWIPE_LABELS[dest] ?? "Avançar") : "Voltar",
    });
  }

  function finishGesture(endX: number, endY: number, start: GestureMark): boolean {
    resetVisualDrag();
    if (startsInHorizontalZone(start.el, wrapRef.current)) return false;
    const { overlayOpen: locked, sheetKind: sheet, pathname: path } = stateRef.current;
    if (locked || sheet !== null || wideViewport()) return false;

    const dx = endX - start.x;
    const dy = endY - start.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx < SWIPE_THRESHOLD_PX) return false;
    if (absDx <= absDy * SWIPE_DOMINANCE_RATIO) return false;
    const velocity = absDx / Math.max(1, performance.now() - start.t);
    if (absDx < SWIPE_LONG_DRAG_PX && velocity < SWIPE_MIN_VELOCITY_PX_MS)
      return false;

    const search = currentSearch();
    const dest = targetRouteForSwipe(path, dx, search);
    if (dest) {
      directionRef.current = dx < 0 ? 1 : -1;
      animateArrivalRef.current = !prefersReducedMotion();
      router.push(dest);
      return true;
    }
    if (shouldSwipeBack(path, dx, search)) {
      animateArrivalRef.current = false;
      router.back();
      return true;
    }
    return false;
  }

  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    if (e.touches.length > 1) {
      gestureRef.current = null;
      resetVisualDrag();
      return;
    }
    const t = e.changedTouches[0];
    if (!t) return;
    gestureRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: performance.now(),
      el: e.target as HTMLElement | null,
      kind: "touch",
    };
  }

  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    const start = gestureRef.current;
    if (!start || start.kind !== "touch") return;
    const t = e.changedTouches[0];
    if (!t) return;
    updateVisualDrag(t.clientX - start.x, t.clientY - start.y, start.el);
  }

  function onTouchEnd(e: TouchEvent<HTMLDivElement>) {
    const start = gestureRef.current;
    if (!start || start.kind !== "touch") return;
    gestureRef.current = null;
    const t = e.changedTouches[0];
    if (!t) {
      resetVisualDrag();
      return;
    }
    finishGesture(t.clientX, t.clientY, start);
  }

  function onTouchCancel() {
    if (gestureRef.current?.kind === "touch") {
      gestureRef.current = null;
      resetVisualDrag();
    }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "mouse" || e.button !== 0 || wideViewport()) return;
    gestureRef.current = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      el: e.target as HTMLElement | null,
      kind: "pointer",
      pointerId: e.pointerId,
    };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = gestureRef.current;
    if (!start || start.kind !== "pointer" || start.pointerId !== e.pointerId) return;
    updateVisualDrag(e.clientX - start.x, e.clientY - start.y, start.el);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const start = gestureRef.current;
    if (!start || start.kind !== "pointer" || start.pointerId !== e.pointerId) return;
    gestureRef.current = null;
    const selectedText = typeof window !== "undefined" ? window.getSelection()?.toString() : "";
    if (selectedText && selectedText.length > 0) {
      resetVisualDrag();
      return;
    }
    const navigated = finishGesture(e.clientX, e.clientY, start);
    if (navigated) {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 200);
    }
  }

  function onPointerCancel() {
    if (gestureRef.current?.kind === "pointer") {
      gestureRef.current = null;
      resetVisualDrag();
    }
  }

  function onClickCapture(e: ReactMouseEvent<HTMLDivElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  return (
    <div
      ref={wrapRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
      style={
        dragOffsetPx !== 0
          ? { transform: `translateX(${dragOffsetPx}px)`, transition: "none" }
          : undefined
      }
      className="relative"
    >
      {swipeHint && (
        <div
          aria-hidden="true"
          className={`pointer-events-none fixed top-1/2 z-50 -translate-y-1/2 rounded-full border border-border-medium bg-surface-1/95 px-3 py-1.5 text-xs font-bold text-primary shadow-elevated backdrop-blur-md ${
            swipeHint.direction === "left" ? "right-3" : "left-3"
          }`}
        >
          {swipeHint.direction === "left"
            ? `${swipeHint.label} →`
            : `← ${swipeHint.label}`}
        </div>
      )}
      {children}
    </div>
  );
}

export default SwipeNav;

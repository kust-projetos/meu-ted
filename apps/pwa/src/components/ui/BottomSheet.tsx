"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { X } from "lucide-react";
import {
  OVERLAY_Z_INDEX,
  prefersReducedMotion,
  useBodyScrollLock,
  useOverlayDialog,
} from "@/lib/ui/overlay-a11y";

/** Arrastar o cabeçalho mais que isso para baixo fecha a sheet. */
export const SHEET_DRAG_DISMISS_PX = 90;

/** Duração da animação de saída (translateY 100%, Onda 4). */
export const SHEET_EXIT_MS = 200;

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  onBeforeClose?: () => boolean;
  title: string;
  children: ReactNode;
  className?: string;
}

export function BottomSheet({
  open,
  onClose,
  onBeforeClose,
  title,
  children,
  className = "",
}: BottomSheetProps) {
  /* A sheet permanece montada durante a animação de saída: `rendered`
   * controla a presença no DOM e `leaving` aplica o translateY(100%).
   * O scroll lock acompanha `rendered` para cobrir a saída. */
  const [rendered, setRendered] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  const onBeforeCloseRef = useRef(onBeforeClose);
  useBodyScrollLock(rendered);
  const containerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; dy: number } | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    onBeforeCloseRef.current = onBeforeClose;
  }, [onBeforeClose]);

  const clearExitTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearExitTimer(), [clearExitTimer]);

  /* Fecha interno (botão/overlay/Escape/drag): anima a saída
   * translateY(100%) em SHEET_EXIT_MS com var(--easing-standard) ANTES de
   * chamar onClose de fato; instantâneo sob prefers-reduced-motion. */
  const requestClose = useCallback(() => {
    if (leavingRef.current) return;
    if (onBeforeCloseRef.current && !onBeforeCloseRef.current()) return;
    if (prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    leavingRef.current = true;
    setLeaving(true);
    const el = sheetRef.current;
    if (el) {
      // Mata a animação de entrada (CSS animations vencem inline styles:
      // fechar nos primeiros 280ms manteria o sheetUp e suprimiria a saída).
      el.style.animation = "none";
      el.style.transition = `transform ${SHEET_EXIT_MS}ms var(--easing-standard)`;
      el.style.transform = "translateY(100%)";
    }
    clearExitTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onCloseRef.current();
    }, SHEET_EXIT_MS);
  }, [clearExitTimer]);

  /* SPEC §21 (H2): foco inicial no primeiro focalizável (botão fechar),
   * trap de Tab, restore ao fechar e inert no fundo — primitiva compartilhada.
   * `rendered` cobre a animação de saída (mesmo ciclo do scroll lock). */
  useOverlayDialog(containerRef, { open: rendered, onEscape: requestClose });

  useEffect(() => {
    const panel = sheetRef.current;
    const viewport = window.visualViewport;
    if (!rendered || !panel || !viewport) return;
    const updateViewport = () => {
      const inset = Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop));
      const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      if (inset > 80 && coarse) {
        panel.style.maxHeight = `${Math.min(0.92 * viewport.height, viewport.height - 8)}px`;
        panel.style.translate = `0 ${-inset}px`;
        if (!prefersReducedMotion()) panel.style.transition = "translate 150ms ease-out";
      } else {
        panel.style.maxHeight = "";
        panel.style.translate = "";
        if (panel.style.transition === "translate 150ms ease-out") panel.style.transition = "";
      }
    };
    const focusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !panel.contains(target)) return;
      requestAnimationFrame(() => {
        if (!panel.contains(target)) return;
        const box = target.getBoundingClientRect();
        const parent = panel.getBoundingClientRect();
        if (box.top < parent.top || box.bottom > parent.bottom) {
          target.scrollIntoView({ block: "center" });
        }
      });
    };
    updateViewport();
    viewport.addEventListener("resize", updateViewport);
    viewport.addEventListener("scroll", updateViewport);
    panel.addEventListener("focusin", focusIn);
    return () => {
      viewport.removeEventListener("resize", updateViewport);
      viewport.removeEventListener("scroll", updateViewport);
      panel.removeEventListener("focusin", focusIn);
      panel.style.maxHeight = "";
      panel.style.translate = "";
      if (panel.style.transition === "translate 150ms ease-out") panel.style.transition = "";
    };
  }, [rendered]);

  /* Fechamento vindo do pai (open true->false): se a saída já foi animada
   * via requestClose, desmonta direto; senão anima antes de desmontar.
   * Reabertura no meio da saída cancela o timer e restaura a posição. */
  /* eslint-disable react-hooks/set-state-in-effect -- delayed-unmount da
   * animação de saída: transições de `open` precisam armar/cancelar o estado
   * de saída de forma síncrona (mesmo padrão do Dialog mounted). */
  useEffect(() => {
    if (open) {
      clearExitTimer();
      leavingRef.current = false;
      setLeaving(false);
      setRendered(true);
      const el = sheetRef.current;
      if (el) {
        el.style.transform = "";
        el.style.transition = "";
        el.style.animation = "";
      }
      return;
    }
    if (!rendered) return;
    if (leavingRef.current) {
      leavingRef.current = false;
      setLeaving(false);
      setRendered(false);
      return;
    }
    if (prefersReducedMotion()) {
      setRendered(false);
      return;
    }
    leavingRef.current = true;
    setLeaving(true);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      leavingRef.current = false;
      setLeaving(false);
      setRendered(false);
    }, SHEET_EXIT_MS);
  }, [open, rendered, clearExitTimer]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* Drag-to-dismiss no cabeçalho (spec AGY Onda 2/3 §4.2): só o header é
   * zona de arraste (touch-none) para não sequestrar a rolagem do conteúdo.
   * Segue o dedo sem transição; ao soltar, >90px fecha, senão retorna com
   * 200ms (instantâneo sob reduced-motion, que mantém o dismiss). */
  function resetSheetTransform() {
    const el = sheetRef.current;
    if (el) {
      el.style.transform = "";
      el.style.transition = "";
    }
  }

  function onDragStart(e: ReactTouchEvent<HTMLDivElement>) {
    if (leavingRef.current) return;
    if (e.touches.length > 1) return;
    const t = e.touches[0];
    if (!t) return;
    dragRef.current = { y: t.clientY, dy: 0 };
    const el = sheetRef.current;
    if (el) el.style.transition = "none";
  }

  function onDragMove(e: ReactTouchEvent<HTMLDivElement>) {
    if (leavingRef.current) return;
    const drag = dragRef.current;
    if (!drag) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - drag.y;
    if (dy <= 0) return;
    drag.dy = dy;
    if (!prefersReducedMotion()) {
      const el = sheetRef.current;
      if (el) el.style.transform = `translateY(${dy}px)`;
    }
  }

  function onDragEnd() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (leavingRef.current) return;
    /* Dismiss: NÃO zera o transform (causava fechamento abrupto sem curva
     * de saída); requestClose anima de onde o dedo está até 100%. */
    if (drag && drag.dy > SHEET_DRAG_DISMISS_PX) {
      requestClose();
      return;
    }
    const el = sheetRef.current;
    if (el) {
      el.style.transition = prefersReducedMotion()
        ? ""
        : "transform 200ms var(--easing-standard)";
      el.style.transform = "";
    }
  }

  function onDragCancel() {
    dragRef.current = null;
    if (leavingRef.current) return;
    resetSheetTransform();
  }

  if (!rendered) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0"
      style={{ zIndex: OVERLAY_Z_INDEX.sheet }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs animate-fade-in transition-opacity"
        onClick={requestClose}
      />

      {/* Sheet container: S3 surface + elevated top edge (item premium 2).
          Durante leaving a animação de entrada é removida (classe +
          animation:none inline) para o translateY(100%) da saída sempre
          prevalecer, mesmo fechando nos primeiros 280ms. */}
      <div
        ref={sheetRef}
        data-testid="bottom-sheet-panel"
        className={`fixed bottom-0 left-0 right-0 z-50 flex max-h-[92dvh] flex-col overflow-y-auto rounded-t-[26px] border-t border-border-strong bg-surface-3 shadow-sheet ${leaving ? "" : "animate-sheet-up "}${className}`}
        style={{
          padding: "20px 20px calc(32px + env(safe-area-inset-bottom))",
          ...(leaving
            ? {
                animation: "none",
                transform: "translateY(100%)",
                transition: `transform ${SHEET_EXIT_MS}ms var(--easing-standard)`,
              }
            : undefined),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Zona de arraste: drag handle + cabeçalho */}
        <div
          data-testid="bottom-sheet-drag"
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
          onTouchCancel={onDragCancel}
          className="cursor-grab touch-none select-none active:cursor-grabbing"
        >
          {/* Drag handle */}
          <div className="mx-auto mb-4 h-1 w-10 flex-none rounded-full bg-border-strong/60" />

          {/* Header */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="flex-1 text-[17px] font-bold text-text-primary">
              {title}
            </h2>
            <button
              type="button"
              onClick={requestClose}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-surface-2 text-text-muted transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              aria-label="Fechar"
            >
              <X size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>

        {/* Content */}
        {children}
      </div>
    </div>
  );
}

export default BottomSheet;

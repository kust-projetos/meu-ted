"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock, useOverlayDialog } from "@/lib/ui/overlay-a11y";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className = "",
}: DialogProps) {
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Lock body scroll while open (ref-counted across stacked overlays)
  useBodyScrollLock(open);

  /* SPEC §21 (H2): foco inicial, trap de Tab, restore ao fechar, Escape
   * (topmost) e inert no fundo via primitiva compartilhada. `mounted` é
   * necessário porque o portal só existe após a montagem. */
  useOverlayDialog(containerRef, { open: open && mounted, onEscape: onClose });

  if (!mounted || !open) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "dialog-title" : undefined}
      aria-describedby={description ? "dialog-description" : undefined}
    >
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs animate-fade-in transition-opacity"
        onClick={onClose}
      />

      {/* Dialog Box */}
      <div
        className={`relative z-10 w-full max-w-md overflow-hidden rounded-[20px] border border-border-strong bg-surface-3 p-6 shadow-elevated transition-all ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            {title && (
              <h2
                id="dialog-title"
                className="text-[17px] font-bold text-text-primary"
              >
                {title}
              </h2>
            )}
            {description && (
              <p
                id="dialog-description"
                className="mt-1 text-[13px] text-text-muted"
              >
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-surface-2 text-text-muted transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="mt-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export default Dialog;

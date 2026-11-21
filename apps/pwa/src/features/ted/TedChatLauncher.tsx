"use client";

import { useEffect } from "react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useIsOverlayOpen } from "@/lib/ui/overlay-a11y";

/**
 * Public open channel for the TED chat (mirrors the `pwa:open-tx`
 * convention in AppShell). Any surface — e.g. the empty Insights card —
 * navigates to the dedicated `/ted` page via `openTedChat()`; the launcher
 * owns the listener, so there is a single source of truth, no parallel event.
 *
 * T5.3 (SPEC §22): `openTedChat({ operationId })` deep-links the page chat
 * to ONE pending operation via `/ted?operationId=…`. The id is display
 * routing only — the Decision Service inside the chat still owns
 * confirm/cancel/retry.
 */
export const OPEN_TED_CHAT_EVENT = "pwa:open-ted";

export type OpenTedChatOptions = Readonly<{
  /** Authoritative pending-operation id to focus once the chat page opens. */
  operationId?: string;
}>;

type OpenTedChatDetail = OpenTedChatOptions | undefined;

export function openTedChat(options?: OpenTedChatOptions): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<OpenTedChatDetail>(OPEN_TED_CHAT_EVENT, { detail: options }));
  }
}

function readFocusedOperationId(event: Event): string | null {
  const detail = (event as CustomEvent<OpenTedChatDetail>).detail;
  return typeof detail?.operationId === "string" && detail.operationId.length > 0
    ? detail.operationId
    : null;
}

export function TedChatLauncher() {
  const router = useRouter();
  const pathname = usePathname();
  // A1: hide the FAB while any overlay (sheet/dialog/confirm) is open so it
  // never renders above — or below but visually clashing with — overlay
  // content.
  const overlayOpen = useIsOverlayOpen();

  useEffect(() => {
    function handler(event: Event) {
      const operationId = readFocusedOperationId(event);
      router.push(
        operationId ? `/ted?operationId=${encodeURIComponent(operationId)}` : "/ted",
      );
    }
    window.addEventListener(OPEN_TED_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_TED_CHAT_EVENT, handler);
  }, [router]);

  const hideLauncher = overlayOpen;
  const onTedPage = pathname === "/ted";

  const handleFabOpen = () => {
    try {
      if (typeof window !== "undefined") {
        const search = window.location.search ?? "";
        window.sessionStorage.setItem("meu-ted:ted-origin", `${pathname ?? "/"}${search}`);
      }
    } catch {
      /* storage indisponível */
    }
    router.push("/ted");
  };

  // No early return before hooks: compute the flag above, render null here.
  if (onTedPage) return null;

  return (
    <button
      type="button"
      onClick={handleFabOpen}
      aria-label="Abrir assistente TED"
      tabIndex={hideLauncher ? -1 : undefined}
      data-overlay-restore-fallback
      className={`group fixed bottom-[88px] right-4 z-40 flex h-14 w-14 min-w-14 items-center justify-center overflow-hidden rounded-full bg-surface-1/90 p-0.5 shadow-elevated ring-2 ring-primary/35 backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:shadow-modal focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/30 active:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0 lg:bottom-6 lg:right-6 ${hideLauncher ? "pointer-events-none opacity-0" : ""}`}
    >
      <Image
        src="/brand/ted-launcher.png"
        alt=""
        width={52}
        height={52}
        priority
        className="h-full w-full rounded-full object-cover transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
      />
    </button>
  );
}

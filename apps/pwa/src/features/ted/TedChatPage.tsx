"use client";

import { useSearchParams } from "next/navigation";
import { TedChat } from "./TedChat";

/**
 * Dedicated TED page content (client): reads `?operationId=` and routes it
 * as `focusedOperationId` into the page-bound chat (display routing only —
 * the Decision Service still owns every decision).
 *
 * Layout: the wrapper bounds the chat to the AppShell content area ABOVE
 * the fixed mobile BottomNav (`--tab-bar-height: 72px` + safe-area), so the
 * message list scrolls internally with no double scrollbar and no overlap.
 * On lg the BottomNav is hidden (`lg:hidden`) and the chat fills the
 * desktop content height instead.
 */
export function TedChatPage() {
  const searchParams = useSearchParams();
  const operationId = searchParams.get("operationId");
  const focusedOperationId = operationId && operationId.length > 0 ? operationId : null;

  return (
    <main className="flex flex-col px-4 pt-4 pb-[calc(var(--tab-bar-height)+env(safe-area-inset-bottom))] lg:px-6 lg:py-6 lg:pb-6">
      {/* No rigid pixel min-height: on short/landscape viewports it would
          exceed the space above the fixed BottomNav (external scrollbar,
          composer offscreen). The dvh calc alone bounds the chat. */}
      <div className="h-[calc(100dvh-var(--tab-bar-height)-env(safe-area-inset-bottom)-2rem)] lg:h-[calc(100dvh-3rem)]">
        <TedChat focusedOperationId={focusedOperationId} />
      </div>
    </main>
  );
}

export default TedChatPage;

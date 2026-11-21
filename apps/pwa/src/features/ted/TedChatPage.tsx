"use client";

import { TedChat } from "./TedChat";

/**
 * Página dedicada do TED (cliente). O chat ocupa a área de conteúdo acima da
 * BottomNav fixa (`--tab-bar-height: 72px` + safe-area), com rolagem interna
 * e sem barra dupla. No desktop a BottomNav é oculta e o chat preenche a
 * altura disponível.
 */
export function TedChatPage() {
  return (
    <main className="flex flex-col px-4 pt-4 pb-[calc(var(--tab-bar-height)+env(safe-area-inset-bottom))] lg:px-6 lg:py-6 lg:pb-6">
      <div className="h-[calc(100dvh-var(--tab-bar-height)-env(safe-area-inset-bottom)-2rem)] lg:h-[calc(100dvh-3rem)]">
        <TedChat />
      </div>
    </main>
  );
}

export default TedChatPage;

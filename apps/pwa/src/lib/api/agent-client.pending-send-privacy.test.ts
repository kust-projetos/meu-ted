/**
 * FIX-P1-SESS #176 (RED): o rascunho de envio (`ted.pending-send.*`) era
 * chaveado só por workspace — o ator B, no mesmo workspace/browser, reidratava
 * o retry do ator A. A chave precisa incluir o ator; reload do MESMO ator
 * preserva o retry legítimo; logout/troca/revogação limpa tudo; âncora legada
 * ambígua nunca reidrata para outra conta.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  savePendingChatSend,
  loadPendingChatSend,
  clearPendingChatSend,
  clearAllPendingChatSends,
  type PendingChatSend,
} from "./agent-client";
import { OFFLINE_PRINCIPAL_STORAGE_KEY } from "@/lib/auth/offline-identity";

const WS = "ws-privacy-1";
const ACTOR_A = "actor-A";
const ACTOR_B = "actor-B";

function setPrincipal(actor: string | null): void {
  if (actor === null) window.localStorage.removeItem(OFFLINE_PRINCIPAL_STORAGE_KEY);
  else window.localStorage.setItem(OFFLINE_PRINCIPAL_STORAGE_KEY, actor);
}

function draft(content: string): PendingChatSend {
  return {
    messageId: `msg-${content}`,
    content,
    createdAt: new Date().toISOString(),
    attachments: [],
  };
}

function pendingSendKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith("ted.pending-send.")) keys.push(key);
  }
  return keys.sort();
}

beforeEach(() => {
  sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  window.localStorage.clear();
});

describe("P1 #176 — rascunho isolado por ator", () => {
  it("ator B não vê o rascunho do ator A no mesmo workspace", () => {
    setPrincipal(ACTOR_A);
    savePendingChatSend(WS, draft("rascunho de A"));
    setPrincipal(ACTOR_B);
    expect(loadPendingChatSend(WS)).toBeNull();
  });

  it("reload do mesmo ator preserva o retry legítimo", () => {
    setPrincipal(ACTOR_A);
    const send = draft("rascunho de A");
    savePendingChatSend(WS, send);
    // "Reload": mesma sessão de armazenamento, mesmo principal.
    const reloaded = loadPendingChatSend(WS);
    expect(reloaded?.messageId).toBe(send.messageId);
    expect(reloaded?.content).toBe("rascunho de A");
  });

  it("workspaces diferentes não compartilham rascunho mesmo com o mesmo ator", () => {
    setPrincipal(ACTOR_A);
    savePendingChatSend(WS, draft("rascunho ws-1"));
    expect(loadPendingChatSend("ws-privacy-2")).toBeNull();
  });

  it("âncora legada ambígua não reidrata para outra conta", () => {
    // Formato legado (só workspace, sem ator) gravado antes do fix.
    sessionStorage.setItem(
      `ted.pending-send.${WS}`,
      JSON.stringify({ messageId: "msg-legado", content: "legado", createdAt: new Date().toISOString() }),
    );
    setPrincipal(ACTOR_B);
    expect(loadPendingChatSend(WS)).toBeNull();
  });

  it("âncora legada segue reidratando sem principal conhecido (compatibilidade)", () => {
    sessionStorage.setItem(
      `ted.pending-send.${WS}`,
      JSON.stringify({ messageId: "msg-legado", content: "legado", createdAt: new Date().toISOString() }),
    );
    setPrincipal(null);
    expect(loadPendingChatSend(WS)?.messageId).toBe("msg-legado");
  });

  it("clearAllPendingChatSends remove chaves com e sem ator", () => {
    setPrincipal(ACTOR_A);
    savePendingChatSend(WS, draft("a"));
    sessionStorage.setItem(`ted.pending-send.${WS}`, JSON.stringify({ messageId: "x", content: "y" }));
    setPrincipal(ACTOR_B);
    savePendingChatSend(WS, draft("b"));
    expect(pendingSendKeys().length).toBeGreaterThanOrEqual(2);
    clearAllPendingChatSends();
    expect(pendingSendKeys()).toHaveLength(0);
  });

  it("clearPendingChatSend remove a âncora do escopo (ator + legada)", () => {
    setPrincipal(ACTOR_A);
    savePendingChatSend(WS, draft("a"));
    sessionStorage.setItem(`ted.pending-send.${WS}`, JSON.stringify({ messageId: "x", content: "y" }));
    clearPendingChatSend(WS);
    expect(loadPendingChatSend(WS)).toBeNull();
    expect(pendingSendKeys()).toHaveLength(0);
  });
});

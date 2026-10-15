/**
 * FIX-P1-SESS #176 (RED, parte 2): logout / troca de principal / revogação
 * (todos passam por `clearSensitiveSession`) precisam purgar as âncoras
 * `ted.pending-send.*` — nenhuma conta posterior pode reidratar o retry de
 * outra. O bare `{}` (sem teardown) preserva — purga é teardown, não varredura.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { clearSensitiveSession } from "@/lib/session";
import { savePendingChatSend } from "@/lib/api/agent-client";
import { OFFLINE_PRINCIPAL_STORAGE_KEY } from "@/lib/auth/offline-identity";

const WS = "ws-purge-1";

function pendingSendKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith("ted.pending-send.")) keys.push(key);
  }
  return keys;
}

beforeEach(() => {
  sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  window.localStorage.clear();
});

describe("P1 #176 — purge das âncoras no teardown de sessão", () => {
  it("logout (clearToken) purga âncoras com e sem ator", async () => {
    window.localStorage.setItem(OFFLINE_PRINCIPAL_STORAGE_KEY, "actor-A");
    savePendingChatSend(WS, {
      messageId: "m-a",
      content: "rascunho de A",
      createdAt: new Date().toISOString(),
    });
    sessionStorage.setItem(`ted.pending-send.${WS}`, JSON.stringify({ messageId: "x", content: "legado" }));
    expect(pendingSendKeys().length).toBeGreaterThanOrEqual(1);
    await clearSensitiveSession({ clearToken: true });
    expect(pendingSendKeys()).toHaveLength(0);
  });

  it("revogação de vínculo (clearWorkspaceBinding) purga âncoras", async () => {
    window.localStorage.setItem(OFFLINE_PRINCIPAL_STORAGE_KEY, "actor-A");
    savePendingChatSend(WS, {
      messageId: "m-a",
      content: "rascunho de A",
      createdAt: new Date().toISOString(),
    });
    await clearSensitiveSession({ clearV1Snapshot: true, clearProfile: true, clearWorkspaceBinding: true });
    expect(pendingSendKeys()).toHaveLength(0);
  });

  it("revogação de identidade (clearOfflineIdentity) purga âncoras", async () => {
    window.localStorage.setItem(OFFLINE_PRINCIPAL_STORAGE_KEY, "actor-A");
    savePendingChatSend(WS, {
      messageId: "m-a",
      content: "rascunho de A",
      createdAt: new Date().toISOString(),
    });
    await clearSensitiveSession({ clearOfflineIdentity: true });
    expect(pendingSendKeys()).toHaveLength(0);
  });

  it("chamada sem teardown preserva as âncoras", async () => {
    window.localStorage.setItem(OFFLINE_PRINCIPAL_STORAGE_KEY, "actor-A");
    savePendingChatSend(WS, {
      messageId: "m-a",
      content: "rascunho de A",
      createdAt: new Date().toISOString(),
    });
    await clearSensitiveSession({});
    expect(pendingSendKeys().length).toBeGreaterThanOrEqual(1);
  });
});

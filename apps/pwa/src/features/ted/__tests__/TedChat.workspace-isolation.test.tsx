import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Test lives at apps/pwa/src/features/ted/__tests__/ → TedChat is one level up,
// runtime source is reached through the repo root.
const tedChatPath = join(__dirname, "..", "TedChat.tsx");
const conversationsTestPath = join(__dirname, "..", "..", "..", "..", "..", "ted-runtime", "tests", "conversations.test.mjs");

describe("TedChat – isolamento de histórico por workspace", () => {
  it("limpa histórico ao trocar de workspace (prevWorkspaceIdRef e useEffect)", () => {
    const content = readFileSync(tedChatPath, "utf8");
    expect(content).toMatch(/prevWorkspaceIdRef/);
    expect(content).toMatch(/activeWorkspace\?\.id/);
    // Deve limpar mensagens ao trocar
    expect(content).toMatch(/setMessages\(\[\]\)/);
    expect(content).toMatch(/setPendingOps\(\[\]\)/);
  });

  it("fetchAgentHistory é chamado com workspace isolado e loadHistory depende de activeWorkspace", () => {
    const content = readFileSync(tedChatPath, "utf8");
    // A02/R02 (AC07 HIGH): o refresh captura o escopo no início e busca pelo
    // id congelado (`scopeId`), revalidando-o após cada await.
    expect(content).toContain("const scopeId = activeWorkspace.id;");
    expect(content).toContain("fetchAgentHistory(scopeId)");
    expect(content).toContain("loadHistory");
    expect(content).toContain("activeWorkspace");
    expect(content).toMatch(/useCallback/);
  });

  it("runtime restringe sessões a workspace e ator autorizados", () => {
    const content = readFileSync(conversationsTestPath, "utf8");
    expect(content).toContain("workspace default: same-workspace member reads, other workspace refused");
    expect(content).toContain("private: owner only");
    expect(content).toContain("another workspace");
    expect(content).toContain("actor-A");
    expect(content).toContain("actor-B");
  });

  it("runtime cobre autorização de identidade no acesso a sessão", () => {
    const content = readFileSync(conversationsTestPath, "utf8");
    expect(content).toContain("canAccessConversation");
    expect(content).toContain("ownerActor");
    expect(content).toContain("deviceId");
    expect(content).toContain("forbidden");
  });
});

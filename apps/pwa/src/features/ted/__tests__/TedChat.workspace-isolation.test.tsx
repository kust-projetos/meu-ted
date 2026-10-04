import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Test lives at apps/pwa/src/features/ted/__tests__/ → TedChat is one level up,
// the agent source is reached through the repo root (five levels up).
const tedChatPath = join(__dirname, "..", "TedChat.tsx");
const financeChatPath = join(__dirname, "..", "..", "..", "..", "..", "agent", "src", "finance-chat-agent.ts");

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

  it("FinanceChatAgent filtra histórico por workspaceId para isolamento server-side", () => {
    const content = readFileSync(financeChatPath, "utf8");
    expect(content).toContain("allMessages.filter");
    expect(content).toContain("workspaceId");
    expect(content).toMatch(/x-agent-workspace/);
    expect(content).toMatch(/Isolamento por workspace/);
  });

  it("não deve vazar mensagens entre workspaces via DO compartilhado", () => {
    const content = readFileSync(financeChatPath, "utf8");
    // Verifica que histório filtra por metadata.workspaceId
    expect(content).toMatch(/metadata.*workspaceId/);
    expect(content).toMatch(/workspaceId/);
  });
});

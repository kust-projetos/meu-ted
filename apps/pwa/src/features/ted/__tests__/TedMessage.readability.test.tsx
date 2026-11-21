/**
 * Legibilidade das mensagens do agente (R05/AC11, ADR-033): o balão do TED
 * respeita parágrafos, quebras de linha, listas, negrito e emojis — sem
 * dependência nova e sem interpretar HTML cru (XSS).
 */
import { describe, expect, it } from "vitest";
import { render } from "@/lib/test-utils";
import { TedMessage } from "../TedMessage";
import type { AgentMessage } from "@/lib/api/agent-client";

function assistant(content: string): AgentMessage {
  return { id: "m1", actorId: "ted", role: "assistant", content, createdAt: undefined, isOwn: false };
}

describe("TedMessage — legibilidade do markdown do agente", () => {
  it("respeita parágrafos distintos e espaça o primeiro", () => {
    const { container } = render(
      <TedMessage message={assistant("Primeiro parágrafo.\n\nSegundo parágrafo.")} isCurrentUser={false} />,
    );

    const paragraphs = container.querySelectorAll("p");
    // As duas notas de resultado não existem aqui; só os 2 parágrafos do texto.
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe("Primeiro parágrafo.");
    expect(paragraphs[1]?.textContent).toBe("Segundo parágrafo.");
    expect(paragraphs[0]?.className).toContain("mb-2");
    expect(paragraphs[1]?.className).toContain("last:mb-0");
  });

  it("respeita quebras de linha explícitas dentro do parágrafo", () => {
    const { container } = render(
      <TedMessage message={assistant("Linha um\nLinha dois")} isCurrentUser={false} />,
    );

    expect(container.querySelector("p")?.querySelectorAll("br")).toHaveLength(1);
    expect(container.textContent).toContain("Linha um");
    expect(container.textContent).toContain("Linha dois");
  });

  it("renderiza lista com marcadores e lista numerada", () => {
    const { container } = render(
      <TedMessage
        message={assistant("Itens:\n- primeiro\n- segundo\n\nPassos:\n1. abrir\n2. confirmar")}
        isCurrentUser={false}
      />,
    );

    const ul = container.querySelector("ul");
    const ol = container.querySelector("ol");
    expect(ul?.querySelectorAll("li")).toHaveLength(2);
    expect(ol?.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("primeiro");
    expect(container.textContent).toContain("confirmar");
  });

  it("negrito e emojis são preservados, sem HTML cru executável", () => {
    const { container } = render(
      <TedMessage
        message={assistant("**Total** concluído ✅\n\n<script>alert(1)</script>")}
        isCurrentUser={false}
      />,
    );

    expect(container.querySelector("strong")?.textContent).toBe("Total");
    expect(container.textContent).toContain("✅");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("mantém o balão em tema escuro", () => {
    const { container } = render(
      <TedMessage message={assistant("Olá")} isCurrentUser={false} />,
    );

    const bubble = container.querySelector('[data-testid="ted-message-bubble"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.className).toContain("bg-surface-2");
    expect(bubble?.className).toContain("text-text-primary");
    // `text-pretty` no conteúdo evita linha órfã (emoji sozinha no fim).
    expect(bubble?.querySelector("div")?.className).toContain("text-pretty");
  });
});

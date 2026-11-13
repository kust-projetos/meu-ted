import { describe, expect, it } from "vitest";
import { render, screen } from "@/lib/test-utils";
import { TedMessage, safeAttachmentUrl } from "../TedMessage";

describe("safeAttachmentUrl", () => {
  it("allows https URLs", () => {
    expect(safeAttachmentUrl("https://cdn.test/img.png")).toBe("https://cdn.test/img.png");
  });

  it("allows blob URLs (local previews)", () => {
    expect(safeAttachmentUrl("blob:http://localhost/abc")).toBe("blob:http://localhost/abc");
  });

  it("rejects javascript: URLs", () => {
    expect(safeAttachmentUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(safeAttachmentUrl("data:text/html;base64,AAAA")).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(safeAttachmentUrl("not a url")).toBeNull();
    expect(safeAttachmentUrl(null)).toBeNull();
    expect(safeAttachmentUrl(undefined)).toBeNull();
  });
});

describe("TedMessage – attachment URL safety", () => {
  it("renders a placeholder instead of media for javascript: attachment", () => {
    const msg = {
      id: "m-unsafe",
      actorId: "user-1",
      role: "user",
      content: "x",
      createdAt: new Date().toISOString(),
      isOwn: true,
      attachments: [{ type: "image" as const, url: "javascript:alert(1)", name: "evil.png" }],
    } as unknown as Parameters<typeof TedMessage>[0]["message"];
    const { container } = render(<TedMessage message={msg} isCurrentUser={true} senderName="Você" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-testid="ted-attachment-placeholder"]')).not.toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });
});
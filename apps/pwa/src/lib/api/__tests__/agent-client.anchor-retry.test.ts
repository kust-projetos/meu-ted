import { afterEach, describe, expect, it } from "vitest";
import {
  composeChatSend,
  isAnchorSupersededByHistory,
  resolveRetrySend,
} from "../agent-client";

afterEach(() => sessionStorage.clear());

describe("text-only pending-send retry", () => {
  it("reuses the existing draft without minting a second message identity", () => {
    const draft = composeChatSend("texto original", { messageId: "msg-stable" });
    const result = resolveRetrySend({
      messageId: "msg-stable",
      failed: { content: "texto original" },
      stored: draft,
    });

    expect(result).toEqual({ ok: true, send: draft, draft });
  });

  it("recomposes a missing draft with the same messageId/intentionId", () => {
    const result = resolveRetrySend({
      messageId: "msg-stable",
      failed: { content: "texto original" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.send.messageId).toBe("msg-stable");
    expect(result.send.content).toBe("texto original");
    expect(composeChatSend(result.send.content, { messageId: result.send.messageId }).messageId)
      .toBe("msg-stable");
    const retryAgain = resolveRetrySend({
      messageId: result.send.messageId,
      failed: { content: result.send.content },
      stored: result.send,
    });
    expect(retryAgain.ok && retryAgain.send.messageId).toBe("msg-stable");
  });

  it("supersedes only from a later own-history item and fails closed without order", () => {
    const anchor = {
      messageId: "msg-stable",
      content: "texto original",
      createdAt: "2026-10-13T10:00:00.000Z",
    };
    expect(isAnchorSupersededByHistory(anchor, [
      { isOwn: false, content: anchor.content, createdAt: "2026-10-13T10:05:00.000Z" },
    ])).toBe(false);
    expect(isAnchorSupersededByHistory(anchor, [
      { isOwn: true, content: anchor.content, createdAt: "2026-10-13T10:05:00.000Z" },
    ])).toBe(true);
    expect(isAnchorSupersededByHistory(anchor, [
      { isOwn: true, content: anchor.content, createdAt: "2026-10-13T10:05:00.000Z" },
    ])).toBe(true);
  });
});

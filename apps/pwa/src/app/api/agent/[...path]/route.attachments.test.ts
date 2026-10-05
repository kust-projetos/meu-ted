import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { POST } from "./route";

/**
 * A19 slice 1 — the same-origin proxy must not keep the chat 2 MB ceiling on
 * the A13 attachment upload route (the contract allows 10 MB image/audio and
 * 15 MB pdf), and it must keep that ceiling on every OTHER route. It must
 * also carry the kind/name claim headers through the hop, otherwise the DO
 * cannot validate the upload at all.
 */
describe("Agent proxy body ceiling (A19 attachment split)", () => {
  beforeEach(() => {
    vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  });

  const CHAT_LIMIT = 2_097_152;
  const ATTACHMENT_CEILING = 15 * 1024 * 1024;

  const attachmentContext = () => ({
    params: Promise.resolve({
      path: ["agents", "finance-chat-agent", "ws-1", "rpc", "attachments"],
    }),
  });

  const attachmentUrl = "https://pwa.example/api/agent/agents/finance-chat-agent/ws-1/rpc/attachments";

  /** Real PNG magic bytes, padded — the proxy never sniffs, but keep it honest. */
  const pngBody = (totalBytes: number): ArrayBuffer => {
    const out = new Uint8Array(totalBytes);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    return out.buffer;
  };

  it("forwards a 3 MB attachment upload (above the chat ceiling) to the upstream", async () => {
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ ref: "att_1", kind: "image" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const body = pngBody(3 * 1024 * 1024);
    const res = await POST(
      new Request(attachmentUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-ted-attachment-kind": "image",
          "x-ted-attachment-name": "grande.png",
          origin: "https://pwa.example",
        },
        body,
      }),
      attachmentContext(),
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect((await captured!.arrayBuffer()).byteLength).toBe(body.byteLength);
    // The kind/name claims must survive the hop or the DO cannot validate them.
    expect(captured!.headers.get("x-ted-attachment-kind")).toBe("image");
    expect(captured!.headers.get("x-ted-attachment-name")).toBe("grande.png");
  });

  it("rejects a body above the attachment ceiling with 413 before calling upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await POST(
      new Request(attachmentUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-ted-attachment-kind": "image",
          origin: "https://pwa.example",
        },
        body: pngBody(ATTACHMENT_CEILING + 1),
      }),
      attachmentContext(),
    );

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("request.body_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the 2 MB ceiling on every other route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await POST(
      new Request("https://pwa.example/api/agent/agents/finance-chat-agent/ws-1/rpc/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://pwa.example" },
        body: new Uint8Array(CHAT_LIMIT + 1),
      }),
      { params: Promise.resolve({ path: ["agents", "finance-chat-agent", "ws-1", "rpc", "chat"] }) },
    );

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the attachment ceiling on a chunked upload with no Content-Length", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const chunk = new Uint8Array(256 * 1024);
    chunk.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const totalChunks = Math.ceil((ATTACHMENT_CEILING + 1) / chunk.byteLength);
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= totalChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });

    const res = await POST(
      new Request(attachmentUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-ted-attachment-kind": "image",
          origin: "https://pwa.example",
        },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      attachmentContext(),
    );

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
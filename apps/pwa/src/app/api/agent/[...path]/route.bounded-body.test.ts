import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { POST } from "./route";

/**
 * A19 closure (issue #91), finding 3: the same-origin proxy validated the
 * DECLARED Content-Length but then called `request.arrayBuffer()`, so a request
 * with no Content-Length — or one lying about its size — buffered the whole body
 * in memory before the ceiling was applied. The Worker hop already reads the
 * stream incrementally and aborts the moment the ceiling is crossed
 * (`readBoundedBody`, apps/agent/src/worker.ts). These tests pin the same
 * behaviour on the PWA hop by making the byte source OBSERVABLE: every `pull`
 * (bytes handed to the proxy) and the first `cancel` (stream aborted) are
 * counted, so a test can tell "rejected after buffering everything" apart from
 * "rejected while still reading".
 */
describe("Agent proxy bounded body read (A19 closure)", () => {
  beforeEach(() => {
    vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  });

  const CHAT_LIMIT = 2_097_152;

  const ORIGIN = "https://pwa.example";
  const ATTACHMENT_PATH = ["agents", "finance-chat-agent", "ws-1", "rpc", "attachments"];
  const CHAT_PATH = ["agents", "finance-chat-agent", "ws-1", "rpc", "chat"];

  const attachmentUrl = `${ORIGIN}/api/agent/${ATTACHMENT_PATH.join("/")}`;
  const chatUrl = `${ORIGIN}/api/agent/${CHAT_PATH.join("/")}`;

  const attachmentContext = () => ({ params: Promise.resolve({ path: [...ATTACHMENT_PATH] }) });
  const chatContext = () => ({ params: Promise.resolve({ path: [...CHAT_PATH] }) });

  /** Real PNG magic bytes, padded — the proxy never sniffs, but keep it honest. */
  const pngBody = (totalBytes: number): ArrayBuffer => {
    const out = new Uint8Array(totalBytes);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    return out.buffer;
  };

  /**
   * A byte source that reports how much of it the proxy actually read. `pull`
   * runs once per delivered chunk, `cancel` runs once when the proxy aborts
   * the stream instead of draining it.
   */
  const observableStream = (
    chunkBytes: number,
    chunkCount: number,
  ): {
    stream: ReadableStream<Uint8Array>;
    stats: { pulls: number; cancels: number; cancelReason: unknown };
  } => {
    const stats = { pulls: 0, cancels: 0, cancelReason: undefined as unknown };
    const chunk = new Uint8Array(chunkBytes);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        stats.pulls += 1;
        if (stats.pulls > chunkCount) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel(reason) {
        stats.cancels += 1;
        stats.cancelReason = reason;
      },
    });
    return { stream, stats };
  };

  const okUpstream = () =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  const bodyTooLarge = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: { code: string } }).error.code;

  it("forwards a chat body below the 2 MB ceiling", async () => {
    const fetchMock = okUpstream();
    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ text: "Qual o meu saldo?" }),
      }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("rejects a declared Content-Length above the ceiling before reading a single byte", async () => {
    const { stream, stats } = observableStream(64 * 1024, 8);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const request = new Request(chatUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "content-length": String(CHAT_LIMIT + 1),
      },
      body: stream,
      // @ts-expect-error duplex is required for streamed bodies outside browsers
      duplex: "half",
    });
    // The runtime primes the stream queue on its own once the Request is built;
    // settle that first so the counter measures the PROXY, not the runtime.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pullsBeforeProxy = stats.pulls;

    const res = await POST(request, chatContext());

    expect(res.status).toBe(413);
    expect(await bodyTooLarge(res)).toBe("request.body_too_large");
    // Up front means up front: the proxy never pulled from the body, so it
    // never buffered a byte of it.
    expect(stats.pulls).toBe(pullsBeforeProxy);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("interrupts an oversized streamed body with no Content-Length and cancels the stream", async () => {
    // 32 x 256 KB = 8 MB offered against a 2 MB ceiling.
    const { stream, stats } = observableStream(256 * 1024, 32);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin: ORIGIN },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      chatContext(),
    );

    expect(res.status).toBe(413);
    expect(await bodyTooLarge(res)).toBe("request.body_too_large");
    // The ceiling is crossed around the 9th chunk, so the stream must be
    // CANCELLED there. Draining all 32 chunks would be the buffering bug.
    expect(stats.cancels).toBe(1);
    expect(stats.pulls).toBeLessThan(16);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("interrupts a body whose declared Content-Length lies about its size and cancels the stream", async () => {
    // Declares 1 KB, actually offers 8 MB: the declared value must not be trusted.
    const { stream, stats } = observableStream(256 * 1024, 32);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          origin: ORIGIN,
          "content-length": "1024",
        },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      chatContext(),
    );

    expect(res.status).toBe(413);
    expect(await bodyTooLarge(res)).toBe("request.body_too_large");
    expect(stats.cancels).toBe(1);
    expect(stats.pulls).toBeLessThan(16);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a body whose declared Content-Length matches the real size", async () => {
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          origin: ORIGIN,
          "content-length": "1024",
        },
        body: new Uint8Array(1024),
      }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    expect((await captured!.arrayBuffer()).byteLength).toBe(1024);
  });

  it("cancels when small chunks cross the ceiling only on a later chunk", async () => {
    // 64 KB chunks: 32 of them are exactly the ceiling, so the 33rd chunk is
    // the first one over it. The boundary is checked per chunk, in the middle
    // of the stream — never by buffering first.
    const { stream, stats } = observableStream(64 * 1024, 64);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin: ORIGIN },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      chatContext(),
    );

    expect(res.status).toBe(413);
    expect(stats.cancels).toBe(1);
    expect(stats.pulls).toBeGreaterThan(32);
    expect(stats.pulls).toBeLessThan(40);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a streamed body of exactly the ceiling", async () => {
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // 32 x 64 KB == 2_097_152: the ceiling is exclusive, an exact fit passes.
    const { stream } = observableStream(64 * 1024, 32);
    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin: ORIGIN },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    expect((await captured!.arrayBuffer()).byteLength).toBe(CHAT_LIMIT);
  });

  it("defers to the actual bytes when the declared Content-Length is unparseable", async () => {
    const fetchMock = okUpstream();
    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          origin: ORIGIN,
          "content-length": "not-a-number",
        },
        body: new Uint8Array(64),
      }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("forwards a streamed attachment below the attachment ceiling", async () => {
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ ref: "att_1", kind: "image" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // 48 x 256 KB == 12 MB: above the chat ceiling, below the 15 MB one.
    const { stream, stats } = observableStream(256 * 1024, 48);
    const res = await POST(
      new Request(attachmentUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-ted-attachment-kind": "image",
          origin: ORIGIN,
        },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      attachmentContext(),
    );

    expect(res.status).toBe(200);
    expect((await captured!.arrayBuffer()).byteLength).toBe(12 * 1024 * 1024);
    expect(stats.cancels).toBe(0);
  });

  it("cancels an attachment stream that crosses the attachment ceiling", async () => {
    // 72 x 256 KB == 18 MB against the 15 MB attachment ceiling.
    const { stream, stats } = observableStream(256 * 1024, 72);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(attachmentUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-ted-attachment-kind": "image",
          origin: ORIGIN,
        },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      attachmentContext(),
    );

    expect(res.status).toBe(413);
    expect(await bodyTooLarge(res)).toBe("request.body_too_large");
    expect(stats.cancels).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still enforces the ceiling on the no-stream fallback", async () => {
    // Some runtimes hand over a Request without an exposed body stream; the
    // fallback read must not become a hole in the ceiling.
    const request = new Request(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: ORIGIN },
      body: pngBody(CHAT_LIMIT + 1),
    });
    Object.defineProperty(request, "body", { value: null, configurable: true });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(request, chatContext());

    expect(res.status).toBe(413);
    expect(await bodyTooLarge(res)).toBe("request.body_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a small body through the no-stream fallback", async () => {
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // No body stream exposed, but the bytes remain readable through the
    // fallback: below the ceiling they must be forwarded, not dropped.
    const request = new Request(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: ORIGIN },
      body: new Uint8Array(64),
    });
    Object.defineProperty(request, "body", { value: null, configurable: true });

    const res = await POST(request, chatContext());

    expect(res.status).toBe(200);
    expect((await captured!.arrayBuffer()).byteLength).toBe(64);
  });

  it("forwards a body-less POST without a body payload", async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
      }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    expect(capturedInit?.body).toBeUndefined();
  });

  it("forwards an empty body stream without a body payload", async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { stream, stats } = observableStream(64, 0);
    const res = await POST(
      new Request(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: stream,
        // @ts-expect-error duplex is required for streamed bodies outside browsers
        duplex: "half",
      }),
      chatContext(),
    );

    expect(res.status).toBe(200);
    expect(stats.cancels).toBe(0);
    expect(capturedInit?.body).toBeUndefined();
  });
});
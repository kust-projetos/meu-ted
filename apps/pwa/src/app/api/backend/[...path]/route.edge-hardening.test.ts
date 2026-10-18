import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T10 (borda, corpo e CORS) — RED primeiro.
 *
 * O proxy /api/backend materializava o corpo inteiro (`arrayBuffer`) antes de
 * aplicar o teto de 1 MB, e repassava OPTIONS/mutações sem política explícita
 * de Fetch Metadata. Estes testes fixam o contrato:
 *
 * - corpo acima do teto SEM Content-Length (chunked) é cortado DURANTE a
 *   leitura (stream cancelado, sem alocar o corpo todo);
 * - Content-Length falso (declarado menor que o real) não é confiável: vale o
 *   que chega pelo stream;
 * - abort/falha no meio da leitura vira 4xx, nunca 500, sem tocar o upstream;
 * - OPTIONS com Origin não permitido é recusado localmente (sem upstream);
 * - mutação sem Origin + `Sec-Fetch-Site: cross-site` é recusada;
 * - chamadas legítimas continuam passando (same-origin válida; cliente
 *   não-browser sem Origin e sem Fetch Metadata; loopback de E2E/dev).
 */

const BACKEND_LIMIT = 1_048_576;
const ORIGIN = "https://pwa.example";
const URL = `${ORIGIN}/api/backend/payables`;

async function loadRoute() {
  vi.resetModules();
  return await import("./route");
}

function ctx(path: string[] = ["payables"]) {
  return { params: Promise.resolve({ path }) };
}

function observableStream(
  chunkBytes: number,
  chunkCount: number,
): {
  stream: ReadableStream<Uint8Array>;
  stats: { pulls: number; cancels: number };
} {
  const stats = { pulls: 0, cancels: 0 };
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
    cancel() {
      stats.cancels += 1;
    },
  });
  return { stream, stats };
}

function okUpstream() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("backend proxy edge hardening (T10)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("corta corpo chunked acima do teto sem Content-Length e cancela o stream", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { POST } = await loadRoute();
    // 32 x 256 KB = 8 MB contra o teto de 1 MB.
    const { stream, stats } = observableStream(256 * 1024, 32);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin: ORIGIN },
        body: stream,
        // @ts-expect-error duplex exigido para corpo em stream fora do browser
        duplex: "half",
      }),
      ctx(),
    );

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "request.body_too_large",
    );
    // O corte acontece por volta do 5º chunk: drenar os 32 seria o bug.
    expect(stats.cancels).toBe(1);
    expect(stats.pulls).toBeLessThan(16);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("não confia em Content-Length falso menor que o corpo real", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { POST } = await loadRoute();
    // Declara 1 KB, entrega 8 MB: o declarado não pode liberar buffer ilimitado.
    const { stream, stats } = observableStream(256 * 1024, 32);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          origin: ORIGIN,
          "content-length": "1024",
        },
        body: stream,
        // @ts-expect-error duplex exigido para corpo em stream fora do browser
        duplex: "half",
      }),
      ctx(),
    );

    expect(res.status).toBe(413);
    expect(stats.cancels).toBe(1);
    expect(stats.pulls).toBeLessThan(16);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("abort no meio da leitura vira 4xx sem tocar o upstream", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { POST } = await loadRoute();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64));
      },
    });
    const erroring = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = stream.getReader();
        const first = await reader.read();
        if (!first.done) controller.enqueue(first.value);
        reader.releaseLock();
        controller.error(new DOMException("The operation was aborted", "AbortError"));
      },
    });

    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin: ORIGIN },
        body: erroring,
        // @ts-expect-error duplex exigido para corpo em stream fora do browser
        duplex: "half",
      }),
      ctx(),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "request.body_aborted",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa OPTIONS com Origin não permitido sem contatar o upstream", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { OPTIONS } = await loadRoute();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await OPTIONS(
      new Request(URL, {
        method: "OPTIONS",
        headers: { origin: "https://attacker.example" },
      }),
      ctx(),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa mutação sem Origin com Sec-Fetch-Site: cross-site", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { POST } = await loadRoute();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ amountCents: 100 }),
      }),
      ctx(),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mantém mutação same-origin com Origin válido", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { POST } = await loadRoute();
    const fetchMock = okUpstream();

    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ amountCents: 100 }),
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mantém cliente não-browser sem Origin e sem Fetch Metadata", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { POST } = await loadRoute();
    const fetchMock = okUpstream();

    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 100 }),
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mantém GET sem Origin (navegação/legítimo sem Fetch Metadata)", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { GET } = await loadRoute();
    const fetchMock = okUpstream();

    const res = await GET(new Request(URL), ctx());

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mantém override loopback do E2E mesmo com ALLOW_LOCAL_ORIGIN=0", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "http://127.0.0.1:4010");
    vi.stubEnv("ALLOW_LOCAL_ORIGIN", "0");
    const { GET } = await loadRoute();
    const fetchMock = okUpstream();

    const res = await GET(new Request("http://127.0.0.1:3000/api/backend/health"), ctx(["health"]));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:4010/health");
  });

  it("fail-closed: upstream fora do conjunto permitido nunca recebe credencial", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "https://evil.example");
    const { POST } = await loadRoute();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          cookie: "better-auth.session_token=opaque",
        },
        body: JSON.stringify({ amountCents: 100 }),
      }),
      ctx(),
    );

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "upstream_misconfigured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encaminha corpo pequeno com Content-Length verdadeiro", async () => {
    vi.stubEnv("PWA_BACKEND_PROXY_ORIGIN", "");
    const { POST } = await loadRoute();
    let captured: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const payload = JSON.stringify({ amountCents: 100 });
    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "content-length": String(payload.length),
        },
        body: payload,
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect((await captured!.arrayBuffer()).byteLength).toBe(payload.length);
    expect(BACKEND_LIMIT).toBe(1_048_576);
  });
});

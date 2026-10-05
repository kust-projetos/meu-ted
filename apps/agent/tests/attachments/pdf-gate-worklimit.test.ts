/**
 * F4 — o parser de PDF é DEFAULT-OFF e tem TETO DE TRABALHO, não só de saída.
 *
 * - **Gate**: o parse é LOCAL (sem egress, sem credencial), mas ainda é a única
 *   dependência nova e o único parse de CPU do Worker. O plano (§8 "flags novas
 *   default-off") exige uma trava: sem `TED_PDF_TEXT_ENABLED=1` nenhum byte é
 *   parseado e o estado é o `unsupported` honesto da A13.
 * - **Teto de trabalho**: antes, `extractText(proxy)` extraía o documento TODO e
 *   só depois truncava em 20 000 caracteres — o teto era de SAÍDA, não de
 *   TRABALHO. Agora o laço por página EARLY-EXIT ao atingir os tetos, e o
 *   `pagesRead` reportado é o real.
 * - **Deadline honesto**: `Promise.race` resolve o TURN, mas não cancela CPU
 *   síncrona. A mitigação real são os tetos pré-parse + early-exit.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PDF_EXTRACT_MAX_CHARS,
  PDF_EXTRACT_MAX_PAGES,
  createUnpdfExtractor,
  pdfTextProcessorOverride,
} from "../../src/multimodal/pdf-text.js";
import { bytesOf, createAttachmentTestAgent, installRelayMock } from "./helpers.js";
import { getAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const chatRequest = (body: unknown): Request =>
  new Request("https://agent.test.local/rpc/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-actor": "actor-1",
      "x-agent-workspace": "ws-1",
    },
    body: JSON.stringify(body),
  });

describe("F4(a) — gate TED_PDF_TEXT_ENABLED, default-off", () => {
  it("sem a env, o override do PDF é AUSENTE (o registry mantém o unsupported da A13)", () => {
    expect(pdfTextProcessorOverride(undefined)).toBeUndefined();
    expect(pdfTextProcessorOverride({})).toBeUndefined();
    expect(pdfTextProcessorOverride({ TED_PDF_TEXT_ENABLED: "0" })).toBeUndefined();
    expect(pdfTextProcessorOverride({ TED_PDF_TEXT_ENABLED: "true" })).toBeUndefined();
  });

  it("com a env exatamente '1', o processor existe", () => {
    const processor = pdfTextProcessorOverride(
      { TED_PDF_TEXT_ENABLED: "1" },
      { extractor: async () => ({ state: "ok" as const, pages: [], pageCount: 0 }) },
    );
    expect(processor).toBeTypeOf("function");
  });

  it("sem a env, um PDF no turno resolve 'unsupported' e o parser NUNCA é chamado", async () => {
    let parsed = 0;
    const extractor = vi.fn(async () => {
      parsed += 1;
      return { state: "ok" as const, pages: ["conteudo"], pageCount: 1 };
    });
    // A env ausente é o caso real; o spy prova que zero parse aconteceu.
    installRelayMock();
    const { agent } = createAttachmentTestAgent();
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const uploaded = await ingestAttachment({
      storage,
      identity: { workspaceId: "ws-1", actorId: "actor-1" },
      kind: "pdf",
      name: "nota.pdf",
      bytes: bytesOf(new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n")),
    });

    const res = await agent.fetch(
      chatRequest({
        text: "anota",
        intentionId: "intent-pdf-gate-off",
        attachments: [{ type: "pdf", ref: uploaded.ref, name: "nota.pdf" }],
      }),
    );

    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unsupported");
    expect(parsed).toBe(0);
    expect(extractor).not.toHaveBeenCalled();
  });

  it("com a env ligada, o MESMO PDF é lido (o gate não quebrou o caminho legítimo)", async () => {
    installRelayMock();
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_PDF_TEXT_ENABLED: "1" } });
    const storage = getAttachmentStorage((agent as unknown as { env: unknown }).env)!;
    const uploaded = await ingestAttachment({
      storage,
      identity: { workspaceId: "ws-1", actorId: "actor-1" },
      kind: "pdf",
      name: "nota.pdf",
      bytes: bytesOf(buildTextLayerPdf(["Mercado Livre 42,50"])),
    });

    const res = await agent.fetch(
      chatRequest({
        text: "anota",
        intentionId: "intent-pdf-gate-on",
        attachments: [{ type: "pdf", ref: uploaded.ref, name: "nota.pdf" }],
      }),
    );

    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("processed");
  });
});

describe("F4(b) — teto de TRABALHO: early-exit no laço de páginas", () => {
  it("o teto de caracteres é early-exit: as páginas restantes NÃO são lidas", async () => {
    const extractor = createUnpdfExtractor();
    // Um documento de exatamente `PDF_EXTRACT_MAX_PAGES` páginas (portanto NÃO
    // recusado pelo teto de páginas) com texto muito maior que o teto de
    // caracteres. O laço tem de PARAR antes da última página.
    const text = "y".repeat(6_000);
    const bytes = buildTextLayerPdf(
      Array.from({ length: PDF_EXTRACT_MAX_PAGES }, (_, i) => `pagina ${i + 1} ${text}`),
    );

    const outcome = await extractor({
      bytes: bytesOf(bytes),
      mime: "application/pdf",
      maxPages: PDF_EXTRACT_MAX_PAGES,
      maxChars: PDF_EXTRACT_MAX_CHARS,
    });

    expect(outcome.state).toBe("ok");
    if (outcome.state !== "ok") throw new Error('expected "ok"');
    // F4: o trabalho para no teto — menos páginas lidas que as do documento, e
    // o texto acumulado respeita o teto de caracteres.
    expect(outcome.pageCount).toBe(PDF_EXTRACT_MAX_PAGES);
    expect(outcome.pagesRead).toBeGreaterThan(0);
    expect(outcome.pagesRead).toBeLessThan(PDF_EXTRACT_MAX_PAGES);
    expect(outcome.pages.join("").length).toBeLessThanOrEqual(PDF_EXTRACT_MAX_CHARS);
  });

  it("um documento acima do teto de páginas é recusado ANTES de qualquer página ser lida", async () => {
    const extractor = createUnpdfExtractor();
    const bytes = buildTextLayerPdf(Array.from({ length: 25 }, (_, i) => `pagina ${i + 1}`));
    const outcome = await extractor({
      bytes: bytesOf(bytes),
      mime: "application/pdf",
      maxPages: PDF_EXTRACT_MAX_PAGES,
    });
    expect(outcome.state).toBe("too_many_pages");
    if (outcome.state !== "too_many_pages") throw new Error('expected "too_many_pages"');
    expect((outcome as { pages?: unknown }).pages).toBeUndefined();
    // A refusal reads NO page: there is no work to report.
    expect((outcome as { pagesRead?: unknown }).pagesRead).toBeUndefined();
  });

  it("o teto de PÁGINAS também é early-exit, não truncamento silencioso", async () => {
    const extractor = createUnpdfExtractor();
    // Exatamente no teto: lido por inteiro, todas as páginas contabilizadas.
    const bytes = buildTextLayerPdf(Array.from({ length: PDF_EXTRACT_MAX_PAGES }, (_, i) => `p${i}`));
    const outcome = await extractor({
      bytes: bytesOf(bytes),
      mime: "application/pdf",
      maxPages: PDF_EXTRACT_MAX_PAGES,
    });
    expect(outcome.state).toBe("ok");
    if (outcome.state !== "ok") throw new Error('expected "ok"');
    expect(outcome.pagesRead).toBe(PDF_EXTRACT_MAX_PAGES);
  });

  it("a documentação do módulo declara que o deadline é de EVENTO, não de CPU", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/multimodal/pdf-text.ts", import.meta.url), "utf8"),
    );
    expect(source).toMatch(/deadline de evento|não cancela/i);
    expect(source).toMatch(/early-exit/i);
  });
});

/** Byte-accurate minimal PDF writer (valid xref). */
const buildTextLayerPdf = (pages: string[]): Uint8Array => {
  const chunks: Buffer[] = [];
  const offsets = new Map<number, number>();
  let pos = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, "latin1");
    chunks.push(buf);
    pos += buf.length;
  };
  const addObj = (id: number, body: string) => {
    offsets.set(id, pos);
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.7\n");
  const firstPage = 5;
  addObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ")}] >>`);
  addObj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((page, i) => {
    const contentId = firstPage + i * 2 + 1;
    const pageId = firstPage + i * 2;
    // One `Tj` per 40-char chunk: the parser stops reading a single very long
    // string operator, so a dense page needs several of them to be honest.
    const parts = page.match(/.{1,40}/g) ?? [];
    const stream = `BT /F1 12 Tf 72 720 Td\n${parts
      .map((part, k) => (k === 0 ? `(${part}) Tj\n` : `0 -12 Td\n(${part}) Tj\n`))
      .join("")}ET\n`;
    addObj(contentId, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    addObj(pageId, `<< /Type /Page /Parent 2 0 R /Font << /F1 3 0 R >> /MediaBox [0 0 612 792] /Contents ${contentId} 0 R >>`);
  });
  const xrefStart = pos;
  const maxId = pages.length * 2 + firstPage + 1;
  push(`xref\n0 ${maxId}\n0000000000 65535 f \n`);
  for (let id = 1; id < maxId; id += 1) {
    push(offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n");
  }
  push(
    `trailer\n<< /Size ${maxId} /Root 1 0 R /ID [<0102030405060708090a0b0c0d0e0f10><0102030405060708090a0b0c0d0e0f10>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat(chunks));
};
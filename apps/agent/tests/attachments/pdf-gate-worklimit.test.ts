/**
 * P1 fail-closed — a extração de PDF está INDISPONÍVEL até existir limite
 * por-página (isolamento/medição) real. Estes testes fixam:
 *
 * - **Por que foi desligada (P1):** `page.getTextContent()` materializa TODOS
 *   os itens de texto de UMA página ANTES de qualquer teto. O teto de
 *   caracteres só age ENTRE páginas (o `accumulated` é conferido antes de abrir
 *   a PRÓXIMA página) e na SAÍDA (`joinPages` trunca): não há limite de
 *   trabalho/memória POR-PÁGINA. Uma única página é trabalho sem bound
 *   mensurável — o teste "residual P1 documentado" prova isso rodando o parser
 *   real: com `maxChars` pequeno, a página volta materializada BEM acima dele
 *   (o teto não é aplicado dentro dela).
 * - **Como foi desligada:** `pdfTextProcessorOverride` passa a devolver
 *   `undefined` INCONDICIONALMENTE — `TED_PDF_TEXT_ENABLED=1` NÃO reativa o
 *   parser (nem com extractor injetado), e o parser real NUNCA é chamado pelo
 *   fluxo real de anexos: um PDF válido resolve `unsupported` (o fallback A13)
 *   e nenhum texto é extraído/persistido.
 * - **Upload/R2 intacto:** a rota de upload continua 200 e o objeto continua
 *   persistido no R2; só a LEITURA do PDF fica indisponível.
 * - **Deadline é de EVENTO, não de CPU:** com limite por-página inexistente, um
 *   parse travado continuaria queimando CPU depois de o turno responder — o
 *   `Promise.race` de 10 s NÃO cancela a CPU síncrona; a contenção real seriam
 *   os tetos de trabalho (que hoje não cobrem o single-page).
 *
 * O parser (`createUnpdfExtractor`), a dependência `unpdf` e o
 * `createPdfTextProcessor` permanecem no módulo — NADA é removido; só o WIRING
 * (override) está fechado, pendente de execução limitada (bounded execution).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PDF_EXTRACT_MAX_CHARS,
  PDF_EXTRACT_MAX_PAGES,
  createUnpdfExtractor,
  pdfTextProcessorOverride,
} from "../../src/multimodal/pdf-text.js";
import { bytesOf, createAttachmentTestAgent, installRelayMock, uploadRequest } from "./helpers.js";
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

const UPLOAD_GATE = { TED_ATTACHMENTS_ENABLED: "1", TED_ATTACHMENTS_COHORT: "ws-1,actor-1" } as const;

describe("P1 — gate fail-closed: TED_PDF_TEXT_ENABLED NÃO ativa o parser", () => {
  it("sem a env (ou com valor != '1') o override é AUSENTE — PDF segue 'unsupported'", () => {
    expect(pdfTextProcessorOverride(undefined)).toBeUndefined();
    expect(pdfTextProcessorOverride({})).toBeUndefined();
    expect(pdfTextProcessorOverride({ TED_PDF_TEXT_ENABLED: "0" })).toBeUndefined();
    expect(pdfTextProcessorOverride({ TED_PDF_TEXT_ENABLED: "true" })).toBeUndefined();
  });

  it("com TED_PDF_TEXT_ENABLED=1 o override CONTINUA AUSENTE (a env não reativa o parser)", () => {
    // P1 fail-closed: a flag não basta mais — a extração está indisponível
    // enquanto não existir limite por-página. Nem com a env ligada...
    expect(pdfTextProcessorOverride({ TED_PDF_TEXT_ENABLED: "1" })).toBeUndefined();
    // ...nem com um extractor injetado (o caminho legítimo dos testes) o
    // processor é construído: o override devolve undefined antes de qualquer
    // parser.
    expect(
      pdfTextProcessorOverride({ TED_PDF_TEXT_ENABLED: "1" }, {
        extractor: async () => ({ state: "ok" as const, pages: ["x"], pageCount: 1 }),
      }),
    ).toBeUndefined();
  });

  it("com TED_PDF_TEXT_ENABLED=1, um PDF no turno resolve 'unsupported' e o parser real NUNCA é chamado", async () => {
    // A env ligada é o pior caso da regressão: se o parser estivesse acessível,
    // um PDF com camada de texto viraria `processed` e o texto "Mercado Livre"
    // seria persistido. Observar `unsupported` + ausência do texto extraído é a
    // prova de que ZERO byte foi parseado pelo parser real.
    installRelayMock();
    const { agent, persisted } = createAttachmentTestAgent({ extraEnv: { TED_PDF_TEXT_ENABLED: "1" } });
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
        intentionId: "intent-pdf-disabled",
        attachments: [{ type: "pdf", ref: uploaded.ref, name: "nota.pdf" }],
      }),
    );

    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unsupported");
    // O parser real extrairia este texto; sua ausência prova que não rodou.
    expect(JSON.stringify(persisted)).not.toContain("Mercado Livre");
  });

  it("sem a env, um PDF no turno resolve 'unsupported' e o parser NUNCA é chamado", async () => {
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
  });
});

describe("P1 — upload/R2 NÃO é afetado pela desativação da leitura de PDF", () => {
  it("um PDF sobe pela rota real (200 + objeto no R2) e no turno segue 'unsupported'", async () => {
    installRelayMock();
    const { agent, bucket } = createAttachmentTestAgent({ extraEnv: { ...UPLOAD_GATE, TED_PDF_TEXT_ENABLED: "1" } });

    const uploadRes = await agent.fetch(
      uploadRequest(bytesOf(buildTextLayerPdf(["Mercado Livre 42,50"])), {
        "x-ted-attachment-kind": "pdf",
        "x-ted-attachment-name": "nota.pdf",
      }),
    );
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { ref: string };
    expect(uploaded.ref).toMatch(/^att_/);
    // Upload + write R2 intactos: um objeto persistido, nenhuma funcionalidade
    // de armazenamento foi tocada pela desativação da LEITURA.
    expect(bucket.objects.size).toBe(1);

    const chatRes = await agent.fetch(
      chatRequest({
        text: "anota",
        intentionId: "intent-pdf-r2",
        attachments: [{ type: "pdf", ref: uploaded.ref, name: "nota.pdf" }],
      }),
    );
    const body = (await chatRes.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.[0]?.state).toBe("unsupported");
  });
});

describe("residual P1 documentado — o teto de caracteres NÃO limita dentro de um page", () => {
  it("getTextContent() materializa a página inteira antes de qualquer teto (por que a extração está desligada)", async () => {
    const extractor = createUnpdfExtractor();
    // UMA página com texto muito acima do teto pedido. O laço só confere
    // `maxChars` ANTES de abrir a PRÓXIMA página, e o truncamento de saída
    // (`joinPages`) age DEPOIS: nenhum dos dois limita o que `getTextContent()`
    // já materializou DENTRO desta página. A página volta MAIOR que o teto — o
    // teto é cross-page/saída, NÃO um bound de trabalho/memória por-página.
    // (Nota honesta: este builder sintético extrai ~2500 chars/página por
    // artefato do fixture; a prova é relacional — qualquer extrato da página
    // excede o teto porque o teto não é aplicado dentro dela.)
    const smallCeiling = 1_000;
    const bytes = buildTextLayerPdf(["a".repeat(20_000)]);

    const outcome = await extractor({
      bytes: bytesOf(bytes),
      mime: "application/pdf",
      maxPages: PDF_EXTRACT_MAX_PAGES,
      maxChars: smallCeiling,
    });

    expect(outcome.state).toBe("ok");
    if (outcome.state !== "ok") throw new Error('expected "ok"');
    expect(outcome.pages[0]!.length).toBeGreaterThan(smallCeiling);
  });
});

describe("F4(b) — tetos do EXTRACTOR (cross-page + saída), preservados no módulo", () => {
  it("o teto de caracteres é early-exit ENTRE páginas: as páginas restantes NÃO são lidas", async () => {
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

/**
 * A05 — R05 (SPEC §5) / AC11: Markdown seguro no bubble do assistente.
 *
 * Invariantes testadas (nenhuma depende de biblioteca externa — o renderer é
 * in-house e constrói SOMENTE elementos React):
 *  - HTML bruto, <script> e <img onerror=…> são TEXTO LITERAL (inerte);
 *  - link só vira <a> com http/https ABSOLUTO, sempre `target="_blank"` +
 *    `rel="noopener noreferrer"`; javascript:/data:/file:/relativo/esquema
 *    desconhecido continuam texto;
 *  - imagem markdown não vira <img> (nenhum tracking remoto);
 *  - código (inline e bloco) é texto puro, sem parsing interno;
 *  - headings usam semântica de heading sem poluir o outline do documento;
 *  - tabela vive em contêiner com scroll horizontal e células quebram URL longa;
 *  - mensagem de usuário/membro continua TEXTO LITERAL.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@/lib/test-utils";
import { TedMarkdown, parseMarkdown, isSafeExternalUrl, isSpaceCode } from "../TedMarkdown";
import { TedMessage } from "../TedMessage";
import type { AgentMessage } from "@/lib/api/agent-client";

function assistant(content: string): AgentMessage {
  return { id: "m1", actorId: "ted", role: "assistant", content, createdAt: undefined, isOwn: false };
}

function userMessage(content: string): AgentMessage {
  return { id: "u1", actorId: "user-1", role: "user", content, createdAt: undefined, isOwn: true };
}

describe("R05 — HTML bruto é inerte (AC11)", () => {
  it("renderiza <script> como texto literal e não cria elemento script", () => {
    const { container } = render(<TedMarkdown content={"<script>alert(1)</script>"} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("não cria elemento a partir de HTML bruto com evento inline (<img onerror>)", () => {
    const { container } = render(<TedMarkdown content={'antes <img src="x" onerror="alert(1)"> depois'} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("img,script,iframe,object,embed,svg")).toHaveLength(0);
    expect(container.textContent).toContain('<img src="x" onerror="alert(1)">');
  });

  it("não rastreia imagem remota: sintaxe de imagem markdown vira texto inerte", () => {
    const { container } = render(<TedMarkdown content={"![pixel](https://tracker.test/p.gif)"} />);

    expect(container.querySelectorAll("img,object,embed")).toHaveLength(0);
    expect(container.textContent).toBe("![pixel](https://tracker.test/p.gif)");
  });

  it("sinal de imagem malformado continua texto, sem img", () => {
    const { container } = render(<TedMarkdown content={"!atenção ![abre sem fecha e ![x] solto"} />);

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toBe("!atenção ![abre sem fecha e ![x] solto");
  });

  it("não transforma tag com nome de link em elemento navegável", () => {
    const { container } = render(<TedMarkdown content={"<a href=\"javascript:alert(1)\">clique</a>"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain('<a href="javascript:alert(1)">clique</a>');
  });
});

describe("R05 — whitelist de protocolo de link", () => {
  const blocked: Array<[string, string]> = [
    ["javascript", "[clique](javascript:alert(1))"],
    ["data", "[clique](data:text/html;base64,PHNjcmlwdD4=)"],
    ["file", "[clique](file:///etc/passwd)"],
    ["vbscript", "[clique](vbscript:msgbox(1))"],
    ["ftp (esquema desconhecido)", "[clique](ftp://exemplo.test/a.txt)"],
    ["relativa", "[clique](/docs/relatorio)"],
    ["protocol-relative", "[clique](//evil.test/x)"],
    ["mailto (não é fonte externa http/https)", "[clique](mailto:alguem@exemplo.test)"],
    ["javascript com caixa mista", "[clique](JaVaScRiPt:alert(1))"],
  ];

  it.each(blocked)("mantém %s como texto inerte (sem <a>)", (_label, content) => {
    const { container } = render(<TedMarkdown content={content} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe(content);
  });

  it("https absoluto vira link com opener protection", () => {
    render(<TedMarkdown content={"[ TED](https://exemplo.test/relatorio)"} />);

    const link = screen.getByRole("link", { name: "TED" });
    expect(link).toHaveAttribute("href", "https://exemplo.test/relatorio");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("http absoluto também é aceito", () => {
    render(<TedMarkdown content={"[site](http://exemplo.test)"} />);

    const link = screen.getByRole("link", { name: "site" });
    expect(link).toHaveAttribute("href", "http://exemplo.test");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("link sem protocolo é neutro, mas o rótulo ainda é legível", () => {
    const { container } = render(<TedMarkdown content={"[rótulo]()"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("rótulo");
  });

  it("URL com parêntese escapado cai como texto (backslash é rejeitado por design)", () => {
    const { container } = render(<TedMarkdown content={"[doc](https://exemplo.test/a\\)b)"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("[doc](https://exemplo.test/a\\)b)");
  });

  it("href inseguro com parêntese escapado mantém a sintaxe original inteira", () => {
    const { container } = render(<TedMarkdown content={"[x](javascript:alert\\(1\\))"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("[x](javascript:alert\\(1\\))");
  });

  it("nunca emite href perigoso para entradas com espaço/controle/aspas", () => {
    const { container } = render(<TedMarkdown content={'[x](https://exemplo.test/" onmouseover="alert(1))'} />);

    expect(container.querySelector("a")).toBeNull();
  });
});

describe("R05 — inline", () => {
  it("renderiza negrito, itálico (asterisco e underscore) e código inline", () => {
    const { container } = render(<TedMarkdown content={"**forte** e *itálico* e _também_ e `código`"} />);

    expect(container.querySelector("strong")?.textContent).toBe("forte");
    const ems = Array.from(container.querySelectorAll("em")).map((el) => el.textContent);
    expect(ems).toEqual(["itálico", "também"]);
    expect(container.querySelector("code")?.textContent).toBe("código");
  });

  it("conteúdo de código inline é texto puro (sem parsing interno)", () => {
    const { container } = render(<TedMarkdown content={"`**não** <b>x</b> [l](https://a.test)`"} />);

    const code = container.querySelector("code");
    expect(code?.textContent).toBe("**não** <b>x</b> [l](https://a.test)");
    expect(code?.querySelector("strong, b, a")).toBeNull();
  });

  it("asterisco solto/matemático não vira itálico", () => {
    const { container } = render(<TedMarkdown content={"2 * 3 = 6 e 4 / 2"} />);

    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("2 * 3 = 6 e 4 / 2");
  });

  it("underscore dentro de palavra não vira itálico (snake_case)", () => {
    const { container } = render(<TedMarkdown content={"user_account_id"} />);

    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("user_account_id");
  });

  it("escape com backslash neutraliza o marcador", () => {
    const { container } = render(<TedMarkdown content={"\\*não é itálico\\*"} />);

    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("*não é itálico*");
  });

  it("quebra de linha dentro do parágrafo vira <br> e preserva o texto", () => {
    const { container } = render(<TedMarkdown content={"linha 1\nlinha 2"} />);

    expect(container.querySelector("br")).not.toBeNull();
    expect(container.textContent).toContain("linha 1");
    expect(container.textContent).toContain("linha 2");
  });

  it("emoji passa ileso (decorativo, sem strip)", () => {
    const { container } = render(<TedMarkdown content={"✅ tudo certo 🎉"} />);

    expect(container.textContent).toContain("✅ tudo certo 🎉");
  });
});

describe("R05 — blocos", () => {
  it("headings usam semântica de heading com aria-level e não poluem o outline", () => {
    const { container } = render(
      <TedMarkdown content={"# Um\n\n## Dois\n\n### Três\n\n#### Quatro\n\n##### Cinco\n\n###### Seis"} />,
    );

    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(screen.getByRole("heading", { level })).toBeInTheDocument();
    }
    expect(container.querySelectorAll("h1,h2,h3,h4,h5,h6")).toHaveLength(0);
  });

  it("listas não-ordenadas e ordenadas viram listas semânticas", () => {
    const { container } = render(<TedMarkdown content={"- um\n- dois\n\n1. primeiro\n2. segundo"} />);

    const ul = container.querySelector("ul");
    const ol = container.querySelector("ol");
    expect(ul?.querySelectorAll("li")).toHaveLength(2);
    expect(ol?.querySelectorAll("li")).toHaveLength(2);
    expect(ul?.textContent).toContain("um");
    expect(ol?.textContent).toContain("primeiro");
  });

  it("bloco cercado é texto puro com a informação da linguagem preservada", () => {
    const { container } = render(<TedMarkdown content={"```ts\nconst a = **1**;\n```"} />);

    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector("code")?.textContent).toBe("const a = **1**;\n");
    expect(pre?.querySelector("strong")).toBeNull();
    expect(pre?.getAttribute("data-language")).toBe("ts");
  });

  it("HTML dentro de bloco de código continua texto", () => {
    const { container } = render(<TedMarkdown content={"```\n<script>alert(1)</script>\n```"} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("<script>alert(1)</script>\n");
  });

  it("tabela GFM renderiza th/td e sobrevive a tabela malformada", () => {
    const { container } = render(
      <TedMarkdown
        content={
          "| Mês | Total |\n| --- | ---: |\n| Jan | R$ 10,00 |\n| Fev | R$ 20,00 |\n\n| solta | sem separador"
        }
      />,
    );

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(Array.from(table!.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["Mês", "Total"]);
    expect(Array.from(table!.querySelectorAll("td")).map((td) => td.textContent)).toEqual([
      "Jan",
      "R$ 10,00",
      "Fev",
      "R$ 20,00",
    ]);
    // The malformed trailing row is NOT a table (no separator) — it stays text.
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.textContent).toContain("| solta | sem separador");
  });

  it("parágrafos distintos são blocos distintos", () => {
    const { container } = render(<TedMarkdown content={"primeiro\n\nsegundo"} />);

    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("conteúdo vazio não quebra", () => {
    const { container } = render(<TedMarkdown content="" />);

    expect(container.textContent).toBe("");
  });
});

describe("R05 — acessibilidade e apresentação", () => {
  it("tabela vive em contêiner com scroll horizontal", () => {
    const { container } = render(
      <TedMarkdown content={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />,
    );

    const wrapper = container.querySelector("table")?.parentElement;
    expect(wrapper?.tagName).toBe("DIV");
    expect(wrapper?.className).toContain("overflow-x-auto");
  });

  it("célula quebra URL longa (break-words)", () => {
    const { container } = render(
      <TedMarkdown
        content={
          "| link |\n| --- |\n| https://exemplo.test/relatorio/2026/10/03/um/caminho/muito/longo/sem/espacos |"
        }
      />,
    );

    const cell = container.querySelector("td");
    expect(cell?.className).toContain("break-words");
  });

  it("link tem foco visível", () => {
    render(<TedMarkdown content={"[x](https://exemplo.test)"} />);

    const className = screen.getByRole("link", { name: "x" }).className;
    expect(className).toContain("focus-visible:outline-none");
    expect(className).toContain("focus-visible:ring-2");
  });

  it("hierarquia de headings é decrescente (nível 1 não é maior que o 6)", () => {
    const { container } = render(<TedMarkdown content={"# Um\n\n###### Seis"} />);

    const levels = Array.from(container.querySelectorAll('[role="heading"]')).map((el) => el.className);
    expect(levels).toHaveLength(2);
    expect(levels[0]).not.toBe(levels[1]);
    expect(levels[0]).toContain("font-bold");
  });
});

describe("R05 — helpers do renderer", () => {
  it("isSafeExternalUrl rejeita esquema http(s) SEM autoridade (resolvido contra base)", () => {
    // `new URL("https:relatorio")` NÃO lança: o parser WHATVG resolve o
    // esquema especial sem base e devolve `https://relatorio/` com hostname
    // não-vazio. Sem exigir a marca de autoridade `//`, o href viraria rota da
    // própria PWA em vez de destino externo.
    expect(isSafeExternalUrl("https:relatorio")).toBe(false);
    expect(isSafeExternalUrl("http:relatorio")).toBe(false);
    expect(isSafeExternalUrl("https:")).toBe(false);
    expect(isSafeExternalUrl("http:")).toBe(false);
    expect(isSafeExternalUrl("http://")).toBe(false);
    expect(isSafeExternalUrl("https://")).toBe(false);

    // Autoridade presente continua ACEITO (contrato preservado).
    expect(isSafeExternalUrl("https://exemplo.test")).toBe(true);
    expect(isSafeExternalUrl("https://exemplo.test/relatorio?a=1#b")).toBe(true);
    expect(isSafeExternalUrl("HTTPS://EXEMPLO.TEST")).toBe(true);
  });

  it("link com http(s) sem autoridade vira texto inerte, sem <a>", () => {
    const content = "[relatório](https:relatorio)";
    const { container } = render(<TedMarkdown content={content} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe(content);
  });

  it("isSafeExternalUrl aceita apenas http/https absoluto e sem whitespace/controle", () => {
    expect(isSafeExternalUrl("https://exemplo.test")).toBe(true);
    expect(isSafeExternalUrl("http://exemplo.test/a?b=1#c")).toBe(true);
    expect(isSafeExternalUrl("HTTPS://EXEMPLO.TEST")).toBe(true);

    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("JavaScript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<b>")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("/relativa")).toBe(false);
    expect(isSafeExternalUrl("relativa")).toBe(false);
    expect(isSafeExternalUrl("//exemplo.test")).toBe(false);
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl(" https://exemplo.test")).toBe(false);
    expect(isSafeExternalUrl("https://exemplo.test/ com espaco")).toBe(false);
    expect(isSafeExternalUrl("https://exemplo.test\\@evil.test")).toBe(false);
    expect(isSafeExternalUrl("https://exemplo.test\n")).toBe(false);
  });

  it("parseMarkdown é puro e determinístico", () => {
    const src = "# t\n\n- a\n- b\n\n[l](https://x.test)";
    expect(parseMarkdown(src)).toEqual(parseMarkdown(src));
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n\n")).toEqual([]);
  });

  it("entrada patológica não estoura a stack nem some texto", () => {
    const nested = "*".repeat(4000) + "x" + "*".repeat(4000);
    const unclosedFence = "```\n".repeat(500);
    const manyMarkers = "**a*_b`c[d](e".repeat(500);

    for (const src of [nested, unclosedFence, manyMarkers]) {
      expect(() => parseMarkdown(src)).not.toThrow();
      const { container, unmount } = render(<TedMarkdown content={src} />);
      expect(container.querySelector("script, img, iframe")).toBeNull();
      unmount();
    }
    // Além do teto de recursão o texto é preservado, a formatação não.
    expect(parseMarkdown(nested)[0]?.kind).toBe("paragraph");
  });

  it("TODO caractere da entrada patológica aparece na saída renderizada", () => {
    // Não basta não lançar: nenhum caractere pode SUMIR da renderização.
    // Entradas com sintaxe de código (```/`) ficam de fora de propósito: a
    // crase é DELIMITADOR, não conteúdo (invariante 4 do módulo), e um fence
    // isolado abre+fecha bloco vazio por regra CommonMark. O que não pode sumir
    // é o payload das entradas sem sintaxe de código.
    const inputs = [
      "*".repeat(4000) + "x" + "*".repeat(4000),
      "[".repeat(4000),
      "![".repeat(2000) + "x",
      "[a](".repeat(2000),
      "](".repeat(2000),
    ];

    for (const src of inputs) {
      const { container, unmount } = render(<TedMarkdown content={src} />);
      const rendered = container.textContent ?? "";
      for (const ch of new Set(src)) {
        expect(rendered, `caractere ${JSON.stringify(ch)} ausente`).toContain(ch);
      }
      unmount();
    }
  });

  it("entrada sem semântica de markdown preserva TODOS os caracteres, incluindo quebra", () => {
    // Nenhuma das entradas abaixo forma marcação válida, então a saída tem de
    // ser idêntica byte a byte (a quebra vira <br>, cujo textContent é vazio —
    // por isso a comparação é sobre nós/elementos, não só sobre textContent).
    for (const src of ["[".repeat(4000), "![".repeat(2000) + "x", "[a](".repeat(2000), "](".repeat(2000)]) {
      const blocks = parseMarkdown(src);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.kind).toBe("paragraph");
      const children = (blocks[0] as { children: Array<{ kind: string; value?: string }> }).children;
      // Só `break` pode introduzir nós além de texto; nenhum marcador é engolido.
      const nonText = children.filter((node) => node.kind !== "text");
      expect(nonText, `nós não-texto inesperados: ${JSON.stringify(nonText.map((n) => n.kind))}`).toHaveLength(0);

      const joined = children.map((node) => (node.kind === "text" ? (node.value as string) : "\n")).join("");
      expect(joined).toBe(src);
    }
  });

  it("conteúdo SEM semântica de markdown sobrevive ao teto de varredura byte a byte", () => {
    // `[a](` nunca forma link (parêntese de destino sem fechamento) e não tem
    // qualquer marcador válido: cada caractere da entrada tem de reaparecer,
    // mesmo quando o orçamento de varredura estoura no meio do caminho.
    const src = "[a](".repeat(40_000);

    const { container, unmount } = render(<TedMarkdown content={src} />);
    expect(container.textContent).toBe(src);
    unmount();
  });

  it("parse de entrada patológica fica dentro de tempo razoável (sem travar a renderização)", () => {
    // n = 2000 colchetes: laço pedido na revisão. Teto folgado — é guarda de
    // regressão contra travar a thread, não medida fina.
    const brackets = "[".repeat(2000);
    const startedBrackets = performance.now();
    parseMarkdown(brackets);
    const bracketsMs = performance.now() - startedBrackets;
    expect(bracketsMs).toBeLessThan(150);

    // Forma patológica com o pior caso real do renderer: o parêntese de destino
    // nunca fecha, então cada `[` revarre o sufixo inteiro (custo quadrático
    // que travava ~1s em 64KB). Teto generoso para não depender da máquina.
    const unclosedParen = "[a](".repeat(32_000);
    const startedParen = performance.now();
    parseMarkdown(unclosedParen);
    const parenMs = performance.now() - startedParen;
    expect(parenMs).toBeLessThan(500);
  });

  it("entrada legítima grande mantém a formatação (o teto de varredura não é atingido)", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `- **Mês ${i}**: R$ ${i},00 — [relatório](https://exemplo.test/rel/${i}) e _destaque_`,
    );
    const { container, unmount } = render(<TedMarkdown content={lines.join("\n")} />);

    // 400 listas, 400 negritos, 400 links, 400 itálicos: nada pode degrada
    // para texto literal por causa do orçamento.
    expect(container.querySelectorAll("ul > li")).toHaveLength(400);
    expect(container.querySelectorAll("strong")).toHaveLength(400);
    expect(container.querySelectorAll("em")).toHaveLength(400);
    expect(container.querySelectorAll("a")).toHaveLength(400);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://exemplo.test/rel/0");
    unmount();
  });

  it("cercado sem fechamento consome o resto como código (mesma regra do CommonMark)", () => {
    const { container } = render(<TedMarkdown content={"```\naberto\n\n**fechado**"} />);

    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("aberto\n\n**fechado**\n");
    // Texto permanece inerte e nada é interpretado dentro do bloco.
    expect(container.querySelector("strong")).toBeNull();
  });

  it("tabela com linha sem pipes fecha a tabela e vira parágrafo", () => {
    const { container } = render(<TedMarkdown content={"| a | b |\n| --- | --- |\n| 1 | 2 |\ntexto solto"} />);

    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("tr")).toHaveLength(2);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toBe("texto solto");
  });

  it("parágrafo colado numa tabela (sem linha vazia) quebra no cabeçalho", () => {
    const { container } = render(<TedMarkdown content={"Resumo:\nMês | Total\n--- | ---\nJan | 10"} />);

    expect(container.querySelector("p")?.textContent).toBe("Resumo:");
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("td")?.textContent).toBe("Jan");
  });

  it("pipe escapado (\\|) não quebra a célula", () => {
    const { container } = render(<TedMarkdown content={"| a | b |\n| --- | --- |\n| x \\| y | z |"} />);

    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("td")?.textContent).toBe("x | y");
  });

  it("parágrafo seguido de lista ou tabela é quebrado no bloco seguinte", () => {
    const { container } = render(
      <TedMarkdown content={"Resumo:\n- primeiro\n- segundo\n\n outro parágrafo\n\nMês | Total\n--- | ---\nJan | 10"} />,
    );

    expect(container.querySelector("p")?.textContent).toBe("Resumo:");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("th")?.textContent).toBe("Mês");
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });
});

describe("R05 — formatação de célula não depende da POSIÇÃO da coluna", () => {
  it("célula formatada na coluna 9 e 10 mantém negrito e link", () => {
    // Regressão: `.map(parseInline)` passa o ÍNDICE como `depth`, então a 10ª
    // coluna caía no fallback literal e a formatação dependia da posição.
    const header = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    const content = [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      `| a1 | a2 | a3 | a4 | a5 | a6 | a7 | a8 | **nove** | [dez](https://exemplo.test/dez) |`,
      `| b1 | b2 | b3 | b4 | b5 | b6 | b7 | b8 | *nove* | _dez_ |`,
    ].join("\n");

    const { container } = render(<TedMarkdown content={content} />);

    const headers = Array.from(container.querySelectorAll("th"));
    expect(headers).toHaveLength(10);
    // Formatação no cabeçalho também depende da coluna, não do índice.
    expect(headers[9]?.textContent).toBe("c10");

    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(2);

    const ninth = rows[0]!.querySelectorAll("td")[8]!;
    expect(ninth.querySelector("strong")?.textContent).toBe("nove");
    expect(ninth.textContent).toBe("nove");

    const tenth = rows[0]!.querySelectorAll("td")[9]!;
    expect(tenth.querySelector("a")).not.toBeNull();
    expect(tenth.querySelector("a")).toHaveAttribute("href", "https://exemplo.test/dez");

    const tenthB = rows[1]!.querySelectorAll("td")[9]!;
    expect(tenthB.querySelector("em")?.textContent).toBe("dez");
  });
});

describe("R05 — separador incompatível não inventa tabela", () => {
  it("separador com MENOS células que o cabeçalho mantém a linha como parágrafo", () => {
    const { container } = render(<TedMarkdown content={"a | b\n---"} />);

    expect(container.querySelectorAll("table")).toHaveLength(0);
    const paragraph = container.querySelector("p");
    // A quebra de linha vira <br> (o bubble preserva o newline com
    // whitespace-pre-wrap); o texto das duas linhas continua legível.
    expect(paragraph?.querySelectorAll("br")).toHaveLength(1);
    expect(paragraph?.textContent).toBe("a | b---");
  });

  it("separador incompatível no meio de um parágrafo não abre tabela", () => {
    const { container } = render(<TedMarkdown content={"a | b\nc | d\n---"} />);

    expect(container.querySelectorAll("table")).toHaveLength(0);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    const paragraph = container.querySelector("p");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(2);
    expect(paragraph?.textContent).toBe("a | bc | d---");
  });

  it("tabela legítima com separador completo continua sendo tabela", () => {
    const { container } = render(<TedMarkdown content={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />);

    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(Array.from(container.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["a", "b"]);
    expect(Array.from(container.querySelectorAll("td")).map((td) => td.textContent)).toEqual(["1", "2"]);
  });
});

describe("R05 — reconhecimento de bloco é LINEAR (sem backtracking de regex)", () => {
  // Os dois piores casos abaixo vinha dos `\s*` adjacentes de FENCE_RE e
  // TABLE_DELIM_RE: eles disputam os mesmos espaços no backtracking, e o custo
  // é quadrático em n (reprodução do reviewer: ~500ms/704ms com n=30000).
  // Tetos folgados: o ponto é barrar o quadrático, não medir a máquina.

  it("fence patológico (muitos espaços) não custa tempo quadrático", () => {
    const src = "```" + " ".repeat(30_000) + "!";

    const started = performance.now();
    parseMarkdown(src);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
  });

  it("separador patológico (muitos espaços) não custa tempo quadrático", () => {
    const src = "a | b\n-" + " ".repeat(30_000) + "X";

    const started = performance.now();
    parseMarkdown(src);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
  });

  it("linha de fence patológica NÃO some (vira parágrafo com o texto inteiro)", () => {
    const src = "```" + " ".repeat(200) + "!";
    const { container } = render(<TedMarkdown content={src} />);

    // Não é fence (o `!` no fim invalida), logo o texto precisa continuar visível.
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe(src);
  });

  it("linha de separador patológica NÃO some (vira parágrafo com o texto inteiro)", () => {
    // O pipe inicial evita que a linha seja reinterpretada como item de lista
    // (`- texto` casaria LIST_RE) — aqui o alvo é só a linha separadora.
    const tail = "-" + " ".repeat(200) + "X";
    const { container } = render(<TedMarkdown content={`a | b\n|${tail}`} />);

    expect(container.querySelectorAll("table")).toHaveLength(0);
    const paragraph = container.querySelector("p");
    // Uma quebra só: as duas linhas viram um parágrafo; o texto não é engolido.
    expect(paragraph?.querySelectorAll("br")).toHaveLength(1);
    expect(paragraph?.textContent).toBe(`a | b|${tail}`);
  });

  it("fence mantém semântica de marcador, linguagem e espaços", () => {
    const ts = render(<TedMarkdown content={"```ts\nconst a = 1;\n```"} />);
    expect(ts.container.querySelector("pre")?.getAttribute("data-language")).toBe("ts");
    expect(ts.container.querySelector("pre")?.textContent).toBe("const a = 1;\n");
    ts.unmount();

    // Tilde, marcador mais longo e espaços em volta da linguagem.
    const tilde = render(<TedMarkdown content={"~~~~ js\nconst b = 2;\n~~~~"} />);
    expect(tilde.container.querySelector("pre")?.getAttribute("data-language")).toBe("js");
    expect(tilde.container.querySelector("pre")?.textContent).toBe("const b = 2;\n");
    tilde.unmount();

    const bare = render(<TedMarkdown content={"```\nsem linguagem\n```"} />);
    expect(bare.container.querySelector("pre")?.getAttribute("data-language")).toBeNull();
    bare.unmount();

    // Linguagem richer: o charset original é [A-Za-z0-9_+-].
    const rich = render(<TedMarkdown content={"```a+b-c_1\ncorpo\n```"} />);
    expect(rich.container.querySelector("pre")?.getAttribute("data-language")).toBe("a+b-c_1");
    rich.unmount();

    // `!` não pertence ao charset de linguagem: não é fence.
    const notFence = render(<TedMarkdown content={"```!x"} />);
    expect(notFence.container.querySelector("pre")).toBeNull();
    expect(notFence.container.querySelector("p")?.textContent).toBe("```!x");
    notFence.unmount();

    // Menos de 3 marcadores não abre bloco: a linha fica como parágrafo.
    const tooShort = render(<TedMarkdown content={"``"} />);
    expect(tooShort.container.querySelectorAll("pre")).toHaveLength(0);
    expect(tooShort.container.querySelector("p")?.textContent).toBe("``");
    tooShort.unmount();

    // Dois marcadores + texto: idem, nenhum bloco de código.
    const twoTicks = render(<TedMarkdown content={"~~\ncorpo solto\n~~"} />);
    expect(twoTicks.container.querySelectorAll("pre")).toHaveLength(0);
    twoTicks.unmount();
  });

  it("separador mantém semântica de pipes externos, alignment e contagem", () => {
    // Sem pipes externos.
    const bare = render(<TedMarkdown content={"a | b\n--- | ---\n1 | 2"} />);
    expect(bare.container.querySelectorAll("table")).toHaveLength(1);
    bare.unmount();

    // Com pipes externos dos dois lados e alignment completo.
    const aligned = render(<TedMarkdown content={"x | y\n| :--- | ---: |\n1 | 2"} />);
    expect(aligned.container.querySelectorAll("table")).toHaveLength(1);
    expect(Array.from(aligned.container.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
      "x",
      "y",
    ]);
    aligned.unmount();

    // Alignment mínimo `:---:` continua válido.
    const centered = render(<TedMarkdown content={"x | y\n:-: | :-:\n1 | 2"} />);
    expect(centered.container.querySelectorAll("table")).toHaveLength(1);
    centered.unmount();

    // Linha de "- " é ITEM DE LISTA (LIST_RE), não separador: nenhuma tabela.
    const notDelimiter = render(<TedMarkdown content={"a | b\n- -\n1 | 2"} />);
    expect(notDelimiter.container.querySelectorAll("table")).toHaveLength(0);
    expect(notDelimiter.container.querySelector("p")?.textContent).toBe("a | b");
    expect(notDelimiter.container.querySelectorAll("ul > li")).toHaveLength(1);
    notDelimiter.unmount();
  });
});

describe("R05 — \s do engine congelado (isSpaceCode ≡ /\\s/)", () => {
  it("isSpaceCode casa EXATAMENTE o conjunto de code points que /\\s/ casa no BMP", () => {
    // Regressão do contrato: a varredura linear de fence/separador/heading/lista
    // depende de `isSpaceCode` reproduzir a classe `\s` do engine. Se um dia o
    // engine mudar o conjunto (ou o predicado divergir), este teste falha em vez
    // de degradar o parse silenciosamente.
    const divergent: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      const char = String.fromCodePoint(cp);
      if (isSpaceCode(cp) !== /\s/.test(char)) divergent.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    }

    expect(divergent).toEqual([]);
  });

  it("isSpaceCode reconhece o conjunto completo esperado (25 code points do BMP)", () => {
    const expected = [
      0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
      0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
      0x205f, 0x3000, 0xfeff,
    ];
    const actual: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (isSpaceCode(cp)) actual.push(cp);
    }

    expect(actual).toEqual(expected);
  });
});

describe("R05 — heading/lista são LINEARES (sem backtracking de regex)", () => {
  // `\s+(.*)$` reexaminava os espaços quando o conteúdo trazia U+2028/U+2029
  // (esses caracteres sobrevivem ao split("\n") mas `.` não os consome):
  // medido 616ms/787ms/667ms com n=30000. Tetos folgados — o alvo é barrar o
  // quadrático, não medir a máquina.

  it.each([
    ["heading", "#"],
    ["lista", "-"],
    ["ordered", "1."],
  ])("linha patológica de %s não custa tempo quadrático", (_label, prefix) => {
    const src = prefix + " ".repeat(30_000) + "X\u2028X";

    const started = performance.now();
    parseMarkdown(src);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
  });

  it.each([
    ["heading", "#"],
    ["lista", "-"],
    ["ordered", "1."],
  ])("linha patológica de %s NÃO some (vira parágrafo íntegro, byte a byte)", (_label, prefix) => {
    // U+2028 impede o fechamento de `(.*)$`: a linha NÃO é heading/list item,
    // logo precisa continuar visível como texto. O `trim()` interno do parser
    // remove o U+2028 das pontas — o miolo, não.
    const src = prefix + " ".repeat(200) + "X\u2028X";
    const { container } = render(<TedMarkdown content={src} />);

    expect(container.querySelector("[role='heading'], ul, ol")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe(prefix + " ".repeat(200) + "X\u2028X");
  });

  it("heading mantém semântica de nível, indentação e conteúdo", () => {
    const levels = render(<TedMarkdown content={"# Um\n\n### Três\n\n###### Seis"} />);
    expect(levels.container.querySelectorAll("[role='heading']")).toHaveLength(3);
    expect(levels.container.querySelector("[aria-level='3']")?.textContent).toBe("Três");
    levels.unmount();

    // Até 3 espaços de indentação; 4 não é heading (parágrafo).
    const indent3 = render(<TedMarkdown content={"   # indentado"} />);
    expect(indent3.container.querySelector("[role='heading']")).not.toBeNull();
    indent3.unmount();

    const indent4 = render(<TedMarkdown content={"    # fundo demais"} />);
    expect(indent4.container.querySelector("[role='heading']")).toBeNull();
    expect(indent4.container.querySelector("p")?.textContent).toBe("    # fundo demais");
    indent4.unmount();

    // 7+ `#` não é heading (limite é 6).
    const tooMany = render(<TedMarkdown content={"####### nope"} />);
    expect(tooMany.container.querySelector("[role='heading']")).toBeNull();
    expect(tooMany.container.querySelector("p")?.textContent).toBe("####### nope");
    tooMany.unmount();

    // `#` colado no texto não é heading (exige espaço).
    const glued = render(<TedMarkdown content={"#semEspaco"} />);
    expect(glued.container.querySelector("[role='heading']")).toBeNull();
    glued.unmount();
  });

  it("lista mantém semântica de marcador, indentação e delimitador", () => {
    const markers = render(<TedMarkdown content={"- a\n* b\n+ c"} />);
    expect(markers.container.querySelectorAll("ul > li")).toHaveLength(3);
    markers.unmount();

    // 3 marcadores: nenhum é item de lista.
    const notMarker = render(<TedMarkdown content={"-- a"} />);
    expect(notMarker.container.querySelectorAll("li")).toHaveLength(0);
    expect(notMarker.container.querySelector("p")?.textContent).toBe("-- a");
    notMarker.unmount();

    // 4 espaços de indentação não é item de lista.
    const indent4 = render(<TedMarkdown content={"    - fundo"} />);
    expect(indent4.container.querySelectorAll("li")).toHaveLength(0);
    expect(indent4.container.querySelector("p")?.textContent).toBe("    - fundo");
    indent4.unmount();

    // `-` colado no texto não é item.
    const glued = render(<TedMarkdown content={"-semEspaco"} />);
    expect(glued.container.querySelectorAll("li")).toHaveLength(0);
    glued.unmount();

    // Marcador com tab como separador continua item.
    const tabSep = render(<TedMarkdown content={"-\titem"} />);
    expect(tabSep.container.querySelectorAll("ul > li")).toHaveLength(1);
    tabSep.unmount();
  });

  it("lista ordenada mantém delimitador . e ) e limite de 9 dígitos", () => {
    const both = render(<TedMarkdown content={"1. ponto\n2) parêntese"} />);
    expect(both.container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(both.container.querySelector("ol")?.textContent).toContain("ponto");
    expect(both.container.querySelector("ol")?.textContent).toContain("parêntese");
    both.unmount();

    // 9 dígitos: ainda é item. 10 dígitos: não é.
    const nine = render(<TedMarkdown content={"123456789. nove"} />);
    expect(nine.container.querySelectorAll("ol > li")).toHaveLength(1);
    nine.unmount();

    const ten = render(<TedMarkdown content={"1234567890. dez"} />);
    expect(ten.container.querySelectorAll("li")).toHaveLength(0);
    expect(ten.container.querySelector("p")?.textContent).toBe("1234567890. dez");
    ten.unmount();

    // Delimitador ausente não é item ordenado.
    const noDelim = render(<TedMarkdown content={"1 ponto"} />);
    expect(noDelim.container.querySelectorAll("li")).toHaveLength(0);
    noDelim.unmount();
  });
});

describe("R05 — integração no bubble (usuário literal, assistente markdown)", () => {
  it("mensagem do assistente renderiza markdown", () => {
    const { container } = render(<TedMessage message={assistant("**Total**: R$ 10,00")} isCurrentUser={false} />);

    expect(container.querySelector("strong")?.textContent).toBe("Total");
  });

  it("mensagem do usuário permanece TEXTO LITERAL (nada de markdown)", () => {
    const { container } = render(
      <TedMessage
        message={userMessage("**Total**: R$ 10,00 e [ TED](https://a.test) e `código`")}
        isCurrentUser
        senderName="Você"
      />,
    );

    expect(container.querySelector("strong, code, a, em")).toBeNull();
    expect(container.textContent).toContain("**Total**: R$ 10,00 e [ TED](https://a.test) e `código`");
  });

  it("mensagem de outro membro permanece TEXTO LITERAL", () => {
    const { container } = render(
      <TedMessage
        message={{ ...userMessage("# não é heading"), isOwn: false, role: "user" }}
        isCurrentUser={false}
        senderName="Membro"
      />,
    );

    expect(container.querySelector('[role="heading"], h1, h2, h3')).toBeNull();
    expect(container.textContent).toContain("# não é heading");
  });

  it("payload hostil do assistente não executa nem rastrea", () => {
    const { container } = render(
      <TedMessage
        message={assistant('<img src="https://tracker.test/p.gif" onerror="alert(1)"> [clique](javascript:alert(2))')}
        isCurrentUser={false}
      />,
    );

    expect(container.querySelectorAll("img,script,a")).toHaveLength(0);
    expect(container.textContent).toContain("[clique](javascript:alert(2))");
  });

  it("render do assistente é estável entre re-renders do mesmo conteúdo", () => {
    const { container, rerender } = render(<TedMarkdown content={"a\n\nb"} />);
    const firstParagraph = container.querySelector("p");

    rerender(<TedMarkdown content={"a\n\nb"} />);
    expect(container.querySelector("p")).toBe(firstParagraph);
  });
});
import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /pendentes (legacy aprovações)", () => {
  it("issues a permanent 308 redirect to compromissos", async () => {
    const res = await GET(new Request("http://localhost:3000/pendentes"));

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("http://localhost:3000/compromissos");
  });

  it("preserves unknown query params in the redirect target", async () => {
    const res = await GET(
      new Request("http://localhost:3000/pendentes?token=abc&x=1"),
    );

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/compromissos?token=abc&x=1",
    );
  });

  it("drops the obsolete aba param", async () => {
    const res = await GET(new Request("http://localhost:3000/pendentes?aba=pendencias"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/compromissos");
  });
});

import { describe, expect, it } from "vitest";
import { accountSchema } from "./schemas";

describe("account presentation schema", () => {
  const base = { id: "a1", name: "Conta", balanceCents: 0 };

  it("defaults missing presentation values for older responses", () => {
    expect(accountSchema.parse(base)).toMatchObject({
      institutionId: null,
      cardProductId: null,
    });
  });

  it("parses nullable presentation values", () => {
    expect(accountSchema.parse({
      ...base,
      institutionId: "itau",
      cardProductId: null,
    })).toMatchObject({ institutionId: "itau", cardProductId: null });
  });
});

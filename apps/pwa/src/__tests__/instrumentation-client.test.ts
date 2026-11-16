import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("instrumentation-client", () => {
  it("liga o jitless do Zod para não sondar eval sob a CSP da PWA", async () => {
    await import("../instrumentation-client");
    expect(z.config().jitless).toBe(true);
  });

  it("não chama new Function ao construir e validar um schema de objeto", async () => {
    await import("../instrumentation-client");
    const original = globalThis.Function;
    let calls = 0;
    const spy = new Proxy(original, {
      construct(target, args, newTarget) {
        calls += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    globalThis.Function = spy as FunctionConstructor;
    try {
      const schema = z.object({ id: z.string().uuid(), n: z.number() });
      expect(schema.safeParse({ id: "00000000-0000-4000-8000-000000000001", n: 1 }).success).toBe(true);
    } finally {
      globalThis.Function = original;
    }
    expect(calls).toBe(0);
  });
});

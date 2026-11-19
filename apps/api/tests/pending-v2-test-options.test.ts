import { expect, it } from "vitest";
import { createInMemoryPendingOperationV2Store } from "../src/approvals/pending-v2.js";
import { buildTestApp } from "./test-app.js";

it("buildTestApp registers Pending V2 when the store is in test options", async () => {
  const { app } = buildTestApp({}, {
    pendingV2Store: createInMemoryPendingOperationV2Store(),
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/pending-operations/v2/propose",
      headers: { "idempotency-key": "synthetic-options-test" },
      payload: {},
    });

    expect(response.statusCode).not.toBe(404);
  } finally {
    await app.close();
  }
});

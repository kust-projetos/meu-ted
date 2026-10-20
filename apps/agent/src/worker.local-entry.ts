// LOCAL-ONLY entrypoint shim for `wrangler dev` (DO NOT deploy).
// Local workerd validates entrypoint exports strictly and rejects the extra
// named exports in worker.ts (e.g. EXPECTED_PWA_ORIGIN) that the production
// deploy path tolerates. This shim re-exports only what the runtime needs:
// the default handler and the Durable Object class. Production deploys keep
// using src/worker.ts unchanged.
export { default, FinanceChatAgent } from "./worker.js";

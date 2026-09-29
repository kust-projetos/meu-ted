import type { NextConfig } from "next";
import path from "node:path";
import withSerwistInit from "@serwist/next";
import { CANONICAL_REDIRECTS } from "./src/lib/routes";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: ["@pi-finance/llm-contracts"],
  // Client-bundle env inlining (production hotfix 2026-09-23): NEXT_PUBLIC_*
  // vars that stay undefined at build time keep a runtime `process.env` access
  // in the browser bundle, which forces the `process` polyfill module — absent
  // from this dependency graph — and crashes the client at boot (PWA stuck on
  // the ApiUnconfiguredScreen SSR fallback). Defining them here guarantees
  // textual inlining in every environment. Empty string is falsy and maps to
  // the same behavior as "absent" for every consumer (same-origin proxy
  // fallbacks, `=== "1"|"true"` flags, and the defensive numeric parse that
  // treats non-positive values as the 72h default).
  env: {
    NEXT_PUBLIC_PI_FINANCE_API_BASE_URL: process.env.NEXT_PUBLIC_PI_FINANCE_API_BASE_URL ?? "",
    NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL: process.env.NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL ?? "",
    NEXT_PUBLIC_TED_MICROPHONE: process.env.NEXT_PUBLIC_TED_MICROPHONE ?? "",
    NEXT_PUBLIC_TED_ATTACHMENT_INGESTION: process.env.NEXT_PUBLIC_TED_ATTACHMENT_INGESTION ?? "",
    NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS: process.env.NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS ?? "",
    NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT: process.env.NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT ?? "",
    // Semantics-preserving: undefined AND "" both resolve to compat ON
    // (token-store treats any value outside {"0","false","no","off"} as on).
    NEXT_PUBLIC_LEGACY_BEARER_COMPAT: process.env.NEXT_PUBLIC_LEGACY_BEARER_COMPAT ?? "",
  },
  webpack: (config) => {
    if (config.name === "client") {
      // Replace Next 16.3.x's client process polyfill with a safe stub (see
      // src/polyfills/process-client.js): the original's fallback
      // `require('next/dist/compiled/process')` gets a module id with no
      // factory in the emitted client graph and crashes the browser at boot.
      // Cover both entry points: the ProvidePlugin `process` target and the
      // polyfill's own fallback specifier.
      config.resolve.alias = {
        ...config.resolve.alias,
        process: path.resolve(__dirname, "src/polyfills/process-client.js"),
        "next/dist/compiled/process": path.resolve(__dirname, "src/polyfills/process-client.js"),
      };
    }
    return config;
  },
  // Item 13: absorbed page routes keep working as temporary redirects to
  // the canonical IA (tabs under /compromissos and /hub/*). Incoming query
  // (?accountId=, ?cardId=) is preserved by Next.js. permanent:false so a
  // future IA pass can change targets without poisoned caches.
  async redirects() {
    return CANONICAL_REDIRECTS.map((redirect) => ({ ...redirect, permanent: false }));
  },
};

const serwistConfig = {
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
  // SWCoordinator owns registration/update/reload so form dirty-state guards
  // and the live E2E request interceptor observe the same lifecycle.
  register: false,
  reloadOnOnline: true,
  disable: false,
};

export default withSerwistInit(serwistConfig)(nextConfig);

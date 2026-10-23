# PWA Audit Risk Acceptance

> Reviewed 2026-10-23 · Expires 2026-12-31 · Owner: project-maintainer
>
> Current findings are accepted under strict exact-field matching.
> The audit blocks immediately when a finding changes or this acceptance expires.

## Runtime (1)

| Package | Severity | Scope | Reason |
|---|---|---|---|
| `zod` | high | PWA runtime | GHSA-mrhx-c7xc-m3w5 (CVE-2023-54404) requires an attacker-controlled large array parsed by an **unconstrained** array schema. Every PWA array schema validates trusted API/Agent responses; the only external input path (`/api/csp-report`) caps bodies at 8192 bytes and validates bounded scalar fields, not arrays. `zod` 3.x has no patched release (the fix is `4.6.6`, a major migration); migrate to zod 4 before the review. |

## Build-Time (8)

| Package | Severity | Scope | Reason |
|---|---|---|---|
| `@lhci/cli`, `@lhci/utils`, `lighthouse`, `puppeteer-core`, `chromium-bidi` | high | Lighthouse CI only | One exact-match dependency chain rooted in Lighthouse. The 2026-10-23 advisory drift re-shaped the records (`via` now includes `zod`, `proxy-agent`, and `chromium-bidi`); npm's proposed resolution still downgrades `@lhci/cli`. Build-time toolchain, never shipped to Cloudflare production. |
| `@serwist/build`, `@serwist/next`, `@serwist/webpack-plugin` | high | Serwist build only | Affected solely through their nested `zod` copies while compiling the service worker during `pwa:build`; never runs in Cloudflare production. Resolved when the PWA migrates to zod 4. |

## Controls And Review

- The isolated PWA audit has only the PWA dependency graph and matches every
  record exactly (`name`, severity, `via`, effects, and range).
- The approval records expire on 2026-12-31; a new audit and owner decision
  are required before then.
- `wrangler` was upgraded to `4.152.0` (`miniflare` 5.20261019.2-beta →
  `sharp` 0.35.5), eliminating its former `miniflare`/`sharp` audit chain
  without an exception.
- Re-evaluate the remaining exact build-time exceptions if their dependency
  chains publish compatible remediations.

## Resolved in the current patch

- Next.js and `eslint-config-next` are pinned to `16.4.1`; Sharp and the
  `next>sharp` override are pinned to `0.35.5`, resolving critical runtime
  advisories GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr plus high
  GHSA-p3m5-59mp-jv5r fixed in Next.js `16.4.1`.
- Vitest and `@vitest/coverage-v8` are aligned to `4.1.12` throughout workspace
  manifests, resolving the `@vitest/mocker` advisories GHSA-qxg6-89mg-rqv8 and
  GHSA-xp26-3454-mjgp. These remediations are not accepted exceptions.
- Vite is pinned by the root override to `8.1.6`, resolving
  GHSA-587h-7wmj-h5pm (CVE-2026-112942) found in the API image. The release's
  Node engine and the existing Vitest and React plugin peer ranges accept this
  patch version; no scanner exception was added.

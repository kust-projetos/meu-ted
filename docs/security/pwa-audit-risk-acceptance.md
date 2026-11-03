# PWA Audit Risk Acceptance

> Reviewed 2026-11-03 · Expires 2026-12-31 · Owner: project-maintainer
>
> Current findings are accepted under strict exact-field matching.
> The audit blocks immediately when a finding changes or this acceptance expires.
>
> 2026-11-03 review (CI run 41630116732, `Scoped audit` job 125897226478):
> The run reported 31 blocked records: new advisories for `glob` and
> `minimatch`, the already-accepted Zod runtime advisory with a changed graph
> shape, and downstream records whose graph/range shape changed. Every current
> record has one precise `pwa-2026-11-03-*` entry; no unrelated record is
> accepted; strict exact matching remains intact. Prior decisions below are
> preserved unchanged.
>
> 2026-11-03 follow-up (CI run 41639892340, `Scoped audit` job 125930435456):
> The run revealed two additional alternate exact `effects` shapes for the
> already-accepted dev-only minimatch/ESLint chain — `eslint-plugin-import`
> with effects `[]` (first-run entry covers `['eslint-config-next']`) and
> `eslint-plugin-react` with effects `['eslint-config-next']` (first-run entry
> covers `[]`). Each has a separate exact `pwa-2026-11-03-*-effects-*` entry;
> no new advisory or risk family, and strict exact matching is unchanged.

## Runtime (2 shapes, 1 risk)

| Package | Severity | Scope | Reason |
|---|---|---|---|
| `zod` | high | PWA runtime | GHSA-mrhx-c7xc-m3w5 (CVE-2023-54404) requires an attacker-controlled large array parsed by an **unconstrained** array schema. Every PWA array schema validates trusted API/Agent responses; the only external input path (`/api/csp-report`) caps bodies at 8192 bytes and validates bounded scalar fields, not arrays. `zod` 3.x has no patched release (the fix begins at `4.6.6`, a major migration; target `4.6.7`); migrate to zod 4 before the review. 2026-11-03: npm re-reported the direct record with a changed effects graph (`pwa-2026-11-03-zod`, scope `runtime`) — same accepted risk, new audit shape. |

## Build-Time (2026-11-03 drift: LHCI / OpenNext / Serwist / Glob / Minimatch / Rimraf / Chrome)

| Package | Severity | Scope | Reason |
|---|---|---|---|
| `@lhci/cli`, `@lhci/utils`, `chrome-launcher`, `rimraf` | high/moderate | Lighthouse CI only | Exact graph/range shape drift of the already-accepted Lighthouse chain (now via the `chrome-launcher`/`rimraf`/`glob` path). Build-time toolchain, never shipped to Cloudflare production; npm proposes only the breaking `@lhci/cli` 0.3.3 major downgrade. |
| `@node-minify/core`, `@opennextjs/aws`, `@opennextjs/cloudflare`, `glob` | moderate | OpenNext build only | **New** advisory GHSA-3g3m-2fjr-6pw4 (Glob AbortSignal cancellation bypass, moderate) in the OpenNext build chain, plus shape drift of the already-accepted records. Build toolchain only; npm proposes only the breaking `@opennextjs/cloudflare` 0.3.0 major downgrade. |
| `@serwist/build`, `@serwist/next`, `@serwist/webpack-plugin`, `minimatch` | high/moderate | Serwist build only | **New** advisory GHSA-g3hv-75wg-m249 (minimatch globparts DoS, moderate) plus shape drift of the already-accepted Serwist records (via now includes `glob` alongside `zod`). Serwist compiles the service worker during `pwa:build`; never runs in Cloudflare production. The PWA's direct zod migration alone does not remediate nested Serwist copies; a compatible upstream release or separately tested override is still required. |

## Dev-Only (2026-11-03 drift: ESLint / TypeScript-ESLint / Stryker)

| Package | Severity | Scope | Reason |
|---|---|---|---|
| `eslint`, `@eslint-community/eslint-utils`, `@eslint/config-array`, `@eslint/eslintrc`, `@next/eslint-plugin-next`, `eslint-config-next`, `eslint-plugin-import`, `eslint-plugin-jsx-a11y`, `eslint-plugin-react` | moderate | Dev lint only | Exact graph/range shape drift of the already-accepted ESLint chain (via the new `minimatch` advisory). Dev dependencies, never bundled into the PWA runtime; npm proposes only breaking majors (`eslint` 4.0.0, `eslint-config-next` 12.0.4). |
| `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@typescript-eslint/type-utils`, `@typescript-eslint/typescript-estree`, `@typescript-eslint/utils`, `typescript-eslint` | moderate | Dev lint only | Same drift, TypeScript-ESLint side of the chain (via `minimatch`/`eslint`). Dev-only, same non-remediation. |
| `@stryker-mutator/core`, `@stryker-mutator/typescript-checker`, `@stryker-mutator/vitest-runner` | moderate | Dev mutation-testing only | Same drift via `minimatch`; no fix available. Dev-only, never shipped. |

## Previously accepted Build-Time entries (8)

| Package | Severity | Scope | Reason |
|---|---|---|---|
| `@lhci/cli`, `@lhci/utils`, `lighthouse`, `puppeteer-core`, `chromium-bidi` | high | Lighthouse CI only | One exact-match dependency chain rooted in Lighthouse. The 2026-10-23 advisory drift re-shaped the records (`via` now includes `zod`, `proxy-agent`, and `chromium-bidi`); npm's proposed resolution still downgrades `@lhci/cli`. Build-time toolchain, never shipped to Cloudflare production. |
| `@serwist/build`, `@serwist/next`, `@serwist/webpack-plugin` | high | Serwist build only | Affected through their nested `zod` copies while compiling the service worker during `pwa:build`; never runs in Cloudflare production. A direct PWA zod migration alone does not update these nested copies; resolution requires a compatible upstream release or a separately tested override. |

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
- `glob` is pinned by the root override `glob@^10` to `10.5.0`, resolving
  GHSA-5j98-mcp5-4vw2 (CLI command injection) in the `@node-minify/core` copy
  pulled by `@opennextjs/aws`. The `glob@13` copy used by the OpenNext adapter
  itself is outside the affected range. This is a remediation, not an accepted
  exception.
- `undici` is pinned by the root override `undici@^7` to `7.30.1`, resolving
  GHSA-4qv8-2p9j-2685 (EventSource parser DoS), GHSA-f72v-6w45-q472 (SRI
  algorithm bypass), and GHSA-xjj6-f33q-929c (content-encoding DoS). The
  previous `7.29.1` pin was reached through `miniflare` (build toolchain) and
  `jsdom` (test toolchain). This is a remediation, not an accepted exception.
- Vite is pinned by the root override to `8.1.6`, resolving
  GHSA-587h-7wmj-h5pm (CVE-2026-112942) found in the API image. The release's
  Node engine and the existing Vitest and React plugin peer ranges accept this
  patch version; no scanner exception was added.

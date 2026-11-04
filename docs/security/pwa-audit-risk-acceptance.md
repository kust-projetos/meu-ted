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
>
> 2026-11-04 follow-up (CI run 41824366393, `Scoped audit`):
> The run re-reported the already-accepted Lighthouse CI `rimraf` record with
> a bounded range shape (`2.3.0 - 3.0.2 || 4.2.0 - 6.1.3`, via `[glob]`,
> effects `[chrome-launcher]`). One exact `pwa-2026-11-04-rimraf` entry covers
> only that shape (scope `build-time`, chain Lighthouse → `chrome-launcher` →
> `rimraf` → `glob`); strict exact matching is unchanged and no audit
> criterion was relaxed.
>
> 2026-11-04 follow-up (CI run 41876660420, `Scoped audit` job 126737770091,
> PR #290 SHA `eb1010a`):
> The run re-reported the already-accepted dev-only TypeScript-ESLint/minimatch
> chain (`pwa-2026-11-03-minimatch`, GHSA-g3hv-75wg-m249) with two alternate
> exact graph shapes — `@typescript-eslint/eslint-plugin` with effects
> `['typescript-eslint']` (first-run entry covers `[]`) and
> `@typescript-eslint/parser` with via
> `['@typescript-eslint/typescript-estree','@typescript-eslint/type-utils','@typescript-eslint/utils','eslint']`
> and effects `['@typescript-eslint/eslint-plugin']` (first-run entry covers
> via `['@typescript-eslint/typescript-estree','eslint']` with effects
> `['@typescript-eslint/eslint-plugin','typescript-eslint']`). Each has a
> separate exact `pwa-2026-11-04-typescript-eslint-*-shape` entry (scope
> `dev-only`, expires 2026-12-31); no new advisory or risk family. Both rows
> report `fixAvailable: eslint-config-next@12.0.4 isSemVerMajor:true` — a
> breaking major downgrade that is not applied and does not alter dependencies.
> Strict exact matching is unchanged; the full audit is not claimed green until
> rerun.
>
> 2026-11-04 follow-up (PWA CI run 41900996857, Scoped audit job 126823057023,
> HEAD 0c9cbce):
> The run reported ten exact graph shapes from the same already-accepted
> families: seven dev-only records (@stryker-mutator/core,
> @stryker-mutator/typescript-checker, @typescript-eslint/eslint-plugin,
> @typescript-eslint/parser, @typescript-eslint/type-utils,
> @typescript-eslint/utils, eslint-config-next) plus the build-time aggregate
> glob row and the narrower minimatch row and the dev-only typescript-eslint
> row. npm transitive graph/advisory metadata reshaped (narrower via/effects/range
> windows, alternate aggregate via); this is a shape change, not a claim that any
> advisory was fixed or remediated. Each shape has one separate exact
> pwa-2026-11-04-* entry (scopes as recorded, all expire 2026-12-31); no generic
> or pattern acceptance was added and strict exact matching is unchanged. No
> breaking major upgrade/downgrade is applied by this acceptance. The full scoped
> audit must be rerun; green is not claimed until that rerun passes.

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
| `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@typescript-eslint/type-utils`, `@typescript-eslint/typescript-estree`, `@typescript-eslint/utils`, `typescript-eslint` | moderate | Dev lint only | Same drift, TypeScript-ESLint side of the chain (via `minimatch`/`eslint`). Dev-only, same non-remediation. 2026-11-04: two alternate exact shapes accepted (`pwa-2026-11-04-typescript-eslint-eslint-plugin-shape`, `pwa-2026-11-04-typescript-eslint-parser-shape`); `eslint-config-next@12.0.4` fix is a breaking major downgrade, not applied. |
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
- The 2026-11-04 `rimraf` drift keeps the same posture: investigating a
  compatible remediation (upstream fix or separately validated override)
  remains future work. The only npm-observed option — the breaking
  `@lhci/cli` 0.3.3 major downgrade — is unverified for this toolchain and
  was not applied; no automatic downgrade is authorized by this acceptance.

### Future `rimraf` remediation experiment (not applied)

The current upstream `@lhci/cli` 0.16.0 still declares
`chrome-launcher: ^0.13.4`; `chrome-launcher` 0.13.4 depends on
`rimraf: ^3.0.2`. The upstream `chrome-launcher` 0.14.0 release removed
`rimraf` (and `mkdirp`); 0.15.2 remains CommonJS, while the 1.x line is
ESM-only. A narrowly scoped override of the LHCI `chrome-launcher` branch to
0.15.2 is therefore a candidate to remove this path without downgrading
`@lhci/cli`, but compatibility is **not proven** and the override is not
installed in this patch.

Before replacing this risk acceptance, a separate branch must verify the
resolved PWA graph (`pnpm why chrome-launcher rimraf glob`), run
the Lighthouse collection/build path on Linux/Node 22/npm 10 and the existing
supported local platforms with report output kept local (no public upload),
check browser launch and cleanup/teardown for hangs or `EPERM`, and rerun the
exact scoped audit with no new allowlist shape. If any check fails or the
vulnerable `rimraf` node remains, keep this expiring build-time acceptance and
do not apply the breaking `@lhci/cli` 0.3.3 downgrade.

Sources: [@lhci/cli 0.16.0 manifest](https://registry.npmjs.org/@lhci/cli/0.16.0),
[chrome-launcher 0.13.4 manifest](https://registry.npmjs.org/chrome-launcher/0.13.4),
[chrome-launcher 0.15.2 manifest](https://registry.npmjs.org/chrome-launcher/0.15.2),
[upstream chrome-launcher changelog](https://github.com/GoogleChrome/chrome-launcher/blob/main/changelog.md).

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

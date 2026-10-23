# PWA Audit Risk Acceptance

> Reviewed 2026-09-19 · Expires 2026-12-31 · Owner: project-maintainer
>
> Six current build-time vulnerabilities are accepted under strict exact-field matching.
> The audit blocks immediately when a finding changes or this acceptance expires.

## Build-Time (6)

| Package | Severity | Scope | Reason |
|---|---|---|---|
| `@lhci/cli`, `@lhci/utils`, `lighthouse`, `puppeteer-core`, `@puppeteer/browsers`, `extract-zip` | high | Lighthouse CI only | This is one exact-match dependency chain. Two path-traversal advisories remain in `extract-zip`; npm's proposed resolution downgrades `@lhci/cli` from `0.15.1` to `0.12.0`, so no non-breaking fix is available. |

## Controls And Review

- The isolated PWA audit has only the PWA dependency graph and matches every
  record exactly (`name`, severity, `via`, effects, and range).
- The approval records expire on 2026-12-31; a new audit and owner decision
  are required before then.
- Historical note (2026-09-19): `sharp@0.35.4` failed the OpenNext Cloudflare
  bundle on Windows. That prior acceptance is superseded: Next.js `16.4.1`
  requires the fixed Sharp line (`^0.35.5`), and the critical advisories
  GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr are not covered by the old
  acceptance. Next, eslint-config-next, and Sharp are now pinned to `16.4.1`,
  `16.4.1`, and `0.35.5`; the scoped `next>sharp` override is `0.35.5`.
- `wrangler` was upgraded to `4.135.0`, eliminating its former
  `miniflare`/`sharp` audit chain without an exception.
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

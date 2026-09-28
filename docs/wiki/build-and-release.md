# Build & release

Three tsup entry groups build core, voice, and framework wrappers to ESM/CJS/IIFE (es2020 targets, minified). Size budgets are hard CI gates. Releases flow through changesets.

## Build configs (`tsup.config.ts`)

- **Core + separate optional entries** (`src/core/index.ts`, `src/capture/index.ts`, `src/handoff/index.ts`, `src/voice/index.ts`, `src/verification/index.ts`, `src/instrumentation/index.ts`): ESM + CJS. Verification and development instrumentation are independent ESM/CJS exports, with no core import edge. Instrumentation receives TypeScript from its host and uses only Node built-ins at runtime. Core externalizes `pinflowjs/voice` so the lazy `import('pinflowjs/voice')` stays a runtime reference — voice never enters the core graph ("0 bytes for text users").
- **IIFE** (`src/core/iife.ts` → `dist/pinflow.iife.js`): minified standalone bundle for CDN (unpkg/jsdelivr). Also externalizes `pinflowjs/voice`.

**All three configs set `treeshake: true`.** The IIFE entry was the sole omission until 0.9.0, and it cost 191 B gz: because the voice specifier is an external DYNAMIC import, esbuild emits its `__require`/`__toESM` CJS-interop preamble unconditionally, and rollup's post-pass is what drops it. Use `true`, never `'smallest'` — that preset sets `propertyReadSideEffects: false`, which licenses rollup to delete the layout-forcing `.offsetHeight`/`.offsetWidth` reads in `annotator.ts` that exist to flush style. The change is invisible in raw bytes (raw fell 32 B while gz fell 296 B on the shipped artifact), so judge it on `pnpm size` only.

- **Wrappers** (`src/react/index.ts`, `src/vue/index.ts`): ESM + CJS. They import bare `pinflow` (not dist paths), resolved by the consumer's bundler through this package's `exports` map — prevents shipping a second copy of core inside each wrapper and keeps wrappers ~1 KB.

**Private-member mangling:** `mangleProps: /^_/` (the `MANGLE_PRIVATE` regex in `tsup.config.ts`) is applied to every config. `_`-prefixed members (Annotator, GestureController, TranscriptStore, …) are renamed during minification — never rename or un-prefix them casually; they are part of the minification contract.

**`__PINFLOW_VERSION__`** is a compile-time define read from `package.json`. Vitest doesn't inject it; `src/core/index.ts` carries a `typeof` fallback for test runtime.

## Size budgets (`package.json` `size-limit`)

| Entry         | Budget (gz) |
| ------------- | ----------- |
| core IIFE     | 30.81 KB    |
| core ESM      | 30.68 KB    |
| voice ESM     | 4.45 KB     |
| capture ESM   | 25 KB       |
| handoff ESM   | 7 KB        |
| react wrapper | 0.51 KB     |
| vue wrapper   | 0.69 KB     |

`pnpm size` gates CI (`verify` job) and publishing (`prepublishOnly` runs build + test + size). Policy: budgets only ratchet **down** between features — kept razor-thin over actuals so regressions surface immediately. Raises happen only as deliberate, changeset-documented trades, and are re-ratcheted to actuals afterwards: once for the v3 lifecycle features, again for the 0.4.1 reliability fixes (CSP-safe stylesheet adoption, heal-ladder correctness), again for the 0.5.0 direct-manipulation arc, again for the 0.6.1 coarse-container-anchor fix, and again for actionable feedback (structured capture/export, the expected-outcome field, per-tab baseline reconciliation — see `.changeset/actionable-feedback-size.md`). Ceilings are set from **linux CI actuals**, which run a few bytes above a local macOS measurement. Check budget impact after any core change.

**The Linux/macOS gap is still scaling, and it is now the whole margin.** Measured on this repo: ~20 B at 17 KB, then 50 B (ESM) and 100 B (IIFE) at 22 KB, and **120 B on BOTH entries at 23.8 KB**. 0.11.1 shipped at 23.8 against a 23.81 ceiling — about ten bytes — which left no room for the correctness fix that followed and forced an approved raise one release later. A ceiling set from a local `pnpm size` is not a ceiling; it is a coin flip that gets tighter every release. Set it generously, read the figure CI reports, ratchet to that plus ~50 B. 0.12.0 followed that procedure across three stacked features (Keep/Clear row, dialog-layer binding, accessible-name rung): the gap measured 80 B (IIFE) and 90 B (ESM) at 24.9 KB — smaller than the 120 B at 23.8, so it is not monotonic either; predicting it in either direction is the mistake. Actionable feedback measured only 30 B (IIFE) and 20 B (ESM) at 26.6 KB.

**A re-ratchet re-stales the wiki marker.** The ratchet commit necessarily lands AFTER the CI run that produced its number, so it lands after the `.last-sync` move that certified the branch — and it touches `package.json`, a watched path. `wiki:check` then fails on a branch that was green minutes earlier. Expect to move the marker a second time, as the final commit, after the ratchet.

**The two core entries can move in opposite directions, and 0.9.0 is the case that proved it.** The same golf pass freed 278 B on IIFE and only 91 B on ESM — treeshaking recovered a CJS-interop preamble that only the IIFE build emitted — so the artifact-quality fixes that followed fitted inside the IIFE ratchet and did not fit inside ESM's. ESM's ceiling was raised mid-release as an approved trade and then ratcheted back **below** its starting point once builder-mode UI was removed later in the same release — 22.42 → 22.6 → 22.04. Never reason about "the core budget" as one number, never assume a saving measured on one entry transfers to the other, and do not treat a mid-release raise as final: the number that matters is the one on the merge commit.

**The local↔CI gap scales with bundle size**, measured twice in 0.9.0 on the same machine and
runner: **103 B IIFE at 22.65 kB**, then **74 B IIFE at 22.17 kB** after the bundle shrank. ESM
sat at ~70 B both times, above the ~50 B this repo previously assumed. Never predict it; push,
read the figure CI prints, ratchet to that + ~50 B.

**Two measurement traps, both hit in practice.** Deleting source that is ALREADY tree-shaken out can GROW gz — removing the unused `clearProject` export cost +2 B on ESM, because the bundle bytes never contained it and the only effect was perturbing gzip's dictionary. And **comment-level changes to `dist` can never move the gate**: `size-limit` re-bundles and re-minifies with its own esbuild pass before gzipping, so stripping a duplicate `sourceMappingURL` measured exactly 0 B. For the same reason the gate figure is not the gzip of the shipped file — a hand-rolled `gzipSync(dist/...)` read 133 B lower than `pnpm size`. Never substitute one for the other.

**Per-item byte estimates are not reliable at this size**, in either direction: in 0.9.0 one fix estimated at ~50 B measured 155 B, while two estimated at ~60 B together measured 5 B because both reused patterns already in the bundle. Land related cuts as ONE commit and quote the bundle figure, never the line items.

## Release flow

- `pnpm changeset` for every user-facing change (`.changeset/config.json`: public access, baseBranch `main`).
- The package publishes **unscoped as `pinflowjs`** from `github.com/pinflowjs/pinflow` (`package.json` `name`, `repository`, `homepage`, `bugs`). The former `@brijeshp/pinflow` name is deprecated on npm and must not be reintroduced anywhere a consumer copies from (README, `docs/guide.md`, `agent/`, `examples/`). The self-reference specifiers in `tsup.config.ts` (`external`), `vitest.config.ts` (`alias`), `tsconfig.json` (`paths`) and the `size-limit` `ignore` lists must all name the same package string.
- `release.yml` uses `changesets/action@v1` to open a version PR / publish to npm on push to `main` (requires `NPM_TOKEN`).
- npm publish protections are belt-and-braces: `files` allowlist (`dist`, `agent`, `README.md`, `LICENSE`, `CHANGELOG.md`) **and** a whitelist-style `.npmignore` (`*` then `!` negations). Both must be updated together when adding a shipped directory — `files` alone happens to work with `npm pack`, but the two disagreeing defeats the point of having both. Provenance enabled (`publishConfig.provenance: true`).
- **`agent/`** ships the artifact reading protocol in four formats (skill, slash command, editor rule, `AGENTS.md` snippet); `agent/README.md` maps each to the tools that read it. Markdown only — it is not part of any bundle and costs consumers zero bytes, but it is published, so it is part of the package's public surface.

## CI (`.github/workflows/`)

- **e2e caches Playwright browsers** (`~/.cache/ms-playwright`, keyed on the lockfile hash). Without it `playwright install --with-deps` hits an external CDN every run; on 2026-08-19 that step hung 89 minutes without reaching `pnpm build`, which is indistinguishable from a broken suite until you read the step list. On a cache hit only `install-deps` runs (apt packages are not in the cached path).
- **`ci.yml`** — `verify` job: `scripts/provenance-check.mjs` (no AI-agent attribution in commit messages since 2026-08-10 — the AGENTS.md invariant, enforced on the log itself), `format:check`, `typecheck`, `build` (BEFORE tests so bundle-isolation hard-fails rather than skips), `test:coverage` (the 80/75 thresholds are enforced in CI), `size`, `wiki:check`. `e2e` job: build + Playwright across chromium / mobile-chrome / mobile-safari. pnpm caching in both.
- **`release.yml`** — changesets publish on push to `main`, gated by re-running the full battery (format/typecheck/build/coverage/size/E2E/wiki-check) on the exact SHA before publishing; `prepublishOnly` independently runs build + coverage + size.
- The remote is `origin` (public GitHub) and both workflows are **live**: pushing `main` triggers the release chain — `release.yml` runs the full battery on that SHA, then changesets opens a "Version Packages" PR, and npm publish fires only when that PR is merged. Treat every push to `main` as a release act.

## Command reference (`package.json` scripts)

| Command              | Does                                            |
| -------------------- | ----------------------------------------------- |
| `pnpm build`         | tsup (all configs)                              |
| `pnpm dev`           | tsup --watch                                    |
| `pnpm test`          | vitest run                                      |
| `pnpm test:watch`    | vitest watch                                    |
| `pnpm test:coverage` | vitest run --coverage                           |
| `pnpm test:e2e`      | playwright test                                 |
| `pnpm typecheck`     | tsc --noEmit                                    |
| `pnpm format`        | prettier --write .                              |
| `pnpm format:check`  | prettier --check . (CI gate)                    |
| `pnpm size`          | size-limit (CI + prepublish gate)               |
| `pnpm wiki:check`    | wiki staleness check (`scripts/wiki-check.mjs`) |
| `pnpm changeset`     | create a changeset                              |
| `pnpm release`       | build + changeset publish                       |

Prettier config lives inline in `package.json`: singleQuote, semi, trailingComma `all`, printWidth 100. Engines: node >= 18; package manager: pnpm.

The feedback target-integrity feature has an owner-approved core budget increase
for entity/shadow constraints, modal handling, bounded capture facts and current
resolution diagnostics. CI measured 30.76 kB IIFE and 30.63 kB ESM for this feature. Each core
ceiling was ratcheted to its own CI result plus approximately 50 bytes.
Voice and framework wrapper ceilings are unchanged.

Capture and handoff are independent ESM/CJS entries with no runtime dependencies. Capture excludes handoff UI and serialization; handoff can be dynamically loaded by a host before enabling its Share button. Check their separate compressed sizes and the sum a host downloads after exporting; do not describe deferred bytes as removed bytes. The new-entry ceilings are provisional pending CI measurement and ratcheting. Existing full-entry ceilings remain unchanged: the pending mobile fixes plus the capture/handoff boundary exceed them locally, so publication requires an explicit owner-approved trade and the normal CI ratchet procedure.

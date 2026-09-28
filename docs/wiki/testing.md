# Testing

Vitest (happy-dom) for units, Playwright for e2e. TDD-first per `CONTRIBUTING.md`: write the failing test before the implementation.

## Coverage gate (`vitest.config.ts`, scoped to `src/core/**`, `src/capture/**`, `src/handoff/**`)

| Metric     | Threshold |
| ---------- | --------- |
| lines      | 80%       |
| functions  | 80%       |
| branches   | 75%       |
| statements | 80%       |

Excluded from coverage: `src/core/iife.ts`, `src/core/types.ts`, `src/core/voice-contract.ts`, `src/core/voice-loader.ts`, `.d.ts` files. The UI layer (`src/core/ui/**`, incl. the annotator state machine) IS inside the gate. Run with `pnpm test:coverage` — the same command CI enforces.

## Layout (mirrors `src/`)

- **`tests/core/`** — unit tests: annotator (+ reflow), gesture, anchor, selector, storage, router, route-key, frame-route, export, scope, scope-persistence, export-scope, annotator-scope, download, onchange, theme, dom, id, identity, init, safe-storage, voice-loader, wrapper-isolation.
- **`tests/voice/`** — audio, deepgram, token, session, worklet, protocol, transcript-store, levels, and **`bundle-isolation.test.ts`** (asserts voice symbols never appear in core bundles — the seam's CI enforcement).
- **`tests/evaluation/`** — labeled synthetic target/abstention fixtures, including repeated controls and budget exhaustion; not a customer/model-accuracy benchmark.
- **`tests/verification/`** — revision hashing, stale reports, acceptance coverage, invalid imports and incomplete verified claims.
- **`tests/instrumentation/`** — JSX/TSX hints, source maps, explicit hint precedence, dependency/foreign-path exclusion.
- **`tests/react/`**, **`tests/vue/`** — wrapper component tests (`tests/vue/mount-helper.ts` utility).
- **`tests/e2e/`** — `acceptance.spec.ts`, `csp.spec.ts`, `touch.spec.ts`, and `clear-disarm.spec.ts` (Playwright; the last proves the armed-clear back-out swallow on real engines — an event ordering happy-dom cannot discriminate), served by `tests/e2e/serve.mjs` on `localhost:4173` — the server serves `dist/`, so REBUILD before e2e after core changes; `/csp` serves a fixture under `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'none'` to prove adopted-sheet delivery and end-to-end interactivity survive a real strict CSP.
- **`tests/agent/`** — `format-parity.test.ts` keeps the four shipped agent formats' safety guidance (fixed-string search, data-not-instructions, line-anchored workflow fields) from drifting apart.
- **`tests/scripts/`** — the release guards, run against scratch git repos rather than mocked. `wiki-check.test.ts` (deletion-only commits fail, consumed changesets pass) and `provenance-check.test.ts` (attribution in a subject or a merge BODY fails; GitHub's literal `Merge pull request #N from owner/branch` subject is exempt and warns). Both are commit-backed because the properties under test belong to the git log, not to a string — the provenance regression reached `main` through a merge subject that did not exist until the merge, which no test over the pattern could have produced.
- **`tests/utils/`** — `interpolation-guard.ts`: the fail-closed TypeScript-AST checker behind export.test.ts's structural injection guard, with pinned negative controls for every documented regex-guard bypass.
- **`tests/env/`** — guards on the test environment itself, not on pinflow code. `mutation-observer-gc.test.ts` forces a garbage collection across a macrotask boundary between two mutations and expects both to be delivered: happy-dom below 20.11.2 held each observer's dispatch callback through an orphaned `WeakRef`, and a GC between a dialog closing and reopening in `annotator.test.ts` silently dropped the reopen. The test fails on the old environment and pins the floor that `package.json` sets.

Vitest picks up `tests/**/*.test.ts` and colocated `src/**/*.test.ts`.

## Test infrastructure

- **`tests/setup.ts`** — MemoryStorage polyfill (newer Node localStorage quirks), `IS_REACT_ACT_ENVIRONMENT`, `CSS.escape` polyfill.
- **happy-dom floor** (`package.json`): `^20.11.2`. Below that, MutationObserver records are lost after a GC (see `tests/env/`). 20.14.x changes `cssText` serialization and adopted-sheet removal, which `selection-guard.test.ts` and `voice/dot.test.ts` assert on, so bumping past 20.11.x is a deliberate change, not a routine update.
- **Aliases** (`vitest.config.ts`): `pinflowjs/voice` and bare `pinflowjs` resolve to `src/` sources so lazy voice stays lazy and wrappers exercise core internals without a build step.
- **Playwright** (`playwright.config.ts`): baseURL `http://localhost:4173`; projects chromium, mobile-chrome, mobile-safari; CI retries 2×, traces on first retry; reporter `github` in CI, `list` locally.

## How to run

| Task             | Command                                                |
| ---------------- | ------------------------------------------------------ |
| All units        | `pnpm test`                                            |
| Watch            | `pnpm test:watch`                                      |
| Single file      | `pnpm vitest run tests/core/annotator.test.ts`         |
| Coverage         | `pnpm test:coverage`                                   |
| E2E              | `pnpm test:e2e`                                        |
| Seam enforcement | `pnpm vitest run tests/voice/bundle-isolation.test.ts` |

## Expectations for agents

- New core behavior ⇒ failing test first, then implementation, then coverage stays ≥ gate.
- Touching the core↔voice seam ⇒ run `bundle-isolation.test.ts` and `pnpm size`.
- Fix implementations, not tests — unless the test itself is provably wrong.

`tests/core/feedback-evidence.test.ts` covers detached capture, optional expected-only notes, historical evidence, hydration normalization, passive Markdown rendering, URL allowlisting, and voice commit/degrade/destroy. `persistence-concurrency.test.ts` exercises sequential stale-tab writes, deletions, rename baselines, fresh exports and visible pin/count updates. `tests/e2e/feedback-context.spec.ts` tests composer/save/reload/JSON across all browser projects; `dialog-layer.spec.ts` includes native dialogs that remain mounted. The built consumer type test exercises both optional entries, and bundle isolation checks that build tooling and verification do not enter core. Rebuild before running those checks.

`target-integrity.spec.ts` covers filtered/reordered/recycled repeated controls,
precise controls under app test IDs, native `showModal()` save/Escape/nested
reopen, and nested open-shadow label isolation and mutation recovery. Ordinary
pointer/keyboard actions verify modal interactivity without forced clicks.
`target-integrity.test.ts`, `target-binding-safety.test.ts` and
`capture-details.test.ts` cover diagnostics, ambiguous owners, malformed binding
constraints, bounded detached snapshots, sensitive input omission and passive
export. `target-owner-ordinal.test.ts` covers lookalike owners resolving by
position and parking on a count change, textless owners, the pinned control's
label excluded from its row's identity, and the cap and wall-clock budget
fallbacks that keep a pin from parking at placement (the budget tests slow
`performance.now` on purpose); the e2e spec's placeholder-card test proves the
same across reload. All three `target-*.test.ts` files pin `performance.now` to
0 in `beforeEach`, as `selector.test.ts` does for its walk-budget tests: a
loaded worker can otherwise stall a sub-millisecond owner scan past its 8 ms
capture budget, degrade the owner to a hint and fail the test for a scheduling
reason. Its transformed-modal and re-render tests cover the confined
overlay; `anchor-actions.test.ts` covers the action roles a leaf click climbs to. `feedback-evidence.test.ts` also covers intent
save/reopen/cancel/clear.

`tests/core/mobile-share.test.ts` covers native sharing, attachment/text fallback, cancellation,
blocked APIs, manual copying and touch tablets with a fine primary pointer.
`tests/core/visual-viewport.test.ts` covers viewport bounds and off-screen anchor clamping.
`tests/e2e/mobile-viewport.spec.ts` simulates keyboard resize/panning without resizing the layout
viewport, plus tall forms and export panels across the three browser projects. `export-helper.ts`
checks desktop downloads and captures mobile share payloads under real click activation. These
checks do not drive a physical device's OS keyboard or share sheet; device validation remains separate.

`capture-entry.test.ts` verifies editing without handoff UI, snapshot isolation, exact artifact parity with the full entry (including hostile text and unresolved targets), shared lifecycle, target-map prototype isolation and synchronous sharing of frozen content. `capture-bundle.test.ts` checks the runtime import graph and built outputs for forbidden handoff/voice code. The packed-consumer test compiles the new public contracts. `capture-entry.spec.ts` serves `/capture` and tests actual independently minified entries across all browser projects: deferred handoff requests, save/reload evidence, native-share activation/cancellation and full/capture replacement in both directions.

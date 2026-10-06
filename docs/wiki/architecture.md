# Architecture

Pinflow is a zero-backend annotation layer: a framework-agnostic core engine, an optional lazily-loaded voice module, and two thin framework wrappers. localStorage is the local-first source of truth; artifacts (markdown for pasting into coding agents, versioned JSON for machines) are generated client-side. Hosts that want cross-device sync and a team review lifecycle bring their own backend via the two-hook contract in `PROTOCOL.md` at the repo root: `onChange` is the write half, `config.source` the read half, and the server owns the `status`/`resolution` disposition.

## Module map

```
src/
  core/               framework-agnostic engine — the only required code
    index.ts          public entry: init() singleton → Handle { destroy, refreshRoute }
    types.ts          public config + data types (PinflowConfig, Comment, Anchor, …)
    runtime.ts        shared initialization and page-wide active lifecycle
    ui/capture-annotator.ts  pins, editor, evidence, persistence and gestures
    ui/annotator.ts   full controller subclass: export chip, panels and clear
    ui/styles.ts      hand-minified shadow-DOM CSS, --pf-* theme tokens
    ui/dom-base.ts    stylesheet-independent shadow-root factory and geometry
    ui/dom.ts         full-style factory facade for internal callers
    ui/outline.ts     the scope outline: one container, N boxes, one idempotent remove()
    gesture/          stealth activation (Alt+click / long-press)
    storage.ts        schema-versioned localStorage persistence (v1→v2→v3→v4)
    persistence.ts   three-way baseline/desired/disk reconciliation for same-reviewer tabs
    feedback.ts      bounded capture context, hydration normalization, opt-in URL policy
    safe-storage.ts   in-memory fallback when localStorage is blocked
    anchor.ts         element anchoring: build/resolve/screen-project anchors
    selector.ts       selector-candidate generation + resolution ladder
    target.ts         composed targets, repeated owner constraints and shadow host paths
    capture.ts        bounded DOM text/state/geometry snapshot at placement
    details.ts        DOM-free snapshot normalizer shared by capture, storage and export
    scope.ts          region → element SET: the blast-radius ladder + covered set
    scope-limits.ts   record caps shared by scope.ts and storage.ts (neither may import the other)
    source-path.ts    data-pinflow-source validator; DOM-free so export.ts can use it
    router.ts         SPA route watching (history patching)
    route-key.ts      logical screen key derivation (strips pinflow URL params)
    export.ts         markdown export (the product's actual output)
    voice-contract.ts type-only port core exposes to voice (VoiceHost/VoiceSession)
    voice-loader.ts   the ONLY place voice is imported — dynamic import('pinflowjs/voice')
    iife.ts           CDN/script-tag auto-init shim
  capture/            smaller reviewer entry; detached snapshot API
  handoff/            optional frozen artifact adapter and delivery actions
  voice/              optional module: mic capture, Deepgram streaming, dot UI
  verification/       optional DOM-free revision-bound verification sidecars
  instrumentation/    optional Node-only development JSX/TSX source hints
  react/index.ts      thin wrapper (<Annotator> component)
  vue/index.ts        thin wrapper (props mirror config; onSubmit → submitHandler)
```

Tests mirror this layout under `tests/` (see [testing.md](./testing.md)).

## Optional module boundaries

Voice must cost text-only users **0 bytes**. `pinflowjs/voice` is marked external in every core build config (`tsup.config.ts`), so the dynamic import in `src/core/voice-loader.ts` stays a runtime reference and voice code never enters the core graph. The interface between the two sides is the type-only contract in `src/core/voice-contract.ts`. `tests/voice/bundle-isolation.test.ts` enforces this in CI. Full detail: [voice.md](./voice.md).

The capture entry imports `CaptureAnnotator` and its capture stylesheet. The full entry imports the `Annotator` subclass, full styles and serializers. `CaptureAnnotator` is abstract and its constructor renders directly. The handoff seams — panel cleanup/reflow, corpus UI updates and the composer's export action — are abstract methods: the full `Annotator` implements them and the capture entry stubs them, so neither bundle carries the other's. The chip slot (`_chipEl`) is a base-class field because the full widget's `_syncChip` fills it during the base constructor, before any subclass field initializer runs. Base and subclass are bundled together; their mangled properties never cross separately compiled entry boundaries. `pinflowjs/handoff` consumes only the stable `CaptureSnapshot` data contract.

The runtime uses `Symbol.for('pinflow.active-instance')` on the page global for one active lifecycle across packed entries. Only the unprefixed public handle crosses this boundary. A second `destroy()` is harmless (teardown is idempotent throughout), and a handle clears the slot only while it still owns it. No telemetry, runtime dependency, or new persisted schema is introduced.

## Data flow (happy path)

1. **Activate**: control button, or stealth gesture (`src/core/gesture/`) in `stealth`/`both` modes.
2. **Pin**: click an element → `buildAnchor()` (`src/core/anchor.ts`) prefers the nearest actionable control, otherwise a `data-testid` ancestor without crossing a modal/structural boundary, then captures selector candidates (`src/core/selector.ts`), a text fingerprint, and percentage offsets from it.
3. **Comment**: text via the explicit-save editor popup, or voice via the lazily-loaded module streaming Deepgram transcripts back through `VoiceHost.commit`.
   3b. **Scope**: `resolveScope()` (`src/core/scope.ts`) derives the containing boundary ONCE at placement — never on a reflow frame — and `ScopeOutline` paints it before the composer opens.
4. **Persist**: `upsertComment()` → baseline/desired/disk reconciliation (`persistence.ts`) → `saveStore()` (`src/core/storage.ts`) under `pinflow:c:<project>:<reviewer>`; `onChange` fires after each persisted mutation.
5. **Hydrate** (hosts with a backend): `config.source()` fetched once at identity resolution, merged by comment id (`mergeComments()`); server wins disposition, local-only/newer comments re-announce through `onChange` so sync losses self-heal.
6. **Re-render**: route changes (`src/core/router.ts` or host-driven `Handle.refreshRoute()`) close any open draft popup and re-scope pins to the current logical screen (`src/core/route-key.ts`, or host-supplied `config.routeKey`).
7. **Export**: `src/core/export.ts` renders reviewer/builder markdown and versioned JSON (also reachable via `Handle.exportMarkdown()/exportJSON()/downloadExport()` and the package-entry toolkit re-exports); comment text is untrusted input — blockquote escaping guards prompt injection when users paste exports into coding agents.

## Cross-cutting conventions

- **Singleton**: one active instance; re-`init()` destroys the previous one.
- **Generation guards**: `_generation` counters cancel in-flight async work (voice loads, late callbacks) across route changes and teardown.
- **`_`-prefix = mangled**: tsup mangles `/^_/` members; treat `_` renames as breaking.
- **Never throws on storage**: blocked localStorage degrades to an in-memory shim (`src/core/safe-storage.ts`) with a single console warning.

## Modes

- **reviewer** (default): one person's pins, scoped to their name.
- **builder**: the handle's exports aggregate every reviewer store in the browser. Renders no chrome and no foreign pins — the drawer, reviewer filter and read-only pin view were removed in 0.9.0 (tag `builder-mode-final`); the aggregation they wrapped is untouched.

## Optional feedback tooling

`captureContext` runs once with the actual composed clicked element and viewport click coordinates and carries explicit reproduction facts through text/voice storage and export. Original selectors/scope survive repair, and repairs flush once per render/reposition pass. The verification entry hashes the original evidence and authored request; it validates reports without executing checks or changing status. The development instrumentation entry accepts the host compiler and emits relative source hints plus source maps for JSX/TSX. Both are separate package exports, never core imports, and add no mandatory runtime dependencies.

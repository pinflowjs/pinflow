import { normalizeFeedback, captureFeedback, captureUrl } from '../feedback';
import type { FeedbackContext } from '../types';
import { eventTarget, matchesOwner } from '../target';
import { anchorTarget, anchorToScreen, buildAnchor, inAnchorLayer, resolveAnchor } from '../anchor';
import { demoteScope, resolveScope } from '../scope';
import type { ScopeRect } from '../scope';
import { ScopeOutline } from './outline';
import { buildSelectors, getTextFingerprint } from '../selector';
import { createId } from '../id';
import { now } from '../time';
import { routeKey } from '../route-key';
import {
  deleteComment as deleteCommentFromStore,
  emptyStore,
  loadStore,
  mergeComments,
  normalizeComments,
  renameReviewer,
  saveStore,
  unionByRecency,
  upsertComment,
} from '../storage';
import { rememberedReviewer } from '../identity';
import { authoredRevision, reconcileSnapshots } from '../persistence';
import type {
  Scope,
  ActivationConfig,
  Anchor,
  AreaPercent,
  Comment,
  Mode,
  PinflowConfig,
  ReviewerStore,
  VoiceMeta,
} from '../types';
import { GestureController } from '../gesture/controller';
import { acquireSelectionGuard } from './selection-guard';
import type { Logger, VoiceHost, VoiceModule, VoiceSession } from '../voice-contract';
import { loadVoice as defaultLoadVoice } from '../voice-loader';
import {
  box,
  contrastFor,
  createRoot,
  el,
  fit,
  flipPosition,
  place,
  type UIRoot,
} from './dom-base';

// Not publicly configurable (P4.4). GestureController keeps its internal
// option for tests.
//
// 400, not 500: WebKit's and Chromium's own long-press recognizers fire at
// ~500ms, so an equal threshold made it a per-device coin flip. Lose the race
// and the platform takes the gesture — pinflow silently does nothing, which
// reads as "the long-press is broken on iOS". Win it and the draft opens
// underneath iOS's selection handles. Landing first is the only stable side.
const LONG_PRESS_MS = 400;
const MOVE_THRESHOLD_PX = 10;

// Text-level tags an area sample can land inside. A hit is clamped up past
// these because `**Area covers:**` names the block a region crosses: an <em> or
// <a> quotes a fragment mid-sentence, and on a page that is ABOUT feedback that
// fragment reads like reviewer prose inside the artifact itself — the exact
// confusion the field exists to prevent.
//
// Anchored both ends, no /g (lastIndex is stateful across .test), no /i
// (tagName is uppercase for HTML and literal-case for SVG, so /i would start
// matching SVG elements this list does not mean).
const INLINE_TAG_RE = /^(A|B|CODE|EM|I|KBD|SMALL|SPAN|STRONG|U)$/;

// Matches GestureController's SWALLOW_WINDOW_MS. This used to clear on the next
// task, on the reasoning that "a mouse click follows its pointerup
// synchronously" — true for mouse, false for touch, where iOS still applies a
// ~350ms tap delay on pages without a responsive viewport. The delayed click
// then arrived after the window had closed and placed a second, spurious pin.
// Pinflow's own chrome is exempt from the swallow, so a bounded window cannot
// deafen the draft popup's own buttons.
const CLICK_SWALLOW_MS = 700;

// A drawn rect as percentages of `el`'s box, clamped to it (review fr1). A
// zero-area anchor yields no rect at all — a fabricated one is worse than an
// absent one.
//
// BOTH endpoints are clamped and the extent derived from their difference.
// Deriving `w` from the raw region width instead was asymmetric: a rect
// overflowing the RIGHT edge clamped correctly, while one overflowing the LEFT
// clamped `x` to 0 and kept the full width, claiming total coverage of an
// element it half-covered (0.11.1 review #1). That was unreachable while the
// anchor was the rect's containing ancestor — containment guaranteed no
// overflow — and became routine the moment a marquee could anchor to a member
// the rect spills past.
function areaWithin(el: Element, region: ScopeRect): { areaPercent?: AreaPercent } {
  const tr = el.getBoundingClientRect();
  if (!(tr.width > 0 && tr.height > 0)) return {};
  const clamp = (v: number): number => Math.min(100, Math.max(0, v));
  const x = clamp(((region.left - tr.left) / tr.width) * 100);
  const y = clamp(((region.top - tr.top) / tr.height) * 100);
  return {
    areaPercent: {
      x,
      y,
      w: clamp(((region.left + region.width - tr.left) / tr.width) * 100) - x,
      h: clamp(((region.top + region.height - tr.top) / tr.height) * 100) - y,
    },
  };
}

// Dispositioned by the team (via hydration) — a shared record, not the
// reviewer's draft: frozen in the UI (no edit/delete, exempt from
// empty-cleanup). `open` is NOT resolved; it stays fully editable.
function isResolved(c: Comment): boolean {
  return c.status === 'done' || c.status === 'declined';
}

export interface AnnotatorDeps {
  config: Required<Pick<PinflowConfig, 'project'>> & PinflowConfig;
  /** null = stealth mode with identity deferred to the first activation. */
  reviewer: string | null;
  mode: Mode;
  storage: Storage;
  /** Resolves (and may prompt for) the reviewer identity at first activation. */
  resolveIdentity?: () => string | null;
  /** Injectable for tests; defaults to the real lazy `import('pinflowjs/voice')`. */
  loadVoice?: () => Promise<VoiceModule>;
}

interface ActiveVoice {
  mount: HTMLDivElement;
  session: VoiceSession | null;
  /** Aborts in-flight startup (token/socket/mic) on teardown — review #4. */
  abort: AbortController;
}

interface ActiveInput {
  wrap: HTMLDivElement;
  commentId: string;
  /** Opened by the gesture that created the comment: nothing in it is the
   *  reviewer's until they save, however much host context prefilled. */
  fresh: boolean;
  /** Detach the popup's document-level dismiss listeners. */
  cleanup(): void;
  /** Persist the draft's current text and close (frozen popups just close).
   *  Lets export surfaces resolve an open draft LOSSLESSLY before acting. */
  save(): void;
}

const MUTATIONS: MutationObserverInit = {
  childList: true,
  characterData: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['open', 'hidden', 'aria-hidden', 'class', 'style', 'id', 'data-testid'],
};
export class CaptureAnnotator {
  protected readonly _ui: UIRoot;
  protected readonly _deps: AnnotatorDeps;
  // Host-defined logical screen key (config.routeKey) or the URL default —
  // the seam that makes frame-per-screen hosts (wizards, phased experiences
  // on one URL) work: pins anchor to and show on the host's notion of a
  // screen, and refreshRoute() re-evaluates it.
  protected readonly _routeKey: () => string;
  protected _reviewer: string | null;
  protected _store: ReviewerStore;
  protected _baseline: ReviewerStore;
  private _healsPending = false;
  private _started = false;
  protected _annotating = false;
  protected _pins = new Map<string, HTMLButtonElement>();
  // Marching-ants footprints for area comments (one per visible area comment,
  // keyed like _pins): the drawn region stays visible on the page, muted for
  // dispositioned comments, hidden with orphans. pointer-events:none — the
  // host page is never occluded interactively.
  private _areas = new Map<string, HTMLDivElement>();
  // Reflow-path caches (P2.1/P2.2): repositioning runs at up to 60fps, so it
  // must never re-scan localStorage or re-run the selector ladder per frame.
  // Both are dropped whenever data or route changes (persist / renderPins).
  private _visibleCache: Array<Comment & { reviewer?: string }> | null = null;
  private readonly _anchorCache = new Map<string, Element | null>();
  protected _activeInput: ActiveInput | null = null;
  // Bottom-left dock (0.5.0): THE one standing affordance. Reviewer gets an
  // arm segment (+/× toggle) unless stealth; the count chip joins it when
  // there is something to export. Builder renders no dock chrome at all
  // (0.9.0 removed the drawer).
  protected _dockEl: HTMLDivElement | null = null;
  protected _armEl: HTMLButtonElement | null = null;
  // Identifies the in-flight source hydration, so a newer one supersedes it.
  private _hydrationToken: object | null = null;
  // True once ANY source() hydration has resolved and merged: "not in flight"
  // is not "in sync" — a rejected or throwing source leaves the device blind
  // to server truth, and the synced clear refuses in that state (0.11.0
  // review #5).
  protected _hydrated = false;
  private _mutations: MutationObserver | null = null;
  private _orphanTimer = 0;
  /** Host page's body cursor, saved on entering annotate mode and restored on exit. */
  private _prevBodyCursor = '';
  private _selGuard: (() => void) | undefined;
  // Armed-mode hover outline: a non-interactive accent box over the element
  // under the cursor, rendered inside the shadow root — host styles/classes
  // are never touched. The move listener exists ONLY while armed (P2 posture:
  // no capture-phase move handler at rest, mirroring the gesture controller's
  // press scoping). The same element doubles as the marquee box while dragging.
  private _hoverEl: HTMLDivElement | null = null;
  // One owner, one idempotent teardown, N-agnostic (see ui/outline.ts).
  private _outline = new ScopeOutline();
  private _hoverTarget: Element | null = null;
  private _hoverFrame = 0;
  // Drag-to-marquee (armed mode, mouse/pen only): press origin + latest
  // corner; `live` flips once the press travels past MOVE_THRESHOLD_PX —
  // below it the press stays a plain click and the click handler places a
  // point pin. The marquee is a PICKER: release resolves the tightest
  // containing element and drops a normal element-anchored comment carrying
  // `areaPercent`. Listeners share the armed window (P2: zero work at rest).
  // One-shot: the next armed click belongs to a finished/aborted gesture.
  // Needed because _onDocumentClick registers at ARM time — earlier than any
  // per-gesture one-shot listener on the same window target, so listener
  // order alone cannot shield a click that arrives while still armed.
  private _eatClick = false;
  // Retire callbacks for in-flight dying-press shields. Each normally clears
  // itself on its own pointer's next event, but touch and pen never reuse an
  // id — so a shield outliving destroy() would keep swallowing host input and
  // hold this Annotator and its shadow tree alive. destroy() drains them.
  private _shields = new Set<() => void>();
  private _marquee: {
    id: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    live: boolean;
    /** A second pointer joined: the whole gesture is dead, including the
     *  initiating pointer's eventual compatibility click. */
    aborted: boolean;
    /** Ids of pointers still down on an aborted marquee — ONLY participants
     *  retire members (a pre-existing bystander pointer must not skew the
     *  accounting, review r5); each participant's release swallows its own
     *  compatibility click, and the state clears when the last one lifts. */
    pending: number[];
  } | null = null;
  private _reflowFrame = 0;
  private _orphanRetryAt = 0;
  private _gesture: GestureController | null = null;
  // Bumped on every teardown (destroy/route change) so in-flight async voice
  // work resolving into a stale world can detect it and self-cancel.
  private _generation = 0;
  // Set once destroy() finishes tearing down: from then on the annotator must
  // never write to storage or touch the DOM, no matter what resolves late.
  protected _destroyed = false;
  private _activeVoice: ActiveVoice | null = null;
  // Deletion tombstones for the window where a source() hydration is in
  // flight: a snapshot fetched BEFORE a delete must not resurrect the
  // deleted comment when it resolves AFTER it (0.3.0 review P1) — and a
  // resurrected copy would even re-announce as an 'add' on the next
  // reconcile, restoring it server-side.
  protected _pendingDeletes: Set<string> | null = null;
  protected readonly _voiceLogger: Logger = {
    warn: (m, d) => console.warn(`[pinflow] ${m}`, d),
    error: (m, d) => console.error(`[pinflow] ${m}`, d),
  };

  constructor(deps: AnnotatorDeps, styles: string) {
    this._deps = deps;
    this._routeKey =
      deps.config.routeKey ??
      (() => routeKey(captureUrl(window.location.href, deps.config.urlQueryParams)));
    this._ui = createRoot(styles);
    this._applyTheme();
    this._reviewer = deps.reviewer;
    // Deferred-identity (stealth) starts with an inert placeholder store; the
    // real corpus is loaded once _ensureIdentity resolves a name.
    this._store =
      deps.reviewer !== null
        ? (loadStore(deps.storage, deps.config.project, deps.reviewer) ??
          emptyStore(deps.config.project, deps.reviewer))
        : emptyStore(deps.config.project, '');
    this._baseline = { ...this._store, comments: this._store.comments.slice() };
  }

  /** Mount only after the concrete controller has initialized its fields. */
  start(): void {
    if (this._started || this._destroyed) return;
    this._started = true;
    this._renderDock();
    this._renderPins();
    this._startGesture();
    this._hydrateFromSource();
    window.addEventListener('resize', this._onReflow);
    window.visualViewport?.addEventListener('resize', this._onReflow);
    window.visualViewport?.addEventListener('scroll', this._onReflow);
    // Capture phase: scroll events on nested overflow containers do NOT
    // bubble, but they DO capture through document — without this, pins over
    // inner scrollareas keep stale fixed coordinates (review #6).
    document.addEventListener('scroll', this._onReflow, { passive: true, capture: true });
    // Host re-renders reposition pins too. Without this a pin whose element
    // left the DOM — a dialog unmounting is the common case — kept its last
    // screen position over whatever the overlay had covered until the
    // reviewer happened to scroll. Same rAF throttle as scroll; the cached
    // anchor check per pin is an isConnected read, and re-resolving parked
    // pins stays behind the 500 ms retry gate. Our own shadow tree is not
    // observed: subtree observers do not cross the shadow boundary.
    // An ESM init() may run before <body> exists (module script in <head>):
    // createUIRoot defers its append the same way, and observe(null) throws.
    this._mutations = new MutationObserver(this._onReflow);
    const observe = (): void => {
      if (!this._destroyed && document.body) this._mutations?.observe(document.body, MUTATIONS);
    };
    if (document.body) {
      observe();
      for (const target of this._anchorCache.values()) if (target) this._observeTarget(target);
    } else document.addEventListener('DOMContentLoaded', observe, { once: true });
  }

  /** Boot-line datum: comment count of the (synchronously loaded) local store. */
  get _count(): number {
    return this._store.comments.length;
  }

  // L2.1: the read half of the sync protocol, fetched once per resolved
  // identity — i.e. wherever the store becomes real: the constructor when the
  // reviewer is known at init, or _ensureIdentity when stealth's deferred
  // identity resolves. Reviewer mode only (`source` is scoped to the current
  // reviewer; builder-mode all-reviewer hydration is a later slice).
  // Generation + destroyed guards follow _startVoiceDot: a fetch resolving
  // after destroy()/refreshRoute() must not write into the stale world.
  // Hydration-APPLIED changes never echo into onChange (they're the host's
  // own data coming back). The one exception is reconciliation: a local
  // comment ABSENT from the server list either never synced (transient write
  // failure) or predates sync — re-announce it as an 'add' so the host's
  // write pipe repairs the gap (idempotent: PROTOCOL upserts by id).
  private _hydrateFromSource(): void {
    const source = this._deps.config.source;
    if (!source || this._deps.mode !== 'reviewer' || this._reviewer === null) return;
    // Guarded by destruction and by THIS FETCH's token, not the route
    // generation: a SPA navigating during a slow fetch must still receive its
    // server comments (review #3). Route changes only re-render; they don't
    // invalidate the corpus the fetch belongs to.
    //
    // The token used to be the reviewer name, which made a rename cancel an
    // in-flight read (0.7.0 review #7) — but `reviewer` is a display label, and
    // relabelling does not change whose data was requested. A fresh token per
    // hydration still supersedes an older one, which is what the guard is for.
    const token = (this._hydrationToken = {});
    // The host callback is called synchronously (tests and hosts may hand
    // out the resolver immediately) but a synchronous THROW is contained the
    // same as a rejection, and the payload is normalized like any untrusted
    // blob — a non-array or malformed entries never reach merge (review #18).
    let fetched: Promise<unknown>;
    try {
      fetched = Promise.resolve(source());
    } catch (err) {
      this._voiceLogger.warn('source hydration failed — using local store', err);
      return;
    }
    const tombstones = (this._pendingDeletes = new Set<string>());
    void fetched.then(
      (raw) => {
        if (this._pendingDeletes === tombstones) this._pendingDeletes = null;
        if (this._destroyed || this._hydrationToken !== token) return;
        const all = normalizeComments(raw);
        // Fulfilled is not accepted (0.11.0 review #6): a response that is
        // not an array, or an array whose entries the normalizer dropped, has
        // still never shown this device server truth — the id-keyed clear
        // stays gated. An entry counts as seen when a record with its id
        // survived normalization (duplicates collapse legitimately).
        const ids = new Set(all.map((c) => c.id));
        this._hydrated =
          Array.isArray(raw) &&
          (raw as unknown[]).every((e) => {
            const id = (e as { id?: unknown } | null)?.id;
            return typeof id === 'string' && ids.has(id);
          });
        const server = all.filter((c) => !tombstones.has(c.id));
        // Two repair cases (review r16): an id the server LACKS re-announces
        // as 'add'; an id the server has but with an older updatedAt (a lost
        // update — the merge keeps the local content) re-announces as
        // 'update'. Server-newer/tie stays silent (no-echo rule).
        const serverById = new Map(server.map((c) => [c.id, c.updatedAt]));
        const repair = this._store.comments
          .map((c) => {
            const serverUpdatedAt = serverById.get(c.id);
            if (serverUpdatedAt === undefined) return { type: 'add' as const, id: c.id };
            if (c.updatedAt > serverUpdatedAt) return { type: 'update' as const, id: c.id };
            return null;
          })
          .filter((r) => r !== null);
        this._store = { ...this._store, comments: mergeComments(this._store.comments, server) };
        this._persist();
        this._renderPins();
        for (const r of repair) {
          const merged = this._store.comments.find((c) => c.id === r.id);
          if (merged) this._emitChange(r.type, merged);
        }
      },
      (err) => {
        if (this._pendingDeletes === tombstones) this._pendingDeletes = null;
        this._voiceLogger.warn('source hydration failed — using local store', err);
      },
    );
  }

  destroy(): void {
    this._generation += 1;
    window.removeEventListener('resize', this._onReflow);
    window.visualViewport?.removeEventListener('resize', this._onReflow);
    window.visualViewport?.removeEventListener('scroll', this._onReflow);
    document.removeEventListener('scroll', this._onReflow, { capture: true });
    this._mutations?.disconnect();
    this._mutations = null;
    window.clearTimeout(this._orphanTimer);
    this._gesture?.stop();
    // dispose() may synchronously best-effort persist an in-flight transcript,
    // so the destroyed flag flips only after voice teardown completes.
    this._teardownVoice();
    this._destroyed = true;
    this._closeActiveInput(false);
    // Explicit: _closeActiveInput returns early when no composer is open, and
    // teardown must leave nothing painted either way.
    this._outline.clear();
    if (this._annotating) this._exitAnnotateMode();
    // AFTER _exitAnnotateMode, which is what mints shields for a still-held
    // press — draining earlier would leave the ones it just created.
    this._shields.forEach((retire) => retire());
    if (this._reflowFrame) cancelAnimationFrame(this._reflowFrame);
    this._closePanel(); // sheet dismiss listeners live on document — must detach
    this._ui.destroy();
  }

  // Release any in-flight voice session and remove its dot. dispose() best-effort
  // persists already-committed transcript text (see session.ts).
  private _teardownVoice(): void {
    const v = this._activeVoice;
    if (!v) return;
    this._activeVoice = null;
    v.abort.abort(); // startup still in flight must not gain a socket or mic
    v.session?.dispose();
    v.mount.remove();
  }

  private _activationMode(): NonNullable<ActivationConfig['mode']> {
    // 'both' by default: the button stays discoverable AND Alt+click /
    // long-press work out of the box (first-user feedback: the obvious power
    // move silently failing reads as broken). 'toggle' remains the opt-out.
    return this._deps.config.activation?.mode ?? 'both';
  }

  // Stealth/both modes add a capture-phase long-press (touch) + Alt+click
  // (desktop) gesture that drops a comment without the visible control button.
  private _startGesture(): void {
    if (this._activationMode() === 'toggle') return;
    this._gesture = new GestureController({
      mode: this._activationMode(),
      longPressMs: LONG_PRESS_MS,
      moveThresholdPx: MOVE_THRESHOLD_PX,
      onActivate: (x, y, target) => this._placeCommentAt(x, y, target),
      // Alt+drag marquee. `suspended` makes the controller inert while armed
      // — the armed press handlers own ALL input then, so neither activation
      // path can double-fire (review r1 [P2]).
      suspended: () => this._annotating,
      onAreaChange: (x0, y0, x1, y1) => {
        const m =
          this._marquee ??
          (this._marquee = { id: 0, x0, y0, x1, y1, live: true, aborted: false, pending: [] });
        m.x1 = x1;
        m.y1 = y1;
        m.live = true;
        this._scheduleHoverFrame();
      },
      onAreaCommit: (x0, y0, x1, y1) => {
        this._marquee = null;
        this._clearHover();
        this._placeAreaComment(
          Math.min(x0, x1),
          Math.min(y0, y1),
          Math.abs(x1 - x0),
          Math.abs(y1 - y0),
        );
      },
      onAreaCancel: () => {
        this._marquee = null;
        this._scheduleHoverFrame(); // repaint drops the marquee box
      },
    });
    this._gesture.start();
  }

  refreshRoute(): void {
    this._generation += 1;
    // A recording in progress finalizes and persists to its FROZEN route (the
    // host captured the route at dot creation), then the dot is removed.
    const v = this._activeVoice;
    if (v) {
      this._activeVoice = null;
      // A session already RECORDING finalizes normally; startup still in
      // flight aborts (no session yet to stop) — review #4.
      if (!v.session) v.abort.abort();
      const mount = v.mount;
      void Promise.resolve(v.session?.stop()).finally(() => mount.remove());
    }
    this._closeActiveInput();
    this._renderPins();
  }

  // Scroll/resize only moves existing pins — it never adds or removes them.
  // Re-creating DOM on every scroll frame caused jank; instead, rAF-throttle
  // and just translate existing pin elements.
  private _onReflow = (): void => {
    if (this._reflowFrame) return;
    this._reflowFrame = requestAnimationFrame(() => {
      this._reflowFrame = 0;
      this._repositionPins();
      this._positionPanel();
      if (this._activeInput)
        this._positionInputNearPin(this._activeInput.wrap, this._activeInput.commentId);
    });
  };

  // Theme tokens ride as custom properties on the shadow host and inherit into
  // the shadow tree, where styles.ts consumes them via var(--pf-*,stock).
  private _applyTheme(): void {
    const theme = this._deps.config.theme;
    if (!theme) return;
    for (const [k, v] of Object.entries(theme)) {
      if (v) {
        this._ui.host.style.setProperty(
          `--pf-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`,
          v,
        );
      }
    }
    // One-variable theming: an accent alone derives its readable contrast
    // color (hex accents only — anything fancier, the host sets both).
    if (theme.accent && !theme.accentContrast) {
      const c = contrastFor(theme.accent);
      if (c) this._ui.host.style.setProperty('--pf-accent-contrast', c);
    }
  }

  protected _persist(): void {
    this._invalidateViewCaches();
    this._reconcileIdentity();
    if (this._writeStore()) this._renderPins();
  }

  private _writeStore(): boolean {
    const before = JSON.stringify(this._store.comments);
    const disk = loadStore(this._deps.storage, this._store.project, this._store.reviewer);
    this._trackTies(disk?.comments ?? [], this._store.comments);
    this._store = {
      ...this._store,
      comments: reconcileSnapshots(
        this._baseline.comments,
        this._store.comments,
        disk?.comments ?? [],
      ),
    };
    if (saveStore(this._deps.storage, this._store))
      this._baseline = { ...this._store, comments: this._store.comments.slice() };
    return before !== JSON.stringify(this._store.comments);
  }

  /**
   * Another tab may have renamed this reviewer since our last write. Identity
   * resolution only ever consults the remembered name, so writing under our
   * now-retired key resurrects a corpus nobody will ever load again — the
   * comment simply vanishes on reload (0.7.0 review #3).
   *
   * Fold forward instead: move whatever is on disk under the old key into the
   * remembered one, then union our in-memory store (which holds the write
   * about to happen) on top.
   */
  protected _reconcileIdentity(): void {
    const from = this._reviewer;
    if (from === null || this._deps.mode !== 'reviewer') return;
    const { storage, config } = this._deps;
    const remembered = rememberedReviewer(storage, config.project);
    if (!remembered || remembered === from) return;
    // Two different falses from renameReviewer (0.11.0 review #5): nothing
    // under the old key means another tab already folded it — adopt the
    // remembered name and union what landed. A refused COPY, though, means
    // the corpus is still under the old key, and switching identity anyway
    // would verify an empty destination while the durable copy survives
    // elsewhere. Stay put; the next persist retries the fold.
    const held = loadStore(storage, config.project, from);
    // The rename's own union is storage-level and tie-dropping: record any
    // source-vs-destination tie divergence BEFORE the move (0.11.0 review #8).
    if (held) {
      const dest = loadStore(storage, config.project, remembered);
      if (dest) this._trackTies(dest.comments, held.comments);
    }
    if (held && !renameReviewer(storage, config.project, from, remembered)) {
      // The pre-read and the rename's own read can straddle another tab's
      // fold: if the old key is GONE now, this was a move, not a refusal —
      // fall through and adopt, or a later persist would recreate the retired
      // key and strand it behind the remembered marker (0.11.0 review #6).
      if (loadStore(storage, config.project, from)) {
        // Genuinely refused. The destination may still be OCCUPIED with newer
        // revisions the fold could not move — read it in read-only, so what
        // lives there joins every count and every verification instead of
        // being deleted blind (0.11.0 review #6).
        const parked = loadStore(storage, config.project, remembered);
        if (parked)
          this._store = {
            ...this._store,
            comments: this._unionTracked(parked.comments, this._store.comments),
          };
        return;
      }
    }
    const landed = loadStore(storage, config.project, remembered);
    this._reviewer = remembered;
    this._store = {
      ...this._store,
      reviewer: remembered,
      comments: reconcileSnapshots(
        this._baseline.comments,
        this._store.comments,
        landed?.comments ?? [],
      ),
    };
    this._baseline = landed ?? emptyStore(config.project, remembered);
  }

  // A2: notify the host after a persisted mutation. Host exceptions must never
  // break the annotator, and a torn-down world must never call out.
  protected _emitChange(type: 'add' | 'update' | 'delete', comment: Comment): void {
    const current = this._store.comments.find((c) => c.id === comment.id);
    if (type === 'delete' ? current : !current) return;
    if (current) comment = current;
    // Tombstone BEFORE the callback gate: the hydration race exists whether
    // or not the host listens to onChange.
    if (type === 'delete') this._pendingDeletes?.add(comment.id);
    const cb = this._deps.config.onChange;
    if (!cb || this._destroyed) return;
    try {
      // Promise-wrap so a rejected ASYNC handler is contained exactly like a
      // synchronous throw (review #10) — the documented guarantee.
      void Promise.resolve(cb(this._store, { type, comment })).catch((err) =>
        this._voiceLogger.warn('onChange handler threw', err),
      );
    } catch (err) {
      this._voiceLogger.warn('onChange handler threw', err);
    }
  }

  private _invalidateViewCaches(): void {
    this._visibleCache = null;
    this._anchorCache.clear();
  }

  private _renderDock(): void {
    const dock = el('div', 'dock');
    this._dockEl = dock;
    // Reviewer arm segment: a pure arm/disarm toggle — click/drag on the page
    // IS the interface. Stealth stays chromeless; builder never arms.
    if (this._deps.mode === 'reviewer' && this._activationMode() !== 'stealth') {
      const arm = el('button', 'arm'); // glyph is drawn in CSS (::before bars)
      arm.type = 'button';
      arm.dataset['active'] = 'false';
      arm.setAttribute('aria-label', 'Annotate this page');
      arm.addEventListener('click', () => this._toggleAnnotateMode());
      dock.appendChild(arm);
      this._armEl = arm;
    }
    this._ui.root.appendChild(dock);
  }

  // The arm segment mirrors the armed state: + arms, × stops (the CSS-drawn
  // glyph rotates 45° on data-active — no text swap).
  private _syncArm(): void {
    const a = this._armEl;
    if (!a) return;
    a.dataset['active'] = String(this._annotating);
    a.setAttribute('aria-label', this._annotating ? 'Stop annotating' : 'Annotate this page');
  }

  /** Batch-scoping revision stamp: content recency PLUS the server-owned
   * disposition — PROTOCOL moves status/resolution without touching updatedAt,
   * and state the artifact never captured must never be cleared by it. JSON
   * keeps the tuple injective for arbitrary strings (a NUL-delimited join was
   * not — 0.11.0 review #3), and status canonicalizes to 'open' exactly as the
   * exporter prints absence, so a server echo that merely makes the default
   * explicit is not a new revision. The text rides along so two records with
   * degenerate (missing or equal-invalid) timestamps can never alias into one
   * clearable revision — what the artifact quoted is what "exported" means
   * (0.11.0 review #5). Route and createdAt ride too — location moved on a
   * timestamp tie is content the artifact did not show (0.11.0 review #6).
   * The stamp's deliberate boundary is AUTHORED and server-owned content:
   * server-side anchor drift without an updatedAt bump is off-contract by
   * PROTOCOL's whole-comment content merge, and the local heal ladder
   * (_persistHeal — deliberately silent, no bump) is maintenance of DERIVED
   * selector data whose feedback is fully present in the artifact, so
   * neither makes a comment "unexported" (0.11.0 review #7). */
  protected _rev(c: Comment): string {
    return authoredRevision(c);
  }

  // Ids whose two copies tie on updatedAt but differ in revision, mapped to
  // the tie timestamp. This is EVIDENCE with a lifetime, not fold state: a
  // union can overwrite the divergent side, and a later export can freeze the
  // surviving tie winner into a legitimate-looking batch — but the discarded
  // revision appeared in NO artifact. An entry is pruned only when its
  // comment moves to a strictly different updatedAt or leaves the board
  // (0.11.0 review #6, #7, #8). Unresolvable by design otherwise: PROTOCOL
  // has no way to verify the backend copy, so a standing tie is standing
  // ambiguity.
  protected readonly _foldConflicts = new Map<string, string>();

  /** Record tie conflicts between two comment lists — same id, same
   * updatedAt, different revision — BEFORE any union picks a winner
   * (0.11.0 review #7, #8). */
  protected _trackTies(a: Comment[], b: Comment[]): void {
    const byId = new Map(b.map((c) => [c.id, c]));
    for (const x of a) {
      const m = byId.get(x.id);
      if (m && m.updatedAt === x.updatedAt && this._rev(m) !== this._rev(x))
        this._foldConflicts.set(x.id, x.updatedAt);
    }
  }

  /** Union with conflict tracking (0.11.0 review #7). */
  protected _unionTracked(base: Comment[], mine: Comment[]): Comment[] {
    this._trackTies(base, mine);
    return unionByRecency(base, mine);
  }

  // A resolve that came through the fallback chain (fingerprint / fuzzy)
  // means the stored css/xpath went stale — the next load would fall all the
  // way through again, and one more edit could orphan the pin for good.
  // Persist the rebuilt selectors. Deliberately SILENT: no onChange, no
  // updatedAt bump — this is mechanical repair of local anchoring, not
  // reviewer content, and a synced server copy must win the next merge
  // untouched. Fingerprint stays as pinned (it is provenance: the artifact
  // reports what the reviewer actually commented on). Reviewer mode only —
  // builder aggregates other reviewers' stores read-only.
  // A heal moves the anchor to a DIFFERENT element than the reviewer pinned,
  // so every derived node list on the scope describes a DOM that no longer
  // exists. Keeping them would let the artifact name elements with total
  // confidence that were never in the drawn region — the wrong-re-anchor
  // doctrine, one layer up. The boundary survives: it is the one claim a heal
  // does not invalidate.
  private _healScope(comment: Comment): Comment {
    return comment.scope
      ? {
          ...comment,
          capturedScope: comment.capturedScope ?? comment.scope,
          scope: demoteScope(comment.scope),
        }
      : comment;
  }

  private _observeTarget(target: Element): void {
    let root = target.getRootNode();
    for (let depth = 0; root instanceof ShadowRoot && depth < 8; depth++) {
      this._mutations?.observe(root, MUTATIONS);
      root = root.host.getRootNode();
    }
  }

  private _persistHeal(commentId: string, target: Element): void {
    this._observeTarget(target);
    if (this._deps.mode !== 'reviewer') return;
    const c = this._store.comments.find((x) => x.id === commentId);
    if (!c) return;
    const fresh = buildSelectors(target);
    if (!fresh.css) return; // never cement a degenerate selector
    const s = c.anchor.selectors;
    if (
      fresh.css === s.css &&
      fresh.xpath === s.xpath &&
      fresh.testid === s.testid &&
      fresh.id === s.id
    )
      return;
    this._store = {
      ...this._store,
      comments: this._store.comments.map((x) =>
        x.id === commentId
          ? this._healScope({
              ...x,
              anchor: {
                ...x.anchor,
                capturedSelectors: x.anchor.capturedSelectors ?? x.anchor.selectors,
                selectors: fresh,
              },
            })
          : x,
      ),
    };
    // NOT _persist(): that invalidates the anchor cache, but a heal describes
    // the very element just cached — flushing it would force a redundant
    // ladder walk on the next reflow frame (P2.2 would regress). The VISIBLE
    // cache, however, still holds pre-heal comment objects and must go, or
    // later re-resolves would use the stale selectors (0.3.0 review #6).
    this._visibleCache = null;
    this._healsPending = true;
  }

  /** Fold the durable truth into memory: the remembered identity first (a
   * cross-tab rename), then the on-disk corpus under the current key (a
   * cross-tab edit) — memory wins only where genuinely newer. Renders only
   * when the fold changed something material, so a no-op fold cannot replay
   * pin entrances (0.11.0 review #4). */
  protected _foldDurable(): void {
    const before = this._store.comments;
    this._reconcileIdentity();
    if (this._reviewer !== null) {
      const disk = loadStore(this._deps.storage, this._deps.config.project, this._reviewer);
      if (disk) {
        this._trackTies(disk.comments, this._store.comments);
        this._store = {
          ...this._store,
          comments: unionByRecency(
            disk.comments,
            reconcileSnapshots(this._baseline.comments, this._store.comments, disk.comments),
          ),
        };
        this._baseline = disk;
      }
    }
    const cur = this._store.comments;
    const changed =
      cur.length !== before.length ||
      cur.some((c, i) => {
        const b = before[i];
        return !b || b.id !== c.id || this._rev(b) !== this._rev(c);
      });
    if (changed) this._renderPins();
  }

  private _toggleAnnotateMode(): void {
    if (this._annotating) this._exitAnnotateMode();
    else this._enterAnnotateMode();
  }

  private _enterAnnotateMode(): void {
    // A gesture-owned marquee may be in flight (keyboard-activated arm mid-
    // Alt-drag). It carries a sentinel pointer id the armed handlers must
    // never adopt — clear it BEFORE the armed listeners attach, or its
    // phantom participant strands the abort accounting and the window guard
    // (review r6 [P2]). The controller press dies SYNCHRONOUSLY here, not via
    // the lazy suspended() probe: a transient arm→disarm between pointer
    // events would otherwise leave it live to commit on release (review r7).
    this._gesture?.suspendPress();
    this._marquee = null;
    this._clearHover();
    this._annotating = true;
    this._syncArm();
    window.addEventListener('click', this._onDocumentClick, true);
    // Touch taps never reach _onArmedPointerDown (it returns early for touch,
    // so native scrolling keeps working), and cancelling a pointer event does
    // not suppress touch's compatibility mouse burst anyway — that is routed
    // through touchstart. Without these two the click was correctly swallowed
    // while the host still got mousedown+mouseup from every armed tap.
    window.addEventListener('mousedown', this._eatUnlessOwnUi, true);
    window.addEventListener('mouseup', this._eatUnlessOwnUi, true);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('pointermove', this._onHoverMove, { passive: true, capture: true });
    window.addEventListener('pointerdown', this._onArmedPointerDown, true);
    window.addEventListener('pointerup', this._onArmedPointerUp, true);
    window.addEventListener('pointercancel', this._onArmedPointerCancel, true);
    this._prevBodyCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    // Same category as the crosshair: a modal, reversible host override.
    // While armed, a long-press must belong to the pin gesture alone — not
    // also start WebKit text selection and the touch callout (0.5.x).
    this._selGuard = acquireSelectionGuard();
    // Arming is pinning intent — it replaces whatever surface was up.
    this._closePanel();
  }

  protected _exitAnnotateMode(): void {
    this._annotating = false;
    this._syncArm();
    window.removeEventListener('click', this._onDocumentClick, true);
    window.removeEventListener('mousedown', this._eatUnlessOwnUi, true);
    window.removeEventListener('mouseup', this._eatUnlessOwnUi, true);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('pointermove', this._onHoverMove, { capture: true });
    window.removeEventListener('pointerdown', this._onArmedPointerDown, true);
    window.removeEventListener('pointerup', this._onArmedPointerUp, true);
    window.removeEventListener('pointercancel', this._onArmedPointerCancel, true);
    // A press still held at teardown (Escape mid-press) keeps a shield until
    // its OWN release: the pointerup and its compatibility click belong to
    // the annotation gesture, never the host (ce #2). Aborted marquees shield
    // every remaining participant.
    if (this._marquee) {
      for (const id of this._marquee.aborted ? this._marquee.pending : [this._marquee.id])
        this._shieldDyingPress(id);
    }
    this._marquee = null;
    this._pressGuards(false);
    this._abortGuard(false);
    this._clearHover();
    document.body.style.cursor = this._prevBodyCursor;
    this._prevBodyCursor = '';
    this._selGuard?.();
    this._selGuard = undefined;
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this._exitAnnotateMode();
  };

  // True for events on pinflow's own chrome, shared by the armed click, hover
  // targeting, and marquee starts. contains() covers the retargeted
  // (host-level) case; composedPath covers edges where the capture target is
  // the shadow-internal node itself — without it, an armed click on pinflow's
  // own UI would both place a bogus pin AND stopPropagation away the
  // control's handler.
  private _isOwnUi(target: unknown, e?: Event): boolean {
    return (
      !(target instanceof Element) ||
      this._ui.host.contains(target) ||
      e?.composedPath?.().includes(this._ui.host) === true
    );
  }

  // rAF-throttled like _onReflow. While a marquee press is live this tracks
  // the drag corner instead of hover-targeting.
  private _onHoverMove = (e: Event): void => {
    const m = this._marquee;
    if (m) {
      if (m.aborted) return; // dead gesture: nothing paints, nothing updates
      const p = e as PointerEvent;
      if ((p.pointerId ?? 0) !== m.id) return; // stray pointers never drive the box
      m.x1 = p.clientX;
      m.y1 = p.clientY;
      // Live threshold, both directions: returning inside it de-latches so a
      // release at the origin is a plain click again — never a 0×0 area.
      m.live = Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > MOVE_THRESHOLD_PX;
      this._scheduleHoverFrame();
      return;
    }
    const target = eventTarget(e);
    // Preview = capture: highlight the CANONICAL anchor target (the nearest
    // data-testid ancestor, exactly what a click will store), not the leaf
    // under the cursor — the box the reviewer sees is the box they select.
    this._hoverTarget = this._isOwnUi(target, e) ? null : anchorTarget(target as Element);
    this._scheduleHoverFrame();
  };

  private _scheduleHoverFrame(): void {
    if (this._hoverFrame) return;
    this._hoverFrame = requestAnimationFrame(() => {
      this._hoverFrame = 0;
      this._paintHover();
    });
  }

  private _paintHover(): void {
    const m = this._marquee;
    if (m?.live) {
      const box = this._ensureHoverEl();
      box.dataset['marquee'] = 'true';
      this._sizeHoverEl(
        Math.min(m.x0, m.x1),
        Math.min(m.y0, m.y1),
        Math.abs(m.x1 - m.x0),
        Math.abs(m.y1 - m.y0),
      );
      return;
    }
    const t = this._hoverTarget;
    if (!t?.isConnected) {
      if (this._hoverEl) this._hoverEl.style.display = 'none';
      return;
    }
    const box = this._ensureHoverEl();
    delete box.dataset['marquee'];
    const r = t.getBoundingClientRect();
    this._sizeHoverEl(r.left, r.top, r.width, r.height);
  }

  private _ensureHoverEl(): HTMLDivElement {
    if (!this._hoverEl) {
      this._hoverEl = el('div', 'hl');
      this._ui.root.appendChild(this._hoverEl);
    }
    return this._hoverEl;
  }

  private _sizeHoverEl(left: number, top: number, width: number, height: number): void {
    box(this._hoverEl!, left, top, width, height);
  }

  // Mouse/pen only: a passive listener cannot preventDefault, so a touch
  // marquee would fight native scrolling — touch keeps click-to-pin. Primary
  // button only (right-drag stays the host's), and the initiating pointerId
  // is recorded so stray pointers can neither resize nor commit the box.
  private _onArmedPointerDown = (e: Event): void => {
    const p = e as PointerEvent;
    if (this._marquee) {
      const m = this._marquee;
      const joiner = p.pointerId ?? 0;
      // ANY participant pressing again proves its release was lost outside the
      // window (no pointerup arrives — documented browser behavior): retire it
      // and fall through to a fresh press (ce #5). Gating this on `!m.aborted`
      // left the aborted gesture with no recovery at all: its participants had
      // already stopped being able to retire themselves, so one lost release
      // stranded `_marquee` forever and the standing abort guard went on
      // eating every click on the page.
      if (m.aborted ? m.pending.includes(joiner) : joiner === m.id) {
        if (m.aborted) {
          m.pending = m.pending.filter((x) => x !== joiner);
          if (m.pending.length) return; // others still down — stay aborted
          this._abortGuard(false);
        }
        this._marquee = null;
        this._pressGuards(false);
        this._scheduleHoverFrame();
      } else {
        // A second pointer joining aborts the WHOLE gesture. The state stays
        // (flagged) until EVERY participating pointer has lifted, so each
        // release can swallow its own compatibility click — both orderings
        // (review r2/r4 [P2]). First join: initiator + joiner are down.
        if (!m.aborted) {
          m.aborted = true;
          m.live = false;
          m.pending = [m.id, joiner];
          this._pressGuards(false);
          // Standing WINDOW-capture interceptor for the abort's lifetime: mid-
          // abort stray clicks must never reach host capture listeners that
          // registered before pinflow (review r5 [P2]).
          this._abortGuard(true);
          this._scheduleHoverFrame();
        } else if (!m.pending.includes(joiner)) {
          m.pending = [...m.pending, joiner]; // a third+ pointer joined the dead gesture
        }
        return;
      }
    }
    if (p.isPrimary === false || p.pointerType === 'touch' || (p.button ?? 0) !== 0) return;
    if (this._isOwnUi(e.target, e)) return;
    // Accepted press: armed mode owns EVERY phase of this pointer. Stopping
    // it at window capture — before any host listener, wherever registered —
    // keeps host buttons, sliders, routers, and drag surfaces inert during
    // annotation; preventDefault also suppresses the compatibility mouse
    // events. The trailing click still fires and _onDocumentClick owns it
    // (ce #3). Touch and pinflow's own UI returned above, untouched.
    e.preventDefault();
    e.stopImmediatePropagation();
    this._marquee = {
      id: p.pointerId ?? 0,
      x0: p.clientX,
      y0: p.clientY,
      x1: p.clientX,
      y1: p.clientY,
      live: false,
      aborted: false,
      pending: [],
    };
    this._pressGuards(true);
  };

  // A press orphaned by armed-mode teardown: window-capture one-shots own its
  // release — the pointerup is suppressed and its compatibility click
  // swallowed — then self-detach. A SAME-pointer re-press retires the shield
  // without swallowing (the release was lost outside the window; the next
  // engagement is a genuine host interaction — ce #2/#5).
  private _shieldDyingPress(id: number): void {
    const retire = (): void => {
      this._shields.delete(retire);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
    };
    const onDown = (e: Event): void => {
      if (((e as PointerEvent).pointerId ?? 0) === id) retire();
    };
    const onUp = (e: Event): void => {
      if (((e as PointerEvent).pointerId ?? 0) !== id) return;
      retire();
      e.preventDefault();
      e.stopImmediatePropagation();
      this._swallowNextClick();
    };
    const onCancel = (e: Event): void => {
      if (((e as PointerEvent).pointerId ?? 0) === id) retire();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    this._shields.add(retire);
  }

  // Suppress text selection and native drag-and-drop for the press duration —
  // the marquee must never fight the browser's drag ghost or leave a
  // selection trail. Press-scoped: zero listeners at rest.
  private _pressGuards(on: boolean): void {
    const fn = on ? document.addEventListener : document.removeEventListener;
    fn.call(document, 'selectstart', this._killDefault, true);
    fn.call(document, 'dragstart', this._killDefault, true);
  }

  private _killDefault = (e: Event): void => {
    e.preventDefault();
  };

  // Standing window-capture click interceptor, alive only while a marquee
  // abort is in flight: the first stop on the propagation path, so it runs
  // before ANY host capture listener regardless of registration order.
  // Idempotent: duplicate add/remove of the same handler is a no-op.
  // One blanket window-capture eater, shared by every surface that needs one:
  // the armed-mode compatibility mouse burst (touch taps never reach
  // _onArmedPointerDown, and cancelling a pointer event does not suppress that
  // burst anyway), and the standing guard held for an abort's lifetime.
  //
  // The own-UI check is not optional in either role — without it a stranded
  // abort ate the arm segment's own click and left no way to disarm.
  private _eatUnlessOwnUi = (e: Event): void => {
    if (this._isOwnUi(e.target, e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private _abortGuard(on: boolean): void {
    const fn = on ? window.addEventListener : window.removeEventListener;
    fn.call(window, 'click', this._eatUnlessOwnUi, true);
  }

  private _onArmedPointerUp = (e: Event): void => {
    const m = this._marquee;
    const p = e as PointerEvent;
    if (!m) return;
    // Our accepted pointer's release is ours end-to-end (ce #3). Aborted
    // participants (pinch fingers) keep their natural phases — only their
    // compatibility clicks are swallowed.
    // The accepted pointer's release is ours whether or not the gesture was
    // later aborted: its pointerdown was already eaten when we claimed it, so
    // handing the host a pointerup with no matching down desyncs any drag
    // surface. Joiners keep their natural phases; only their clicks are eaten.
    if ((p.pointerId ?? 0) === m.id) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (m.aborted) {
      // Only PARTICIPANTS retire the abort; each release swallows its own
      // compatibility click (which follows synchronously). The state — and
      // the standing window guard — clear when the last participant lifts
      // (review r2/r4/r5 [P2]).
      const pid = p.pointerId ?? 0;
      if (!m.pending.includes(pid)) return;
      m.pending = m.pending.filter((x) => x !== pid);
      this._swallowNextClick();
      if (m.pending.length === 0) {
        this._marquee = null;
        this._abortGuard(false);
      }
      return;
    }
    if ((p.pointerId ?? 0) !== m.id) return;
    this._marquee = null;
    this._pressGuards(false);
    const x1 = p.clientX ?? m.x1;
    const y1 = p.clientY ?? m.y1;
    // The RELEASE coordinates decide, not the latched flag — the
    // return-to-origin move can be coalesced away (review r2 [P2]). Below the
    // threshold the press was a click; _onDocumentClick owns it.
    if (Math.hypot(x1 - m.x0, y1 - m.y0) <= MOVE_THRESHOLD_PX) {
      this._scheduleHoverFrame(); // drop any stale marquee box
      return;
    }
    this._swallowNextClick();
    this._exitAnnotateMode();
    this._placeAreaComment(
      Math.min(m.x0, x1),
      Math.min(m.y0, y1),
      Math.abs(x1 - m.x0),
      Math.abs(y1 - m.y0),
    );
  };

  // The drag's trailing click must reach neither pinflow (double pin) nor the
  // host (a drag is not a click). WINDOW capture — the first stop on the
  // propagation path — so it runs before any host document-capture listener
  // regardless of registration order; stopImmediatePropagation silences
  // same-node listeners too (review r1 [P1]). Swallows exactly ONE click; the
  // 0-timeout clears the no-click case — a mouse click fires synchronously
  // after pointerup, so a later genuine click is never eaten.
  private _swallowNextClick(): void {
    // Two mechanisms, one contract: the flag shields while ARMED (where
    // _onDocumentClick is first in window listener order), the one-shot
    // listener shields after teardown. Both self-clear on the next task —
    // a mouse click follows its pointerup synchronously.
    if (this._destroyed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drop = (): void => {
      this._shields.delete(drop);
      window.removeEventListener('click', swallow, true);
      this._eatClick = false;
      clearTimeout(timer);
    };
    const swallow = (ce: Event): void => {
      if (this._isOwnUi(ce.target, ce)) return; // pinflow's chrome is never eaten
      drop();
      ce.preventDefault();
      ce.stopImmediatePropagation();
    };
    this._eatClick = true;
    window.addEventListener('click', swallow, true);
    timer = setTimeout(drop, CLICK_SWALLOW_MS);
    // Tracked like a shield so destroy() takes it with everything else: this
    // one-shot outliving its Annotator swallowed a later, unrelated host click.
    this._shields.add(drop);
  }

  private _onArmedPointerCancel = (e: Event): void => {
    const m = this._marquee;
    if (!m) return;
    if (m.aborted) {
      // No compatibility click follows a cancel — just retire the participant.
      const pid = (e as PointerEvent).pointerId ?? 0;
      if (!m.pending.includes(pid)) return;
      m.pending = m.pending.filter((x) => x !== pid);
      if (m.pending.length === 0) {
        this._marquee = null;
        this._abortGuard(false);
      }
      return;
    }
    const pid = (e as PointerEvent).pointerId;
    if (pid !== undefined && pid !== m.id) return; // a stray pointer's cancel is not ours
    this._marquee = null;
    this._pressGuards(false);
    this._scheduleHoverFrame(); // repaint drops the marquee box
  };

  // Resolve the tightest element whose box contains the drawn rect, then drop
  // a NORMAL element-anchored comment (pin at the rect's center) carrying the
  // rect as percentages of that element.
  private _placeAreaComment(left: number, top: number, width: number, height: number): void {
    const cx = left + width / 2;
    const cy = top + height / 2;
    const contains = (elm: Element): boolean => {
      const r = elm.getBoundingClientRect();
      return r.left <= left && r.top <= top && r.right >= left + width && r.bottom >= top + height;
    };
    // The element the sample LANDED on is the block the rect sits on. Recording
    // the climb's last element instead — the highest child below the containing
    // ancestor — meant a rect drawn a little wider than its block walked past
    // that block and quoted a sibling's opening text, while `positionPercent`
    // still pointed at the right place. Nothing in the artifact could reveal
    // the disagreement, so the agent read the prose and edited the wrong thing.
    //
    // `hit !== e` preserves the do-nothing case: a rect already contained by
    // the element under the pointer names nothing, rather than naming its own
    // container. Sample two more points down the diagonal so a rect over a row
    // of cards can name all of them. Runs ONCE, on pointerup: nothing here
    // touches the per-frame reflow path.
    const subjects: Element[] = [];
    const climb = (x: number, y: number): Element | null => {
      let e: Element | null = document.elementFromPoint?.(x, y) ?? null;
      if (e && this._ui.host.contains(e)) e = null; // a pin under the sample
      const hit = e;
      while (e && !contains(e)) e = e.parentElement;
      if (hit && hit !== e) {
        // `**Area covers:**` promises the BLOCK a region crosses. Deduping on
        // the CLAMPED element matters as much as the clamp: two samples landing
        // on different words of one paragraph are one subject, not two.
        let b: Element = hit;
        while (INLINE_TAG_RE.test(b.tagName) && b.parentElement) b = b.parentElement;
        if (subjects.length < 3 && !subjects.includes(b)) subjects.push(b);
      }
      return e;
    };
    // Centre first, so subjects[0] shares positionPercent's provenance WHEN the
    // centre lands on a block. When it lands in a gutter the climb stops
    // immediately, records nothing, and subjects[0] becomes the first inset's
    // block — a real block the rect crosses, which is still the best heading
    // available, just not the pin's own. The 1/6 and 5/6 insets never sit on an
    // edge, so a neighbouring block cannot be picked up by a rounding error.
    const target = climb(cx, cy);
    climb(left + width / 6, top + height / 6);
    climb(left + (width * 5) / 6, top + (height * 5) / 6);
    const covers = subjects
      // No second slice: getTextFingerprint already bounds at FP_MAX (80), and
      // capping again at 40 threw away half of the field an agent locates with.
      .map((e) => getTextFingerprint(e) || e.tagName.toLowerCase())
      .join('\n');
    // areaPercent is measured inside _placeCommentAt, against whatever that
    // settles on as the anchor — the walk can move it off this container.
    this._placeCommentAt(cx, cy, target ?? document.body, subjects[0], covers || undefined, {
      left,
      top,
      width,
      height,
    });
  }

  private _clearHover(): void {
    if (this._hoverFrame) {
      cancelAnimationFrame(this._hoverFrame);
      this._hoverFrame = 0;
    }
    this._hoverTarget = null;
    this._hoverEl?.remove();
    this._hoverEl = null;
  }

  private _onDocumentClick = (e: MouseEvent): void => {
    // FIRST, ahead of every swallow below: pinflow's own chrome must stay
    // operable in every state. Ordered after the _marquee branch, a stranded
    // abort ate the arm segment's own click and left the reviewer with no way
    // to disarm — the guard locked the exit it exists to protect.
    if (this._isOwnUi(e.target, e)) return;
    // stopImmediatePropagation, not stopPropagation, at all three sites: this
    // handler is on WINDOW capture, and so is a host's outside-click dismiss,
    // router, or analytics listener. stopPropagation cannot silence a sibling
    // on the same node, so a host listener registered after init still saw
    // every armed click. Every neighbouring armed handler already did this.
    if (this._eatClick) {
      this._eatClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Any in-flight armed press (pending, live, or aborted) means this click
    // belongs to ANOTHER pointer — e.g. a joiner lifting before the marquee's
    // initiator releases. It places nothing AND is consumed: armed mode owns
    // input, so no mid-gesture click may leak to the host (review r3/r4 [P2]).
    if (this._marquee) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    this._exitAnnotateMode();
    this._placeCommentAt(e.clientX, e.clientY, eventTarget(e)!);
  };

  // Stealth defers the (blocking) identity prompt from init to the first
  // activation — the moment identity is actually needed, right before any
  // comment can be created. Declining leaves the layer dormant; the next
  // activation asks again. Resolving loads that reviewer's existing corpus.
  private _ensureIdentity(): boolean {
    if (this._reviewer !== null) return true;
    const name = this._deps.resolveIdentity?.() ?? null;
    if (!name) return false;
    this._reviewer = name;
    this._store =
      loadStore(this._deps.storage, this._deps.config.project, name) ??
      emptyStore(this._deps.config.project, name);
    this._baseline = { ...this._store, comments: this._store.comments.slice() };
    this._renderPins();
    this._hydrateFromSource(); // the store just became real — sync it (L2.1)
    return true;
  }

  // Shared by the toggle click path and the stealth gesture: drop an anchored
  // note at a screen point. Voice-configured → a streaming voice dot; otherwise
  // the classic text input.
  private _placeCommentAt(
    clientX: number,
    clientY: number,
    target: Element,
    // Area picker only; both point paths pass none of these and are unchanged.
    deep?: Element,
    covers?: string,
    region?: ScopeRect,
  ): void {
    this._ui.syncLayer();
    if (this._ui.host.contains(target)) return; // never annotate our own UI
    if (!this._ensureIdentity()) return; // identity is required before any comment exists
    // Resolved ONCE, here, at commit time — never on a reflow frame. A live
    // marquee paints only its own box; the walk is 1.18 ms clean and 8.14 ms
    // under 6x throttling, which is fine once and fatal at 60 Hz.
    //
    // Measured against the CANONICAL anchor target so preview, capture,
    // footprint and outline are all the same element.
    const scoped = resolveScope(anchorTarget(target), region);
    // A marquee's container is chosen by CONTAINMENT, which is a cliff with no
    // tolerance: a rect aimed at a badge but drawn a few px past its section's
    // seam finds nothing below the page shell, and the anchor used to ride
    // along — so Element, Context, Position and every selector described a
    // container the reviewer never pointed at, in a real prototype export. The
    // WALK does not have that failure mode; it scored the badge correctly in
    // both draws. So when the walk found exactly one member, that member is
    // what the note is about and the anchor follows it. A multi-member set
    // keeps the container — it is the honest common answer for a set — and the
    // BOUNDARY is never re-derived either way: it answers "how far may a fix
    // reach", which the overhang does not make wrong, only loose.
    // `membersComplete` gates it: a walk that gave up on its node budget may
    // have left members unvisited, and one member found before the budget ran
    // out is not proof that one is all there was (0.11.1 review #2). The
    // record's own `truncated` would be the WRONG gate — an EXCLUDED_CAP
    // overflow sets it while leaving `members` complete, so gating on it would
    // silently drop this fix on any region grazing more than twelve elements.
    const sole =
      region && scoped?.elements.membersComplete && scoped.elements.members.length === 1
        ? scoped.elements.members[0]!
        : null;
    const el = sole ?? target;
    const anchor: Anchor = {
      ...buildAnchor(el, clientX, clientY, deep),
      // buildAnchor canonicalizes to the nearest data-testid ancestor — the
      // rect must be measured against THAT element, or areaPercent and the
      // selectors would describe different boxes (review r1 [P1]).
      ...(region ? areaWithin(anchorTarget(el), region) : {}),
      ...(covers ? { covers } : {}),
    };
    // Same synchronous turn as the hover box's removal: both commit paths call
    // _clearHover() immediately before this, and a frame that paints with
    // neither box makes the resolve blink.
    if (scoped) this._outline.show(this._ui.root, scoped, region);
    const scope = scoped?.scope;
    const feedback = captureFeedback(this._deps.config.captureContext, target, {
      clientX,
      clientY,
    });
    if (this._deps.config.voice) {
      if (this._activeVoice) return; // one recording at a time
      this._startVoiceDot(anchor, clientX, clientY, scope, feedback);
      return;
    }
    this._commitTextComment(anchor, '', true, undefined, undefined, scope, feedback);
  }

  // `route`/`fullUrl` default to the current location; the voice degrade path
  // passes BOTH frozen at dot creation — they describe one moment and must
  // never split across a navigation (review #32).
  private _commitTextComment(
    anchor: Anchor,
    text: string,
    openForEdit: boolean,
    route?: string,
    fullUrl?: string,
    scope?: Scope,
    feedback?: FeedbackContext,
  ): void {
    const t = now();
    const comment: Comment = {
      id: createId(),
      createdAt: t,
      updatedAt: t,
      route: route ?? this._routeKey(),
      fullUrl: fullUrl ?? captureUrl(window.location.href, this._deps.config.urlQueryParams),
      text,
      modality: 'text',
      anchor,
      // Frozen at PIN time alongside the route, not resolved here: a voice
      // note commits long after the gesture, and re-deriving at commit would
      // attribute a boundary to a DOM the reviewer never saw.
      ...(scope ? { scope } : {}),
      ...(feedback ? { feedback } : {}),
    };
    this._store = upsertComment(this._store, comment);
    this._persist();
    this._emitChange('add', comment);
    this._renderPins();
    if (openForEdit) this._openInput(comment.id, true);
  }

  private _loadVoiceModule(): Promise<VoiceModule> {
    return (this._deps.loadVoice ?? defaultLoadVoice)();
  }

  // Drop a voice dot, lazily load the voice module, and start a session — with
  // generation guards so an import/start resolving after teardown self-cancels
  // and releases whatever it produced.
  private _startVoiceDot(
    anchor: Anchor,
    clientX: number,
    clientY: number,
    scope?: Scope,
    feedback?: FeedbackContext,
  ): void {
    const mount = el('div');
    mount.style.cssText = 'position:fixed;';
    place(
      mount,
      flipPosition({ left: clientX, top: clientY }, { width: 280, height: 140 }, this._ui.bounds()),
    );
    this._ui.root.appendChild(mount);

    const active: ActiveVoice = { mount, session: null, abort: new AbortController() };
    this._activeVoice = active;
    const myGen = this._generation;
    const route = this._routeKey();
    // fullUrl freezes WITH the route (review #32): both describe where
    // the recording began, and navigation mid-finalize must not split them.
    const host = this._buildVoiceHost(
      mount,
      anchor,
      route,
      captureUrl(window.location.href, this._deps.config.urlQueryParams),
      active,
      myGen,
      scope,
      feedback,
    );

    this._loadVoiceModule()
      .then((mod) => {
        if (myGen !== this._generation) {
          mount.remove();
          return;
        }
        return mod.start(host).then((session) => {
          if (myGen !== this._generation) {
            session.dispose();
            mount.remove();
            return;
          }
          active.session = session;
        });
      })
      .catch((err) => {
        this._voiceLogger.warn('voice module failed to load', err);
        if (myGen === this._generation) host.degradeToText();
      });
  }

  private _buildVoiceHost(
    mount: HTMLDivElement,
    anchor: Anchor,
    route: string,
    fullUrl: string,
    active: ActiveVoice,
    gen: number,
    // Frozen at dot creation alongside `route`/`fullUrl`, and for the same
    // reason: a recording commits long after the gesture, and all three
    // describe one moment that must never split across a navigation.
    scope?: Scope,
    feedback?: FeedbackContext,
  ): VoiceHost {
    const voiceComment = (text: string, voice: VoiceMeta): Comment => {
      const t = now();
      return {
        id: createId(),
        createdAt: t,
        updatedAt: t,
        route,
        fullUrl,
        text,
        modality: 'voice',
        voice,
        anchor,
        // An area + voice comment carries both: the scope is a property of the
        // gesture, not of the modality.
        ...(scope ? { scope } : {}),
        ...(feedback ? { feedback } : {}),
      };
    };
    const commitVoice = (text: string, voice: VoiceMeta): void => {
      if (this._activeVoice === active) this._activeVoice = null;
      const comment = voiceComment(text, voice);
      this._store = upsertComment(this._store, comment);
      this._persist();
      this._emitChange('add', comment);
      mount.remove();
      this._outline.clear();
      this._renderPins();
    };
    return {
      config: this._deps.config.voice ?? {},
      mount,
      anchor,
      route,
      // destroy() guards: after teardown a late callback must not touch the
      // DOM or instance state — but a transcript that finished finalizing
      // AFTER destroy() (stop() was in flight when the host tore down) is
      // still the reviewer's words: persist it STORAGE-ONLY so it is not
      // lost (review #5). Reads the stored corpus fresh because
      // `this._store` is part of the dead world.
      commit: ({ text, voice }) => {
        if (this._destroyed) {
          if (text.trim().length === 0 || this._reviewer === null) return;
          const stored =
            loadStore(this._deps.storage, this._deps.config.project, this._reviewer) ??
            emptyStore(this._deps.config.project, this._reviewer);
          saveStore(this._deps.storage, upsertComment(stored, voiceComment(text, voice)));
          return;
        }
        commitVoice(text, voice);
      },
      discard: () => {
        if (this._destroyed) return;
        if (this._activeVoice === active) this._activeVoice = null;
        mount.remove();
        // The one abandon path that shows an outline and may never open a
        // composer, so _closeActiveInput never runs to clear it.
        this._outline.clear();
      },
      degradeToText: (prefill) => {
        if (this._destroyed) return;
        if (this._activeVoice === active) this._activeVoice = null;
        mount.remove();
        // After a route change (generation bumped) the recording's route is no
        // longer on screen: persist any transcript to the FROZEN route, but
        // never open an editor there — and drop a degrade with nothing to say.
        const live = gen === this._generation;
        const text = prefill ?? '';
        if (!live && text.length === 0) return;
        this._commitTextComment(anchor, text, live, route, fullUrl, scope, feedback);
      },
      logger: this._voiceLogger,
      signal: active.abort.signal,
    };
  }

  // Memoized because `_renderPins` and `_syncChip` both ask on the same tick.
  //
  // Builder mode renders NOTHING. It aggregates at export, and the reviewer it
  // resolved to is incidental: `resolveReviewer` reads persisted identity
  // before the `__builder__` fallback is reached, so opening `?mode=builder` in
  // a browser that has been used for reviewing lands on the LAST reviewer's
  // store. Drawing that person's pins under "builder" is worse than drawing
  // none — it looks like an aggregate and is one arbitrary reviewer.
  private _visibleComments(): Array<Comment & { reviewer?: string }> {
    if (this._visibleCache) return this._visibleCache;
    const route = this._routeKey();
    this._visibleCache =
      this._deps.mode === 'builder' ? [] : this._store.comments.filter((c) => c.route === route);
    return this._visibleCache;
  }

  protected _renderPins(): void {
    // Full renders release observed detached roots; resolved targets re-register below.
    this._mutations?.disconnect();
    if (document.body) this._mutations?.observe(document.body, MUTATIONS);
    this._ui.syncLayer();
    this._invalidateViewCaches();
    // Every count-changing path funnels through here (place, save-dismiss of
    // an empty draft, delete, hydration merge, builder clear), so the export
    // chip stays honest with one sync point.
    this._syncChip();
    for (const el of this._pins.values()) el.remove();
    this._pins.clear();
    for (const el of this._areas.values()) el.remove();
    this._areas.clear();
    const comments = this._visibleComments();
    comments.forEach((c, i) => {
      const target = resolveAnchor(c.anchor);
      this._anchorCache.set(c.id, target);
      if (target) this._persistHeal(c.id, target);
      // A real <button>: keyboard operability (Enter/Space) and focusability
      // come from the platform, not from re-implemented key handlers.
      const pin = el('button', 'pin', String(i + 1));
      pin.type = 'button';
      // L2.3: dispositioned pins render muted (styles.ts); done swaps the
      // number for a ✓, with the index preserved in the title.
      if (isResolved(c) && c.status) {
        pin.dataset['status'] = c.status;
        if (c.status === 'done') {
          pin.textContent = '✓';
          pin.title = `Comment ${i + 1} — done`;
        }
      }
      if (c.reviewer) pin.title = c.reviewer;
      pin.setAttribute('aria-label', pin.title || `Comment ${i + 1}`);
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        // Opening an existing comment takes over from armed placement — leave
        // annotate mode so the next outside click can't place a spurious pin.
        if (this._annotating) this._exitAnnotateMode();
        this._openInput(c.id);
      });
      // Every comment gets a footprint element: drawn areas show the drawn
      // rect, element-anchored points show the CAPTURED element's bounds
      // (_placeArea hides degenerate cases — orphans, near-viewport anchors).
      const rect = target ? target.getBoundingClientRect() : null;
      const area = el('div', 'area');
      if (isResolved(c) && c.status) area.dataset['status'] = c.status;
      this._placeArea(area, c, target, rect);
      this._ui.root.appendChild(area);
      this._areas.set(c.id, area);
      this._placePin(pin, c, target, rect);
      this._ui.root.appendChild(pin);
      this._pins.set(c.id, pin);
    });
    this._flushHeals();
  }

  private _flushHeals(): void {
    if (!this._healsPending) return;
    this._healsPending = false;
    if (this._writeStore()) this._renderPins();
  }

  // The footprint is the anchored element's live rect × the stored
  // percentages — recomputed wherever pins are placed, so it rides the same
  // cached-anchor reflow path (orphaned: hidden with its pin).
  private _placeArea(
    area: HTMLDivElement,
    comment: Comment,
    target: Element | null,
    rect: DOMRect | null,
  ): void {
    const a = comment.anchor.areaPercent;
    if (!target || !rect) {
      area.style.display = 'none';
      return;
    }
    const r = rect;
    // Element-anchored comments footprint the captured element itself, except
    // degenerate anchors: collapsed boxes, or near-viewport ones (a click on
    // empty space anchors <body> — ants around the whole page are noise).
    const bx = a
      ? this._areaRect(a, r)
      : r.width >= 1 &&
          r.height >= 1 &&
          (r.width < window.innerWidth * 0.9 || r.height < window.innerHeight * 0.9)
        ? r
        : null;
    if (!bx) {
      area.style.display = 'none';
      return;
    }
    box(area, bx.left, bx.top, bx.width, bx.height);
  }

  // The RENDERED footprint rect, shared by the footprint and its pin (the pin
  // straddles this rect's top-left corner — they must never drift apart).
  // Compound clamp: stored data is untrusted (each leaf validates 0–100
  // independently, but x+w may exceed 100) — never paint past the anchor.
  // The 2px visibility floor (an axis-aligned drag's line must not vanish)
  // is capped to the anchor and shifts the box INWARD at clamped edges, so
  // position + extent stay inside the anchor together (review fr1/fr2).
  private _areaRect(
    a: AreaPercent,
    r: DOMRect,
  ): { left: number; top: number; width: number; height: number } {
    const width = Math.min(Math.max(2, (Math.min(a.w, 100 - a.x) / 100) * r.width), r.width);
    const height = Math.min(Math.max(2, (Math.min(a.h, 100 - a.y) / 100) * r.height), r.height);
    return {
      left: r.left + Math.max(0, Math.min((a.x / 100) * r.width, r.width - width)),
      top: r.top + Math.max(0, Math.min((a.y / 100) * r.height, r.height - height)),
      width,
      height,
    };
  }

  private _placePin(
    pin: HTMLButtonElement,
    comment: Comment,
    target: Element | null,
    rect: DOMRect | null,
  ): void {
    if (!target) {
      // Orphaned pin: HIDDEN, not a gray floater — a parked dot pointing at
      // nothing reads as breakage (first-user feedback). The element stays
      // mounted so the bounded retry can heal and un-hide it; the export
      // sheet surfaces the unanchored count instead.
      pin.dataset['orphaned'] = 'true';
      pin.style.display = 'none';
      return;
    }
    delete pin.dataset['orphaned'];
    pin.style.display = '';
    // Area pins straddle the footprint's top-left corner (the pin's own
    // translate(-50%,-50%) centers it ON the corner point) — derived at
    // render from areaPercent, so display policy needs no schema change and
    // positionPercent keeps recording the drawn center as provenance.
    const a = comment.anchor.areaPercent;
    const r = rect ?? target.getBoundingClientRect();
    place(
      pin,
      a ? this._areaRect(a, r) : anchorToScreen(target, comment.anchor.positionPercent, r),
    );
  }

  // Cheap path used on scroll/resize: just reposition existing pins, skipping
  // the querySelector + element-create cost of a full renderPins().
  private _repositionPins(): void {
    this._ui.syncLayer();
    // Orphan recovery is bounded, not per-frame: an anchor that mounted AFTER
    // the initial render (async host content) re-runs the ladder at most every
    // 500ms during reflow, so scrolling stays cheap while orphans can heal
    // (review #22).
    const t = performance.now();
    const retryOrphans = t - this._orphanRetryAt > 500;
    if (retryOrphans) this._orphanRetryAt = t;
    let parked = false;
    const byId = new Map(this._visibleComments().map((c) => [c.id, c]));
    for (const [id, pin] of this._pins) {
      const c = byId.get(id);
      if (!c) continue;
      let target = this._cachedAnchor(c);
      if (target === null && retryOrphans) {
        target = resolveAnchor(c.anchor);
        this._anchorCache.set(c.id, target);
        if (target) this._persistHeal(c.id, target);
      }
      if (target === null) parked = true;
      // ONE geometry read per target per frame, shared by pin + footprint —
      // interleaved read→write→read forces layout twice (ce-review #6).
      const rect = target ? target.getBoundingClientRect() : null;
      this._placePin(pin, c, target, rect);
      const area = this._areas.get(id);
      if (area) this._placeArea(area, c, target, rect);
    }
    this._flushHeals();
    // A pass that skipped its parked pins because of the gate still owes them
    // one retry once it expires: the pass was triggered by a change (a
    // mutation, a scroll), and a dialog reopening 100 ms after it closed is
    // exactly that change. Without this the pin stayed parked until the next
    // unrelated reflow. One timer, never stacked; cleared on destroy.
    if (parked && !retryOrphans && !this._orphanTimer)
      this._orphanTimer = window.setTimeout(
        () => {
          this._orphanTimer = 0;
          this._onReflow();
        },
        501 - (t - this._orphanRetryAt),
      );
    // Orphan state may have flipped either way — keep an open sheet honest.
    this._updateSheetTitle();
  }

  // Reflow path never re-runs the full selector ladder. A cached element that
  // left the DOM (host re-render) is re-resolved once and re-cached; an
  // orphaned (null) entry stays parked between bounded retries (see
  // _repositionPins) — its position can't change per frame.
  private _cachedAnchor(c: Comment): Element | null {
    const hit = this._anchorCache.get(c.id);
    if (
      hit === null ||
      (hit !== undefined &&
        hit.isConnected &&
        inAnchorLayer(c.anchor, hit) &&
        matchesOwner(c.anchor, hit))
    )
      return hit;
    const el = resolveAnchor(c.anchor);
    this._anchorCache.set(c.id, el);
    if (el) this._persistHeal(c.id, el);
    return el;
  }

  // Explicit-save popup: Save (or Cmd/Ctrl+Enter) persists; Escape or clicking
  // anywhere outside dismisses, dropping unsaved edits. Dismissing a comment
  // whose saved text is still empty deletes it — no orphan pins littering the
  // page from an accidental gesture.
  private _openInput(commentId: string, fresh = false): void {
    this._closeActiveInput();
    const comment = this._store.comments.find((c) => c.id === commentId);
    if (!comment) return;
    // A resolved comment opens as a frozen read-only view: readOnly textarea
    // (text stays selectable/copyable), a muted disposition line in place of
    // the Save/Delete row. Esc/outside-click still close it.
    const frozen = isResolved(comment);
    const wrap = el('div', 'input');
    const ta = el('textarea');
    ta.placeholder = 'What should change?';
    ta.value = comment.text;
    ta.rows = 3;
    ta.readOnly = frozen;
    wrap.appendChild(ta);
    const outcome =
      this._deps.config.expectedOutcome || comment.feedback?.expected ? el('textarea') : null;
    if (outcome) {
      outcome.setAttribute('aria-label', 'Expected outcome');
      outcome.placeholder = 'What should happen? (optional)';
      outcome.rows = 2;
      outcome.maxLength = 1000;
      outcome.value = comment.feedback?.expected ?? '';
      outcome.readOnly = frozen;
      wrap.appendChild(el('div', 'res', 'Expected outcome (optional)'));
      wrap.appendChild(outcome);
    }
    const intent = el('select');
    intent.setAttribute('aria-label', 'Apply to');
    for (const [value, label] of [
      ['', 'Not specified'],
      ['instance', 'This instance'],
      ['component', 'This component'],
      ['matching', 'All matching items'],
    ]) {
      const option = el('option', undefined, label);
      option.value = value!;
      intent.appendChild(option);
    }
    intent.value = comment.feedback?.intent ?? '';
    intent.disabled = frozen;
    const intentLabel = el('label', 'scope-label', 'Apply to (optional)');
    intentLabel.appendChild(intent);
    wrap.appendChild(intentLabel);
    if (frozen) {
      const mark = comment.status === 'done' ? '✓ Done' : '✕ Declined';
      const note = comment.resolution ? ` — ${comment.resolution}` : '';
      wrap.appendChild(el('div', 'res', mark + note));
    }
    this._ui.root.appendChild(wrap);

    const save = (): void => {
      if (this._destroyed || frozen) return;
      const persisted = this._store.comments.find((c) => c.id === commentId);
      // Hydration can disposition this very comment while the editor is open;
      // a resolved record is the team's, so the stale edit is discarded
      // (review #7).
      if (persisted && isResolved(persisted)) {
        this._closeActiveInput(false);
        return;
      }
      if (
        persisted &&
        (ta.value !== persisted.text ||
          (outcome && outcome.value !== (persisted.feedback?.expected ?? '')) ||
          intent.value !== (persisted.feedback?.intent ?? ''))
      ) {
        // Hand-correcting a voice transcript flags the meta as edited (immutably).
        const voicePatch = persisted.voice ? { voice: { ...persisted.voice, edited: true } } : {};
        const updated: Comment = {
          ...persisted,
          text: ta.value,
          updatedAt: now(),
          ...voicePatch,
        };
        const feedback = normalizeFeedback({
          ...persisted.feedback,
          ...(outcome ? { expected: outcome.value } : {}),
          intent: intent.value,
        });
        if (feedback) updated.feedback = feedback;
        else delete updated.feedback;
        this._store = upsertComment(this._store, updated);
        this._persist();
        this._emitChange('update', updated);
      }
      this._closeActiveInput(true, true);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault(); // dismiss the editor without cancelling its native modal host
        e.stopPropagation(); // don't also exit annotate mode
        this._closeActiveInput();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        save();
      }
    };
    ta.addEventListener('keydown', onKey);
    outcome?.addEventListener('keydown', onKey);
    // The chip is exempt so a tap on it reaches _toggleSheet, which saves this
    // draft losslessly instead of the outside-tap discarding it (review #3).
    const disarm = this._armOutsideDismiss(
      () => [wrap, this._dismissExempt()],
      () => this._closeActiveInput(),
    );
    if (!frozen) {
      const actions = el('div', 'actions');
      const del = el('button', 'delete', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => {
        const removed = this._store.comments.find((c) => c.id === commentId);
        this._store = deleteCommentFromStore(this._store, commentId);
        this._persist();
        if (removed) this._emitChange('delete', removed);
        this._closeActiveInput(false); // already gone — nothing to clean up
        this._renderPins();
      });
      const saveBtn = el('button', 'save', 'Save');
      saveBtn.type = 'button';
      saveBtn.addEventListener('click', save);
      const exp = this._composerExport();
      if (exp) actions.append(del, exp, saveBtn);
      else actions.append(del, saveBtn);
      wrap.appendChild(actions);
    }
    this._positionInputNearPin(wrap, commentId);
    this._activeInput = {
      wrap,
      commentId,
      fresh,
      cleanup: disarm,
      save: () => (frozen ? this._closeActiveInput() : save()),
    };
    ta.focus({ preventScroll: true });
  }

  // Dismissal requires a COMPLETED outside tap: armed on pointerdown, fired
  // on the matching pointerup. A second finger joining (pinch — on iOS the
  // recovery gesture after input auto-zoom) or the browser stealing the
  // gesture (pointercancel: touch scroll, pinch-zoom) aborts instead of
  // firing. composedPath (not target) because document-level listeners see
  // shadow-internal events retargeted to the host. Armed on the next task so
  // the gesture that opened the surface can't instantly close it. isPrimary
  // is only ever false on real multi-touch — plain events (jsdom, synthetic)
  // count as primary. Shared by the draft popup and the export sheet; the
  // returned disarm is idempotent-safe cleanup. `within` is a thunk returning
  // the elements that do NOT count as outside (the surface itself + the chip,
  // whose taps must reach their own click handlers — review #3/#7); a thunk
  // because the chip can be created/removed while the surface is open.
  protected _armOutsideDismiss(
    within: () => Array<HTMLElement | null>,
    onDismiss: () => void,
  ): () => void {
    let pendingTap: number | null = null;
    const inside = (e: Event): boolean => {
      const path = e.composedPath();
      return within().some((elm) => elm !== null && path.includes(elm));
    };
    const onOutsideDown = (e: Event): void => {
      const p = e as PointerEvent;
      if (p.isPrimary === false) {
        // A second finger ANYWHERE (even on the surface) makes this a pinch,
        // so the containment check must come after — review r20.
        pendingTap = null;
        return;
      }
      if (inside(e)) return;
      pendingTap = p.pointerId ?? 0;
    };
    const onOutsideUp = (e: Event): void => {
      if (pendingTap === null || ((e as PointerEvent).pointerId ?? 0) !== pendingTap) return;
      pendingTap = null;
      if (inside(e)) return; // released back inside
      // The tap meant "close this", not "operate whatever is under it". Without
      // this the reviewer dismissed a draft and navigated the prototype in the
      // same gesture — the trailing click went straight to the host control.
      this._swallowNextClick();
      onDismiss();
    };
    const onOutsideCancel = (e: Event): void => {
      if (((e as PointerEvent).pointerId ?? 0) === pendingTap) pendingTap = null;
    };
    const arm = window.setTimeout(() => {
      document.addEventListener('pointerdown', onOutsideDown, true);
      document.addEventListener('pointerup', onOutsideUp, true);
      document.addEventListener('pointercancel', onOutsideCancel, true);
    }, 0);
    return () => {
      window.clearTimeout(arm);
      document.removeEventListener('pointerdown', onOutsideDown, true);
      document.removeEventListener('pointerup', onOutsideUp, true);
      document.removeEventListener('pointercancel', onOutsideCancel, true);
    };
  }

  private _positionInputNearPin(wrap: HTMLDivElement, commentId: string): void {
    const pin = this._pins.get(commentId);
    if (!pin) return;
    // A native focus/scroll may have moved a containing dialog since the last frame.
    this._ui.syncLayer();
    const pr = pin.getBoundingClientRect();
    const vp = this._ui.bounds();
    const size = fit(wrap, vp);
    place(wrap, flipPosition({ left: pr.right, top: pr.top }, size, vp));
  }

  // Closing never saves — Save is explicit. A dismissed comment whose SAVED
  // text is still empty gets deleted (`cleanupEmpty=false` for delete/destroy:
  // delete already removed it; destroy must not write during teardown). A
  // saved expected outcome counts as content; host context on a fresh pin the
  // reviewer never saved does not, or every dismissed gesture would persist.
  private _closeActiveInput(cleanupEmpty = true, saved = false): void {
    const input = this._activeInput;
    // AFTER the guard, not before it. _openInput closes any previous composer
    // on its way in, so an unconditional clear here wiped the outline that the
    // very same placement had just painted — the outline never survived to be
    // seen. It belongs to a composer that actually existed.
    if (!input) return;
    this._outline.clear();
    this._activeInput = null;
    input.cleanup();
    input.wrap.remove();
    if (!cleanupEmpty || this._destroyed) return;
    const c = this._store.comments.find((x) => x.id === input.commentId);
    // Resolved comments are exempt: they can't be empty in practice (the team
    // dispositioned real feedback) but a shared record must never self-delete.
    if (
      c &&
      c.text === '' &&
      ((input.fresh && !saved) || !c.feedback?.expected) &&
      !isResolved(c)
    ) {
      this._store = deleteCommentFromStore(this._store, input.commentId);
      this._persist();
      this._emitChange('delete', c);
      this._renderPins();
    }
  }

  // Only classify comments on the current route — we can't tell if a comment
  // on another route would resolve without navigating there, so those stay
  // "live" conservatively (spec §5.2 intent: orphaned = element missing now).
  protected _resolution = (c: Comment): import('../types').TargetResolution => {
    const report: import('../types').TargetResolution = { availability: 'not-checked' };
    if (c.route === this._routeKey()) resolveAnchor(c.anchor, document, report);
    return report;
  };
  // Handoff hooks are inert for capture-only hosts. Full Annotator owns their UI.
  protected _closePanel(): void {}
  protected _positionPanel(): void {}
  protected _syncChip(): void {}
  protected _updateSheetTitle(): void {}
  protected _dismissExempt(): HTMLElement | null {
    return null;
  }
  protected _composerExport(): HTMLButtonElement | null {
    return null;
  }
}

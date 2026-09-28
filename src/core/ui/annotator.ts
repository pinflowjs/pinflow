import { normalizeFeedback, captureFeedback, captureUrl } from '../feedback';
import type { FeedbackContext } from '../types';
import { eventTarget, matchesOwner } from '../target';
import { anchorTarget, anchorToScreen, buildAnchor, inAnchorLayer, resolveAnchor } from '../anchor';
import { demoteScope, resolveScope } from '../scope';
import type { ScopeRect } from '../scope';
import { ScopeOutline } from './outline';
import { buildSelectors, getTextFingerprint } from '../selector';
import { copyToClipboard, download, shareFeedback } from '../download';
import {
  exportBuilder,
  exportFilename,
  exportJSON as exportStoresJSON,
  exportReviewer,
  attribution,
} from '../export';
import { createId } from '../id';
import { now } from '../time';
import { routeKey } from '../route-key';
import {
  deleteComment as deleteCommentFromStore,
  emptyStore,
  loadAllStores,
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
import { box, contrastFor, createUIRoot, el, fit, flipPosition, place, type UIRoot } from './dom';

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

interface AnnotatorDeps {
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

export class Annotator {
  private readonly _ui: UIRoot;
  private readonly _deps: AnnotatorDeps;
  // Host-defined logical screen key (config.routeKey) or the URL default —
  // the seam that makes frame-per-screen hosts (wizards, phased experiences
  // on one URL) work: pins anchor to and show on the host's notion of a
  // screen, and refreshRoute() re-evaluates it.
  private readonly _routeKey: () => string;
  private _reviewer: string | null;
  private _store: ReviewerStore;
  private _baseline: ReviewerStore;
  private _healsPending = false;
  private _annotating = false;
  private _pins = new Map<string, HTMLButtonElement>();
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
  private _activeInput: ActiveInput | null = null;
  // Bottom-left dock (0.5.0): THE one standing affordance. Reviewer gets an
  // arm segment (+/× toggle) unless stealth; the count chip joins it when
  // there is something to export. Builder renders no dock chrome at all
  // (0.9.0 removed the drawer).
  private _dockEl: HTMLDivElement | null = null;
  private _armEl: HTMLButtonElement | null = null;
  private _panelEl: HTMLDivElement | null = null;
  // Lives only while the export sheet is open; read once, on export.
  private _nameEl: HTMLInputElement | null = null;
  // Identifies the in-flight source hydration, so a newer one supersedes it.
  private _hydrationToken: object | null = null;
  // True once ANY source() hydration has resolved and merged: "not in flight"
  // is not "in sync" — a rejected or throwing source leaves the device blind
  // to server truth, and the synced clear refuses in that state (0.11.0
  // review #5).
  private _hydrated = false;
  // Anytime-export affordance: the count chip, whichever element anchors the
  // open panel (control in toggle mode, chip for the export sheet), which KIND
  // of panel is up (a sheet summon must replace a menu/confirmation, not just
  // toggle it away — review #4), and the sheet's outside-dismiss teardown.
  private _chipEl: HTMLButtonElement | null = null;
  private _panelAnchor: HTMLElement | null = null;
  // Status-line write generation — see _say().
  private _sayGen = 0;
  private _sheetOpen = false;
  private _sheetDismiss: (() => void) | null = null;
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
  private _destroyed = false;
  private _activeVoice: ActiveVoice | null = null;
  // Deletion tombstones for the window where a source() hydration is in
  // flight: a snapshot fetched BEFORE a delete must not resurrect the
  // deleted comment when it resolves AFTER it (0.3.0 review P1) — and a
  // resurrected copy would even re-announce as an 'add' on the next
  // reconcile, restoring it server-side.
  private _pendingDeletes: Set<string> | null = null;
  private readonly _voiceLogger: Logger = {
    warn: (m, d) => console.warn(`[pinflow] ${m}`, d),
    error: (m, d) => console.error(`[pinflow] ${m}`, d),
  };

  constructor(deps: AnnotatorDeps) {
    this._deps = deps;
    this._routeKey =
      deps.config.routeKey ??
      (() => routeKey(captureUrl(window.location.href, deps.config.urlQueryParams)));
    this._ui = createUIRoot();
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
    // Desktop accelerator for the export sheet. A chord, so it can never
    // collide with typing in host inputs; gated at registration (config is
    // immutable per instance).
    if (this._exportUiEnabled()) document.addEventListener('keydown', this._onExportHotkey, true);
  }

  /** Boot-line datum: comment count of the (synchronously loaded) local store. */
  get _count(): number {
    return this._store.comments.length;
  }

  private _onExportHotkey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.repeat) return; // held chord must not strobe the sheet
    if (!(k.metaKey || k.ctrlKey) || !k.shiftKey || k.key.toLowerCase() !== 'e') return;
    // The chord stays the HOST'S unless pinflow will actually act (review #11):
    // an open sheet toggles closed; otherwise there must be something to export.
    if (!this._sheetOpen && this._store.comments.length === 0) return;
    k.preventDefault();
    this._toggleSheet();
  };

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
    document.removeEventListener('keydown', this._onExportHotkey, true);
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
      if (this._panelEl) this._positionPanel();
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

  private _persist(): void {
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
  private _reconcileIdentity(): void {
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
  private _emitChange(type: 'add' | 'update' | 'delete', comment: Comment): void {
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

  private _closePanel(): void {
    this._sheetDismiss?.();
    this._sheetDismiss = null;
    this._panelEl?.remove();
    this._panelEl = null;
    this._sheetOpen = false;
    this._nameEl = null;
  }

  // Anchor the panel above whatever summoned it (control bottom-right, chip
  // bottom-left), aligned to the anchor's near edge; flipPosition handles
  // tiny viewports. An anchor can leave the DOM while an async export is in
  // flight (last comment deleted → chip unmounted — review #6): fall back to
  // the control, then to the chip's home corner.
  private _positionPanel(): void {
    if (!this._panelEl) return;
    const anchor = this._panelAnchor?.isConnected
      ? this._panelAnchor
      : ((this._chipEl?.isConnected ? this._chipEl : null) ??
        (this._armEl?.isConnected ? this._armEl : null));
    const vp = this._ui.bounds();
    const size = fit(this._panelEl, vp);
    if (!anchor) {
      place(this._panelEl, {
        left: vp.left + 16,
        top: Math.max(vp.top + 16, vp.top + vp.height - size.height - 16),
      });
      return;
    }
    const rect = anchor.getBoundingClientRect();
    // Chip sits left, control sits right: align the panel toward the wider side.
    const left =
      rect.left + size.width / 2 > vp.left + vp.width / 2 ? rect.right - size.width : rect.left;
    place(this._panelEl, flipPosition({ left, top: rect.top - size.height - 8 }, size, vp, 0));
  }

  // ── Anytime export: count chip + summonable sheet ──
  // "Summon, don't station": stealth mode has no standing chrome, so the
  // export affordance is a chip in the pins' own visual vocabulary — it
  // exists only while the reviewer has comments, and reads as the sum of
  // their pins, not as new furniture.

  private _exportUiEnabled(): boolean {
    if (this._deps.mode !== 'reviewer') return false;
    const mode = this._deps.config.exportUi ?? 'auto';
    if (mode === 'never') return false;
    // 'auto': a host that hydrates from a backend (source) owns collation —
    // member-side export there is noise. Local-first installs get it free.
    return mode === 'always' || !this._deps.config.source;
  }

  /** "1 comment" / "3 comments" — shared by the chip, the sheet and the clear. */
  private _n(v: number, w: string): string {
    return `${v} ${w}${v === 1 ? '' : 's'}`;
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
  private _rev(c: Comment): string {
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
  private readonly _foldConflicts = new Map<string, string>();

  /** Record tie conflicts between two comment lists — same id, same
   * updatedAt, different revision — BEFORE any union picks a winner
   * (0.11.0 review #7, #8). */
  private _trackTies(a: Comment[], b: Comment[]): void {
    const byId = new Map(b.map((c) => [c.id, c]));
    for (const x of a) {
      const m = byId.get(x.id);
      if (m && m.updatedAt === x.updatedAt && this._rev(m) !== this._rev(x))
        this._foldConflicts.set(x.id, x.updatedAt);
    }
  }

  /** Union with conflict tracking (0.11.0 review #7). */
  private _unionTracked(base: Comment[], mine: Comment[]): Comment[] {
    this._trackTies(base, mine);
    return unionByRecency(base, mine);
  }

  /** The exported batch as it exists right now: comments still at an exported
   * revision. Anything added, edited, dispositioned, or CONFLICTED since is
   * excluded. */
  private _exportedNow(rev: ReadonlyMap<string, string>): Comment[] {
    return this._store.comments.filter(
      (c) => rev.get(c.id) === this._rev(c) && !this._foldConflicts.has(c.id),
    );
  }

  private _sheetTitle(): string {
    const comments = this._store.comments;
    const screens = new Set(comments.map((c) => c.route)).size;
    // Orphans are hidden on the page; the sheet is where they're accounted
    // for (current route only — other routes' elements aren't here to check).
    let lost = 0;
    for (const pin of this._pins.values()) if (pin.dataset['orphaned']) lost++;
    const tail = lost > 0 ? ` · ${lost} unanchored` : '';
    return `${this._n(comments.length, 'comment')} · ${this._n(screens, 'screen')}${tail}`;
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

  private _syncChip(): void {
    const count = this._exportUiEnabled() ? this._store.comments.length : 0;
    if (count === 0) {
      if (this._chipEl) {
        this._chipEl.remove();
        this._chipEl = null;
        // The sheet is meaningless without comments; menus/confirmations stay
        // (the confirmation must survive its own export — review #6 anchors it
        // through the connectivity fallback instead).
        if (this._sheetOpen) this._closePanel();
      }
      return;
    }
    const label = `Export feedback — ${this._n(count, 'comment')}`;
    if (!this._chipEl) {
      const chip = el('button', 'chip', String(count));
      chip.type = 'button';
      chip.addEventListener('click', () => this._toggleSheet());
      this._dockEl?.appendChild(chip);
      this._chipEl = chip;
    } else {
      this._chipEl.textContent = String(count);
    }
    this._chipEl.setAttribute('aria-label', label);
    this._chipEl.title = label;
    // An open sheet tracks the corpus live (hydration merge, voice commit,
    // deletes) — Export always uses the store, so the label must too (review #5).
    if (this._sheetOpen && this._panelEl) {
      const h = this._panelEl.querySelector('h3');
      if (h) h.textContent = this._sheetTitle();
    }
  }

  private _toggleSheet(): void {
    // Summoning the export surface ends pinning — without this, a chip/hotkey
    // summon over an ARMED menu left the crosshair live and the next host
    // click planted a spurious comment (verification round, reproduced).
    if (this._annotating) this._exitAnnotateMode();
    if (this._sheetOpen) {
      this._closePanel();
      return;
    }
    this._closePanel(); // a summon REPLACES a menu/confirmation (review #4)
    // Resolve any open draft losslessly before exporting (review #3): typed
    // text is saved; a still-empty draft is deleted by the save path.
    this._activeInput?.save();
    // The save can delete the sole (empty) comment — nothing left to export
    // means nothing to summon (review #8).
    if (this._store.comments.length === 0 || !this._chipEl?.isConnected) return;
    const rest = 'Downloads the markdown and copies it to your clipboard.';
    // ONE export action. The sheet used to fork into "& share" / "& clear",
    // which asked for the disposal decision before either channel had run —
    // and download() cannot report failure, so the wipe could be authorised
    // by a reviewer who received nothing. Disposal is its own control now,
    // never an export variant, and its armed copy says plainly that nothing
    // is exported first.
    const exp = this._makeButton(
      'Export & share',
      () => void this._handleReviewerExport(),
      'primary',
    );
    const sheet = this._makePanel(this._sheetTitle(), rest, [exp]);
    this._attachClear({
      panel: sheet,
      row: sheet.querySelector<HTMLDivElement>('.row')!,
      primary: exp,
      batch: () => new Map(this._store.comments.map((c) => [c.id, this._rev(c)])),
      rest: () => rest,
      warn: (n) => `Deletes your ${n} from this browser. Nothing is exported first.`,
    });
    // Attribution is asked for HERE and nowhere else: it is the only moment it
    // matters, and the only one where a reviewer has context for the question.
    // Optional by design — a skipped name exports fine, just unattributed.
    const name = el('input', 'name');
    name.type = 'text';
    name.placeholder = 'Your name (optional)';
    name.value = this._displayName();
    name.setAttribute('aria-label', 'Your name, included in the export');
    // Enter is "I'm done naming, export" — the primary action of this sheet.
    name.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void this._handleReviewerExport();
    });
    this._nameEl = name;
    sheet.insertBefore(name, sheet.querySelector('.row'));
    // Host-owned submission channel (0.5.0: lives here since the menu panel
    // is gone; hosts pairing onSubmit with `source` should set exportUi).
    if (this._deps.config.onSubmit) {
      const row = el('div', 'row');
      row.appendChild(this._makeButton('Send to builder', () => void this._handleOnSubmit()));
      sheet.appendChild(row);
    }
    this._panelAnchor = this._chipEl;
    this._sheetOpen = true;
    this._panelEl = sheet;
    this._ui.root.appendChild(sheet);
    this._positionPanel();
    // The chip is exempt from outside-dismiss: its own click must reach the
    // toggle (a physical tap's pointerup would otherwise close the sheet and
    // the trailing click reopen it — review #7).
    this._sheetDismiss = this._armOutsideDismiss(
      () => [sheet, this._chipEl],
      () => this._closePanel(),
    );
  }

  /** Fold the durable truth into memory: the remembered identity first (a
   * cross-tab rename), then the on-disk corpus under the current key (a
   * cross-tab edit) — memory wins only where genuinely newer. Renders only
   * when the fold changed something material, so a no-op fold cannot replay
   * pin entrances (0.11.0 review #4). */
  private _foldDurable(): void {
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

  // Synced hosts stay consistent: every removal goes out as its own delete
  // (PROTOCOL deletes are per-comment; there is no bulk op on the wire).
  //
  // Verify, then report (0.11.0 review #4). The fold reads the durable truth
  // before anything is selected; the strip is REVISION-scoped on every pass,
  // so a newer revision folded in mid-wipe is never destroyed; and after the
  // loop the final state — memory AND disk — decides what is claimed: deletes
  // go out only for ids with no surviving copy anywhere, and `clean` is false
  // whenever an exported revision remains (a swallowed setItem failure, or a
  // pathological run of interleaved renames), so the caller reports failure
  // instead of success. localStorage offers no cross-context lock; this is as
  // strong as read-before, verify-after can make a lockless store.
  private _clearReviewerComments(rev: ReadonlyMap<string, string>): {
    tried: boolean;
    clean: boolean;
  } {
    this._foldDurable();
    const at = (c: Comment): boolean =>
      rev.get(c.id) === this._rev(c) && !this._foldConflicts.has(c.id);
    const intent = this._store.comments.filter(at);
    if (!intent.length) return { tried: false, clean: true };
    for (let i = 0; i < 4; i++) {
      this._store = { ...this._store, comments: this._store.comments.filter((c) => !at(c)) };
      this._persist();
      this._reconcileIdentity();
      if (!this._store.comments.some(at)) break;
    }
    const disk =
      this._reviewer === null
        ? null
        : loadStore(this._deps.storage, this._deps.config.project, this._reviewer);
    // Durably clean means the disk shows NOTHING from before the export under
    // a cleared id: the exact exported revision is a failed write, and an
    // OLDER one is a failed write resurrecting pre-export content behind a
    // success report. A strictly newer survivor is a legitimate edit (0.11.0
    // review #10).
    const intentTs = new Map(intent.map((c) => [c.id, c.updatedAt]));
    const diskStale = (c: Comment): boolean => {
      const ts = intentTs.get(c.id);
      return ts !== undefined && c.updatedAt <= ts;
    };
    const clean = !this._store.comments.some(at) && !disk?.comments.some(diskStale);
    const survivors = new Set(
      [...this._store.comments, ...(disk?.comments ?? [])].map((c) => c.id),
    );
    // The verification read folds back into memory too: on a failed write the
    // screen must keep showing what disk still holds — pins vanishing under a
    // "could not be cleared" message would be a lie in the other direction,
    // and a later successful persist from the stripped memory would silently
    // erase the survivors (0.11.0 review #5).
    if (disk)
      this._store = {
        ...this._store,
        // Tracked like every other union: a divergence another tab persisted
        // DURING the wipe must be recorded here, or the next export would
        // legitimize deleting the discarded side (0.11.0 review #9).
        comments: this._unionTracked(disk.comments, this._store.comments),
      };
    // A failed clear keeps its batch — but only the part that VERIFIABLY
    // survived: an id absent from both final stores was durably removed and
    // gets its delete, so folding it back would restore locally what the wire
    // was just told to drop. Fold-back and delete emission agree per id
    // (0.11.0 review #11, #12).
    if (!clean)
      this._store = {
        ...this._store,
        comments: this._unionTracked(
          this._store.comments,
          intent.filter((c) => survivors.has(c.id)),
        ),
      };
    for (const c of intent) if (!survivors.has(c.id)) this._emitChange('delete', c);
    this._renderPins();
    return { tried: true, clean };
  }

  // Built imperatively to keep reviewer names out of innerHTML.
  private _makeButton(
    label: string,
    onClick: () => void,
    variant?: 'primary' | 'clr',
  ): HTMLButtonElement {
    const b = el('button', variant, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // Shared scaffolding for the reviewer panel and the export confirmation.
  private _makePanel(title: string, body: string, buttons: HTMLButtonElement[]): HTMLDivElement {
    const panel = el('div', 'panel');
    const row = el('div', 'row');
    row.append(...buttons);
    // The paragraph is the panel's status line, not static prose: the
    // confirmation rewrites it for a copy failure, for the armed clear, and for
    // the wipe itself. Without this the copy failure changed silently.
    const p = el('p', undefined, body);
    p.setAttribute('aria-live', 'polite');
    panel.append(el('h3', undefined, title), p, row);
    return panel;
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

  private _exitAnnotateMode(): void {
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

  private _renderPins(): void {
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
    if (this._sheetOpen && this._panelEl) {
      const h = this._panelEl.querySelector('h3');
      if (h) h.textContent = this._sheetTitle();
    }
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
      () => [wrap, this._chipEl],
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
      if (this._exportUiEnabled()) {
        // Anytime export from the moment of engagement: SAVES the draft
        // first (never silently discards typed text), then summons the sheet.
        const exp = el('button', 'exportall', `Export all · ${this._store.comments.length}`);
        exp.type = 'button';
        // _toggleSheet saves the draft itself (ActiveInput.save) — one path.
        exp.addEventListener('click', () => this._toggleSheet());
        actions.append(del, exp, saveBtn);
      } else {
        actions.append(del, saveBtn);
      }
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
  private _armOutsideDismiss(
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
  private _resolution = (c: Comment): import('../types').TargetResolution => {
    const report: import('../types').TargetResolution = { availability: 'not-checked' };
    if (c.route === this._routeKey()) resolveAnchor(c.anchor, document, report);
    return report;
  };

  private _isOrphaned = (c: Comment): boolean => {
    if (c.route !== this._routeKey()) return false;
    return resolveAnchor(c.anchor) === null;
  };

  /**
   * Current corpus as versioned JSON (`{ pinflowExport, generatedAt, comments }`):
   * this reviewer's store in reviewer mode, every reviewer's in builder mode.
   * Public — exposed on the init() handle for host-owned pipelines.
   */
  exportJSON(): string {
    if (this._deps.mode === 'reviewer') this._foldDurable();
    return exportStoresJSON(
      this._deps.mode === 'builder' ? this._allStores() : this._store,
      this._resolution,
    );
  }

  private _allStores(): ReviewerStore[] {
    return loadAllStores(this._deps.storage, this._deps.config.project);
  }

  /**
   * Markdown artifact via the same generator as the export button (builder
   * mode aggregates all stores). Public — hosts own the submission moment
   * (stealth has no chrome), so the handle exposes this.
   */
  exportMarkdown(): string {
    return this._buildArtifact()[0];
  }

  /**
   * Download the markdown artifact + copy it to the clipboard, with NO
   * confirmation panel — the host owns that UX. Public, on the handle.
   */
  downloadExport(): void {
    const [md, filename] = this._buildArtifact();
    download(md, filename);
    void copyToClipboard(md);
  }

  /** Attribution from the STORED identity — `attribution()` owns the rule. */
  private _displayName(): string {
    return attribution(this._reviewer ?? '');
  }

  /**
   * Single source for the markdown artifact + its filename, mode-aware.
   *
   * `attributeTo` is the export-scoped override from the sheet. It is passed
   * explicitly, and the built artifact is then carried to the confirmation
   * panel, because a rebuild would fall back to the stored identity and undo a
   * reviewer who deliberately cleared the field (0.7.0 review #5).
   */
  private _buildArtifact(attributeTo?: string): [md: string, filename: string] {
    if (this._deps.mode === 'reviewer') this._foldDurable();
    const { project, describeRoute } = this._deps.config;
    const meta = { generatedAt: now(), project, resolve: this._resolution };
    const builder = this._deps.mode === 'builder';
    const who = attributeTo ?? this._displayName();
    return [
      builder
        ? exportBuilder(this._allStores(), meta, this._isOrphaned, describeRoute)
        : exportReviewer({ ...this._store, reviewer: who }, meta, this._isOrphaned, describeRoute),
      exportFilename(project, builder ? null : who, meta.generatedAt),
    ];
  }

  /**
   * Settle identity for a terminal sheet action and report who this artifact
   * belongs to. Shared by BOTH terminal actions — Send to builder read the
   * store directly and never saw the typed name (0.7.0 review #4).
   *
   * - a typed name renames and attributes to it
   * - a CLEARED field is an export-scoped opt-out: no rename, no attribution,
   *   and the corpus keeps the identity it is filed under
   * - no field at all (no sheet) defers to the stored identity
   */
  private _settleName(): string | undefined {
    const field = this._nameEl;
    if (!field) return undefined;
    const typed = field.value.trim();
    if (!typed) return '';
    if (typed === this._reviewer) return typed;
    return this._renameTo(typed) ? typed : undefined;
  }

  /**
   * Move the corpus to `name`. The storage key embeds the reviewer, so this is
   * a key move, not a field edit — and the new identity is committed only if
   * the move succeeded. A refused write leaves both the name and the comments
   * where they were: that export goes out unattributed, which is honest, where
   * remembering a name whose corpus never moved would open empty next visit.
   */
  private _renameTo(name: string): boolean {
    const from = this._reviewer;
    if (from === null) return false;
    const { storage, config } = this._deps;
    // Track source-vs-destination tie divergence before the storage-level
    // union drops a side, and FOLD the reloaded corpus with memory instead of
    // replacing it — memory may hold a failed-persist revision that exists
    // nowhere else (0.11.0 review #8).
    {
      const held = loadStore(storage, config.project, from);
      const dest = loadStore(storage, config.project, name);
      if (held && dest) this._trackTies(dest.comments, held.comments);
    }
    if (!renameReviewer(storage, config.project, from, name)) return false;
    this._reviewer = name;
    const landed = loadStore(storage, config.project, name) ?? emptyStore(config.project, name);
    this._store = {
      ...landed,
      comments: this._unionTracked(landed.comments, this._store.comments),
    };
    this._baseline = landed;
    // Folding into an existing corpus changes what belongs on screen; without
    // this the pins and the chip disagree with the artifact (review #6).
    this._renderPins();
    return true;
  }

  private async _handleReviewerExport(): Promise<void> {
    // Export is a terminal action for the armed state: the reviewer moved on
    // from pinning (0.3.0 review #4). Disarm BEFORE capturing the ownership
    // panel — disarming may rebuild an open menu.
    if (this._annotating) this._exitAnnotateMode();
    // Read the field BEFORE the artifact is built; it decides the attribution.
    const [md, filename] = this._buildArtifact(this._settleName());
    // The batch freezes WITH the artifact, in this same synchronous block — a
    // hydration merge or voice commit landing during the clipboard await below
    // is already outside it (0.11.0 review #2). The clear on the confirmation is
    // scoped to exactly these revisions; anything at a different one since is
    // feedback (or disposition) the file does not hold.
    const rev = new Map(this._store.comments.map((c) => [c.id, this._rev(c)]));
    // Conflict evidence is pruned, never cleared: an entry survives every
    // batch until its comment moves past the tie or leaves the board (0.11.0
    // review #8).
    const byId = new Map(this._store.comments.map((c) => [c.id, c.updatedAt]));
    for (const [id, ts] of this._foldConflicts)
      if (byId.get(id) !== ts) this._foldConflicts.delete(id);
    if (window.matchMedia('(any-pointer:coarse)').matches) {
      this._showConfirmation(false, [md, filename], rev, true);
      return;
    }
    download(md, filename);
    const startedFrom = this._panelEl;
    // Serialized page-wide inside copyToClipboard (0.11.0 review #10, #11).
    const copied = await copyToClipboard(md);
    // A slow clipboard must not resurrect stale UI (review #23): the
    // confirmation appears only if the EXACT surface that launched the export
    // is still open — a closed or replaced panel invalidates it entirely.
    if (this._destroyed || this._panelEl === null || this._panelEl !== startedFrom) return;
    this._showConfirmation(copied, [md, filename], rev);
  }

  // Retries hold the frozen artifact and outlive revision-scoped clearing.
  // Desktop tries download + clipboard; mobile opens the OS share sheet.
  // A resolved native share is not proof that a recipient received the file.
  private _showConfirmation(
    copied: boolean,
    artifact?: [md: string, filename: string],
    rev?: ReadonlyMap<string, string>,
    mobile = false,
  ): void {
    this._closePanel();
    // Delivery is mutable: a Copy retry that succeeds AFTER a failed export
    // write upgrades what the armed warning AND the resting line may honestly
    // claim (0.11.0 review #4).
    let delivered = copied;
    // The resting body is also the disarm target: backing out of an armed
    // clear restores the truest line the panel can currently claim.
    let shareStatus = 'Share your feedback or copy it into a message.';
    const baseNow = (): string =>
      mobile
        ? delivered
          ? 'Copied to your clipboard.'
          : shareStatus
        : delivered
          ? 'Copied to your clipboard. If no file downloaded, paste it instead.'
          : 'Check your downloads for the file.';
    const send = this._makeButton(mobile ? 'Share feedback' : 'Download Feedback Markdown', () => {
      const [md, filename] = artifact ?? this._buildArtifact();
      if (!mobile) return download(md, filename);
      if (send.disabled) return;
      send.disabled = true;
      const gen = ++this._sayGen;
      // Invoke before any await: Web Share consumes the tap's user activation.
      void shareFeedback(md, filename).then((result) => {
        send.disabled = false;
        shareStatus =
          result === 'shared'
            ? 'Share sheet closed. You can share again or copy the feedback.'
            : result === 'cancelled'
              ? 'Sharing canceled. Your feedback is still here.'
              : 'Sharing unavailable. Copy the feedback into a message instead.';
        if (!this._destroyed && this._panelEl === panel && gen === this._sayGen)
          this._say(shareStatus);
      });
    });
    const panel = this._makePanel('Your feedback is ready', baseNow(), [
      // NOT downloadExport(): that also writes the clipboard, which would make
      // this button silently clobber it behind the reviewer's back — the panel
      // offers the two channels separately on purpose.
      //
      // Retries re-send the artifact that was ALREADY built. Rebuilding here
      // would re-derive attribution from the stored identity, after the sheet
      // and its name field are gone (review #5) — and, since 0.11.0, would
      // rebuild from a store the Clear below may have just emptied. Holding
      // the artifact is what lets both retries outlive the wipe.
      send,
      this._makeButton(
        'Copy to Clipboard',
        () =>
          void this._reCopy(artifact?.[0], mobile).then((ok) => {
            if (ok) delivered = true;
          }),
      ),
    ]);
    // Clearing remains separate from delivery; Done closes without deleting.
    const row = el('div', 'row');
    const done = this._makeButton('Done', () => this._closePanel(), 'primary');
    row.appendChild(done);
    if (rev?.size)
      this._attachClear({
        panel,
        row,
        primary: done,
        batch: () => rev,
        rest: baseNow,
        // Answers the only question a reviewer actually has here — which
        // depends on what this panel can honestly claim: with a verified
        // clipboard the file is safe; without one, say so instead.
        warn: (n) =>
          `Deletes your ${n} from this browser. ` +
          (delivered
            ? mobile
              ? 'The clipboard copy is unaffected.'
              : 'The exported file is unaffected.'
            : mobile
              ? 'Check you received the feedback first: delivery is not confirmed.'
              : 'Check the file downloaded first: there is no other copy.'),
      });
    panel.appendChild(row);
    this._panelEl = panel;
    this._ui.root.appendChild(panel);
    this._positionPanel();
    if (mobile) send.click();
  }

  // The two-tap clear, shared by the export sheet and the confirmation.
  //
  // Resting, it is a quiet text control. The first tap ARMS: the panel's
  // primary (Export & share / Done) is hidden, a Keep button appears beside
  // the control, and the control itself becomes the filled destructive
  // affirmative, labelled with the count. The row now reads as one question
  // with two answers — the earlier "Clear N comments?" label on the same
  // quiet control read as a prompt, and reviewers answered it by pressing the
  // accented Done beside it, which finished without clearing. Two taps rather
  // than an undo: deletes go out per-comment on the sync wire (PROTOCOL has
  // no bulk op), so there is no reversal.
  //
  // `batch` is read at the arming tap, AFTER the durable fold: the
  // confirmation returns the revisions the export froze, the sheet snapshots
  // the corpus as it stands. Either way the wipe is revision-scoped — a
  // revision persisted by another tab between the taps is never destroyed.
  private _attachClear(o: {
    panel: HTMLDivElement;
    row: HTMLDivElement;
    primary: HTMLButtonElement;
    batch: () => ReadonlyMap<string, string>;
    rest: () => string;
    warn: (count: string) => string;
  }): void {
    let rev: ReadonlyMap<string, string> = new Map();
    let armed = false;
    let at = 0;
    let offOut: (() => void) | null = null;
    // A click on a FOCUSABLE host control fires focusout between pointerdown
    // and pointerup; disarming there would tear the pointer listener down
    // mid-gesture and skip the back-out swallow. Track the gesture and let
    // the pointer path finish it (0.11.0 review #6).
    let midPointer = false;
    let fled = false; // focus left the panel while a gesture was in flight
    const pd = (): void => {
      midPointer = true;
    };
    // On EVERY gesture end a deferred focus departure must land (0.11.0
    // review #7) — but a pointerup defers ITS disarm to the next task: this
    // listener runs before the outside-dismiss's, and a synchronous disarm
    // would remove that later listener mid-dispatch, skipping the back-out
    // swallow in real DOM (0.11.0 review #8). An outside release disarms
    // via the dismiss itself; the timeout only catches inside releases.
    let tid: ReturnType<typeof setTimeout> | null = null;
    const pu = (): void => {
      midPointer = false;
      if (fled) {
        fled = false;
        // OWNED: the composite disposer cancels it, so a panel replaced
        // before this fires is never written to (0.11.0 review #9).
        tid = setTimeout(() => {
          tid = null;
          if (armed) disarm();
        }, 0);
      }
    };
    // A release that never arrives — drag out of the window, app switch —
    // still ends the gesture and lands the departure (0.11.0 review #9).
    const onBlur = (): void => {
      midPointer = false;
      if (fled) {
        fled = false;
        disarm();
      }
    };
    // No click follows a cancel — the departure lands immediately.
    const pc = (): void => {
      midPointer = false;
      if (fled) {
        fled = false;
        disarm();
      }
    };
    const live = () => this._exportedNow(rev);
    // Every path out of the armed state funnels here: the state drops, the
    // host-page listeners below are disposed, and the panel's own dismiss —
    // the sheet's outside tap — is handed back to the slot it came from
    // (0.11.0 review #4).
    const unarm = (): void => {
      armed = false;
      fled = false;
      offOut?.();
      offOut = null;
    };
    const rest = (): void => {
      keep.hidden = true;
      o.primary.hidden = false;
    };
    const disarm = (): void => {
      if (!armed) return;
      unarm();
      rest();
      clr.className = 'clr';
      clr.textContent = 'Clear comments';
      this._say(o.rest());
    };
    // Both retirement paths park focus on the primary: the activation just
    // removed the focused element, and a keyboard reviewer must land inside
    // the still-open panel, not on the host page (0.11.0 review #1). A sheet
    // that emptied its corpus has already closed — the arm control is the
    // nearest thing left standing.
    const spend = (msg: string): void => {
      unarm();
      rest();
      clr.remove();
      if (o.panel.isConnected) o.primary.focus();
      else this._armEl?.focus();
      this._say(msg);
    };
    // Backing out is a first-class answer, not a tap elsewhere: it lands
    // focus on the resting control so a keyboard reviewer is not dropped.
    const keep = this._makeButton('Keep', () => {
      disarm();
      clr.focus();
    });
    keep.hidden = true;
    const clr = this._makeButton(
      'Clear comments',
      () => {
        if (!armed) {
          // The FIRST tap reads the durable truth too — a rename or an edit
          // persisted by another tab must retire the control, not arm a
          // count from stale memory (0.11.0 review #4).
          this._foldDurable();
          rev = o.batch();
          const n = live().length;
          if (!n) return spend('Nothing left to clear.');
          armed = true;
          at = performance.now();
          // Arming is a question posed to the reviewer; leaving the panel is
          // walking away from it. A tap anywhere on the host page disarms,
          // so a stray tap minutes later cannot land on a decision nobody
          // is making (0.11.0 review #4). One composite disposer owns
          // everything the armed state put on the document, and it lives in
          // the shared slot — _closePanel and destroy() tear it all down even
          // mid-arm (0.11.0 review #7). The slot may already hold the sheet's
          // own outside-dismiss: the composite CHAINS it, so closing the panel
          // still disposes it, and a mere disarm hands it back untouched.
          const prev = this._sheetDismiss;
          const offDismiss = this._armOutsideDismiss(() => [o.panel], disarm);
          document.addEventListener('pointerdown', pd, true);
          document.addEventListener('pointerup', pu, true);
          document.addEventListener('pointercancel', pc, true);
          window.addEventListener('blur', onBlur);
          const own = (offOut = (): void => {
            offDismiss();
            document.removeEventListener('pointerdown', pd, true);
            document.removeEventListener('pointerup', pu, true);
            document.removeEventListener('pointercancel', pc, true);
            window.removeEventListener('blur', onBlur);
            if (tid !== null) {
              clearTimeout(tid);
              tid = null;
            }
            // Teardown by ANY owner leaves the closure inert: no stale
            // timer, no stale state, nothing left to say (0.11.0 review #9).
            armed = false;
            fled = false;
            midPointer = false;
            if (this._sheetDismiss === composite) this._sheetDismiss = prev;
          });
          const composite = (): void => {
            own();
            prev?.();
          };
          this._sheetDismiss = composite;
          o.primary.hidden = true;
          keep.hidden = false;
          clr.className = 'clr a';
          clr.textContent = `Clear ${this._n(n, 'comment')}`;
          return this._say(o.warn(this._n(n, 'comment')));
        }
        // One physical gesture must never be both taps: a double-tap (or a
        // key-repeat burst) delivers its second activation well inside this
        // window, and the whole safety of the control is that the second
        // tap is a SEPARATE decision. Same idiom as the gesture layer's
        // swallow window.
        if (performance.now() - at < 600) return;
        // PROTOCOL deletes are id-keyed with no revision precondition, so a
        // wipe while hydration is in flight could destroy a backend revision
        // this device has never seen. Wait it out (0.11.0 review #4).
        if (this._pendingDeletes)
          return this._say('Still syncing with the host. Try again in a moment.');
        // A hydration that FAILED never becomes safe by settling: the
        // device has not seen server truth, and an id-keyed delete could
        // destroy a backend revision it never knew (0.11.0 review #5).
        if (this._deps.config.source && !this._hydrated)
          return this._say('Could not sync with the host. Reload to clear.');
        // Verify-then-report: the wipe re-selects against the durable truth,
        // and claims only what the final state supports (0.11.0 review #4).
        // The retries stay either way: this panel is the route to the file.
        const r = this._clearReviewerComments(rev);
        if (!r.tried) return spend('Nothing left to clear.');
        if (!r.clean) {
          disarm();
          return this._say('Some comments could not be cleared. Try again.');
        }
        spend('Comments cleared. You can still export or copy the feedback.');
      },
      'clr',
    );
    // Enter activates a focused button once per keydown INCLUDING repeats —
    // a held key would sail past the window above on its own cadence.
    clr.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      // Enter alone: it activates per-keydown including repeats. Arrows and
      // paging must keep scrolling (0.11.0 review #2).
      if (k.repeat && k.key === 'Enter') k.preventDefault();
    });
    // Reaching for any other control is leaving the question — disarm, so a
    // stray tap minutes later cannot land on a decision nobody is making.
    o.panel.addEventListener(
      'click',
      (e) => {
        if (armed && e.target !== clr) disarm();
      },
      true,
    );
    // Keyboard parity for the outside disarm: Tabbing out of the panel is
    // leaving the question too (0.11.0 review #5). Retirement paths move
    // focus themselves, but only after unarm(), so their focusout is inert.
    o.panel.addEventListener('focusout', (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      const leaving = armed && (!to || !o.panel.contains(to));
      if (!leaving) return;
      if (midPointer) {
        fled = true; // the gesture owns the disarm — but the departure lands
        return;
      }
      disarm();
    });
    o.row.prepend(keep, clr);
  }

  /** The panel's status line. Live-region'd in _makePanel, so writes announce.
   * Every write bumps the generation: an async narrator that captured an older
   * one must stay silent, or a slow clipboard would overwrite the armed
   * warning at the decision moment (0.11.0 review #1). */
  private _say(text: string): void {
    this._sayGen++;
    const p = this._panelEl?.querySelector('p');
    if (p) p.textContent = text;
    this._positionPanel();
  }

  // Reports only what it can verify, and only when nothing outranked it.
  // Ownership-checked like the export path (review #23), plus two generation
  // rules: the request RESERVES a generation at start, so of two overlapping
  // retries the latest wins; and anything said since (armed clear, wipe
  // report) outranks the narration entirely. Returns the clipboard result
  // either way — delivery and narration are separate facts (0.11.0 review #2).
  private async _reCopy(md?: string, mobile = false): Promise<boolean> {
    const startedFrom = this._panelEl;
    const gen = ++this._sayGen;
    const content = md ?? this._buildArtifact()[0];
    const ok = await copyToClipboard(content);
    if (!this._destroyed && this._panelEl === startedFrom && gen === this._sayGen) {
      this._say(
        ok ? 'Copied to your clipboard.' : 'Copy failed. Try again or use the other export option.',
      );
      if (!ok && mobile && startedFrom) {
        let field = startedFrom.querySelector('textarea');
        if (!field) {
          field = el('textarea', 'manual-copy');
          field.setAttribute('aria-label', 'Feedback to copy');
          field.readOnly = true;
          field.value = content;
          startedFrom.appendChild(field);
        }
        this._say('Copy unavailable. Select and copy the feedback below.');
        this._positionPanel();
        field.focus({ preventScroll: true });
        field.select();
      }
    }
    return ok;
  }

  private async _handleOnSubmit(): Promise<void> {
    if (!this._deps.config.onSubmit) return;
    if (this._annotating) this._exitAnnotateMode();
    // The sheet's OTHER terminal action, and equivalent to Export & share by
    // contract — so it settles the typed name the same way. Reading the store
    // directly sent the builder a handle the reviewer had just replaced
    // (review #4). The payload carries the persisted identity, not the
    // export-scoped blank: a host storing this needs a real key.
    this._settleName();
    try {
      await this._deps.config.onSubmit(this._store);
    } catch (err) {
      this._voiceLogger.warn('onSubmit handler threw', err);
    }
  }
}

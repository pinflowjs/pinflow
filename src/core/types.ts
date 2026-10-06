export type Mode = 'reviewer' | 'builder';

export interface SelectorCandidates {
  testid: string | null;
  id: string | null;
  css: string;
  xpath: string;
  /**
   * The role-and-name rung (0.12.0, additive): the element's role (explicit,
   * else a small implicit map — `checkbox`, `link`, `button`…) and its
   * accessible name from aria-label / aria-labelledby / an associated
   * `<label>` / alt / title (≤80). Never from text content — the fingerprint
   * owns text. Present only when a name exists. Resolves between `id` and
   * `css`, and only when unique; a CSS-modules rebuild kills every hashed
   * class in the css path but leaves `role="switch"` + "Spoke for Alfred Hart".
   */
  role?: string;
  name?: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PositionPercent {
  x: number;
  y: number;
}

/** Marquee-drawn region as percentages of the anchored element's box (0–100). */
export interface AreaPercent {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TargetEvidence {
  /** Owner's root depth in the shadow host chain; absent means the target root. */
  rootDepth?: number;
  identity?: 'id' | 'testid';
  /** Position among same-tag nodes sharing this text at capture, recorded only when there were several; resolution requires the same count. */
  ordinal?: number;
  count?: number;
  /** Relative XPath from the owner to the anchored element, excluded from the owner's text so a fix to the pinned control keeps its entity. */
  path?: string;
  /** The lookalike scan hit its cap or budget at capture: a locator hint, never a constraint. */
  ambiguous?: true;
  context?: Anchor['context'];
  selectors: SelectorCandidates;
  textFingerprint: string;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CaptureDetails {
  text?: string;
  truncated?: true;
  state?: string[];
  bounds?: CaptureRect;
  parentBounds?: CaptureRect;
  textRects?: CaptureRect[];
  layout?: {
    display?: string;
    lineHeight?: string;
    gap?: string;
    overflow?: string;
    width?: string;
    height?: string;
  };
  limitation?: 'canvas' | 'frame' | 'shadow-host';
}
export interface CapturePoint {
  clientX: number;
  clientY: number;
}

export interface Anchor {
  /** Bounded DOM facts, distinct from host-supplied observations and reviewer intent. */
  details?: CaptureDetails;
  /** Semantic repeated owner: a resolution constraint, never just a source hint. */
  owner?: TargetEvidence;
  /** Outer-to-inner open shadow hosts. A missing host parks the target; an empty path is a binding that cannot be resolved (excessive nesting, or corrupt binding evidence on hydration). */
  shadowPath?: TargetEvidence[];

  /** Original locators, retained on the first repair. Current selectors remain the live locator. */
  capturedSelectors?: SelectorCandidates;
  /** Precise clicked descendant when the stable anchor is an ancestor. Historical evidence only. */
  target?: TargetEvidence;
  selectors: SelectorCandidates;
  textFingerprint: string;
  positionPercent: PositionPercent;
  viewport: Viewport;
  /**
   * Present on area comments (drag-to-marquee): the drawn rect relative to
   * the anchored element. The marquee is a PICKER — the comment still anchors
   * to a single element (pin at the rect's center), so persistence, healing,
   * and rendering are identical to point comments. Additive in 0.5.0.
   *
   * WHICH element that is depends on what the region covered (since 0.11.1).
   * When the scope walk resolves exactly ONE member, the anchor is that member
   * — the thing the note is about. Otherwise it is the smallest ancestor whose
   * box contains the drawn rect. Consumers must read `selectors` to know which;
   * do not assume the anchor contains the rect.
   *
   * Because it need not contain it, the rect is CLAMPED to the anchor's box on
   * every side: `{x:0,w:100}` means "covers the whole element", not "the
   * reviewer drew exactly this". Both endpoints clamp, so `x+w` and `y+h`
   * never exceed 100 and the stored extent is the true overlap.
   */
  areaPercent?: AreaPercent;
  /**
   * Area comments only: up to 3 newline-separated labels (≤40 chars each) of
   * the blocks the drawn rect was sampled over. The comment still anchors to
   * the containing ancestor — this names WHAT the rect covered, which the
   * ancestor's own text cannot: a rect spanning sibling cards climbs to a
   * page-level container whose first 80 characters describe a different part
   * of the page entirely. A pin-time record like `context.styles`, so it goes
   * stale if the page changes. Additive in 0.6.1.
   */
  covers?: string;
  /**
   * Best-effort human context captured at pin time: accessible name, role,
   * and the nearest preceding/ancestor heading text (≤80 chars each) — lets
   * exports say "the 'Continue' button under 'Next section'". Additive in v3.
   *
   * `styles` is a computed-style micro-snapshot of the properties feedback is
   * usually ABOUT (background, color, font, radius — captured at pin time, so
   * it reflects what the reviewer saw); `src` is the truncated image URL for
   * image pins. Together they give an agent the "what is being pinned"
   * blast radius without screenshots.
   */
  /**
   * The modal LAYER the pinned element lived in, when it had one: the nearest
   * `[role="dialog"]` / `[role="alertdialog"]` / `[aria-modal="true"]` / open
   * `<dialog>` ancestor, named by its accessible name (aria-label,
   * aria-labelledby, else its first heading; ≤80 chars). A layer pin resolves
   * ONLY inside an open dialog of that name and parks (orphaned, hidden)
   * otherwise — it never heals onto the page underneath, which is what
   * closing a modal used to do to every pin taken on it. Additive in 0.12.0.
   */
  layer?: { role: 'dialog'; name?: string };
  context?: {
    name?: string;
    role?: string;
    heading?: string;
    /** Truncated (≤200 chars) `src` when the pinned element is an image. */
    src?: string;
    /** Only meaningful values are captured; defaults (transparent bg, 0 radius) are omitted. */
    styles?: {
      background?: string;
      backgroundImage?: string;
      color?: string;
      fontSize?: string;
      /** First family only, quotes stripped. */
      fontFamily?: string;
      /** Omitted at the `start` initial value; present means someone chose it. */
      textAlign?: string;
      radius?: string;
    };
  };
}

/**
 * Which ladder rung produced a scope. Strongest first — an agent must be able
 * to tell a host-declared `data-pinflow-source` boundary from a landmark
 * fallback, because they justify very different confidence.
 */
export type ScopeRung = 'source' | 'testid' | 'repeated' | 'landmark' | 'anchor';

export type ScopeConfidence = 'high' | 'medium' | 'low';

/** How much of an element the drawn region covered. `grazed` is never emitted as a change. */
export type ScopeBand = 'inside' | 'partial';

/**
 * One element named by a scope. Locators plus just enough human context to
 * recognise it; every string is captured pre-capped and codepoint-stripped, so
 * the JSON twin and the `onChange` wire payload are clean too — not only the
 * markdown.
 */
export interface ScopeNode {
  /** Lowercased tag name. */
  tag: string;
  /** CSS path, same generator as the anchor's. */
  css: string;
  testid?: string;
  /** Accessible name, alt text, or text fingerprint — ≤80 chars. */
  label?: string;
}

export interface ChangeNode extends ScopeNode {
  band: ScopeBand;
}

/**
 * The element whose CSS actually animates, and WHICH properties — never their
 * values. A value is a lie at capture time: the reviewer's pointer is on the
 * element when they release, so `.card:hover { rotate: 0deg }` computes to
 * `0deg` on a note that says "remove the shaking". The property or keyframes
 * NAME is a literal source token an agent can grep for instead.
 */
export interface MotionNode extends ScopeNode {
  props: string;
}

/**
 * The blast radius: what an agent acting on this comment may change, and the
 * boundary it may not leave.
 *
 * Lives on `Comment`, NOT on `Anchor`, and that placement is load-bearing.
 * `hasValidAnchor` is fatal — a malformed leaf drops the whole comment,
 * because anchor leaves are dereferenced unguarded. Scope is rendered guarded
 * and never re-resolved, so it is strippable, and strippable fields belong on
 * the comment. Losing a boundary hint must never lose the reviewer's words.
 *
 * There is deliberately NO `kind` discriminator on `Comment` — that would make
 * `Comment` a union and break it as the single wire type PROTOCOL.md
 * documents. Structure is total instead: `between` present → insertion;
 * `members` present → region; neither → point. No empty collection is ever
 * written, so a backend that normalises `[]` to absent cannot change an
 * annotation's kind in transit.
 */
export interface Scope {
  /**
   * Tuning generation. Mandatory and NOT retrofittable: the coverage bands and
   * caps are unresolved research, `rung`/`confidence` are persisted AND shipped
   * to agents, and retuning them later would make `confidence: 'high'` mean two
   * different things with no way to tell which tuning wrote an existing record.
   */
  gen: number;
  rung: ScopeRung;
  confidence: ScopeConfidence;
  /** Capture-time containing boundary; not proof of current identity or edit permission. */
  boundary: ScopeNode;
  /** Geometrically selected nodes. Non-empty tuple: "a region with no members" is unrepresentable. */
  members?: [ChangeNode, ...ChangeNode[]];
  /**
   * Total same-tag children of the members' shared parent, when the members are
   * only SOME of them. Present means the region sliced a repeated set — which
   * is honest geometry but reads as a deliberate permission list unless the
   * artifact says how many were left out. Absent when the members are the whole
   * set, or do not share one parent and tag.
   */
  siblings?: number;
  /** Grazed neighbours; weak geometric evidence, not a declaration of reviewer intent. */
  excluded?: [ScopeNode, ...ScopeNode[]];
  /** Insertion point: the siblings bracketing the drawn region, in document order. */
  between?: { before?: ScopeNode; after?: ScopeNode };
  /** Host-declared source path — validated against a format allowlist, never merely escaped. */
  source?: string;
  /** A node list hit its cap; the named nodes are a prefix, not the whole set. */
  truncated?: true;
  /** A heal moved the anchor, so the derived node sets no longer describe today's DOM. */
  stale?: true;
  /**
   * The nearest element at or above the change set that actually animates.
   * A LEAD, not a grant: it may sit outside `members` entirely — the thing a
   * motion note is about is usually an ancestor of everything the region
   * covered. Absent unless something genuinely moves.
   */
  motion?: MotionNode;
}

export type Modality = 'text' | 'voice';

export interface VoiceMeta {
  durationMs: number;
  /** 0..1, clamped on read; the provider value is treated as untrusted. */
  confidence?: number;
  /** true when the reviewer hand-corrected the transcript. */
  edited?: boolean;
  /**
   * true when the salvaged text includes un-finalized interim results
   * (session torn down mid-utterance, e.g. network dropped before finalize).
   */
  interim?: boolean;
  /** provenance, e.g. `deepgram:nova-3` — matters for the paid compiler + quality debugging. */
  engine?: string;
}

/** Host-selected reproduction facts. Never populated by inspecting application state or network traffic. */
export interface FeedbackContext {
  /** Host-supplied semantic hit-test result, e.g. chart series/category. Never independently verified. */
  subject?: string;
  /** Reviewer/host-declared intent, distinct from geometric selection. */
  intent?: 'instance' | 'component' | 'matching';
  build?: string;
  state?: string;
  steps?: string[];
  observed?: string;
  expected?: string;
  acceptance?: string[];
  /** Opaque IDs or HTTPS URLs without credentials, query or fragment. No uploads or fetching. */
  attachments?: { kind: 'image' | 'video'; ref: string; label?: string }[];
}

export interface Comment {
  feedback?: FeedbackContext;
  /** Original scope retained before the first repair demotes the live scope. */
  capturedScope?: Scope;
  id: string;
  createdAt: string;
  updatedAt: string;
  route: string;
  fullUrl: string;
  text: string;
  anchor: Anchor;
  /** Required. v1 stores are migrated to `'text'`; the default is applied at creation too. */
  modality: Modality;
  /** Present iff `modality === 'voice'`. */
  voice?: VoiceMeta;
  /**
   * Lifecycle disposition, set by the TEAM via the host — never the reviewer.
   * Server-owned; delivered through hydration. Absent = open.
   */
  status?: 'open' | 'done' | 'declined';
  /** Team's one-line resolution note (≤500 chars). Server-owned, like `status`. */
  resolution?: string;
  /**
   * Derived edit boundary (v4). Client-derived at creation and never
   * re-resolved: re-deriving against a later DOM would attribute a boundary to
   * a reviewer who never saw it. Validated SOFT — a malformed scope is
   * stripped, never fatal. Absent on every v3 record, which stays valid.
   */
  scope?: Scope;
}

export interface ReviewerStore {
  reviewer: string;
  project: string;
  createdAt: string;
  comments: Comment[];
}

/** How the reviewer activates the annotation layer. */
export interface ActivationConfig {
  /**
   * `both` (default) = the visible control button AND the gesture
   * (Alt+click on desktop, 500ms long-press on touch).
   * `toggle` = button only. `stealth` = gesture only, no chrome.
   */
  mode?: 'toggle' | 'stealth' | 'both';
}

/**
 * Opt-in voice annotation. Presence enables voice; absence keeps pure v1 behavior
 * with no network. The library never holds a Deepgram API key — see `tokenEndpoint`.
 *
 * Credential resolution order: `getToken` → `tokenEndpoint` → `devOnlyToken`.
 */
export interface VoiceConfig {
  /**
   * Escape hatch: mint the short-lived Deepgram grant-token JWT yourself
   * (custom auth, credentials, project scoping). Takes precedence over
   * `tokenEndpoint`. A rejection degrades to the text fallback like any other
   * token failure.
   */
  getToken?: () => Promise<string>;
  /** Preferred: endpoint that mints a short-lived grant-token JWT (`GrantTokenResponse`). */
  tokenEndpoint?: string;
  /**
   * LOCAL DEV ONLY. An opaque, short-lived Deepgram grant-token JWT — NEVER a raw API key.
   * Exposed to every visitor; pinflow throws at init if this is set on a non-local origin.
   */
  devOnlyToken?: string;
}

/** Wire shape returned by a token-mint endpoint (snake_case mirrors Deepgram). */
export interface GrantTokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Design tokens applied as CSS custom properties (`--pf-*`) on the widget's
 * shadow host. All optional; omitted tokens keep the stock look.
 */
export interface PinflowTheme {
  fontFamily?: string;
  /** Primary action color: buttons, pins, active states. */
  accent?: string;
  /** Text/icon color on accent surfaces. */
  accentContrast?: string;
  /** Panel/popup background. */
  surface?: string;
  /** Primary text color inside panels/popups. */
  text?: string;
  /** Secondary/hint text color. */
  textMuted?: string;
  /** Destructive actions and the recording indicator. */
  danger?: string;
  /** Corner radius for panels and inputs, e.g. `'14px'`. */
  radius?: string;
  /** Elevation shadow for panels and inputs. */
  shadow?: string;
}

export interface PinflowConfig {
  /** Opt-in query allowlist for new captured URLs and default route keys. [] removes all queries; undefined preserves legacy routing. Hash and credentials are removed when configured. Custom routeKey remains host-owned. */
  urlQueryParams?: readonly string[];
  /** Called synchronously once at pin time; return only non-sensitive, explicit reproduction facts. */
  captureContext?: (target: Element, point: CapturePoint) => FeedbackContext | undefined;
  /** Show an optional expected outcome field in the composer. Defaults to false. */
  expectedOutcome?: boolean;
  project: string;
  reviewer?: string;
  mode?: Mode;
  onSubmit?: (payload: ReviewerStore) => void | Promise<void>;
  /**
   * Fired after each persisted comment mutation with the fresh store and the
   * change. The host owns debouncing/batching/network; exceptions are caught
   * and logged. Builder-mode "Clear all" does not emit.
   */
  onChange?: (
    store: ReviewerStore,
    change: { type: 'add' | 'update' | 'delete'; comment: Comment },
  ) => void;
  /**
   * Read half of the sync protocol (PROTOCOL.md); `onChange` is the write
   * half. Fetched ONCE when the reviewer identity resolves — at init, or at
   * first activation in stealth mode (hosts refresh by re-init; localStorage
   * makes re-init lossless). The result is merged into the local store by
   * comment id: higher `updatedAt` wins whole-comment for content, but the
   * server ALWAYS wins for `status`/`resolution` — including clearing them —
   * because disposition is team-set, never device-set. Local comments absent
   * from the server are kept (they may not have synced yet).
   *
   * Scope rule: in reviewer mode this returns only the CURRENT reviewer's
   * comments. The host authenticates that however it likes (session, link
   * possession, real auth) — pinflow never enforces identity; `reviewer` is a
   * display label. Builder-mode all-reviewer hydration is a later slice.
   *
   * A rejection is silent (dev-visible warn); localStorage stays
   * authoritative. Hydration-applied changes do NOT emit `onChange` — that
   * callback reports reviewer mutations, and echoing the host's own data back
   * at it would loop.
   */
  source?: () => Promise<Comment[]>;
  /** Visual design tokens; applied once at init. See {@link PinflowTheme}. */
  theme?: PinflowTheme;
  /**
   * Logical screen key used to anchor, show, and group comments. Defaults to
   * the URL (`pathname+search`) — correct for route-per-screen apps. Hosts
   * whose screens change WITHOUT a URL change (wizards, framed/phased
   * experiences) return their own frame id here, and call
   * `handle.refreshRoute()` whenever it changes so pins from other frames
   * hide immediately. The value is stored on each comment and becomes the
   * per-screen grouping in exports/ingestion.
   */
  routeKey?: () => string;
  /**
   * Optional friendly label for a route/frame key, used in export headings
   * (`## Section 2 — Employment details` with the stable key in backticks
   * beneath). Return an empty string for keys without a label — those keep
   * the plain `## Route: <key>` heading. Pairs naturally with `routeKey`.
   */
  describeRoute?: (key: string) => string;
  /**
   * Anytime-export affordance (reviewer mode): a small count chip in the
   * pins' visual vocabulary, shown once the reviewer has a comment; tapping
   * it summons an export sheet wired to the standard export flow. `'auto'`
   * (default) enables it on local-first installs and disables it when
   * `source` is configured — a synced host owns collation, so member-side
   * export is noise there. `'always'`/`'never'` override in either
   * direction. Builder mode is unaffected (its drawer already exports).
   */
  exportUi?: 'auto' | 'always' | 'never';
  /** Activation strategy. Defaults to `{ mode: 'both' }` (0.3.0): button + gesture. */
  activation?: ActivationConfig;
  /** Opt-in voice annotation config. Omit for pure pin/text behavior. */
  voice?: VoiceConfig;
}

/** Export-time diagnostics, never capture-time scope confidence or edit permission. */
export interface TargetResolution {
  availability: 'matched' | 'unresolved' | 'not-checked';
  rung?: 'testid' | 'id' | 'name' | 'css' | 'xpath' | 'text' | 'fuzzy' | 'positional';
  owner?: 'agrees' | 'unresolved' | 'not-recorded';
}

/** Committed feedback and current target checks, detached from the live controller. */
export interface CaptureSnapshot {
  store: ReviewerStore;
  targets: Record<string, TargetResolution>;
}

/** Hosts using capture own submission; handoff UI and builder aggregation are absent. */
export type CaptureConfig = Omit<PinflowConfig, 'mode' | 'onSubmit' | 'exportUi' | 'describeRoute'>;

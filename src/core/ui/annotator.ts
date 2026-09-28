import { STYLES } from './styles';
import { el, fit, flipPosition, place } from './dom-base';
import { CaptureAnnotator, type AnnotatorDeps } from './capture-annotator';
import { copyToClipboard, download, shareFeedback } from '../download';
import {
  exportBuilder,
  exportFilename,
  exportJSON as exportStoresJSON,
  exportReviewer,
  attribution,
} from '../export';
import { resolveAnchor } from '../anchor';
import { emptyStore, loadAllStores, loadStore, renameReviewer } from '../storage';
import { now } from '../time';
import type { Comment, ReviewerStore } from '../types';

/** Full widget: capture plus synchronous exports and the handoff UI. */
export class Annotator extends CaptureAnnotator {
  constructor(deps: AnnotatorDeps) {
    super(deps, STYLES);
    if (this._exportUiEnabled()) document.addEventListener('keydown', this._onExportHotkey, true);
  }
  override destroy(): void {
    document.removeEventListener('keydown', this._onExportHotkey, true);
    super.destroy();
  }

  private _panelEl: HTMLDivElement | null = null;
  // Lives only while the export sheet is open; read once, on export.
  private _nameEl: HTMLInputElement | null = null;
  // Anytime-export affordance: whichever element anchors the open panel
  // (control in toggle mode, chip for the export sheet), which KIND of panel
  // is up (a sheet summon must replace a menu/confirmation, not just toggle it
  // away — review #4), and the sheet's outside-dismiss teardown. The chip
  // itself lives on the base class (_chipEl).
  private _panelAnchor: HTMLElement | null = null;
  // Status-line write generation — see _say().
  private _sayGen = 0;
  private _sheetOpen = false;
  private _sheetDismiss: (() => void) | null = null;

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

  protected override _closePanel(): void {
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
  protected override _positionPanel(): void {
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

  protected override _syncChip(): void {
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
    this._updateSheetTitle();
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
  protected override _updateSheetTitle(): void {
    if (this._sheetOpen && this._panelEl) {
      const h = this._panelEl.querySelector('h3');
      if (h) h.textContent = this._sheetTitle();
    }
  }
  protected override _composerExport(): HTMLButtonElement | null {
    if (!this._exportUiEnabled()) return null;
    const exp = el('button', 'exportall', `Export all · ${this._store.comments.length}`);
    exp.type = 'button';
    exp.addEventListener('click', () => this._toggleSheet());
    return exp;
  }
}

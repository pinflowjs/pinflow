import { CaptureAnnotator, type AnnotatorDeps } from '../core/ui/capture-annotator';
import { initialize, type LifecycleHandle } from '../core/runtime';
import { CAPTURE_STYLES } from '../core/ui/styles';
import { emptyStore } from '../core/storage';
import type { CaptureConfig, CaptureSnapshot, ReviewerStore } from '../core/types';
export { destroy, version } from '../core/runtime';
export { routeKey as routeOf } from '../core/route-key';
export type {
  CaptureConfig,
  CaptureSnapshot,
  Comment,
  ReviewerStore,
  FeedbackContext,
} from '../core/types';

export interface CaptureHandle extends LifecycleHandle {
  /** Snapshot committed comments and current locator results; unsaved drafts are excluded. */
  getSnapshot(): CaptureSnapshot;
}

class CaptureSession extends CaptureAnnotator {
  constructor(deps: AnnotatorDeps) {
    super(deps, CAPTURE_STYLES);
  }
  // No handoff chrome: the host owns submission, so every seam is inert.
  protected _closePanel(): void {}
  protected _positionPanel(): void {}
  protected _syncChip(): void {}
  protected _updateSheetTitle(): void {}
  protected _composerExport(): null {
    return null;
  }
  /** Read committed feedback without exposing mutable controller state. */
  getSnapshot(): CaptureSnapshot {
    if (!this._destroyed) this._foldDurable();
    const store = JSON.parse(JSON.stringify(this._store)) as ReviewerStore;
    return {
      store,
      targets: Object.fromEntries(store.comments.map((c) => [c.id, this._resolution(c)])),
    };
  }
}

export function init(config: CaptureConfig): CaptureHandle {
  return initialize<CaptureSession, CaptureHandle>(
    { ...config, mode: 'reviewer', exportUi: 'never' },
    CaptureSession,
    (annotator) => ({ getSnapshot: () => annotator.getSnapshot() }),
    {
      destroy() {},
      refreshRoute() {},
      getSnapshot: () => ({
        store: emptyStore(config.project, config.reviewer ?? ''),
        targets: {},
      }),
    },
  );
}

import { initialize } from './runtime';
import { Annotator } from './ui/annotator';
import type { PinflowConfig } from './types';
export { destroy, version } from './runtime';
export { routeKey as routeOf } from './route-key';

export type {
  ActivationConfig,
  Anchor,
  AreaPercent,
  Comment,
  FeedbackContext,
  TargetEvidence,
  TargetResolution,
  CapturePoint,
  CaptureDetails,
  CaptureRect,
  Scope,
  GrantTokenResponse,
  Mode,
  Modality,
  PinflowConfig,
  PinflowTheme,
  PositionPercent,
  ReviewerStore,
  SelectorCandidates,
  Viewport,
  VoiceConfig,
  VoiceMeta,
} from './types';

export interface Handle {
  destroy(): void;
  /**
   * Re-evaluate the current route/frame key and re-render pins. Called
   * automatically on URL changes; hosts using `config.routeKey` call it
   * whenever their logical screen changes without a URL change.
   */
  refreshRoute(): void;
  /**
   * Current corpus as versioned JSON (`{ pinflowExport, generatedAt, comments }`):
   * the current reviewer's store in reviewer mode, all stores in builder mode.
   */
  exportJSON(): string;
  /**
   * Markdown artifact, same generator as the export button. Hosts place the
   * submission moment themselves (stealth mode has no chrome).
   */
  exportMarkdown(): string;
  /** Download the artifact + copy to clipboard — no confirmation UI; the host owns UX. */
  downloadExport(): void;
}

// SSR and declined-identity installs get an inert handle with the full API
// (one shared noop: '' for the export getters, ignored for the void methods).
const n = (): '' => '';

export function init(config: PinflowConfig): Handle {
  return initialize<Annotator, Handle>(
    config,
    Annotator,
    (annotator) => ({
      exportJSON: () => annotator.exportJSON(),
      exportMarkdown: () => annotator.exportMarkdown(),
      downloadExport: () => annotator.downloadExport(),
    }),
    { destroy: n, refreshRoute: n, exportJSON: n, exportMarkdown: n, downloadExport: n },
  );
}

// The full artifact toolkit is public: all four are DOM-free pure functions,
// usable server-side (the sensavera hub renders collated exports from backend
// rows with these — no widget, no DOM). Tree-shaken away for widget-only use.
export { exportBuilder, exportFilename, exportJSON, exportReviewer } from './export';
export type { DescribeRoute, ExportMeta, IsOrphaned } from './export';

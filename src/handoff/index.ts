import { exportReviewer, exportJSON, exportFilename, type DescribeRoute } from '../core/export';
import { copyToClipboard, download, shareFeedback } from '../core/download';
import { now } from '../core/time';
import type { CaptureSnapshot, Comment, TargetResolution } from '../core/types';
export type { CaptureSnapshot } from '../core/types';

export interface HandoffArtifact {
  readonly markdown: string;
  readonly json: string;
  readonly filename: string;
  /** Call directly from a user click/tap, after preparing the artifact. */
  share(): Promise<'shared' | 'cancelled' | 'unavailable'>;
  copy(): Promise<boolean>;
  download(): void;
}

/** Prepare once; retries always send the same artifact, even after later edits. */
export function prepareHandoff(
  snapshot: CaptureSnapshot,
  options: { describeRoute?: DescribeRoute } = {},
): HandoffArtifact {
  const { store, targets } = snapshot;
  const generatedAt = now();
  const resolve = (comment: Comment): TargetResolution =>
    (Object.prototype.hasOwnProperty.call(targets, comment.id)
      ? targets[comment.id]
      : undefined) ?? { availability: 'not-checked' };
  const markdown = exportReviewer(
    store,
    { project: store.project, generatedAt, resolve },
    (comment) => resolve(comment).availability === 'unresolved',
    options.describeRoute,
  );
  const json = exportJSON(store, resolve);
  const filename = exportFilename(store.project, store.reviewer, generatedAt);
  return {
    markdown,
    json,
    filename,
    share: () => shareFeedback(markdown, filename),
    copy: () => copyToClipboard(markdown),
    download: () => download(markdown, filename),
  };
}

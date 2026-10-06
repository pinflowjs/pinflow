export function download(content: string, filename: string, type = 'text/markdown'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // Deliberately DETACHED: modern browsers download from unattached anchors,
  // and a detached node's click never propagates to document — an attached
  // one would hit the armed annotate handler and place a bogus pin.
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Clipboard failure is non-fatal: the file download is the primary channel and
// the confirmation copy adjusts its message when the clipboard was unavailable.
//
// ONE clipboard, ONE page-lifetime in-flight write (0.11.0 review #11, #12).
// Two constraints shaped this and ruled a queue out: WebKit rejects writes
// that start behind an async boundary (the user activation is gone by then),
// so every INITIATED write must begin synchronously under its gesture; and a
// write the engine never settles must not wedge the page. So: at most one
// write is in flight. A caller with the SAME content shares its result (a
// retry of the same artifact is the same delivery); different content while
// busy fails fast — refused, never reordered, so a stale write can never land
// after a newer artifact was delivered. The settle bound is ELAPSED time
// checked synchronously at share time — never a timer, which a backgrounded
// page suspends past any wall-clock promise (0.11.0 review #13) — measured on
// BOTH clocks, expiring on either: WebKit's performance.now() freezes through
// system sleep, and Date.now() can step under clock adjustment, so each
// covers the other's blind spot (0.11.0 review #14). Expiry LATCHES: once
// either clock has crossed the bound the record is dead for sharing, whatever
// the clocks do afterwards — a wall-clock rollback must not resurrect a hung
// share (0.11.0 review #15). A late settle still drains the slot.
const CLIP_SETTLE_MS = 3000;
let inFlight: {
  content: string;
  p: Promise<boolean>;
  at: number;
  wall: number;
  dead: boolean;
} | null = null;

async function rawCopy(content: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch {
    /* degrade below */
  }
  return false;
}

export function copyToClipboard(content: string): Promise<boolean> {
  if (inFlight) {
    if (
      inFlight.dead ||
      performance.now() - inFlight.at >= CLIP_SETTLE_MS ||
      Date.now() - inFlight.wall >= CLIP_SETTLE_MS
    ) {
      inFlight.dead = true; // latched — only native settlement clears the slot
      return Promise.resolve(false);
    }
    if (inFlight.content === content) return inFlight.p;
    return Promise.resolve(false); // different content: refused, not latched
  }
  const rec = {
    content,
    at: performance.now(),
    wall: Date.now(),
    dead: false,
    p: Promise.resolve(false),
  };
  rec.p = rawCopy(content).then((ok) => {
    if (inFlight === rec) inFlight = null;
    return ok;
  });
  inFlight = rec;
  return rec.p;
}

/**
 * Hand the artifact to the OS share sheet. Call it synchronously from the tap:
 * Web Share consumes the gesture's user activation at the first call, so any
 * await before it would fail as `unavailable`.
 */
export async function shareFeedback(
  content: string,
  filename: string,
): Promise<'shared' | 'cancelled' | 'unavailable'> {
  try {
    if (!navigator.share) return 'unavailable';
    // Android may refuse a .md attachment; a .txt one carries the same bytes.
    // With neither accepted, the Markdown goes as text.
    const files = [filename, filename.replace(/\.md$/, '.txt')]
      .map((name, i) => [new File([content], name, { type: i ? 'text/plain' : 'text/markdown' })])
      .find((files) => navigator.canShare?.({ files }));
    await navigator.share({
      title: 'Pinflow feedback',
      ...(files ? { files } : { text: content }),
    });
    return 'shared';
  } catch (error) {
    return (error as Error | undefined)?.name === 'AbortError' ? 'cancelled' : 'unavailable';
  }
}

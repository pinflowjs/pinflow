import { anonymousHandle, modeFromUrl, resolveReviewer } from './identity';
import { watchRoute } from './router';
import { acquireStorage } from './safe-storage';
import type { Mode, PinflowConfig } from './types';
import type { CaptureAnnotator, AnnotatorDeps } from './ui/capture-annotator';

// Injected by tsup `define` at build time (src/globals.d.ts); the `typeof`
// guard keeps vitest — which runs source without the define — working.
export const version = typeof __PINFLOW_VERSION__ !== 'undefined' ? __PINFLOW_VERSION__ : '0.0.0';

export interface LifecycleHandle {
  destroy(): void;
  refreshRoute(): void;
}

// One active widget per page, across entries: `pinflowjs` and
// `pinflowjs/capture` are compiled independently, so the slot is a registered
// symbol and holds only the public lifecycle contract — never a mangled
// controller property, whose name differs per bundle.
const SLOT = Symbol.for('pinflow.active-instance');
const page = globalThis as typeof globalThis & { [SLOT]?: LifecycleHandle };

export function destroy(): void {
  page[SLOT]?.destroy();
}

// Twin of `isLocalOrigin` in src/voice/transcription/token.ts — duplicated
// (3 lines of predicate) because core must never runtime-import from voice;
// keep the two in sync.
function isLocalOrigin(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost')
  );
}

/**
 * The init() body every entry shares. `create` picks the controller, `api`
 * exposes its entry-specific methods, and `inert` is the complete handle for
 * SSR and declined-identity installs.
 */
export function initialize<A extends CaptureAnnotator, H extends LifecycleHandle>(
  config: PinflowConfig,
  Controller: new (deps: AnnotatorDeps) => A,
  api: (annotator: A) => Omit<H, keyof LifecycleHandle>,
  inert: H,
): H {
  if (typeof window === 'undefined' || typeof document === 'undefined') return inert;
  // Fail loud: hosts often call init() inside framework effects that swallow
  // throws — surface the failure on the console before rethrowing.
  try {
    return initLive(config, Controller, api) ?? inert;
  } catch (e) {
    console.error('[pinflow] init failed:', e);
    throw e;
  }
}

function initLive<A extends CaptureAnnotator, H extends LifecycleHandle>(
  config: PinflowConfig,
  Controller: new (deps: AnnotatorDeps) => A,
  api: (annotator: A) => Omit<H, keyof LifecycleHandle>,
): H | null {
  // The devOnlyToken guardrail is a LOUD, EARLY failure by design (types.ts
  // promises "throws at init"). token.ts re-checks lazily as defense in depth.
  if (config.voice?.devOnlyToken && !isLocalOrigin(window.location.hostname)) {
    throw new Error(
      'pinflow: voice.devOnlyToken needs a local origin — use voice.tokenEndpoint in production',
    );
  }
  if (page[SLOT]) {
    console.warn('[pinflow] another instance is active — replacing it');
    page[SLOT].destroy();
  }

  const storage = acquireStorage();
  const mode: Mode = config.mode ?? modeFromUrl(window.location.href) ?? 'reviewer';
  const stealth = config.activation?.mode === 'stealth';
  // Nobody is asked who they are at page load. A reviewer gets a minted
  // handle so they have a corpus immediately, and the export sheet asks for a
  // name at the one moment attribution matters. Stealth mints nothing here —
  // it must not even write storage before its first activation, so identity is
  // deferred to the gesture (resolveIdentity).
  const reviewer =
    config.reviewer ??
    resolveReviewer({
      url: window.location.href,
      storage,
      project: config.project,
      ...(mode === 'reviewer' && !stealth ? { mint: anonymousHandle } : {}),
    }) ??
    (mode === 'builder' ? '__builder__' : null);

  if (!reviewer && !stealth) return null;

  const annotator = new Controller({
    config,
    reviewer,
    mode,
    storage,
    ...(reviewer
      ? {}
      : {
          resolveIdentity: () =>
            resolveReviewer({
              url: window.location.href,
              storage,
              project: config.project,
              mint: anonymousHandle,
            }),
        }),
  });
  const watcher = watchRoute(() => annotator.refreshRoute());

  const handle = {
    ...api(annotator),
    destroy() {
      watcher.stop();
      annotator.destroy();
      if (page[SLOT] === handle) delete page[SLOT];
    },
    refreshRoute() {
      annotator.refreshRoute();
    },
  } as H;
  page[SLOT] = handle;
  const n = annotator._count;
  console.info(
    // Fallback must mirror Annotator._activationMode's default.
    `[pinflow] v${version} ready — mode=${mode}, activation=${
      config.activation?.mode ?? 'both'
    }, ${n} comment${n === 1 ? '' : 's'}`,
  );
  return handle;
}

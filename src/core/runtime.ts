import { anonymousHandle, modeFromUrl, resolveReviewer } from './identity';
import { watchRoute } from './router';
import { acquireStorage } from './safe-storage';
import type { Mode, PinflowConfig } from './types';
import type { CaptureAnnotator, AnnotatorDeps } from './ui/capture-annotator';

export const version = typeof __PINFLOW_VERSION__ !== 'undefined' ? __PINFLOW_VERSION__ : '0.0.0';
export interface LifecycleHandle {
  destroy(): void;
  refreshRoute(): void;
}
// Packed entries are compiled independently. This page-wide slot shares only
// the stable public lifecycle contract, never mangled controller properties.
const INSTANCE = Symbol.for('pinflow.active-instance');
const registry = globalThis as typeof globalThis & { [INSTANCE]?: LifecycleHandle };
export function destroy(): void {
  registry[INSTANCE]?.destroy();
}

export function initialize<T extends CaptureAnnotator, E extends object>(
  config: PinflowConfig,
  create: (deps: AnnotatorDeps) => T,
  methods: (annotator: T) => E,
  inert: E,
): E & LifecycleHandle {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { ...inert, destroy() {}, refreshRoute() {} };
  }
  try {
    return initLive(config, create, methods, inert);
  } catch (error) {
    console.error('[pinflow] init failed:', error);
    throw error;
  }
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

function initLive<T extends CaptureAnnotator, E extends object>(
  config: PinflowConfig,
  create: (deps: AnnotatorDeps) => T,
  methods: (annotator: T) => E,
  inert: E,
): E & LifecycleHandle {
  // The devOnlyToken guardrail is a LOUD, EARLY failure by design (types.ts
  // promises "throws at init"). token.ts re-checks lazily as defense in depth.
  if (config.voice?.devOnlyToken && !isLocalOrigin(window.location.hostname)) {
    throw new Error(
      'pinflow: voice.devOnlyToken needs a local origin — use voice.tokenEndpoint in production',
    );
  }
  const current = registry[INSTANCE];
  if (current) {
    console.warn('[pinflow] another instance is active — replacing it');
    current.destroy();
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

  if (!reviewer && !stealth) return { ...inert, destroy() {}, refreshRoute() {} };

  const annotator = create({
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

  let disposed = false;
  const handle = {
    ...methods(annotator),
    destroy() {
      if (disposed) return;
      disposed = true;
      watcher.stop();
      annotator.destroy();
      if (registry[INSTANCE] === handle) delete registry[INSTANCE];
    },
    refreshRoute() {
      annotator.refreshRoute();
    },
  };
  registry[INSTANCE] = handle;
  const n = annotator._count;
  console.info(
    // Fallback must mirror Annotator._activationMode's default.
    `[pinflow] v${version} ready — mode=${mode}, activation=${
      config.activation?.mode ?? 'both'
    }, ${n} comment${n === 1 ? '' : 's'}`,
  );
  return handle;
}

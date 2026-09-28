# Pinflow guide

Everything beyond the first five minutes: configuration, sync, voice, builder
mode, privacy, and troubleshooting. New here? Start with the
[README](../README.md), or try the widget on [pinflow.dev](https://pinflow.dev).

For how the code is put together — architecture, the selector ladder, the export
contract — see the [codebase wiki](./wiki/README.md).

---

## How feedback is stored

With no additional configuration, Pinflow saves comments to `localStorage` in the reviewer's
browser. This is the simplest setup: there is no server, account system, or database to run.

Local storage also defines the limits of that setup:

- Feedback stays on the browser and device where it was created.
- Clearing site data removes it.
- Builder mode can only aggregate reviewers whose comments exist in that same browser.
- If the browser blocks local storage, Pinflow falls back to memory for the current page
  session; those comments do not survive a reload.

Use [backend sync](#connect-your-own-backend) when feedback must follow a reviewer across
devices, appear in a team workspace, or survive cleared browser data.

## Smaller capture entry for custom submission interfaces

Use `pinflowjs/capture` when your app owns the submission interface. It includes pinning,
editing, local persistence, backend sync, optional voice, target evidence and scope capture.
It omits the export chip, export sheet, bulk clear controls and artifact serializers.
The regular `pinflowjs` entry and framework wrappers continue to include the full widget.

```ts
import { init } from 'pinflowjs/capture';

const capture = init({
  project: 'my-prototype',
  expectedOutcome: true,
});

// When opening YOUR submission panel, after the reviewer saves their draft:
const { prepareHandoff } = await import('pinflowjs/handoff');
const artifact = prepareHandoff(capture.getSnapshot());

// Enable your Share button only after preparation completes.
shareButton.onclick = () => {
  void artifact.share().then((result) => {
    if (result === 'unavailable') {
      // Offer a Copy button or selectable artifact.markdown in your interface.
    }
    // Cancellation or a closed share sheet never authorizes deleting comments.
  });
};
copyButton.onclick = () => void artifact.copy();
downloadButton.onclick = () => artifact.download();
```

`getSnapshot()` returns `{ store, targets }`, detached from live state. It reads committed
comments, reconciles durable changes and checks current-route targets. Unsaved text in an
open editor is excluded. Other routes report `not-checked`; unavailable targets retain their
historical evidence. Editing a returned snapshot does not alter stored comments.

`prepareHandoff(snapshot, { describeRoute? })` freezes `markdown`, `json` and `filename`.
Its actions keep sending that artifact if feedback changes later; prepare again to include
new edits. `share()` returns `shared`, `cancelled` or `unavailable`; `copy()` returns a boolean;
`download()` starts a file download without copying. Sharing uses the platform's native sheet
on supported iOS/Android browsers, with attachment/text fallback. A successful share promise
is not confirmation of recipient delivery. Keep comments until the reviewer explicitly removes them.

Prepare before the final tap: awaiting a dynamic import inside the Share click handler can
lose the browser's required user activation. Lazy loading reduces initial transfer; users who
export also fetch the handoff entry. Capturing alone never imports it.

`CaptureConfig` omits `mode`, `onSubmit`, `exportUi` and `describeRoute`. Capture always runs
in reviewer mode; use the full entry for builder aggregation. Use `onChange`/`source` normally
for backend sync, and pass `describeRoute` to `prepareHandoff` if needed. The capture handle
has `destroy()`, `refreshRoute()` and `getSnapshot()`; it does not expose the full handle's
export methods. Both entries share the active page instance, so initializing either replaces
and disposes the other. Calling an old handle's `destroy()` cannot destroy its replacement.

## Frameworks

Install the package when your app uses a bundler:

```bash
npm install pinflowjs
```

The script-tag setup does not require Node.js. Package consumers and contributors need Node.js
18 or newer. React and Vue are optional peer dependencies; install only the framework you
use.

### JavaScript or TypeScript

```ts
import { init } from 'pinflowjs';

const pinflow = init({
  project: 'checkout-redesign',
});
```

`init()` returns a handle for lifecycle, route refresh, and export operations. Pinflow is a
singleton: calling `init()` again replaces the active instance. Call `pinflow.destroy()` when
the host app is torn down.

### React

```tsx
import { Annotator } from 'pinflowjs/react';

export default function App() {
  return (
    <>
      <Annotator project="checkout-redesign" />
      <YourApp />
    </>
  );
}
```

`<Annotator>` renders no visible React node of its own. It mounts Pinflow's isolated interface
when the component mounts and removes it when the component unmounts.

### Next.js

Pinflow uses browser APIs, so put the React wrapper behind a client-component boundary:

```tsx
// app/pinflow-provider.tsx
'use client';

import { Annotator } from 'pinflowjs/react';

export function PinflowProvider() {
  return <Annotator project="checkout-redesign" />;
}
```

Mount `PinflowProvider` from your layout or page. See the complete
[Next.js example](https://github.com/pinflowjs/pinflow/tree/main/examples/nextjs).

### Vue

```vue
<script setup lang="ts">
import { Annotator } from 'pinflowjs/vue';
</script>

<template>
  <Annotator project="checkout-redesign" />
</template>
```

Vue exposes `onSubmit` as `submitHandler` and `onChange` as `changeHandler` because `on*`
props have special meaning in Vue. The other configuration names are unchanged.

## Configuration

Only `project` is required.

```ts
import { init } from 'pinflowjs';

const pinflow = init({
  project: 'checkout-redesign',
  reviewer: 'Sam',
  activation: { mode: 'both' },
  exportUi: 'auto',
  theme: {
    accent: '#6d4aff',
    accentContrast: '#ffffff',
    radius: '12px',
  },
});
```

| Option          | Purpose                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `project`       | Required storage namespace for the reviewed experience.                                                                         |
| `reviewer`      | Sets the display name instead of reading `?reviewer=` or prompting.                                                             |
| `mode`          | Uses reviewer mode by default; `'builder'` makes the handle's exports aggregate every store in this browser (no UI of its own). |
| `activation`    | Chooses the visible control, gestures, or both.                                                                                 |
| `exportUi`      | Controls the reviewer's export controls: `'auto'`, `'always'`, or `'never'`.                                                    |
| `onSubmit`      | Sends the current reviewer's full store through a host-provided function.                                                       |
| `source`        | Loads this reviewer's saved comments from your backend.                                                                         |
| `onChange`      | Reports each saved add, update, and delete to your backend.                                                                     |
| `routeKey`      | Identifies the current screen when the URL is not enough.                                                                       |
| `describeRoute` | Gives route keys readable names in exported feedback.                                                                           |
| `theme`         | Applies Pinflow's optional visual design tokens.                                                                                |
| `voice`         | Enables voice comments through a short-lived token provider.                                                                    |

See the [API reference](https://github.com/pinflowjs/pinflow/blob/main/docs/wiki/api.md) for
complete types, wrapper behavior, and the returned handle.

### Choose how reviewers activate Pinflow

```ts
init({
  project: 'checkout-redesign',
  activation: { mode: 'both' },
});
```

- `'both'` is the default: visible control, Alt/Option+click, and a long-press on touch
  screens and pen devices.
- `'toggle'` shows the control and disables the gestures.
- `'stealth'` hides the control and uses gestures only.

On most Linux desktops (GNOME, KDE) **Alt+drag is the window manager's own "move window"
binding**, so it never reaches the browser and the area gesture is unavailable there. The
dock's **+** button does everything the gestures do. If your reviewers are mainly on Linux,
`'toggle'` removes the gestures rather than leaving a shortcut that silently does nothing.

Stealth mode also delays the name prompt until the reviewer first tries to leave feedback, so
the page loads without any visible Pinflow interaction.

### Identify a reviewer

Pinflow resolves the display name in this order:

1. The `reviewer` configuration value.
2. The `?reviewer=NAME` query parameter.
3. A one-time browser prompt.

For example:

```text
https://preview.example.com/checkout?reviewer=Sam
```

The reviewer name is a label, not authentication. If access control or verified identity
matters, enforce it in your application and backend.

### Review multi-step and single-page experiences

By default, Pinflow groups comments by `pathname + search` and automatically follows browser
navigation. If several screens share one URL, provide your own stable screen key and tell
Pinflow when it changes:

```ts
let currentStep = 'shipping';
const stepLabels: Record<string, string> = {
  shipping: 'Shipping details',
  payment: 'Payment',
  confirmation: 'Confirmation',
};

const pinflow = init({
  project: 'checkout-redesign',
  routeKey: () => currentStep,
  describeRoute: (key) => stepLabels[key] ?? key,
});

function moveToStep(nextStep: string) {
  currentStep = nextStep;
  pinflow.refreshRoute();
}
```

Pins from other screens are hidden, and the readable label appears in exported feedback.

### Match your product's visual style

```ts
init({
  project: 'checkout-redesign',
  theme: {
    fontFamily: 'Inter',
    accent: '#2d6a4f',
    accentContrast: '#ffffff',
    surface: '#ffffff',
    text: '#17221d',
    textMuted: '#66736c',
    danger: '#c2413b',
    radius: '14px',
    shadow: '0 12px 32px rgba(23, 34, 29, 0.16)',
  },
});
```

All theme values are optional. Pinflow renders inside a Shadow DOM so host styles do not leak
into the widget, and Pinflow styles do not leak into the host page.

## Export and share feedback

On touch devices, **Export & share** opens the native share sheet so you can choose an app,
contact, or nearby device. Pinflow shares a Markdown file when supported, otherwise a text
attachment with the same content, or the full text. Canceling keeps your feedback. If sharing
is unavailable, use **Copy to Clipboard**; if copying is blocked too, a selectable text box
lets you copy manually. No download starts automatically on touch devices, including tablets
with a mouse or trackpad. Available destinations depend on your browser and installed apps.

On desktop without touch input, the action downloads a Markdown file and copies the same
content to the clipboard. The result is readable on its own and can be pasted into an issue,
pull request, project document, or coding assistant. The explicit `downloadExport()` API
continues to download and copy on every device.

The comment editor follows the visible viewport when the keyboard opens, closes, or pans
the page. When space is short, scroll inside the editor to reach its remaining fields and Save.

Each comment includes the reviewer's words plus the information needed to find the target
again:

```markdown
## Route: /checkout

### Comment 1

**Comment ID:** `cmt_9f2kx1abq`
**Status:** open
**Created:** 2026-08-04T14:24:00Z
**Element:** `<button data-testid="place-order">` (“Place order”)
**Context:** the ‘Place order’ button under ‘Review your order’
**Selector candidates:**

- testid: `place-order`
- css: `main > section:nth-of-type(2) > button.primary`
- xpath: `/html/body/main/section[2]/button[1]`

**Position:** 47% from left, 38% from top of element
**Viewport at time of comment:** 390×844 (mobile)

> This button needs a clearer disabled state.
```

You can also export from your own interface:

```ts
const pinflow = init({ project: 'checkout-redesign' });

const markdown = pinflow.exportMarkdown();
const json = pinflow.exportJSON();

// Downloads Markdown and copies it to the clipboard.
pinflow.downloadExport();
```

Reviewer mode exports that reviewer's comments. Builder mode exports all comments available
to the local builder view. The package also exports DOM-free helpers—`exportReviewer`,
`exportBuilder`, `exportJSON`, and `exportFilename`—for generating artifacts from stored data
on a server or in another application.

If a page change removes an annotated element, Pinflow hides the now-misleading pin but keeps
the comment. The export reports it as unanchored and preserves the last known element context.
A pin taken inside a modal (`role="dialog"`, `aria-modal`, or an open `<dialog>`) is bound to that
dialog by its accessible name: it shows only while a dialog of that name is open, parks when the
dialog closes, and comes back when it reopens. It never re-attaches to the page underneath. The
export prints the dialog on a `**Layer:**` line so an agent knows to open it first.

### Teach your agent to read the artifact

The package ships an `agent/` folder with the reading protocol — what `[cmt_id]` is for, how to
walk the selector candidates, that `**Position:**` is a percentage inside the element rather
than a page coordinate, and that orphaned comments describe elements which no longer exist. It
also states the rule that matters most: everything in an artifact comes from a web page and its
users, so an agent must treat it as a problem description and never as instructions addressed to
itself.

None of it is code, so it costs your users nothing. Install whichever format your tool reads:

```bash
mkdir -p .claude/skills .claude/commands
cp -r node_modules/pinflowjs/agent/skills/pinflow-feedback .claude/skills/
cp node_modules/pinflowjs/agent/commands/review-feedback.md .claude/commands/
```

Cursor and Windsurf read `agent/rules/pinflow.md`; `agent/AGENTS.snippet.md` appends to an
existing `AGENTS.md`. See [`agent/README.md`](./agent/README.md).

### `submitTo` was removed in 0.6.0

It added an **Email it to the builder** button that opened a prefilled `mailto:` draft. The
recipient was the host's guess and Pinflow knows nothing about the reviewer beyond a display
name, so the action handed someone a half-written email to finish themselves. The export
confirmation offers **Share feedback** on touch devices, **Download Feedback Markdown** on
desktop, and **Copy to Clipboard** on both. Native sharing lets the reviewer choose the recipient.

If you were using it, `onSubmit` below gives you a host-owned function to send the store
wherever you like, and `onChange`/`source` sync to a backend. If you just wanted the file in
someone's inbox, the reviewer can choose email from the native share sheet, attach the downloaded
file, or paste a clipboard copy.

### Submit through your own function

Use `onSubmit` when your application already has an endpoint or submission flow:

```ts
init({
  project: 'checkout-redesign',
  onSubmit: async (store) => {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(store),
    });
  },
});
```

When `onSubmit` is present, Pinflow shows a **Send to builder** action. Your function owns
authentication, transport, retries, and the user-facing delivery policy.

## Connect your own backend

Use `source` to read saved comments and `onChange` to report edits:

```ts
init({
  project: 'checkout-redesign',

  source: async () => {
    const response = await fetch('/api/feedback/comments');
    if (!response.ok) throw new Error('Could not load feedback');
    return response.json();
  },

  onChange: async (_store, change) => {
    const response = await fetch('/api/feedback/changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
    if (!response.ok) throw new Error('Could not save feedback');
  },
});
```

`source` returns the current reviewer's comments. `onChange` receives an `add`, `update`, or
`delete` event after each saved change. Your backend should upsert by the comment's stable
`id` and treat deleting a missing id as a successful no-op.

Pinflow keeps local storage as a safety net. If loading from the backend fails, the local copy
continues to work. On the next successful load, local comments that never reached the server
are reported again through `onChange`.

When `source` is configured, `exportUi: 'auto'` hides the reviewer-side export controls because
the host normally owns collection. Set `exportUi: 'always'` if you want backend sync and local
export at the same time.

The full merge behavior, data shape, and backend responsibilities are documented in the
[sync protocol](https://github.com/pinflowjs/pinflow/blob/main/PROTOCOL.md).

### Return a resolution to the reviewer

Your backend can return two team-owned fields through `source`:

```json
{
  "status": "done",
  "resolution": "Increased the contrast and added a disabled label."
}
```

Supported statuses are `open`, `done`, and `declined`. Done and declined comments become
read-only in the reviewer interface and show the team's note. Pinflow displays this state; it
does not include a team dashboard for setting it.

## Voice comments

Voice is optional and loaded only when configured. Text-only integrations do not download the
voice module.

```ts
init({
  project: 'checkout-redesign',
  voice: {
    tokenEndpoint: '/api/pinflow/deepgram-token',
  },
});
```

The endpoint must return a short-lived Deepgram grant token:

```json
{
  "access_token": "short-lived-token",
  "expires_in": 30
}
```

Never put a Deepgram API key in browser code. `devOnlyToken` accepts a short-lived grant token
on local origins only and throws during initialization anywhere else. If microphone access,
token minting, or transcription fails, Pinflow falls back to a text comment.

Voice is available through the installed ESM/CJS package. It is not supported by the CDN/IIFE
build. See the
[voice documentation](https://github.com/pinflowjs/pinflow/blob/main/docs/wiki/voice.md) for
the token flow and failure behavior.

## Builder mode

Builder mode is an **export switch, not a screen**. `init({ mode: 'builder' })` makes
`exportMarkdown()`, `exportJSON()` and `downloadExport()` span _every_ reviewer store in the
current browser instead of just yours. It renders no chrome of its own — no chip, no drawer,
no pins from other reviewers — so you reach the aggregate through the handle:

```js
const pinflow = init({ project: 'checkout', mode: 'builder' });
pinflow.downloadExport(); // one artifact, every reviewer in this browser
```

It aggregates one **browser**, never a team: reviewers on other machines have their own
localStorage and never appear here. It is a convenience for backend-free reviews, not an
administrative or authenticated area.

> Before 0.9.0 this mode also drew a drawer with reviewer checkboxes, read-only foreign pins
> and a Clear all button. Nobody used it, and its data layer — one browser's localStorage —
> is not the one a real multi-reviewer tier would be built on, so the UI was removed rather
> than maintained. The aggregation it wrapped is untouched. The last commit containing it is
> tagged `builder-mode-final`.
> Treat the URL as a soft secret and do not rely on it for access control.

## Privacy and security

Pinflow does not send telemetry. With the default configuration, it makes no network requests
and stores feedback only in the reviewer's browser.

Network activity begins only when you configure one of these features:

- `source`, `onChange`, or `onSubmit`
- voice transcription
- the browser's normal request for the CDN script, if you use the script-tag installation

A comment contains more than its written text. To help find the selected element again,
Pinflow may record:

- element text, accessible name, and role;
- the nearest heading;
- test id, id, role plus accessible name, CSS, and XPath selector candidates;
- viewport size and relative click position;
- selected computed styles such as color, font, background, and radius;
- image and CSS background-image URLs, which may contain signed or tokenized CDN values.

Treat exported and synced comments as potentially sensitive user-generated data. Avoid using
Pinflow on pages that expose secrets or personal information unless your storage and access
controls are appropriate. Keep webhook URLs, API keys, and other reusable credentials on the
server.

Exported comment content is also untrusted input. Pinflow escapes its generated Markdown to
prevent comments or captured page text from creating new top-level instructions, but any
system that consumes feedback should still apply its normal validation and authorization
rules.

## Browser support and limitations

- Current and previous major versions of Chrome, Safari, Firefox, and Edge
- Mobile Safari and Chrome for Android
- React 18 or newer
- Vue 3 or newer
- Server rendering through the React and Vue wrappers; Pinflow becomes active in the browser

Known limitations:

- Elements inside iframes cannot be annotated.
- The CDN/IIFE build does not support voice comments.
- Builder mode reads local browser data; all-reviewer backend hydration is not included.
- Pinflow provides annotation and integration hooks, not user accounts, permissions, a hosted
  database, or a team dashboard.

## Troubleshooting

On a successful browser initialization, Pinflow logs one line like this:

```text
[pinflow] v0.3.0 ready — mode=reviewer, activation=both, 0 comments
```

If the widget does not appear:

1. Check the browser console for the ready line or an initialization error.
2. Confirm the CDN script loaded successfully, or confirm the installed package is present in
   your bundle.
3. Make sure `project` is a non-empty, stable string.
4. In Next.js, confirm the wrapper is mounted from a `'use client'` component.
5. Remember that stealth mode has no visible control and that iframe contents are outside
   Pinflow's reach.

## API at a glance

| Import            | Use                                                                   |
| ----------------- | --------------------------------------------------------------------- |
| `pinflowjs`       | Core `init`, `destroy`, `routeOf`, version, types, and export helpers |
| `pinflowjs/react` | React `<Annotator>` wrapper                                           |
| `pinflowjs/vue`   | Vue `<Annotator>` wrapper                                             |
| `pinflowjs/voice` | Internal lazy voice entry; do not import directly                     |

The handle returned by `init()` exposes:

| Method             | Use                                                            |
| ------------------ | -------------------------------------------------------------- |
| `destroy()`        | Remove Pinflow and release its listeners and active resources. |
| `refreshRoute()`   | Re-read `routeKey` and display pins for the current screen.    |
| `exportMarkdown()` | Return the current feedback as Markdown.                       |
| `exportJSON()`     | Return the current feedback as versioned JSON.                 |
| `downloadExport()` | Download Markdown and copy it to the clipboard.                |

For full signatures and types, see the
[API reference](https://github.com/pinflowjs/pinflow/blob/main/docs/wiki/api.md).

## Examples

- [Vanilla HTML](https://github.com/pinflowjs/pinflow/tree/main/examples/vanilla-html) — one
  script tag, no build step
- [React + Vite](https://github.com/pinflowjs/pinflow/tree/main/examples/react-vite) — the React
  wrapper in a Vite app
- [Next.js](https://github.com/pinflowjs/pinflow/tree/main/examples/nextjs) — App Router with a
  client boundary
- [Lovable or Bolt prototype](https://github.com/pinflowjs/pinflow/tree/main/examples/lovable-prototype) —
  add Pinflow to generated output
- [Slack](https://github.com/pinflowjs/pinflow/tree/main/examples/webhook-slack) — send feedback
  through a server-side webhook proxy
- [Discord](https://github.com/pinflowjs/pinflow/tree/main/examples/webhook-discord) — send feedback
  through a server-side webhook proxy
- [Vercel + Notion](https://github.com/pinflowjs/pinflow/tree/main/examples/webhook-vercel-notion) —
  store submissions with a serverless function

## Feedback that can be reproduced and checked

A screenshot shows an appearance. A Pinflow comment can also carry the clicked
control, the containing component, reproduction steps, intended behavior and
acceptance checks. Enable the optional composer field and supply a small,
explicit context object:

```ts
import { init } from 'pinflowjs';

const handle = init({
  project: 'checkout-preview',
  expectedOutcome: true,
  urlQueryParams: ['plan'], // [] strips all queries from new URL/route captures
  captureContext: (target) => ({
    build: 'preview-42',
    state: 'cart-open',
    steps: ['Add an item to the cart', 'Select Buy'],
    observed: 'The checkout panel stays closed',
    expected: 'The checkout panel opens',
    acceptance: ['Checkout heading is visible'],
    attachments: [{ kind: 'video', ref: 'recording-42', label: 'Checkout attempt' }],
  }),
});

const json = handle.exportJSON();
const markdown = handle.exportMarkdown();
```

`captureContext` runs synchronously once at the pin gesture, with the actual
clicked element. Its result is copied, validated and frozen in time, including
voice finalization and fallback. A thrown hook does not lose the note. Return
only facts your application deliberately makes available; do not return raw
application state, form values, credentials or personal data. No network,
console, screenshot or session recording is collected automatically.

The optional expected-outcome field works for text and existing voice comments.
A saved expected-only note survives. Escape still discards unsaved input, and
context from `captureContext` alone does not keep a new pin the reviewer
dismisses without saving.
React accepts the same config props; Vue exposes `captureContext`,
`expectedOutcome` and `urlQueryParams` with the same names. Function updates to
`captureContext` take effect without remounting. Configure the URL allowlist at
initialization; use a keyed remount to replace object/array configuration.

Limits are enforced both at capture and hydration: build/state are 120 characters;
observed/expected are 1,000; steps/acceptance contain at most 12 entries of 500
characters. There are at most four attachments. References are opaque IDs or
canonical HTTPS URLs without credentials, query strings or fragments. Labels
are 80 characters. Pinflow stores references, never media blobs, and does not
fetch or upload them. Supply access to attachments separately when needed.

`urlQueryParams` is opt-in because changing existing route keys would hide older
pins on query-based screens. When configured, it filters queries and removes
credentials/fragments from new `fullUrl` captures and filters default route keys.
It never rewrites existing feedback; custom `routeKey` values and page-derived
text/image/style context remain host-owned and may contain sensitive content.
Without the option, legacy URL capture is unchanged. Review exports before
sharing them and use non-sensitive preview data.

Original evidence survives anchor repair. `anchor.selectors` locates the current
anchor; `anchor.capturedSelectors` retains the original selectors after the first
repair. `anchor.target` records the precise clicked descendant if Pinflow anchors
its stable ancestor. `capturedScope` preserves the initial scope when repair
marks the live scope stale. Historical evidence is not a new edit boundary.
Ambiguous fallback text matches abstain rather than choosing the first element.
On a page too large to scan within budget, an exact text match is still used,
but a fuzzy guess is not.

### Verification reports

Use the optional, DOM-free entry point to bind a result to the exact request:

```ts
import { createVerification, isVerificationCurrent } from 'pinflowjs/verification';

const comment = JSON.parse(json).comments[0];
const report = await createVerification(comment, {
  outcome: 'verified',
  interpretation: 'Open checkout when Buy is selected',
  files: ['src/Cart.tsx'],
  checks: [
    {
      name: 'Checkout heading is visible',
      result: 'passed',
      evidence: 'playwright: checkout.spec.ts',
    },
  ],
  assumptions: [],
});

// Re-read the current JSON before accepting a result from another tool.
const current = JSON.parse(handle.exportJSON()).comments[0];
const stillCurrent = await isVerificationCurrent(current, report);
```

The SHA-256 revision covers authored content and original capture evidence, with
stable object-key ordering. Mechanical locator/scope repair and team disposition
are excluded. An edit to the request invalidates the report even when a producer
forgot to advance `updatedAt`. `feedbackRevision` exposes the same hash, and
`readVerification` validates imported sidecar JSON without trusting unknown keys.
These functions require Web Crypto (`crypto.subtle`), available in secure browser
contexts and current Node runtimes; Node 18 hosts may need to supply
`globalThis.crypto` from `node:crypto`'s `webcrypto`.

A `verified` report needs passing checks with evidence references, coverage of every supplied acceptance
criterion (check names match verbatim), and no unresolved assumptions. Use
`partial` or `blocked` when checks fail or cannot run. A report is a self-reported
claim to review: Pinflow does not execute tests, authenticate their results, fetch
references, or set team-owned `status`. Store reports separately from comments.
The four formats in the shipped `agent/` pack teach this reproduce → implement →
verify workflow, including how to report an unbound result when only Markdown
was supplied.

### Optional source instrumentation

For Vite JSX/TSX previews, use the host's existing TypeScript compiler to attach
repository-relative `data-pinflow-source` hints at build time:

```ts
// vite.config.ts
import ts from 'typescript';
import { pinflowSource } from 'pinflowjs/instrumentation';

export default {
  plugins: [pinflowSource({ typescript: ts, root: process.cwd() })],
};
```

This Node-only plugin runs during development (`apply: 'serve'`), preserves source
maps, skips dependencies and files outside the root, and stamps intrinsic JSX
DOM elements. Existing explicit hints take precedence. It does not instrument
Vue templates, Svelte or arbitrary generated markup; those integrations can use
explicit source attributes. Source hints are still page-supplied leads to verify,
never authorization to open or change a file. The compiler is supplied by the
host, so Pinflow adds no runtime dependency. Neither instrumentation nor
verification is imported by the browser core.

### Reliability and evaluation

Same-reviewer tabs reconcile their actual edits against the latest durable
snapshot. Sequential writes preserve unrelated feedback and do not resurrect
completed deletions. This remains a synchronous localStorage design: it does not
provide atomic transactions between truly simultaneous browser processes. Hosts
requiring stronger guarantees should use the existing authenticated sync protocol
and server-side revision/conflict handling.

`tests/evaluation/target-corpus.test.ts` contains labeled synthetic targeting and
abstention cases. `tests/verification/` checks stale revisions and honest failure
reports. The browser suite exercises capture, save, reload and export at all
configured viewport/device combinations. These are regression evaluations, not
measurements of coding-agent success on customer feedback. For that, collect a
consented corpus of resolved requests and compare target identification,
reproduction success, acceptance-check coverage, rework rate and time to an
accepted fix across text-only, screenshots and structured Pinflow evidence.

### Precise targets and intended scope

Pinflow prefers the clicked action over an app/row test ID and preserves the raw
clicked descendant when it anchors a containing control. Repeated controls carry
owner evidence. If a row disappears or changes identity, the pin parks; it must
not move onto the next row. Give repeated entities stable, non-sensitive IDs or
unique test IDs. Identical unnamed rows resolve by position and park as soon as
one is added or filtered away. A row's text identifies it, except the pinned
control's own label, so fixing that label keeps the pin; other text changes in
the row, such as a live timestamp, may require re-placing it. Existing comments
without owner evidence keep their older locator behavior.

The composer’s **Apply to** field declares **This instance**, **This component**,
or **All matching items**. Leaving it unspecified does not imply all instances.
Exported **Selected** members describe what the gesture covered. Scope confidence
measures captured containment, not identity or permission to edit everything.

**Current target** reports a current locator match, an unresolved target, or
`not-checked` for other routes. A match, particularly `fuzzy` or `positional`, is
not proof of identity. JSON carries these diagnostics separately in
`targetResolution`; capture evidence and revision hashes remain unchanged.
Parked notes keep historical selections and viewport. A closed modal does not
mean the element was deleted.

Text is capped at 512 characters, traversal at 64 text nodes, and fragment boxes
at 12. Bounds, parent bounds, line height, display, gap, overflow and dimensions
help explain wrapping or spacing. `truncated` signals a cap; rectangles do not
identify the phrase the reviewer meant. Boolean checked/disabled/ARIA states are
captured without form values. These facts describe capture time, not a test result.
Ask for a precise phrase or expected result when the note still leaves it unclear.

### Host adapters for application state and canvas

Use explicit safe state, not arbitrary datasets or application objects. For
example, a hash-filtered task list can expose its filter and a public task label:

```ts
const review = init({
  project: 'tasks-preview',
  routeKey: () => `tasks:${location.hash === '#/active' ? 'active' : 'all'}`,
  captureContext: (target) => ({
    build: 'preview-42',
    subject: target.closest('li')?.querySelector('label')?.textContent ?? 'Task list',
    state: location.hash === '#/active' ? 'filter: active' : 'filter: all',
  }),
});
const refresh = () => review.refreshRoute();
window.addEventListener('hashchange', refresh);
// On host teardown: removeEventListener('hashchange', refresh); review.destroy();
```

For a canvas/chart, the host owns hit testing. The second capture argument uses
viewport CSS pixels, matching `getBoundingClientRect()`. Convert them to the
coordinate system your chart expects, including any backing-store scale:

```ts
const review = init({
  project: 'chart-preview',
  captureContext: (target, { clientX, clientY }) => {
    if (!(target instanceof HTMLCanvasElement)) return;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // chart.hitTest is your adapter, returning a safe public label for a point.
    const point = chart.hitTest(
      ((clientX - rect.left) * target.width) / rect.width,
      ((clientY - rect.top) * target.height) / rect.height,
    );
    return point ? { subject: point.publicLabel, state: chart.publicViewName } : undefined;
  },
});
```

`subject` is capped at 120 characters. Host-supplied subject, state, steps and
expected outcomes are labeled unverified; Pinflow does not observe the behavior
merely because the host describes it. Supply only facts available at the gesture.

Inside a native `showModal()` dialog the overlay moves into the dialog so it
stays interactive. If that dialog has a transform, filter or containment, pins
still land on the page, but the dock and composer are confined to the dialog's
box until it closes.

Open shadow roots use composed event targets, root-local labels and a host/inner
locator path, with a maximum depth of eight. Give hosts stable IDs when there are
multiple similar widgets. Excessive depth remains unresolved. Canvas, frames and
custom hosts without an open root signal limited DOM evidence. Closed roots and
cross-origin frames need host cooperation; Pinflow cannot inspect their contents,
and a closed root on a generic built-in element is not externally detectable.
For development source hints, use the opt-in instrumentation described above;
validate every source hint against the repository before editing.

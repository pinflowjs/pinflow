---
'pinflowjs': minor
---

Add `pinflowjs/capture` for hosts that provide their own submission interface. It retains annotation, editing, persistence, voice integration, target evidence and scope capture while excluding the export UI and serializers. `getSnapshot()` returns detached committed feedback and current target diagnostics.

Add `pinflowjs/handoff` to prepare frozen Markdown/JSON artifacts on demand, with explicit native share, clipboard and download actions. Existing `pinflowjs` imports keep their synchronous export API and full widget. Both entries replace the same active instance, including when loaded from independently minified bundles.

Capture and handoff have separate size checks. The full-entry ceilings remain unchanged; this branch's full build, including the pending mobile fixes, exceeds them and needs an owner-approved size trade before publishing. New-entry ceilings must be ratcheted from CI measurements before release.

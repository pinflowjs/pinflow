---
'pinflowjs': minor
---

Add `pinflowjs/capture` for hosts that provide their own submission interface. It retains annotation, editing, persistence, voice integration, target evidence and scope capture while excluding the export UI and serializers. `getSnapshot()` returns detached committed feedback and current target diagnostics.

Add `pinflowjs/handoff` to prepare frozen Markdown/JSON artifacts on demand, with explicit native share, clipboard and download actions. Existing `pinflowjs` imports keep their synchronous export API and full widget. Both entries replace the same active instance, including when loaded from independently minified bundles.

`pinflowjs/capture` is about 24 kB gzipped against the full widget's 32 kB, and `pinflowjs/handoff` adds about 6 kB when a host loads it. Each has its own size check.

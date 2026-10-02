---
'pinflowjs': patch
---

Raise the core size ceilings for mobile feedback and the capture/handoff boundary, as an approved trade. Core rises from 30.81 kB (IIFE) and 30.68 kB (ESM) gzipped to 31.81 kB and 31.64 kB. About 0.8 kB buys keeping the editor and export panel inside the visible viewport while the keyboard is open, native sharing on touch devices and the manual-copy fallback. About 0.2 kB is the cost of splitting the controller so `pinflowjs/capture` ships without the handoff UI. The new entries get their own ceilings: 23.81 kB for capture and 6.11 kB for handoff. Every ceiling sits about 50 B over the CI measurement (31.76, 31.59, 23.76 and 6.06 kB), and the README badge reads 32 kB to match.

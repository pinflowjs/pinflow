// Keep rule order identical in the full widget; capture omits handoff-only blocks.
// CSS is a string literal, so whitespace is minimized deliberately.
const foundation =
  ':host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
  '*{box-sizing:border-box}' +
  // The var fallback repeats the static stack (not `inherit`) so .root never
  // depends on :host's font surviving `all:initial` — some Chromium builds
  // drop it (audit 2026-07-23: untokened embeds computed Times).
  // Touch: Chromium flashes a translucent blue tap-highlight square over any
  // tapped control. It inherits, so this one declaration covers every control;
  // the host's all:initial stops a page's own opt-out from reaching the tree.
  '.root{position:fixed;inset:0;pointer-events:none;z-index:2147483646;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;font-family:var(--pf-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif)}' +
  // Bottom-left dock (0.5.0): the ONE standing affordance. Arm segment (+/×)
  // in neutral chrome; the count chip joins it when there is something to
  // export. Children carry pointer-events — the dock itself stays inert.
  // .arm/.chip share the circle; each keeps only its color/size deltas.
  // The --pf-o* variables are set only while the overlay is confined to a host
  // dialog's box (dom.ts syncLayer); unset, both resolve to the viewport corner.
  '.dock{position:fixed;left:calc(var(--pf-ox,0px) + 16px);bottom:calc(100% - var(--pf-oy,0px) - var(--pf-oh,100%) + 16px);display:flex;align-items:center;gap:8px}' +
  '.arm,.chip{pointer-events:auto;height:26px;border:0;padding:0;border-radius:999px;font:inherit;font-weight:600;box-shadow:0 4px 10px rgba(0,0,0,.28),0 0 0 2px var(--pf-surface,light-dark(#fff,#1e222b));cursor:pointer;display:grid;place-items:center}' +
  '.arm{width:26px;background:#0f172a;color:#f8fafc}' +
  // The glyph is DRAWN, not typeset: two crossing bars centered by grid math.
  // Font ink is never optically centered in its em box (platform-dependent),
  // which is how a text "+" sits visibly off-center. Armed rotates the same
  // bars 45° — the + literally becomes the × (ease-out-quart, motion-safe).
  '.arm::before{content:"";width:12px;height:12px;background:linear-gradient(currentColor 0 0) center/12px 2px no-repeat,linear-gradient(currentColor 0 0) center/2px 12px no-repeat;transition:transform .18s cubic-bezier(.165,.84,.44,1)}' +
  '.arm[data-active="true"]::before{transform:rotate(45deg)}' +
  '.arm[data-active="true"]{background:var(--pf-accent,#2563eb);color:var(--pf-accent-contrast,#fff)}';

const panels =
  '.panel{position:fixed;pointer-events:auto;min-width:260px;max-width:320px;background:var(--pf-surface,light-dark(#fff,#1e222b));color:var(--pf-text,light-dark(#0f172a,#e7eaf1));border-radius:var(--pf-radius,12px);padding:16px;box-shadow:var(--pf-shadow,0 16px 48px rgba(15,23,42,.18),0 2px 6px rgba(15,23,42,.08));font-size:13px;line-height:1.45}' +
  '.panel h3{margin:0 0 8px;font-size:13px;font-weight:600}' +
  '.panel p{margin:0 0 12px;opacity:.75;color:var(--pf-text-muted,inherit)}' +
  // Wraps rather than squeezes: `flex:1` alone gave every button an equal
  // share, so a long label (the confirmation's "Download Feedback Markdown")
  // shrank to a 3-line stack. Sizing from content with a floor lets a row that
  // does not fit break instead — the primary takes its own line and the rest
  // share the next. Two-button rows are unaffected: they still fit.
  '.panel .row{display:flex;gap:8px;flex-wrap:wrap}' +
  // The name field shares the button's box so it costs a selector, not a rule.
  '.panel button,.panel input.name{flex:auto;min-width:96px;min-height:36px;padding:8px 12px;border-radius:8px;border:1px solid color-mix(in oklab,currentColor 18%,transparent);background:color-mix(in oklab,currentColor 7%,transparent);color:inherit;font:inherit;cursor:pointer}' +
  // The root sets user-select:none for the pin layer; the field opts back in
  // or it cannot be selected or corrected.
  '.panel input.name{-webkit-user-select:text;user-select:text;box-sizing:border-box;width:100%;margin:0 0 10px;cursor:text}' +
  '.panel button.primary{background:var(--pf-accent,#2563eb);color:var(--pf-accent-contrast,#fff);border-color:transparent}' +
  '.panel button:hover{filter:brightness(.97)}';

const pinsAndOutlines =
  '.pin{position:fixed;pointer-events:auto;width:24px;height:24px;border:0;padding:0;font-family:inherit;border-radius:999px;background:var(--pf-accent,#2563eb);color:var(--pf-accent-contrast,#fff);display:grid;place-items:center;font-size:11px;font-weight:600;box-shadow:0 4px 10px rgba(0,0,0,.28),0 0 0 2px var(--pf-surface,light-dark(#fff,#1e222b));cursor:pointer;transform:translate(-50%,-50%) scale(0);animation:pop .18s ease forwards;transition:transform .12s ease}' +
  '.pin:hover{transform:translate(-50%,-50%) scale(1.08)}' +
  // Resolution treatment (L2.3), cheapest legible option: dispositioned pins go
  // muted via the theme's textMuted token (distinct from orphan gray #a3a3a3);
  // done additionally swaps the number for a ✓ (set in _renderPins), declined
  // keeps its number struck through. One shared bg rule + one declined rule.
  '.pin[data-status]{background:var(--pf-text-muted,light-dark(#64748b,#99a1b3))}' +
  '.pin[data-status="declined"]{text-decoration:line-through}' +
  '@keyframes pop{to{transform:translate(-50%,-50%) scale(1)}}' +
  // Armed-mode hover outline: accent border + faint accent wash over the
  // element under the crosshair. pointer-events:none — purely indicative.
  '.hl{position:fixed;pointer-events:none;border:2px solid var(--pf-accent,#2563eb);background:color-mix(in oklab,var(--pf-accent,#2563eb) 8%,transparent);border-radius:4px;transition:.08s}' +
  // Area footprint: the placed region's marching ants — four 1px edges from
  // repeating-linear-gradients in currentColor (ONE color override covers the
  // muted state) + a faint wash. background-color must come AFTER the
  // background shorthand (the shorthand resets it). Ants freeze under
  // prefers-reduced-motion.
  '.area{position:fixed;pointer-events:none;z-index:-1;opacity:.7;color:var(--pf-accent,#2563eb);background:repeating-linear-gradient(90deg,currentColor 0 4px,transparent 4px 8px) 0 0/100% 1px no-repeat,repeating-linear-gradient(90deg,currentColor 0 4px,transparent 4px 8px) 0 100%/100% 1px no-repeat,repeating-linear-gradient(0deg,currentColor 0 4px,transparent 4px 8px) 0 0/1px 100% no-repeat,repeating-linear-gradient(0deg,currentColor 0 4px,transparent 4px 8px) 100% 0/1px 100% no-repeat;background-color:color-mix(in oklab,currentColor 5%,transparent);animation:march 1s linear infinite}' +
  '.area[data-status]{color:var(--pf-text-muted,light-dark(#64748b,#99a1b3))}' +
  '@keyframes march{to{background-position:8px 0,-8px 100%,0 -8px,100% 8px}}' +
  // Scope outline (v4): one container, N boxes, four composable channels.
  // Default is the CONTEXT treatment (1px, no wash) — the boundary, and any
  // member big enough that a wash would read as "page disabled". [data-m] is a
  // target the note may change; [data-d] is uncertain; [data-seam] is an
  // insertion point, which is a bar rather than a box because there is no
  // element there. No entrance animation: the marquee dim dropping is already
  // a large instantaneous change that reads as "resolved", and a fade competes
  // with it for a keyframe plus a reduced-motion override.
  '.so>i{position:fixed;pointer-events:none;border:1px solid var(--pf-accent,#2563eb);border-radius:4px}' +
  '.so>i[data-m]{border-width:2px;background:color-mix(in oklab,var(--pf-accent,#2563eb) 8%,transparent)}' +
  '.so>i[data-d]{border-style:dashed}' +
  '.so>i[data-seam]{border:0;border-radius:0;background:var(--pf-accent,#2563eb)}' +
  // Drag-to-marquee: the same box, plus a page-dimming "hole" — one huge
  // box-shadow spread instead of an overlay element. Must track the pointer
  // with zero lag, so the hover transition is dropped while dragging.
  '.hl[data-marquee]{box-shadow:0 0 0 200vmax rgba(15,23,42,.32);transition:none}';

const countChip =
  // Anytime-export count chip: the pin vocabulary (same accent circle, same
  // pop-in), docked beside the arm segment.
  '.chip{min-width:26px;padding:0 8px;background:var(--pf-accent,#2563eb);color:var(--pf-accent-contrast,#fff);font-size:12px;transform:scale(0);animation:chippop .18s ease forwards}' +
  '@keyframes chippop{to{transform:scale(1)}}';

const motionAndComposer =
  '@media (prefers-reduced-motion:reduce){.pin{animation:none;transform:translate(-50%,-50%)}.chip{animation:none;transform:none}.hl{transition:none}.area{animation:none}.arm::before{transition:none}}' +
  '@media (max-width:640px){.pin,.arm{width:32px;height:32px;font-size:13px}.chip{min-width:32px;height:32px;font-size:13px}}' +
  '.input{position:fixed;pointer-events:auto;min-width:240px;max-width:320px;background:var(--pf-surface,light-dark(#fff,#1e222b));color:var(--pf-text,light-dark(#0f172a,#e7eaf1));border-radius:var(--pf-radius,10px);padding:10px;box-shadow:var(--pf-shadow,0 12px 32px rgba(15,23,42,.18),0 2px 6px rgba(15,23,42,.08))}';

const manualCopy =
  '.manual-copy{width:100%;height:100px;font-size:16px;-webkit-user-select:text;user-select:text}';

const editor =
  '.input,.panel{overflow:auto;overscroll-behavior:contain}' +
  '.input textarea{-webkit-user-select:text;user-select:text;width:100%;min-height:64px;max-height:160px;resize:none;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.5}' +
  // iOS Safari auto-zooms the page when a focused input is under 16px; the
  // reviewer's recovery pinch then eats the draft. 16px on touch kills the
  // zoom trigger at the source.
  // Spec 'Mobile considerations': hit targets >=44px. Keyed to the POINTER,
  // not the viewport — a landscape phone is 844px wide and still a thumb.
  '@media (pointer:coarse){.input textarea,.input select,.panel input.name{font-size:16px}.panel button{min-height:44px}}' +
  '.input .actions{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:12px;color:var(--pf-text-muted,inherit)}' +
  // Read-only disposition line in a resolved comment's popup ("✓ Done — note").
  '.input .scope-label{display:block;margin-top:8px;font-size:12px}.input select{display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:6px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font:inherit}' +
  '.input .res{margin-top:8px;font-size:12px;color:var(--pf-text-muted,light-dark(#64748b,#99a1b3))}' +
  // .62, not .55: the quiet state must still clear AA 4.5:1 at 13px on both
  // light-dark surfaces (0.11.0 review #1 measured .55 at ~4.0:1 on light).
  '.input .delete,.input .exportall{background:transparent;border:0;color:inherit;cursor:pointer;opacity:.62;font:inherit;padding:0}';

const panelRows = '.panel .row+.row{margin-top:8px}';

const deleteHover =
  // The panel's clear is a REAL button at rest — the shared `.panel button`
  // box beside Export & share / Done. As quiet caption text it was not read as
  // an action at all (0.12.1). Hover tints it toward danger; the border is
  // currentColor-derived, so it follows.
  // Dark fallback lightens: #dc2626 is 4.8:1 on the light surface but 3.3:1
  // on the dark one, and the armed clear is a standing state, not a flash.
  '.input .delete:hover,.panel .clr:hover{opacity:1;color:var(--pf-danger,light-dark(#dc2626,#f87171))}';

const armedClear =
  // Armed, the clear is the row's destructive affirmative: a filled button
  // beside Keep, in the primary's place.
  '.panel .clr.a{background:var(--pf-danger,light-dark(#dc2626,#f87171));color:light-dark(#fff,#0f172a);border-color:transparent}';

const editorActions =
  '.input .exportall:hover{opacity:1}' +
  '.input .save{background:var(--pf-accent,#2563eb);color:var(--pf-accent-contrast,#fff);border:0;border-radius:8px;padding:6px 16px;min-height:30px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}' +
  '.input .save:hover{filter:brightness(.95)}';

export const CAPTURE_STYLES =
  foundation + pinsAndOutlines + motionAndComposer + editor + deleteHover + editorActions;
export const STYLES =
  foundation +
  panels +
  pinsAndOutlines +
  countChip +
  motionAndComposer +
  manualCopy +
  editor +
  panelRows +
  deleteHover +
  armedClear +
  editorActions;

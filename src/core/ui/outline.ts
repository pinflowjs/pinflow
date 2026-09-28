import type { ScopeRect, ScopeResult } from '../scope';
import { box, el } from './dom-base';

// The scope outline: what the reviewer sees resolved, before the composer
// opens. Four orthogonal channels, one meaning each, composable — which is how
// three render cases fit inside one renderer at a handful of CSS rules:
//
//   2px stroke + accent wash  a TARGET the note may change   → **Change:**
//   1px stroke, no wash       CONTEXT — the edit boundary    → **Scope:**
//   dashed                    UNCERTAIN — low confidence     → confidence
//   solid seam bar            an INSERTION POINT             → insertion record
//
// The members carry the weight and the boundary is a whisper. The instinct is
// to draw the big box, but a union box over three cards in a grid IS
// approximately the grid rect — restating the bug in pixels.
//
// Exclusions are deliberately NOT drawn. Absence is already the signal:
// everything unoutlined is excluded. Drawing them doubles the ink, is noisiest
// exactly when a marquee grazes a whole adjacent row, and is the DevTools
// instinct — an explicit anti-reference.
//
// OWNERSHIP. Every box is a child of ONE container, so teardown is a single
// idempotent remove() that is N-agnostic. On a codebase with seventeen
// recorded armed-mode leaks, "N elements that must survive teardown" is the
// exact shape that produced them; "one element" is not.

// Above this share of the viewport a member falls back to the context
// treatment. A full-page 8% wash reads as "disabled" and pollutes every
// screenshot the reviewer takes afterwards — an enormous scope should look
// like a whisper, not a shout.
const QUIET_ABOVE = 0.6;

interface Box {
  l: number;
  t: number;
  w: number;
  h: number;
}

// Geometry is NOT clamped to the viewport: two parallel edges with no visible
// horizontal one honestly reads as "this continues past the screen", which is
// true. Clamping would draw a box the element does not have.
function boxOf(target: Element): Box | null {
  const r = target.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) return { l: r.left, t: r.top, w: r.width, h: r.height };
  // `display:contents` reports 0,0,0,0 AT THE VIEWPORT ORIGIN, so a minimum
  // size here would paint a stray box in the top-left corner — worse than
  // nothing. Fall back to the union of the fragment rects, and if there is
  // still no area, drop the box. A fabricated box is worse than an absent one.
  const rects = target.getClientRects();
  if (!rects.length) return null;
  let l = Infinity;
  let t = Infinity;
  let r2 = -Infinity;
  let b = -Infinity;
  for (let i = 0; i < rects.length; i++) {
    const q = rects[i]!;
    l = Math.min(l, q.left);
    t = Math.min(t, q.top);
    r2 = Math.max(r2, q.right);
    b = Math.max(b, q.bottom);
  }
  return r2 > l && b > t ? { l, t, w: r2 - l, h: b - t } : null;
}

export class ScopeOutline {
  private _el: HTMLDivElement | null = null;

  /**
   * Paint the resolved scope. Replaces whatever was showing, so the caller
   * never has to sequence a clear before a show.
   *
   * `region` is the drawn marquee, needed only to place an insertion's seam:
   * an insertion names a gap, and the container is deliberately never filled —
   * that would assert a boundary the reviewer did not draw.
   */
  show(root: Element, result: ScopeResult, region?: ScopeRect | null): void {
    this.clear();
    const wrap = el('div', 'so');
    const uncertain = result.scope.confidence === 'low';
    const viewport = window.innerWidth * window.innerHeight;

    this._paint(wrap, result.elements.boundary, false, uncertain);
    for (const member of result.elements.members) {
      const b = boxOf(member);
      // A member the size of the page gets the context treatment instead.
      const loud = !b || !viewport || (b.w * b.h) / viewport <= QUIET_ABOVE;
      this._paint(wrap, member, loud, uncertain || false, b);
    }

    if (result.scope.between && region) {
      // Seam on the dominant axis of the drawn gap: a wide, short region reads
      // as a horizontal insertion, a tall narrow one as a vertical one.
      const horizontal = region.width >= region.height;
      const seam = el('i');
      seam.dataset['seam'] = '';
      this._place(
        seam,
        horizontal
          ? { l: region.left, t: region.top + region.height / 2, w: region.width, h: 2 }
          : { l: region.left + region.width / 2, t: region.top, w: 2, h: region.height },
      );
      wrap.appendChild(seam);
    }

    if (!wrap.childElementCount) return;
    this._el = wrap;
    root.appendChild(wrap);
  }

  /** Idempotent, N-agnostic, and safe to call from any teardown path. */
  clear(): void {
    this._el?.remove();
    this._el = null;
  }

  private _paint(
    wrap: HTMLElement,
    target: Element,
    member: boolean,
    dashed: boolean,
    known?: Box | null,
  ): void {
    const b = known === undefined ? boxOf(target) : known;
    if (!b) return;
    const node = el('i');
    if (member) node.dataset['m'] = '';
    if (dashed) node.dataset['d'] = '';
    this._place(node, b);
    wrap.appendChild(node);
  }

  private _place(node: HTMLElement, b: Box): void {
    box(node, b.l, b.t, b.w, b.h);
  }
}

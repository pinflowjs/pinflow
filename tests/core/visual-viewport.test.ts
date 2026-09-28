import { afterEach, expect, it, vi } from 'vitest';
import { createUIRoot, flipPosition } from '../../src/core/ui/dom';
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
it('uses the visible viewport after keyboard resize and pan', () => {
  vi.stubGlobal('visualViewport', { offsetLeft: 12, offsetTop: 180, width: 370, height: 300 });
  const ui = createUIRoot();
  expect(ui.bounds()).toEqual({ left: 12, top: 180, width: 370, height: 300 });
  ui.destroy();
});
it('clamps a panel even when its anchor is beyond the visible viewport', () => {
  expect(
    flipPosition(
      { left: 900, top: 900 },
      { width: 280, height: 220 },
      { left: 0, top: 180, width: 390, height: 300 },
    ),
  ).toEqual({ left: 102, top: 252 });
});

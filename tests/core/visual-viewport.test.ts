import { afterEach, expect, it, vi } from 'vitest';
import { createUIRoot, fit, flipPosition } from '../../src/core/ui/dom';
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
it('keeps the stylesheet width floor unless the visible area is narrower', () => {
  const node = document.createElement('div');
  fit(node, { left: 0, top: 0, width: 390, height: 844 });
  // The composer's 240px and the panel's 260px floors both stand.
  expect(node.style.minWidth).toBe('');
  expect(node.style.maxWidth).toBe('320px');
  expect(node.style.maxHeight).toBe('828px');
  fit(node, { left: 0, top: 0, width: 200, height: 300 });
  expect(node.style.minWidth).toBe('184px');
  expect(node.style.maxWidth).toBe('184px');
});

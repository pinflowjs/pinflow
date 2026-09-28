import { afterEach, describe, expect, it, vi } from 'vitest';
import { init as initFull, destroy as destroyFull } from '../../src/core/index';
import { init, destroy } from '../../src/capture/index';
import { prepareHandoff } from '../../src/handoff/index';
import { buildAnchor } from '../../src/core/anchor';
import { emptyStore, saveStore } from '../../src/core/storage';
import { routeKey } from '../../src/core/route-key';

const config = { project: 'capture-test', reviewer: 'Reviewer', expectedOutcome: true };
function seed() {
  document.body.innerHTML = '<button id="checkout">Checkout</button>';
  const store = emptyStore(config.project, config.reviewer);
  store.comments.push({
    id: 'note',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    text: 'Change the label\n# forged heading',
    route: routeKey(),
    fullUrl: location.href,
    modality: 'text',
    anchor: buildAnchor(document.querySelector('button')!, 0, 0),
    feedback: { expected: 'Checkout opens', intent: 'instance' },
  });
  saveStore(localStorage, store);
}
const root = () => document.querySelector('[data-pinflow-root]')!.shadowRoot!;
afterEach(() => {
  destroy();
  destroyFull();
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('capture entry and optional handoff', () => {
  it('edits and persists evidence without export UI; snapshots cannot mutate live feedback', () => {
    seed();
    const onChange = vi.fn();
    const capture = init({ ...config, onChange });
    expect(root().querySelector('.chip')).toBeNull();
    root().querySelector<HTMLButtonElement>('.pin')!.click();
    expect(root().querySelector('.exportall')).toBeNull();
    root().querySelector('textarea')!.value = 'Make checkout clearer';
    root().querySelector<HTMLButtonElement>('.save')!.click();
    const snapshot = capture.getSnapshot();
    expect(snapshot.store.comments[0]!.text).toBe('Make checkout clearer');
    expect(snapshot.store.comments[0]!.feedback?.expected).toBe('Checkout opens');
    expect(snapshot.targets['note']?.availability).toBe('matched');
    snapshot.store.comments[0]!.text = 'tampered';
    expect(capture.getSnapshot().store.comments[0]!.text).toBe('Make checkout clearer');
    expect(onChange).toHaveBeenCalled();
  });

  it('preserves full-entry Markdown and JSON exactly, including hostile text and orphaned targets', () => {
    seed();
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-09-28T12:00:00.000Z');
    const full = initFull(config);
    const expected = { markdown: full.exportMarkdown(), json: full.exportJSON() };
    full.destroy();
    const capture = init(config);
    const artifact = prepareHandoff(capture.getSnapshot());
    expect(artifact.markdown).toBe(expected.markdown);
    expect(artifact.json).toBe(expected.json);
    document.getElementById('checkout')!.remove();
    const orphan = prepareHandoff(capture.getSnapshot());
    capture.destroy();
    const reloaded = initFull(config);
    expect(orphan.markdown).toBe(reloaded.exportMarkdown());
    expect(orphan.json).toBe(reloaded.exportJSON());
  });

  it('replaces the full instance and does not let an old handle destroy its replacement', () => {
    seed();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = initFull(config);
    const capture = init(config);
    expect(document.querySelectorAll('[data-pinflow-root]')).toHaveLength(1);
    expect(root().querySelector('.chip')).toBeNull();
    full.destroy();
    expect(document.querySelectorAll('[data-pinflow-root]')).toHaveLength(1);
    const next = initFull(config);
    capture.destroy();
    expect(document.querySelectorAll('[data-pinflow-root]')).toHaveLength(1);
    expect(root().querySelector('.chip')).not.toBeNull();
    next.destroy();
  });
  it('does not interpret inherited target-map properties as resolution evidence', () => {
    seed();
    const capture = init(config);
    const snapshot = capture.getSnapshot();
    snapshot.store.comments[0]!.id = 'toString';
    snapshot.targets = {};
    const artifact = prepareHandoff(snapshot);
    expect(artifact.markdown).toContain('"availability":"not-checked"');
    expect(JSON.parse(artifact.json).targetResolution[0].availability).toBe('not-checked');
  });

  it('freezes Markdown and filename at preparation and starts share synchronously', async () => {
    seed();
    const capture = init(config);
    const snapshot = capture.getSnapshot();
    const first = '2026-09-28T23:59:59.999Z';
    vi.spyOn(Date.prototype, 'toISOString')
      .mockReturnValueOnce(first)
      .mockReturnValue('2026-09-29T00:00:00.001Z');
    const artifact = prepareHandoff(snapshot);
    expect(artifact.markdown).toContain(first);
    expect(artifact.filename).toContain('2026-09-28T23-59-59-999Z');
    snapshot.store.comments[0]!.text = 'later edit';
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    try {
      const result = artifact.share();
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ text: artifact.markdown }));
      expect(share.mock.calls[0]![0].text).not.toContain('later edit');
      expect(await result).toBe('shared');
    } finally {
      Reflect.deleteProperty(navigator, 'share');
      Reflect.deleteProperty(navigator, 'canShare');
    }
  });
});

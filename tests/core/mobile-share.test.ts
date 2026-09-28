import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shareFeedback } from '../../src/core/download';
import { Annotator } from '../../src/core/ui/annotator';
import { emptyStore, saveStore } from '../../src/core/storage';
import { routeKey } from '../../src/core/route-key';

const md = '# Feedback\n\nKeep all of this evidence.';
let annotator: Annotator | undefined;
const nativeShare = vi.fn();
const canShare = vi.fn();
function button(label: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelector('[data-pinflow-root]')!.shadowRoot!.querySelectorAll('button'),
  ].find((b) => b.textContent === label);
}
function openSheet() {
  saveStore(localStorage, {
    ...emptyStore('mobile', 'Reviewer'),
    comments: [
      {
        id: 'note',
        text: 'Original feedback',
        route: routeKey(),
        fullUrl: location.href,
        createdAt: '2026-09-28T00:00:00Z',
        updatedAt: '2026-09-28T00:00:00Z',
        modality: 'text',
        anchor: {
          selectors: { testid: null, id: null, css: 'body', xpath: '/html/body' },
          textFingerprint: '',
          positionPercent: { x: 50, y: 50 },
          viewport: { width: 390, height: 844 },
        },
      },
    ],
  });
  annotator = new Annotator({
    config: { project: 'mobile' },
    reviewer: 'Reviewer',
    mode: 'reviewer',
    storage: localStorage,
  });
  document
    .querySelector('[data-pinflow-root]')!
    .shadowRoot!.querySelector<HTMLButtonElement>('.chip')!
    .click();
}
function startExport() {
  openSheet();
  button('Export & share')!.click();
}

beforeEach(() => {
  nativeShare.mockReset().mockResolvedValue(undefined);
  canShare.mockReset().mockReturnValue(true);
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), { share: nativeShare, canShare }),
  );
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q) => ({ matches: q === '(any-pointer:coarse)' }) as MediaQueryList,
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  annotator?.destroy();
  annotator = undefined;
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native feedback sharing', () => {
  it('starts sharing the complete markdown file synchronously in the tap', async () => {
    const result = shareFeedback(md, 'feedback.md');
    expect(nativeShare).toHaveBeenCalledTimes(1);
    const data = nativeShare.mock.calls[0]![0] as ShareData;
    expect(data.files![0]!.name).toBe('feedback.md');
    expect(await data.files![0]!.text()).toBe(md);
    await expect(result).resolves.toBe('shared');
  });
  it('uses a plain text attachment when markdown files are rejected', async () => {
    canShare.mockImplementation((data: ShareData) => data.files?.[0]?.type === 'text/plain');
    await shareFeedback(md, 'feedback.md');
    const file = nativeShare.mock.calls[0]![0].files[0] as File;
    expect(file.name).toBe('feedback.txt');
    expect(await file.text()).toBe(md);
  });
  it('shares full text when file sharing is unavailable', async () => {
    canShare.mockReturnValue(false);
    await shareFeedback(md, 'feedback.md');
    expect(nativeShare).toHaveBeenCalledWith({ title: 'Pinflow feedback', text: md });
  });
  it('treats cancellation as cancellation, without another share attempt', async () => {
    nativeShare.mockRejectedValue(new DOMException('Cancel', 'AbortError'));
    await expect(shareFeedback(md, 'feedback.md')).resolves.toBe('cancelled');
    expect(nativeShare).toHaveBeenCalledTimes(1);
  });
  it('handles missing APIs and permission failures without throwing', async () => {
    nativeShare.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await expect(shareFeedback(md, 'feedback.md')).resolves.toBe('unavailable');
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    await expect(shareFeedback(md, 'feedback.md')).resolves.toBe('unavailable');
  });
});

describe('mobile export controls', () => {
  it('opens native sharing directly and never starts a download', async () => {
    startExport();
    expect(nativeShare).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(button('Download Feedback Markdown')).toBeUndefined();
    expect(button('Share feedback')).toBeDefined();
    expect(button('Copy to Clipboard')).toBeDefined();
    await vi.waitFor(() => expect(button('Share feedback')!.disabled).toBe(false));
  });
  it('cancellation keeps feedback and retry shares the frozen artifact', async () => {
    nativeShare.mockRejectedValueOnce(new DOMException('Cancel', 'AbortError'));
    startExport();
    await vi.waitFor(() => expect(button('Share feedback')!.disabled).toBe(false));
    const first = await nativeShare.mock.calls[0]![0].files[0].text();
    expect(JSON.parse(annotator!.exportJSON()).comments).toHaveLength(1);
    // The reviewer just dismissed the sheet; the resting line still holds.
    expect(document.querySelector('[data-pinflow-root]')!.shadowRoot!.textContent).toContain(
      'Share your feedback or copy it into a message.',
    );
    button('Share feedback')!.click();
    await vi.waitFor(() => expect(nativeShare).toHaveBeenCalledTimes(2));
    expect(await nativeShare.mock.calls[1]![0].files[0].text()).toBe(first);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('unsupported mobile browsers offer copy without a download', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    startExport();
    expect(button('Download Feedback Markdown')).toBeUndefined();
    expect(button('Copy to Clipboard')).toBeDefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-pinflow-root]')!.shadowRoot!.textContent).toContain(
        'Sharing is unavailable here. Copy the feedback instead.',
      ),
    );
  });
  it('the export sheet describes sharing, not a download, on touch', () => {
    openSheet();
    const body = document
      .querySelector('[data-pinflow-root]')!
      .shadowRoot!.querySelector('.panel p');
    expect(body?.textContent).toBe('Opens your share sheet with the markdown.');
  });
});

it('keeps a manual copy route when sharing and clipboard are both unavailable', async () => {
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  startExport();
  button('Copy to Clipboard')!.click();
  await vi.waitFor(() => {
    const field = document
      .querySelector('[data-pinflow-root]')!
      .shadowRoot!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Feedback to copy"]');
    expect(field?.readOnly).toBe(true);
    expect(field?.value).toContain('Original feedback');
  });
});

it('warns about the actual clipboard copy after canceled sharing', async () => {
  nativeShare.mockRejectedValue(new DOMException('Cancel', 'AbortError'));
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  startExport();
  button('Copy to Clipboard')!.click();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-pinflow-root]')!.shadowRoot!.textContent).toContain(
      'Copied to your clipboard.',
    ),
  );
  button('Clear comments')!.click();
  expect(document.querySelector('[data-pinflow-root]')!.shadowRoot!.textContent).toContain(
    'The clipboard copy is unaffected.',
  );
});
it('uses native sharing on a touch tablet with a mouse as its primary pointer', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q) => ({ matches: q === '(any-pointer:coarse)' }) as MediaQueryList,
  );
  startExport();
  expect(nativeShare).toHaveBeenCalledTimes(1);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

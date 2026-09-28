import { expect, test, type Page } from '@playwright/test';
import type { CaptureHandle } from '../../src/capture/index';
import type { Handle } from '../../src/core/index';
import type { HandoffArtifact } from '../../src/handoff/index';

type Fixture = Window & {
  captureHandle: CaptureHandle;
  fullHandle: Handle;
  previous: Array<{ destroy(): void }>;
  artifact: HandoffArtifact;
  shares: Array<{ active: boolean; text?: string }>;
};
async function annotate(page: Page) {
  await page.locator('button.arm').click();
  await page.locator('#checkout').click({ force: true });
  await page
    .locator('[data-pinflow-root] .input textarea')
    .first()
    .fill('Rename this to Complete purchase');
  await page.getByRole('textbox', { name: 'Expected outcome' }).fill('A receipt appears');
  await page.getByRole('combobox', { name: 'Apply to' }).selectOption('instance');
  await expect(page.locator('[data-pinflow-root] .exportall')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('capture-editor.png') });
  await page.locator('[data-pinflow-root] .save').click();
}

test('packed capture keeps evidence, loads handoff only on demand, and shares from a live tap', async ({
  page,
}) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const fixture = window as unknown as Fixture;
    fixture.shares = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: ShareData) => {
        fixture.shares.push({
          active: navigator.userActivation.isActive,
          ...(data.text ? { text: data.text } : {}),
        });
        return Promise.resolve();
      },
    });
  });
  await page.goto('/capture');
  await expect(page.locator('#status')).toHaveText('Capture ready');
  await annotate(page);
  expect(requests).toContain('/dist/capture.js');
  expect(requests).not.toContain('/dist/index.js');
  expect(requests).not.toContain('/dist/handoff.js');
  await expect(page.locator('[data-pinflow-root] .chip')).toHaveCount(0);
  const before = await page.evaluate(() =>
    (window as unknown as Fixture).captureHandle.getSnapshot(),
  );
  expect(before.store.comments[0]!.scope).toBeDefined();
  expect(before.store.comments[0]!.anchor.details).toBeDefined();
  expect(before.store.comments[0]!.feedback).toMatchObject({
    expected: 'A receipt appears',
    intent: 'instance',
  });
  expect(Object.values(before.targets)[0]!.availability).toBe('matched');
  await page.reload();
  await expect(page.locator('button.pin')).toHaveCount(1);
  await page.locator('#prepare').click();
  await expect(page.locator('#share')).toBeEnabled();
  expect(requests).toContain('/dist/handoff.js');
  await expect(page.locator('#artifact')).toHaveValue(/Rename this to Complete purchase/);
  await page.locator('#share').click();
  await expect(page.locator('#status')).toHaveText('shared');
  const shared = await page.evaluate(() => (window as unknown as Fixture).shares);
  expect(shared).toHaveLength(1);
  expect(shared[0]!.active).toBe(true);
  expect(shared[0]!.text).toContain('A receipt appears');
  expect(shared[0]!.text).toContain('instance');
  await expect(page.locator('button.pin')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('independently minified full and capture entries share one live lifecycle in both directions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/capture');
  await expect(page.locator('#status')).toHaveText('Capture ready');
  await annotate(page);
  await page.locator('#full').click();
  await expect(page.locator('#status')).toHaveText('Full ready');
  await expect(page.locator('[data-pinflow-root]')).toHaveCount(1);
  await expect(page.locator('button.chip')).toHaveCount(1);
  const full = await page.evaluate(() =>
    (window as unknown as Fixture).fullHandle.exportMarkdown(),
  );
  expect(full).toContain('Rename this to Complete purchase');
  await page.locator('#capture').click();
  await expect(page.locator('#status')).toHaveText('Capture ready');
  await page.evaluate(() =>
    (window as unknown as Fixture).previous.forEach((handle) => handle.destroy()),
  );
  await expect(page.locator('[data-pinflow-root]')).toHaveCount(1);
  await expect(page.locator('button.chip')).toHaveCount(0);
  await expect(page.locator('button.pin')).toHaveCount(1);
  await page.locator('button.pin').click();
  await expect(page.locator('[data-pinflow-root] .input textarea').first()).toHaveValue(
    'Rename this to Complete purchase',
  );
  expect(errors).toEqual([]);
});

test('a rejected native share leaves captured feedback and the frozen artifact available', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Canceled', 'AbortError')),
    });
  });
  await page.goto('/capture');
  await expect(page.locator('#status')).toHaveText('Capture ready');
  await annotate(page);
  await page.locator('#prepare').click();
  await expect(page.locator('#share')).toBeEnabled();
  const markdown = await page.locator('#artifact').inputValue();
  await page.locator('#share').click();
  await expect(page.locator('#status')).toHaveText('cancelled');
  await expect(page.locator('button.pin')).toHaveCount(1);
  await expect(page.locator('#artifact')).toHaveValue(markdown);
});

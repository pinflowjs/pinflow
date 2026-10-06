import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Handle, PinflowConfig } from '../../src/core/index';

// Headless mobile emulation does not show an OS keyboard. Keep the browser's
// layout viewport unchanged and reproduce the visualViewport geometry/events
// produced by keyboard opening and Safari panning. Physical-device validation
// is still required for the OS keyboard and browser chrome interaction.
type ViewportChange = {
  height: number;
  offsetTop: number;
  width?: number;
  offsetLeft?: number;
  event: 'resize' | 'scroll';
};

async function installVisualViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = window.visualViewport!;
    let simulated: ViewportChange | undefined;
    // Mobile engines initialize before the meta viewport is parsed. Keep
    // their live getters until the test explicitly simulates the keyboard.
    for (const property of ['height', 'offsetTop', 'width', 'offsetLeft'] as const) {
      const nativeGet = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(viewport),
        property,
      )!.get!;
      Object.defineProperty(viewport, property, {
        configurable: true,
        get: () => simulated?.[property] ?? nativeGet.call(viewport),
      });
    }
    (
      window as unknown as { changeVisualViewport(change: ViewportChange): void }
    ).changeVisualViewport = (change) => {
      simulated = change;
      viewport.dispatchEvent(new Event(change.event));
    };
  });
}

async function changeViewport(page: Page, change: ViewportChange): Promise<void> {
  await page.evaluate((next) => {
    (
      window as unknown as { changeVisualViewport(change: ViewportChange): void }
    ).changeVisualViewport(next);
  }, change);
}

async function expectComposerInsideViewport(
  page: Page,
  selector = '[data-pinflow-root] .input',
): Promise<void> {
  await expect
    .poll(async () =>
      page.locator(selector).evaluate((composer) => {
        const rect = composer.getBoundingClientRect();
        const viewport = window.visualViewport!;
        return (
          rect.top >= viewport.offsetTop &&
          rect.bottom <= viewport.offsetTop + viewport.height &&
          rect.left >= viewport.offsetLeft &&
          rect.right <= viewport.offsetLeft + viewport.width
        );
      }),
    )
    .toBe(true);
}

async function openComposer(page: Page): Promise<void> {
  await page.locator('button.arm').click();
  await page.locator('[data-testid="primary-cta"]').click({ force: true });
  await expect(page.locator('[data-pinflow-root] .input')).toBeVisible();
}

test('keyboard resize keeps the composer visible without scrolling the page', async ({ page }) => {
  await installVisualViewport(page);
  await page.goto('/?reviewer=Keyboard');
  await openComposer(page);
  const layoutHeight = await page.evaluate(() => window.innerHeight);
  await changeViewport(page, { height: 280, offsetTop: 0, event: 'resize' });
  expect(await page.evaluate(() => window.innerHeight)).toBe(layoutHeight);
  await expectComposerInsideViewport(page);
  await page.locator('[data-pinflow-root] textarea').fill('Keep this field visible');
  await page.locator('button.save').click();
  await expect(page.locator('[data-pinflow-root] .input')).toHaveCount(0);
  await expect(page.locator('button.pin')).toHaveCount(1);
});

test('visual viewport panning repositions the open composer using its offset', async ({ page }) => {
  await installVisualViewport(page);
  await page.goto('/?reviewer=ViewportPan');
  await openComposer(page);
  await changeViewport(page, { height: 300, offsetTop: 0, event: 'resize' });
  await changeViewport(page, { height: 300, offsetTop: 300, event: 'scroll' });
  await expectComposerInsideViewport(page);
  // Closing the keyboard must restore the available space too.
  const layoutHeight = await page.evaluate(() => window.innerHeight);
  await changeViewport(page, { height: layoutHeight, offsetTop: 0, event: 'resize' });
  await expectComposerInsideViewport(page);
});

test('a composer taller than the keyboard space scrolls its fields and save button into reach', async ({
  page,
}) => {
  await installVisualViewport(page);
  await page.goto('/?reviewer=TallComposer');
  await page.evaluate(() => {
    (window as unknown as { Pinflow: { init(config: PinflowConfig): Handle } }).Pinflow.init({
      project: 'e2e-keyboard-outcome',
      reviewer: 'TallComposer',
      expectedOutcome: true,
    });
  });
  await openComposer(page);
  await changeViewport(page, { height: 170, offsetTop: 100, event: 'resize' });
  await expectComposerInsideViewport(page);
  const composer = page.locator('[data-pinflow-root] .input');
  expect(await composer.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.locator('[data-pinflow-root] textarea').first().fill('Current result is wrong');
  await page.getByRole('textbox', { name: 'Expected outcome' }).fill('The correct result appears');
  const save = page.locator('button.save');
  await save.scrollIntoViewIfNeeded();
  const box = (await save.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(100);
  expect(box.y + box.height).toBeLessThanOrEqual(270);
  await save.click();
  await expect(composer).toHaveCount(0);
  await expect(page.locator('button.pin')).toHaveCount(1);
});

test('a narrowed and horizontally panned visual viewport contains the composer', async ({
  page,
}) => {
  await installVisualViewport(page);
  await page.goto('/?reviewer=HorizontalPan');
  await openComposer(page);
  await changeViewport(page, {
    height: 300,
    offsetTop: 50,
    width: 240,
    offsetLeft: 90,
    event: 'resize',
  });
  await expectComposerInsideViewport(page);
});

test('the export name field and confirmation stay inside the keyboard viewport', async ({
  page,
}) => {
  await installVisualViewport(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
  });
  await page.goto('/?reviewer=ExportKeyboard');
  await openComposer(page);
  await page.locator('[data-pinflow-root] textarea').fill('Make this easier to see');
  await page.locator('button.save').click();
  await page.locator('button.chip').click();
  await page.getByRole('textbox', { name: 'Your name, included in the export' }).focus();
  await changeViewport(page, { height: 260, offsetTop: 80, event: 'resize' });
  await expectComposerInsideViewport(page, '[data-pinflow-root] .panel');
  await page
    .getByRole('textbox', { name: 'Your name, included in the export' })
    .fill('Mobile reviewer');
  await page.getByRole('button', { name: 'Export & share', exact: true }).click();
  await expect(page.getByText('Your feedback is ready', { exact: true })).toBeVisible();
  await expectComposerInsideViewport(page, '[data-pinflow-root] .panel');
  const share = page.getByRole('button', { name: 'Share feedback', exact: true });
  if (await share.count()) {
    await share.click();
    await expect(
      page.getByText('Share your feedback or copy it into a message.', { exact: true }),
    ).toBeVisible();
    await expectComposerInsideViewport(page, '[data-pinflow-root] .panel');
  }
});

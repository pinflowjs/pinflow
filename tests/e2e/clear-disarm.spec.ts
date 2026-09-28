import { test, expect } from '@playwright/test';

// The armed clear's back-out grammar, on real DOM (0.11.0 review #8): a click
// on a focusable host control while armed must DISARM and be SWALLOWED — the
// tap meant "back out of the question", not "operate what is under it". This
// ordering (pointerdown → native focus transfer → focusout → pointerup →
// click) cannot be discriminated in happy-dom, which clones listener lists
// mid-dispatch; only a real engine proves the swallow survives the disarm.

const CONTROL = 'button.arm';
const CHIP = 'button.chip';
const EXPORT_BTN = 'button:has-text("Export & share")';
const TEXTAREA = '[data-pinflow-root] textarea';
const SAVE_BUTTON = '[data-pinflow-root] button.save';
const CLEAR_RESTING = 'button:has-text("Clear comments")';
const HOST_LINK = 'a[data-link][href="/pricing"]';

async function armClear(page: import('@playwright/test').Page): Promise<void> {
  await page.locator(CONTROL).click();
  await page.locator('[data-testid="primary-cta"]').click({ force: true });
  await page.locator(TEXTAREA).fill('disarm me');
  await page.locator(SAVE_BUTTON).click();
  await page.locator(CHIP).click();
  await page.locator(EXPORT_BTN).click();
  await page.locator(CLEAR_RESTING).click();
  await expect(page.locator('button:has-text("Clear 1 comment")')).toBeVisible();
}

test('a host-control click while armed disarms AND is swallowed', async ({ page }) => {
  await page.goto('/?reviewer=Disarmer');
  await armClear(page);

  // A focusable host control with a click probe: pinflow must let the tap
  // back out of the armed question WITHOUT operating the control underneath.
  await page.evaluate(() => {
    const w = window as unknown as { ctaClicks: number };
    w.ctaClicks = 0;
    document
      .querySelector('a[data-link][href="/pricing"]')!
      .addEventListener('click', () => w.ctaClicks++);
  });
  await page.locator(HOST_LINK).click();

  // Backed out of the question…
  await expect(page.locator(CLEAR_RESTING)).toBeVisible();
  // …and the tap did NOT operate the host control underneath.
  expect(await page.evaluate(() => (window as unknown as { ctaClicks: number }).ctaClicks)).toBe(0);

  // The swallow is one-shot: the next deliberate click works normally.
  await page.locator(HOST_LINK).click();
  expect(await page.evaluate(() => (window as unknown as { ctaClicks: number }).ctaClicks)).toBe(1);
});

// The export's clipboard write must succeed under the real tap gesture —
// WebKit rejects writes that begin behind an async boundary, and the
// coordinator's synchronous initiation exists exactly for this (0.11.0
// review #12). The confirmation asserts the verified channel by name only
// when the write genuinely resolved true.
test('the export copy succeeds under the click gesture', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'chromium' || testInfo.project.name === 'mobile-chrome') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await page.goto('/?reviewer=Gesture');
  await page.locator(CONTROL).click();
  await page.locator('[data-testid="primary-cta"]').first().click({ force: true });
  await page.locator(TEXTAREA).fill('copy me');
  await page.locator(SAVE_BUTTON).click();
  await page.locator(CHIP).click();
  await page.locator(EXPORT_BTN).click();
  if (await page.evaluate(() => matchMedia('(any-pointer:coarse)').matches))
    await page.getByRole('button', { name: 'Copy to Clipboard', exact: true }).click();
  await expect(page.locator('text=Copied to your clipboard')).toBeVisible();
});

// The handoff stylesheet block now precedes the overlay block that carries
// `.panel .clr:hover`; the armed fill must still win, or hovering the armed
// control paints danger-red text on a danger-red fill.
test('the armed clear keeps its fill and legible text under hover', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'hover is a fine-pointer state');
  await page.goto('/?reviewer=ArmedHover');
  await armClear(page);
  const armed = page.locator('button:has-text("Clear 1 comment")');
  await armed.hover();
  const { background, color } = await armed.evaluate((b) => {
    const s = getComputedStyle(b);
    return { background: s.backgroundColor, color: s.color };
  });
  expect(background).toBe('rgb(220, 38, 38)');
  expect(color).toBe('rgb(255, 255, 255)');
});

test('the comment survives the backed-out arm', async ({ page }) => {
  await page.goto('/?reviewer=Disarmer2');
  await armClear(page);
  await page.locator(HOST_LINK).click();
  await expect(page.locator(CLEAR_RESTING)).toBeVisible();
  // Nothing was cleared by the back-out.
  await page.locator('button:has-text("Done")').click();
  await expect(page.locator('button.pin')).toHaveCount(1);
});

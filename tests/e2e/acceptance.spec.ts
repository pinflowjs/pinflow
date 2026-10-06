import { exportFeedback } from './export-helper';
import { test, expect } from '@playwright/test';

// Helper: Playwright auto-pierces shadow DOM, so we can use regular selectors.
// 0.5.0: the bottom-right control is gone — the dock's arm segment (+/×)
// arms annotate mode; the count chip summons the export sheet.
const CONTROL = 'button.arm';
const CHIP = 'button.chip';
const PIN = 'button.pin';
const TEXTAREA = '[data-pinflow-root] textarea';
const SAVE_BUTTON = '[data-pinflow-root] button.save';

// §11.1 — Script tag enables annotation with no config beyond data-project
test('AC1: script tag auto-inits annotation', async ({ page }) => {
  await page.goto('/?reviewer=Alice');
  await expect(page.locator('[data-pinflow-root]')).toBeAttached();
  await expect(page.locator(CONTROL)).toBeVisible();
});

// §11.2 — Click element, type comment, persists across reload
test('AC2: pin + comment persists across reload', async ({ page }) => {
  await page.goto('/?reviewer=Alice');
  await page.locator(CONTROL).click();
  await page.locator('[data-testid="primary-cta"]').click({ force: true });
  await page.locator(TEXTAREA).fill('Needs more contrast');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  await page.goto('/?reviewer=Alice');
  await page.waitForTimeout(500);
  await expect(page.locator(PIN)).toHaveCount(1);
});

// §11.3 — Comments persist across SPA route changes
test('AC3: comments persist across SPA routes', async ({ page }) => {
  await page.goto('/?reviewer=Bob');
  await page.locator(CONTROL).click();
  await page.locator('h1').click({ force: true });
  await page.locator(TEXTAREA).fill('Fix heading');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  // Navigate to /pricing
  await page.locator('a[href="/pricing"]').click();
  await page.waitForTimeout(300);
  await expect(page.locator(PIN)).toHaveCount(0);

  // Back to home
  await page.locator('a[href="/"]').click();
  await page.waitForTimeout(300);
  await expect(page.locator(PIN)).toHaveCount(1);
});

// §11.4 — Second reviewer sees only their own comments
test('AC4: reviewer isolation', async ({ page }) => {
  await page.goto('/?reviewer=Alice');
  await page.locator(CONTROL).click();
  await page.locator('h1').click({ force: true });
  await page.locator(TEXTAREA).fill('Alice comment');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  await page.goto('/?reviewer=Bob');
  await page.waitForTimeout(500);
  await expect(page.locator(PIN)).toHaveCount(0);
});

// §11.5 — Reviewer export downloads on desktop and shares on mobile
test('AC5: reviewer export', async ({ page }) => {
  await page.goto('/?reviewer=Eve');
  await page.locator(CONTROL).click();
  await page.locator('[data-testid="primary-cta"]').click({ force: true });
  await page.locator(TEXTAREA).fill('Export test comment');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  await page.locator(CHIP).click();
  const artifact = await exportFeedback(page);
  expect(artifact.filename).toMatch(/^pinflow-feedback-Eve-e2e-test-.+\.md$/);
});

// §11.6 — Builder mode shows all reviewers' comments
test('AC6: builder mode aggregates', async ({ page }) => {
  // Alice
  await page.goto('/?reviewer=Alice');
  await page.locator(CONTROL).click();
  await page.locator('h1').click({ force: true });
  await page.locator(TEXTAREA).fill('Alice says hi');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  // Bob
  await page.goto('/?reviewer=Bob');
  await page.locator(CONTROL).click();
  await page.locator('[data-testid="primary-cta"]').click({ force: true });
  await page.locator(TEXTAREA).fill('Bob says hi');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  // Builder. Since 0.9.0 this mode renders no chrome of its own — the aggregate
  // IS the artifact, so that is what the acceptance criterion checks. The old
  // form asserted two pins on the page, which measured the drawer rather than
  // the guarantee.
  await page.goto('/?mode=builder');
  await page.waitForTimeout(500);
  await expect(page.locator(PIN)).toHaveCount(0);

  const md = await page.evaluate(() => {
    const P = (
      window as unknown as { Pinflow: { init: (c: unknown) => { exportMarkdown(): string } } }
    ).Pinflow;
    return P.init({ project: 'e2e-test', mode: 'builder' }).exportMarkdown();
  });
  expect(md).toContain('Alice says hi');
  expect(md).toContain('Bob says hi');
});

// §11.8 — Markdown is agent-readable
test('AC8: export markdown has selector candidates and element context', async ({ page }) => {
  await page.goto('/?reviewer=Zara');
  await page.locator(CONTROL).click();
  await page.locator('[data-testid="primary-cta"]').click({ force: true });
  await page.locator(TEXTAREA).fill('Check this');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  await page.locator(CHIP).click();
  const { content: md } = await exportFeedback(page);

  expect(md).toContain('# Feedback for e2e-test — from Zara');
  expect(md).toContain('**Selector candidates:**');
  expect(md).toContain('testid: `primary-cta`');
  expect(md).toContain('> Check this');
});

// §11.9 — Pins stay anchored on resize
test('AC9: pins anchored after resize', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/?reviewer=Resize');
  await page.locator(CONTROL).click();
  await page.locator('[data-testid="primary-cta"]').click({ force: true });
  await page.locator(TEXTAREA).fill('resize me');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  const pin = page.locator(PIN);
  await expect(pin).toBeVisible();

  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(500);
  await expect(pin).toBeVisible();
});

// §11.11 — Bundle loads without error
test('AC11: IIFE bundle loads without error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?reviewer=BundleTest');
  expect(errors).toHaveLength(0);
  const hasPinflow = await page.evaluate(
    () => !!(window as unknown as Record<string, unknown>).Pinflow,
  );
  expect(hasPinflow).toBe(true);
});

// 0.5.0 — Drag-to-marquee places an area comment; export carries the region
test('AC12: marquee drag creates an area comment with an Area export line', async ({ page }) => {
  await page.goto('/?reviewer=Marq');
  await page.locator(CONTROL).click();

  const cta = page.locator('[data-testid="primary-cta"]');
  const box = (await cta.boundingBox())!;
  await page.mouse.move(box.x - 20, box.y - 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 20, box.y + box.height + 20, { steps: 4 });
  await page.mouse.up();

  await page.locator(TEXTAREA).fill('This whole area');
  await page.locator(SAVE_BUTTON).click();
  await page.waitForTimeout(300);

  await page.locator(CHIP).click();
  const { content: md } = await exportFeedback(page);
  expect(md).toContain('**Area:**');
  expect(md).toContain('> This whole area');

  // The placed region leaves its marching-ants footprint on the page.
  await expect(page.locator('[data-pinflow-root] .area')).toBeVisible();
});

// 0.5.0 — the stealth grammar: Alt+drag draws an area with no arming at all
test('AC13: Alt+drag without arming places an area comment', async ({ page }) => {
  await page.goto('/?reviewer=AltDrag');
  const cta = page.locator('[data-testid="primary-cta"]');
  const box = (await cta.boundingBox())!;
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x - 15, box.y - 15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 15, box.y + box.height + 15, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator(TEXTAREA)).toBeVisible(); // draft opened for the area
});

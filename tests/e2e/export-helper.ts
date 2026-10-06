import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Capture the native API boundary: headless browsers cannot operate OS share sheets.
export async function exportFeedback(page: Page): Promise<{ filename: string; content: string }> {
  const mobile = await page.evaluate(() => matchMedia('(any-pointer:coarse)').matches);
  if (!mobile) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export & share', exact: true }).click(),
    ]);
    return {
      filename: download.suggestedFilename(),
      content: await readFile((await download.path())!, 'utf8'),
    };
  }
  await page.evaluate(() => {
    Object.defineProperties(navigator, {
      canShare: { configurable: true, value: () => true },
      share: {
        configurable: true,
        value: async (data: ShareData) => {
          const active = navigator.userActivation.isActive;
          const file = data.files![0]!;
          (window as unknown as { sharedFeedback: object }).sharedFeedback = {
            filename: file.name,
            content: await file.text(),
            active,
          };
        },
      },
    });
  });
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: 'Export & share', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as unknown as { sharedFeedback: object }).sharedFeedback),
      ),
    )
    .toBe(true);
  const result = await page.evaluate(
    () =>
      (
        window as unknown as {
          sharedFeedback: { filename: string; content: string; active: boolean };
        }
      ).sharedFeedback,
  );
  expect(result.active).toBe(true);
  expect(downloads).toEqual([]);
  await expect(page.getByRole('button', { name: 'Share feedback', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download Feedback Markdown' })).toHaveCount(0);
  return result;
}

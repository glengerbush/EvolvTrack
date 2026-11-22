import { expect, test } from '@playwright/test';

test('reopening shows the latest recorded data instead of an empty future range', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app#health');
  const graph = page.getByRole('button', { name: 'Interactive health trends graph' });
  await expect(graph).toBeVisible();
  await page.evaluate(async () => {
    const storagePath = '/src/lib/domain/health-data-storage.ts';
    const datesPath = '/src/lib/utils/dateKeys.ts';
    const { addEntry } = await import(storagePath);
    const { addDays, localDateKey } = await import(datesPath);
    const today = localDateKey();
    await addEntry({ date: addDays(today, -28), weightLbs: 190 });
    await addEntry({ date: today, weightLbs: 180, wellness: 7 });
    await addEntry({ date: addDays(today, 28), notes: 'Future reminder' });
  });
  await expect(graph.locator('.weight-point')).toHaveCount(2);
  await page.reload();

  await expect(graph.locator('.weight-point')).toHaveCount(2);
  await expect.poll(async () => graph.evaluate((el) => {
    const latest = el.querySelectorAll('.weight-point')[1].getBoundingClientRect();
    const viewport = el.getBoundingClientRect();
    return latest.left >= viewport.left && latest.right <= viewport.right;
  })).toBe(true);
});

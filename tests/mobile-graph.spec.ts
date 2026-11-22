import { expect, test } from '@playwright/test';

test('reopening keeps the latest data visible with two forecast weeks after a distant planned dose', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app#health');
  const graph = page.getByRole('button', { name: 'Interactive health trends graph' });
  await expect(graph).toBeVisible({ timeout: 15000 });
  const forecastEnd = await page.evaluate(async () => {
    const storagePath = '/src/lib/domain/health-data-storage.ts';
    const datesPath = '/src/lib/utils/dateKeys.ts';
    const { addEntry } = await import(storagePath);
    const { addDays, localDateKey, formatLocaleDate } = await import(datesPath);
    const today = localDateKey();
    await addEntry({ date: addDays(today, -28), weightLbs: 190 });
    await addEntry({ date: today, weightLbs: 180, wellness: 7 });
    await addEntry({ date: addDays(today, 60), amountMg: 5, medication: 'Semaglutide (Ozempic / Wegovy)', planned: true });
    await addEntry({ date: addDays(today, 28), notes: 'Future reminder' });
    return formatLocaleDate(addDays(today, 74));
  });
  await expect(graph.locator('.weight-point')).toHaveCount(2, { timeout: 15000 });
  await page.reload();

  await expect(graph.locator('.weight-point')).toHaveCount(2, { timeout: 15000 });
  await expect.poll(async () => graph.evaluate((el) => {
    const latest = el.querySelectorAll('.weight-point')[1].getBoundingClientRect();
    const viewport = el.getBoundingClientRect();
    return latest.left >= viewport.left && latest.right <= viewport.right;
  })).toBe(true);
  // Startup is still at recorded data; the forecast is available by scrolling.
  await expect.poll(async () => graph.evaluate(el => el.scrollWidth - el.clientWidth - el.scrollLeft)).toBeGreaterThan(100);
  await graph.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.locator('.visible-range')).toContainText(forecastEnd);
  await expect.poll(async () => graph.evaluate(el => {
    const forecast = el.querySelector('.system-line.forecast')!.getBoundingClientRect();
    const viewport = el.getBoundingClientRect();
    return forecast.right > viewport.left && forecast.right <= viewport.right;
  })).toBe(true);
});

test('the plot fills its scrollable width and keeps the final dose label inside', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app#health');
  const graph = page.getByRole('button', { name: 'Interactive health trends graph' });
  await expect(graph).toBeVisible({ timeout: 15000 });
  await page.evaluate(async () => {
    const storagePath = '/src/lib/domain/health-data-storage.ts';
    const datesPath = '/src/lib/utils/dateKeys.ts';
    const { addEntry } = await import(storagePath);
    const { addDays, localDateKey } = await import(datesPath);
    const today = localDateKey();
    await addEntry({ date: addDays(today, -112), weightLbs: 180, amountMg: 5, medication: 'Tirzepatide (Mounjaro / Zepbound)' });
    await addEntry({ date: today, weightLbs: 128, amountMg: 10, medication: 'Tirzepatide (Mounjaro / Zepbound)' });
  });
  await expect(graph.locator('.weight-point')).toHaveCount(2, { timeout: 15000 });
  await page.reload();
  await expect(graph.locator('.weight-point')).toHaveCount(2, { timeout: 15000 });
  const geometry = await graph.evaluate(el => {
    const plot = el.querySelector('.plot-bg')!.getBoundingClientRect();
    const svg = el.querySelector('.data-svg')!.getBoundingClientRect();
    const label = [...el.querySelectorAll('.dose-change text')].at(-1)!.getBoundingClientRect();
    return { plotWidth: plot.width, svgWidth: svg.width, labelRight: label.right, plotRight: plot.right };
  });
  expect(geometry.plotWidth).toBeCloseTo(geometry.svgWidth, 0);
  expect(geometry.labelRight).toBeLessThanOrEqual(geometry.plotRight);
  await expect.poll(async () => graph.evaluate(el => {
    const latest = [...el.querySelectorAll('.weight-point')].at(-1)!.getBoundingClientRect();
    const viewport = el.getBoundingClientRect();
    return latest.left >= viewport.left && latest.right <= viewport.right;
  })).toBe(true);

  // Geometry must stay consistent at every zoom, including after a resize.
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const preset of ['4W', '12W', 'All', '1W']) {
      await page.getByRole('button', { name: preset, exact: true }).click();
      await graph.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      await expect.poll(async () => graph.evaluate(el => {
        const plot = el.querySelector('.plot-bg')!.getBoundingClientRect();
        const svg = el.querySelector('.data-svg')!.getBoundingClientRect();
        const forecast = el.querySelector('.system-line.forecast')!.getBoundingClientRect();
        const label = [...el.querySelectorAll('.dose-change text')].at(-1)!.getBoundingClientRect();
        const viewport = el.getBoundingClientRect();
        return {
          widthMatches: Math.abs(plot.width - svg.width) < 1,
          forecastVisible: forecast.right > viewport.left && forecast.right <= viewport.right,
          labelInside: label.left >= plot.left && label.right <= plot.right,
        };
      }), { message: `${width}px / ${preset}` }).toEqual({ widthMatches: true, forecastVisible: true, labelInside: true });
    }
  }
});

import { expect, test } from '@playwright/test';

test('mobile summaries identify dose status and keep editing and confirmation working', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app#health');
  await expect(page.getByRole('button', { name: 'Interactive health trends graph' })).toBeVisible();
  const dates = await page.evaluate(async () => {
    const storagePath = '/src/lib/domain/health-data-storage.ts';
    const datesPath = '/src/lib/utils/dateKeys.ts';
    const { addEntry } = await import(storagePath);
    const { addDays, localDateKey } = await import(datesPath);
    const today = localDateKey();
    const dates = {
      taken: addDays(today, -2), weight: addDays(today, -1), planned: today,
      future: addDays(today, 7), skipped: addDays(today, -3), zero: addDays(today, -4),
      unknownMedication: addDays(today, -5),
    };
    const medication = 'Semaglutide (Ozempic / Wegovy)';
    await addEntry({ date: dates.taken, amountMg: 2.5, medication });
    await addEntry({ date: dates.weight, weightLbs: 180 });
    await addEntry({ date: dates.planned, amountMg: 2.5, medication, planned: true });
    await addEntry({ date: dates.future, amountMg: 5, medication });
    await addEntry({ date: dates.skipped, amountMg: 2.5, medication, skipped: true });
    await addEntry({ date: dates.zero, amountMg: 0, weightLbs: 181 });
    await addEntry({ date: dates.unknownMedication, amountMg: 2.5 });
    return dates;
  });
  const card = (date: string) => page.locator('.inputs-table tbody tr').filter({
    has: page.getByRole('button', { name: `Edit entry for ${date}`, exact: true }),
  });

  await expect(card(dates.taken).locator('.dose-summary')).toContainText('Dose taken');
  await expect(card(dates.taken).locator('.dose-summary')).toContainText('2.5 mg');
  await expect(card(dates.taken).locator('.dose-summary')).toContainText('Semaglutide');
  await expect(card(dates.planned).locator('.dose-summary')).toContainText('Planned dose');
  await expect(card(dates.future).locator('.dose-summary')).toContainText('Planned dose');
  await expect(card(dates.skipped).locator('.dose-summary')).toContainText('Skipped dose');
  await expect(card(dates.skipped).locator('td.dose')).toHaveCSS('text-decoration-line', 'none');
  await expect(card(dates.weight).locator('.dose-summary')).toHaveCount(0);
  await expect(card(dates.weight).locator('td.system')).not.toBeEmpty();
  await expect(card(dates.zero).locator('.dose-summary')).toHaveCount(0);
  await expect(card(dates.unknownMedication).locator('.dose-summary')).toContainText('Medication not set');

  const placement = await card(dates.taken).evaluate(el => ({
    dateBottom: el.querySelector('td.date')!.getBoundingClientRect().bottom,
    summaryTop: el.querySelector('td.dose')!.getBoundingClientRect().top,
    summaryBottom: el.querySelector('td.dose')!.getBoundingClientRect().bottom,
    weekTop: el.querySelector('td.week')!.getBoundingClientRect().top,
  }));
  expect(placement.summaryTop).toBeGreaterThanOrEqual(placement.dateBottom);
  expect(placement.weekTop).toBeGreaterThanOrEqual(placement.summaryBottom);

  await card(dates.planned).getByRole('button', { name: /Planned dose due/ }).click();
  await page.getByRole('group', { name: 'Confirm planned dose' }).getByRole('button', { name: 'Taken', exact: true }).click();
  await expect(card(dates.planned).locator('.dose-summary')).toContainText('Dose taken');

  await card(dates.future).getByRole('button', { name: /Edit entry/ }).click();
  const editor = page.locator('tr.mobile-card-editing');
  await expect(editor.locator('.dose-summary')).toHaveCount(0);
  await editor.locator('input.dose-input').fill('7.5');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card(dates.future).locator('.dose-summary')).toContainText('7.5 mg');

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(card(dates.future).locator('.dose-summary')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('.dose-summary')).toHaveCount(0);
  await expect(page.locator('td.dose .dose-number').first()).toBeVisible();
  expect(errors).toEqual([]);
});

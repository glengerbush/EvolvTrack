import { expect, test, type Page } from '@playwright/test';

function watchPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

for (const field of ['notes', 'weight']) {
  test(`mobile delete removes a dose with unsaved ${field} without reopening`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const pageErrors = watchPageErrors(page);
    await page.goto('/demo');
    await expect(page).toHaveURL(/\/app#health$/, { timeout: 15_000 });

    const editButton = page.getByRole('button', { name: /Edit entry for/ }).first();
    const editLabel = (await editButton.getAttribute('aria-label'))!;
    const date = editLabel.replace('Edit entry for ', '');
    await editButton.click();
    const card = page.locator('tr.mobile-card-editing');
    await card.locator(field === 'notes' ? 'textarea.notes-input' : 'td.weight input').fill(
      field === 'notes' ? 'Unsaved edit before deletion' : '180',
    );
    await card.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this row?' });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // The database delete succeeding alone isn't enough: the card must vanish too.
    expect(await page.evaluate(async (date) => {
      const modulePath = '/src/lib/domain/health-data-storage.ts';
      const { getAllEntries } = await import(modulePath);
      return (await getAllEntries()).some((entry: { date: string }) => entry.date === date);
    }, date)).toBe(false);
    await expect(page.getByRole('button', { name: editLabel, exact: true })).toHaveCount(0);

    // Deleting must also discard its edit buffers so later store updates render.
    const nextLabel = (await page.getByRole('button', { name: /Edit entry for/ }).first()
      .getAttribute('aria-label'))!;
    await page.evaluate(async (date) => {
      const modulePath = '/src/lib/domain/health-data-storage.ts';
      const { getAllEntries, updateEntry } = await import(modulePath);
      const entry = (await getAllEntries()).find((entry: { date: string }) => entry.date === date);
      await updateEntry(entry.id, { notes: 'Updated after deletion' });
    }, nextLabel.replace('Edit entry for ', ''));
    await expect(page.getByText('Updated after deletion', { exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

test('mobile row delete reports a blocked write and can be retried', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pageErrors = watchPageErrors(page);
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/app#health$/, { timeout: 15_000 });

  const editButton = page.getByRole('button', { name: /Edit entry for/ }).first();
  const editLabel = await editButton.getAttribute('aria-label');
  expect(editLabel).toBeTruthy();
  await editButton.click();
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Delete this row?' });
  await page.evaluate(async () => {
    const modulePath = '/src/lib/domain/health-data-storage.ts';
    const { setLocalProfileSyncState } = await import(modulePath);
    await setLocalProfileSyncState({ syncMode: 'migrating_to_e2ee' });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('encryption change is in progress');
  expect(pageErrors).toEqual([]);

  await page.evaluate(async () => {
    const modulePath = '/src/lib/domain/health-data-storage.ts';
    const { setLocalProfileSyncState } = await import(modulePath);
    await setLocalProfileSyncState({ syncMode: 'plain' });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: editLabel!, exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

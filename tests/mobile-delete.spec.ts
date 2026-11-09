import { expect, test, type Page } from '@playwright/test';

function watchPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
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

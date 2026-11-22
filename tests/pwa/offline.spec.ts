import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Native IndexedDB inspection also works in the compiled PWA, without exposing
// development imports or replacing any application storage code.
async function storedRows(page: Page, table: string) {
  return page.evaluate((table) => new Promise<Record<string, any>[]>((resolve, reject) => {
    const request = indexedDB.open('evolvtrack');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(table);
      const rows = tx.objectStore(table).getAll();
      tx.oncomplete = () => { db.close(); resolve(rows.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), table);
}

test('offline edits and deletion survive a full PWA restart and reconnect', async ({ baseURL }) => {
  test.setTimeout(90000);
  const profile = await mkdtemp(join(tmpdir(), 'evolvtrack-pwa-'));
  const options = {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/usr/bin/chromium',
    viewport: { width: 390, height: 844 },
  };
  let context = await chromium.launchPersistentContext(profile, options);
  const pageErrors: string[] = [];
  const watchErrors = (page: Page) => page.on('pageerror', error => pageErrors.push(error.message));
  try {
    let page = context.pages()[0];
    watchErrors(page);
    await page.goto(`${baseURL}/app#health`);
    await expect(page.getByRole('button', { name: 'Add input row' })).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    });
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Add input row' })).toBeVisible();
    await page.getByRole('button', { name: 'Add input row' }).click();
    let card = page.locator('tr.mobile-card-editing');
    await card.locator('td.wellness input').fill('7');
    await card.getByRole('button', { name: /Open symptoms.*picker/i }).click();
    await card.getByRole('option', { name: 'Nausea', exact: true }).click();
    await card.locator('textarea.notes-input').fill('Created offline');
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await storedRows(page, 'entries'))[0]?.wellness).toBe(7);
    await page.getByRole('button', { name: /Edit entry for/ }).click();
    await card.locator('td.wellness input').fill('9');
    await card.locator('textarea.notes-input').fill('Edited offline');
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await storedRows(page, 'entries'))[0]?.wellness).toBe(9);
    const entry = (await storedRows(page, 'entries'))[0];
    const pending = (await storedRows(page, 'outbox')).find(row => row.entityId === entry.id);
    expect(pending).toMatchObject({ op: 'upsert', payload: { wellness: 9, symptoms: ['Nausea'], notes: 'Edited offline' } });

    // A new browser process with the same profile, already offline at launch.
    await context.close();
    context = await chromium.launchPersistentContext(profile, { ...options, offline: true });
    page = context.pages()[0];
    watchErrors(page);
    await page.goto(`${baseURL}/auth`); // installed PWA start_url
    await expect(page).toHaveURL(/\/app(?:#health)?$/);
    await expect(page.getByText('Edited offline', { exact: true })).toBeVisible();
    expect((await storedRows(page, 'outbox')).find(row => row.entityId === entry.id)).toEqual(pending);
    await page.getByRole('button', { name: /Edit entry for/ }).click();
    card = page.locator('tr.mobile-card-editing');
    await card.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this row?' });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => storedRows(page, 'entries')).toEqual([]);
    const deleted = (await storedRows(page, 'outbox')).find(row => row.entityId === entry.id);
    expect(deleted).toMatchObject({ op: 'delete', payload: null });
    expect((await storedRows(page, 'deletions')).find(row => row.entityId === entry.id)).toBeDefined();

    await context.close();
    context = await chromium.launchPersistentContext(profile, { ...options, offline: true });
    page = context.pages()[0];
    watchErrors(page);
    await page.goto(`${baseURL}/app#health`);
    await expect(page.getByRole('button', { name: 'Add input row' })).toBeVisible();
    await expect(page.getByText('Edited offline', { exact: true })).toHaveCount(0);
    expect(await storedRows(page, 'entries')).toEqual([]);
    expect((await storedRows(page, 'outbox')).find(row => row.entityId === entry.id)).toEqual(deleted);
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Add input row' })).toBeVisible();
    expect(await storedRows(page, 'entries')).toEqual([]);
    // Signed-out users retain pending work until they sign in to sync.
    expect((await storedRows(page, 'outbox')).find(row => row.entityId === entry.id)).toEqual(deleted);
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

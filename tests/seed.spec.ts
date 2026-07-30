import { expect, test, type Page } from '@playwright/test';

function watchBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location().url;
      errors.push(`console: ${message.text()}${location ? ` (${location})` : ''}`);
    }
  });
  return errors;
}

test('homepage renders its primary content at the card-grid width', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  const response = await page.goto('/');

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Your progress should belong to you.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'What is this?' })).toBeVisible();
  await expect(page.locator('.promise-grid > article')).toHaveCount(5);

  const ledeBox = await page.locator('.section-lede').boundingBox();
  const cardsBox = await page.locator('.promise-grid').boundingBox();
  expect(ledeBox).not.toBeNull();
  expect(cardsBox).not.toBeNull();
  expect(Math.abs(ledeBox!.width - cardsBox!.width)).toBeLessThanOrEqual(1);

  await expect(page.getByText('No no canned replies.')).toHaveCount(0);
  await expect(page.getByText('Sign up for to sync')).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test('auth forms validate locally without sending malformed requests', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto('/auth');
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Log in with password' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Email/username and password are required.',
  );

  await page.getByRole('tab', { name: 'Sign Up' }).click();
  await page.getByLabel('Email or username', { exact: false }).fill('new-user');
  await page.getByLabel('Password', { exact: true }).fill('password-one');
  await page.getByLabel('Confirm password').fill('password-two');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toHaveText('Passwords do not match.');

  await page.getByRole('tab', { name: 'Log In' }).click();
  await page.getByLabel('Email or username', { exact: false }).fill('person@example.com');
  await expect(page.getByRole('button', { name: 'Email magic link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('a pre-hydration login submit never puts credentials in the URL', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto('/auth');
    await page.getByLabel('Email or username', { exact: false }).fill('private-user');
    await page.getByLabel('Password', { exact: true }).fill('private-password');
    await expect(page.getByRole('button', { name: 'Log in with password' })).toBeDisabled();

    const url = new URL(page.url());
    expect(url.pathname).toBe('/auth');
    expect(url.search).toBe('');
    expect(page.url()).not.toContain('private-user');
    expect(page.url()).not.toContain('private-password');
  } finally {
    await context.close();
  }
});

test('a local account can sign up, change password, log back in, and delete itself', async ({
  page,
}, testInfo) => {
  const browserErrors = watchBrowserErrors(page);
  const username = `audit-user-${Date.now()}-${testInfo.workerIndex}`;
  const originalPassword = 'Audit-password-1';
  const newPassword = 'Audit-password-2';

  await page.goto('/register');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email or username', { exact: false }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(originalPassword);
  await page.getByLabel('Confirm password').fill(originalPassword);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/app#health$/, { timeout: 10_000 });

  // The setup wizard is covered elsewhere; reload without its persisted flag
  // so this journey can exercise account Settings directly.
  await page.evaluate(() => localStorage.removeItem('evolvtrack-setup-wizard-pending'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Change login password' }).click();
  await page.getByLabel('Current password').fill(originalPassword);
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Login password updated.')).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/auth$/);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email or username', { exact: false }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Log in with password' }).click();
  await expect(page).toHaveURL(/\/app#health$/, { timeout: 10_000 });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain(`Type "${username}" to confirm.`);
    await dialog.accept(username);
  });
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(browserErrors).toEqual([]);
});

test('offline entry opens the dashboard and tab navigation updates the URL', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const offlineCard = page.locator('article.way').filter({ hasText: 'Fully offline, one device' });
  await offlineCard.getByRole('button', { name: 'Continue offline' }).click();

  await expect(page).toHaveURL(/\/app#health$/);
  await expect(page.getByRole('navigation', { name: 'Dashboard tabs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible();
  await page.getByRole('button', { name: 'Medication', exact: true }).click();
  await expect(page).toHaveURL(/\/app#medication$/);
  await expect(page).toHaveTitle('Medication · EvolvTrack');
  expect(browserErrors).toEqual([]);
});

test('the medication compatibility route redirects to its dashboard tab', async ({ page }) => {
  await page.goto('/app/medication');

  await expect(page).toHaveURL(/\/app#medication$/);
  await expect(page).toHaveTitle('Medication · EvolvTrack');
});

test('demo mode seeds sample data and can be exited cleanly', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto('/demo');

  await expect(page).toHaveURL(/\/app#health$/, { timeout: 15_000 });
  await expect(page.getByText('Demo', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exit demo' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit demo' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your progress should belong to you.' })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('homepage and auth stay within a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const homepageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(homepageOverflow).toBeLessThanOrEqual(1);

  await page.goto('/auth');
  const authOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(authOverflow).toBeLessThanOrEqual(1);
});

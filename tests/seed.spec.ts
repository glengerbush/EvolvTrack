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

test('dark-theme brand text meets WCAG AA contrast', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('evolvtrack-color-mode', 'dark');
  });
  await page.goto('/');

  const ratio = await page.locator('.promise h3').first().evaluate((heading) => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (value: string) => {
      const channels = rgb(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const foreground = luminance(getComputedStyle(heading).color);
    const background = luminance(getComputedStyle(heading.closest('.promise')!).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });

  expect(ratio).toBeGreaterThanOrEqual(4.5);
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
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
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

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
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
  await expect(page.getByRole('tablist', { name: 'Dashboard tabs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible();
  const healthTab = page.getByRole('tab', { name: 'Health', exact: true });
  await expect(healthTab).toHaveAttribute('aria-selected', 'true');
  await healthTab.press('ArrowRight');
  await expect(page).toHaveURL(/\/app#medication$/);
  await expect(page).toHaveTitle('Medication · EvolvTrack');
  await expect(page.getByRole('tab', { name: 'Medication', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Medication' })).toBeVisible();
  await expect(page.locator('.dashboard > [role="tabpanel"]')).toHaveCount(1);
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

  const chart = page.locator('.chart-card');
  await expect(chart.getByRole('heading', { name: 'Health trends' })).toBeVisible();
  await expect(chart.getByLabel('Graph data states')).toContainText(/Recorded\s+Planned\s+Forecast/);
  expect(await chart.locator('.wellness-stack').count()).toBeGreaterThan(1);

  const seriesButton = chart.locator('.series-button');
  await expect(seriesButton).toHaveText('Series');
  await seriesButton.click();
  await expect(seriesButton).toHaveAttribute('aria-expanded', 'true');
  await expect(chart.getByRole('group', { name: 'Measurements' })).toBeVisible();
  await expect(chart.getByRole('group', { name: 'Medication models' })).toBeVisible();
  await chart.getByRole('button', { name: 'Done', exact: true }).click();

  const graph = chart.getByRole('button', { name: 'Interactive health trends graph' });
  await graph.focus();
  await graph.press('Home');
  await expect(chart.locator('#graph-day-summary')).not.toContainText('Focus the graph');
  await graph.press('ArrowRight');
  await expect(chart.locator('#graph-day-summary')).toContainText(/Weight|Dose|Wellness|Symptoms/);
  await chart.getByRole('button', { name: 'Dismiss graph inspection' }).click();
  await expect(chart.getByRole('region', { name: 'Graph inspection' })).toHaveCount(0);
  await expect(chart.locator('#graph-day-summary')).toHaveCount(1);
  await page.reload();
  await expect(chart.getByRole('heading', { name: 'Health trends' })).toBeVisible();
  await expect(chart.getByRole('region', { name: 'Graph inspection' })).toHaveCount(0);

  const inputsTable = page.locator('.inputs-table');
  const weekHeader = inputsTable.getByRole('columnheader', { name: 'Week', exact: true });
  await expect(weekHeader).toBeVisible();
  const weekWidth = await weekHeader.evaluate((header) => header.getBoundingClientRect().width);
  expect(weekWidth).toBeLessThanOrEqual(60);

  const dueControl = inputsTable.getByRole('button', { name: /Planned dose due/ });
  await expect(dueControl).toHaveText('Dose due');
  const dueBox = await dueControl.boundingBox();
  const tableBox = await inputsTable.boundingBox();
  expect(dueBox).not.toBeNull();
  expect(tableBox).not.toBeNull();
  expect(dueBox!.x).toBeGreaterThanOrEqual(tableBox!.x);
  expect(dueBox!.x + dueBox!.width).toBeLessThanOrEqual(tableBox!.x + tableBox!.width);

  const weekContrast = await inputsTable.locator('.week-label .week-rail-label').first().evaluate((label) => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (value: string) => {
      const channels = rgb(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const foreground = luminance(getComputedStyle(label).color);
    const background = luminance(getComputedStyle(label).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(weekContrast).toBeGreaterThanOrEqual(4.5);

  const weekBackgrounds = await inputsTable.locator('tbody').evaluate((body) => ({
    due: getComputedStyle(body.querySelector('.week.week-has-due')!).backgroundColor,
    regular: getComputedStyle(body.querySelector('.week:not(.week-has-due)')!).backgroundColor,
  }));
  expect(weekBackgrounds.due).toBe(weekBackgrounds.regular);

  await dueControl.click();
  await expect(page.getByRole('group', { name: 'Confirm planned dose' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Taken', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.week.week-has-due')).toBeVisible();
  const rangeButtonHeights = await chart.locator('.x-range-btn').evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(rangeButtonHeights.every((height) => height >= 44)).toBe(true);
  expect((await graph.boundingBox())!.height).toBeLessThanOrEqual(342);
  const dashboardOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(dashboardOverflow).toBeLessThanOrEqual(1);

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

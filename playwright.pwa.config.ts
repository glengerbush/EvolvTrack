import { defineConfig } from '@playwright/test';
import config from './playwright.config';

// Run after `npm run build`: the development server has no service worker.
const port = process.env.PLAYWRIGHT_PORT ?? '4182';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...config,
  testDir: 'tests/pwa',
  testIgnore: [],
  projects: config.projects?.filter(project => project.name === 'chromium'),
  use: { ...config.use, baseURL },
  webServer: {
    command: `node tests/pwa/server.mjs ${port}`,
    url: baseURL,
    reuseExistingServer: false,
  },
});

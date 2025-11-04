import { test, expect } from '@playwright/test';

test('Landing Page', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.screenshot({ path: 'landing-page.png', fullPage: true });
});

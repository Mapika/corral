// The phone loop, end to end against the demo herd: glance (herd renders, decision card up),
// decide (Allow really resolves), ranch (launch sheet opens), watch (fleet feed streams).
import { test, expect } from '@playwright/test';

test('phone loop: herd → decision → launch sheet → fleet', async ({ page }) => {
  await page.goto('/');

  // Herd renders with the decision card on top.
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByText('corral release')).toBeVisible();
  await expect(page.getByText('Claude wants to use')).toBeVisible();

  // Allow resolves it — the ask leaves the herd.
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Claude wants to use')).toBeHidden();

  // The launch sheet opens with the ranch form.
  await page.getByRole('button', { name: 'Ranch a new agent' }).click();
  await expect(page.getByRole('heading', { name: 'Where' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'First instruction' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // The fleet feed shows live tiles and streams agent output into them.
  await page.getByRole('button', { name: 'Fleet' }).click();
  await expect(page.getByText('market feed')).toBeVisible();
  await expect(page.getByText('corral release')).toBeVisible();
  await expect(page.getByText(/queue|drain|replay/).first()).toBeVisible({ timeout: 20_000 });
});

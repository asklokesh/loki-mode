import { expect, test } from '@playwright/test';

for (const savedModel of ['', 'openrouter/minimax/minimax-m2.1', 'custom/model']) {
  test(`provider model choices preserve ${savedModel || 'fresh defaults'}`, async ({ page }) => {
    await page.addInitScript((model) => {
      localStorage.setItem('pl_settings_providerModels', JSON.stringify(model ? { opencode: model } : {}));
    }, savedModel);
    await page.route('**/api/status', route => route.fulfill({ json: { version: 'test' } }));
    await page.goto('/lab/tests/fixtures/settings-harness.html');
    await page.getByRole('button', { name: 'Providers', exact: true }).click();
    const select = page.getByRole('combobox', { name: 'Model', exact: true }).last();
    await expect(select).toHaveValue(savedModel || 'openrouter/deepseek/deepseek-v3.2');
    const options = await select.locator('option').allTextContents();
    expect(options).toContain('openrouter/minimax/minimax-m3.1-flash:free');
    expect(options).toContain('openrouter/minimax/minimax-m3');
    expect(options.filter(value => value.includes('minimax-m2.1'))).toEqual(
      savedModel.includes('minimax-m2.1') ? [`${savedModel} (saved)`] : [],
    );
    if (savedModel) {
      expect(options).toContain(`${savedModel} (saved)`);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pl_settings_providerModels') || '{}').opencode)).toBe(savedModel);
    }
    await select.selectOption('openrouter/minimax/minimax-m3.1-flash:free');
    await expect(select).toHaveValue('openrouter/minimax/minimax-m3.1-flash:free');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pl_settings_providerModels') || '{}').opencode))
      .toBe('openrouter/minimax/minimax-m3.1-flash:free');
  });
}

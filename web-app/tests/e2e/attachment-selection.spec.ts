import { expect, test, type Page } from '@playwright/test';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function openHarness(page: Page) {
  await page.addInitScript(() => {
    const events: string[] = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    Object.defineProperty(window, '__previewUrlEvents', { value: events });
    URL.createObjectURL = blob => {
      const url = createObjectURL(blob);
      events.push(`create:${url}`);
      return url;
    };
    URL.revokeObjectURL = url => {
      events.push(`revoke:${url}`);
      revokeObjectURL(url);
    };
  });
  await page.goto('/lab/tests/fixtures/attachment-harness.html');
}

async function previewUrlEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __previewUrlEvents: string[] }).__previewUrlEvents);
}

function expectReleasedOnce(events: string[], pairOffset = 0) {
  const created = events[pairOffset];
  const revoked = events[pairOffset + 1];
  expect(created).toMatch(/^create:blob:/);
  expect(revoked).toBe(created.replace(/^create:/, 'revoke:'));
}

test.describe('chat attachment selection', () => {
  test('names the file, exposes type and size, and removes it by keyboard', async ({ page }) => {
    await openHarness(page);

    const attach = page.getByRole('button', { name: 'Attach image' });
    await expect(attach).toHaveAccessibleDescription(/PNG, JPEG, GIF, or WebP image up to 10 MiB/);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'reference.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(1024),
    });

    const selected = page.getByRole('group', { name: 'Selected attachment' });
    await expect(selected).toContainText('reference.png');
    await expect(selected).toContainText('image/png · 1.0 KiB');
    const remove = page.getByRole('button', { name: 'Remove reference.png' });
    await remove.focus();
    await page.keyboard.press('Enter');

    await expect(selected).toHaveCount(0);
    await expect(attach).toBeFocused();
    const events = await previewUrlEvents(page);
    expect(events).toHaveLength(2);
    expectReleasedOnce(events);
  });

  test('replaces instead of duplicating and releases each preview once', async ({ page }) => {
    await openHarness(page);
    const fileInput = page.locator('input[type="file"]');

    await fileInput.setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: Buffer.alloc(8) });
    await fileInput.setInputFiles({ name: 'second.webp', mimeType: 'image/webp', buffer: Buffer.alloc(16) });

    const selected = page.getByRole('group', { name: 'Selected attachment' });
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText('second.webp');
    await expect(selected).not.toContainText('first.png');
    await page.getByRole('button', { name: 'Remove second.webp' }).click();
    const events = await previewUrlEvents(page);
    expect(events).toHaveLength(4);
    expectReleasedOnce(events);
    expectReleasedOnce(events, 2);
  });

  test('small image and text submissions keep working and clear the composer preview', async ({ page }) => {
    const sentMessages: string[] = [];
    await page.route('**/lab/api/sessions/attachment-test/chat/image', route =>
      route.fulfill({ json: { image_id: 'img-1', filename: 'small.png' } }),
    );
    await page.route('**/lab/api/sessions/attachment-test/chat', async route => {
      sentMessages.push((await route.request().postDataJSON()).message);
      await route.fulfill({ json: { task_id: `task-${sentMessages.length}`, status: 'started' } });
    });
    await page.route('**/lab/api/sessions/attachment-test/chat/*/stream', route =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: complete\ndata: {"returncode":0,"files_changed":[]}\n\n',
      }),
    );
    await openHarness(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'small.png',
      mimeType: 'image/png',
      buffer: ONE_PIXEL_PNG,
    });
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(page.getByRole('group', { name: 'Selected attachment' })).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'small.png' })).toBeVisible();
    const events = await previewUrlEvents(page);
    expect(events).toHaveLength(2);
    expectReleasedOnce(events);
    expect(sentMessages[0]).toContain('[Attached image: small.png (id: img-1)]');

    const input = page.locator('textarea[placeholder*="Ask AI"]');
    await input.fill('Keep text-only behavior');
    await page.getByRole('button', { name: 'Send message' }).click();
    expect(sentMessages[1]).toBe('Keep text-only behavior');
  });

  test('cancelling an image-backed send does not release its preview twice', async ({ page }) => {
    let cancelRequests = 0;
    await page.route('**/lab/api/sessions/attachment-test/chat/image', route =>
      route.fulfill({ json: { image_id: 'img-cancel', filename: 'cancel.png' } }),
    );
    await page.route('**/lab/api/sessions/attachment-test/chat', route =>
      route.fulfill({ json: { task_id: 'task-cancel', status: 'started' } }),
    );
    await page.route('**/lab/api/sessions/attachment-test/chat/task-cancel/stream', () => {
      // Leave the SSE request open until the user cancels it.
    });
    await page.route('**/lab/api/sessions/attachment-test/chat/task-cancel/cancel', route => {
      cancelRequests += 1;
      return route.fulfill({ json: { cancelled: true } });
    });
    await openHarness(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'cancel.png',
      mimeType: 'image/png',
      buffer: ONE_PIXEL_PNG,
    });
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();

    await expect(page.getByText('[cancelled]')).toBeVisible();
    expect(cancelRequests).toBe(1);
    const events = await previewUrlEvents(page);
    expect(events).toHaveLength(2);
    expectReleasedOnce(events);
  });
});

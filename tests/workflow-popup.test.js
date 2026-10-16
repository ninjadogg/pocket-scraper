import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

test('popup configures, reorders, saves, and reloads a workflow', async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.SCRAPER_BROWSER_PATH ? { executablePath: process.env.SCRAPER_BROWSER_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.chrome = {
        storage: { local: {
          async get() { return { draft: JSON.parse(localStorage.getItem('draft') || 'null') || {
            name: 'Popup test', url: 'https://example.org', fields: [{ name: 'title', selector: 'h1', kind: 'text' }], actions: []
          } }; },
          async set({ draft }) { localStorage.setItem('draft', JSON.stringify(draft)); }
        } },
        tabs: { async query() { return [{ id: 1, url: 'https://example.org' }]; } }
      };
    });
    let saved;
    await page.route('http://127.0.0.1:3888/api/recipes', async route => {
      if (route.request().method() === 'POST') saved = { ...route.request().postDataJSON(), id: 'saved-workflow' };
      await route.fulfill({ json: route.request().method() === 'POST' ? saved : saved ? [saved] : [] });
    });
    await page.route('http://127.0.0.1:3888/extension/**', route => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      route.fulfill({ body: readFileSync(new URL('../extension/' + name, import.meta.url)), contentType: name.endsWith('.html') ? 'text/html' : 'text/javascript' });
    });
    await page.goto('http://127.0.0.1:3888/extension/popup.html');
    await page.locator('#name').waitFor();
    await page.waitForFunction(() => document.querySelector('#name').value === 'Popup test');
    await page.locator('#workflow').selectOption('steps');
    await page.locator('#addWait').click();
    await page.locator('#steps .item').nth(1).getByRole('button', { name: 'Move up' }).click();
    await page.locator('#steps input[type=number]').fill('250');
    await page.locator('#repeatCount').fill('3');
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.startsWith('Saved.'));
    assert.deepEqual(saved.steps, [{ type: 'wait', waitMs: 250 }, { type: 'extract' }]);
    assert.equal(saved.repeatCount, 3);
    assert.equal(await page.locator('#pickNext').isDisabled(), true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#workflow').value === 'steps');
    assert.equal(await page.locator('#steps .item').count(), 2);
    assert.equal(await page.locator('#repeatCount').inputValue(), '3');
  } finally { await browser.close(); }
});

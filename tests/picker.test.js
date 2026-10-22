import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserOptions } from '../browser-session.js';
import { installPicker } from '../extension/picker.js';

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixture.html'), 'utf8');

test('Visual picker builds a reusable selector from a clicked element', async () => {
  const browser = await chromium.launch({
    headless: true,
    ...browserOptions()
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    // Simulate the Chrome extension message bus on a fixture page.
    await page.evaluate(() => { window.chrome ||= {}; window.chrome.runtime = { sendMessage: message => { window.lastPick = message; } }; });
    await page.evaluate(({ func }) => {
      const injected = new Function(`return (${func})`)();
      injected('field', 'title', 'text');
    }, { func: installPicker.toString() });
    await page.locator('a.job').first().click();
    const pick = await page.evaluate(() => window.lastPick);
    assert.equal(pick.mode, 'field');
    assert.equal(pick.fieldName, 'title');
    assert.equal(pick.matches, 2);
    assert.match(pick.selector, /a.*job/);
    await page.evaluate(({ func }) => new Function(`return (${func})`)()('row', '', 'text'), { func: installPicker.toString() });
    await page.locator('li').first().click();
    const row = await page.evaluate(() => window.lastPick);
    assert.equal(row.mode, 'row'); assert.equal(row.selector, 'li'); assert.equal(row.matches, 2);
    await page.evaluate(({ func }) => new Function(`return (${func})`)()('field', 'location', 'text', 'li'), { func: installPicker.toString() });
    await page.locator('.location').nth(1).click();
    const scoped = await page.evaluate(() => window.lastPick);
    assert.equal(scoped.selector, 'span.location'); assert.equal(scoped.matches, 1);

  } finally { await browser.close(); }
});

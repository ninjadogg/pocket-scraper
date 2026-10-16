import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { acquireSession, sessionStatus, sessionKey } from '../browser-session.js';
import { scrape } from '../runner.js';
import { normalizeRecipe } from '../store.js';

test('saved session survives browser restarts and supports unattended extraction; origin locks prevent overlap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-session-'));
  const server = createServer((req, res) => {
    if (req.headers['user-agent']?.includes('HeadlessChrome') || !req.headers.cookie?.includes('login=verified')) { res.writeHead(403); res.end('Sign in'); return; }
    res.end('<h1>Private release notes</h1><script>document.querySelector("h1").textContent += localStorage.getItem("suffix") || ""</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const recipe = normalizeRecipe({ name: 'Session', url, useBrowserSession: true, fields: [{ name: 'title', selector: 'h1' }] });
  let context;
  try {
    await assert.rejects(scrape(recipe, { sessionOptions: { profileRoot: dir } }), e => e.code === 'SESSION_ATTENTION');
    context = await acquireSession(recipe, { profileRoot: dir });
    assert.equal(sessionStatus(recipe).busy, true);
    await assert.rejects(acquireSession({ ...recipe, url: url + '/other' }, { profileRoot: dir }), e => e.code === 'SESSION_BUSY');
    // A session cookie (no expiry) must survive a clean browser restart too.
    await context.addCookies([{ name: 'login', value: 'verified', url }]);
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => localStorage.setItem('suffix', ' saved'));
    await context.close(); context = null;
    assert.equal(sessionStatus(recipe).busy, false);
    for (let i = 0; i < 2; i++) {
      const output = await scrape(recipe, { sessionOptions: { profileRoot: dir } });
      assert.equal(output.rows[0].fields.title, 'Private release notes saved');
    }
    assert.notEqual(sessionKey(recipe), sessionKey({ ...recipe, url: 'https://example.org' }));
    assert.equal(normalizeRecipe({ ...recipe, useBrowserSession: undefined }, recipe).useBrowserSession, true);
    assert.equal(normalizeRecipe({ ...recipe, url: 'https://example.org', useBrowserSession: undefined }, recipe).useBrowserSession, false);
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

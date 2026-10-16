import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { acquireSession } from '../browser-session.js';

test('session failures pause schedules; a saved session works after service restart and on the scheduler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-session-api-'));
  let child;
  let base;
  let context;
  let visits = 0;
  const source = createServer((req, res) => {
    visits++;
    if (!req.headers.cookie?.includes('verified=yes')) { res.writeHead(403); res.end('Forbidden'); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Release notes</h1>'); }
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0', POCKET_SCRAPER_TOKEN: 'a'.repeat(64), POCKET_SCRAPER_DATA: join(dir, 'store.json') }, stdio: ['ignore', 'pipe', 'ignore'] });
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timeout')), 5000);
      child.on('error', reject);
      child.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
  };
  const stop = async () => { if (child) { const done = once(child, 'close'); child.kill(); await done; child = null; } };
  const post = async (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'a'.repeat(64) }, body: JSON.stringify(data || {}) });
  const get = async path => (await fetch(base + path, { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } })).json();
  const waitFor = async predicate => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Timed out waiting for run');
  };
  try {
    await start();
    let recipe = await (await post('/api/recipes', { name: 'Protected', url: `http://127.0.0.1:${source.address().port}`, fields: [{ name: 'title', selector: 'h1' }], useBrowserSession: true, scheduleMinutes: 0.001 })).json();
    await post('/api/run/' + recipe.id);
    await waitFor(async () => (await get('/api/runs')).find(r => r.status === 'needs_attention'));
    assert.equal((await get('/api/recipes'))[0].sessionNeedsAttention, true);
    assert.equal((await post('/api/run/' + recipe.id)).status, 409);
    await stop(); await start();
    const before = visits;
    await new Promise(resolve => setTimeout(resolve, 10500));
    assert.equal(visits, before, 'paused schedule does not retry after restart');
    assert.equal((await get('/api/runs')).length, 1);
    // Simulate the user saving a verified session, including a nonpersistent login cookie.
    context = await acquireSession(recipe, { profileRoot: join(dir, 'browser-profiles') });
    await context.addCookies([{ name: 'verified', value: 'yes', url: recipe.url }]);
    await context.close(); context = null;
    assert.equal((await post('/api/session/' + recipe.id + '/finish')).status, 200);
    const run = await waitFor(async () => (await get('/api/runs')).find(r => r.status === 'success'));
    assert.equal(run.rowCount, 1);
    assert.equal((await get('/api/records'))[0].fields.title, 'Release notes');
  } finally {
    if (context) await context.close();
    await stop(); await new Promise(resolve => source.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

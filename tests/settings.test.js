import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { intSetting, readSettings } from '../settings.js';

test('settings fall back to the default, with a warning, unless given a whole number in range', () => {
  const warnings = [];
  const warn = text => warnings.push(text);
  const read = raw => intSetting({ X: raw }, 'X', 180_000, { min: 500 }, warn);
  assert.equal(read(undefined), 180_000);
  assert.equal(read(''), 180_000);
  assert.equal(read('  '), 180_000);
  assert.equal(warnings.length, 0, 'unset and empty are not warnings');
  assert.equal(read('60000'), 60_000);
  for (const raw of ['3m', '180s', 'two', '-1', '1.5', '499', 'NaN', 'Infinity']) assert.equal(read(raw), 180_000, raw);
  assert.equal(warnings.length, 8);
  assert.equal(readSettings({ POCKET_SCRAPER_RUN_TIMEOUT_MS: '2147483647' }, warn).runTimeoutMs, 2_147_483_647);
  assert.equal(readSettings({ POCKET_SCRAPER_RUN_TIMEOUT_MS: '3000000000' }, warn).runTimeoutMs, 180_000, 'beyond setTimeout would fire at once');
  assert.equal(warnings.length, 9);
  assert.match(warnings[0], /^X=3m is not a whole number from 500 to \d+; using 180000\.$/);
});

test('server settings: port allows 0, concurrency at least 1, timeout at least 500 ms', () => {
  const warn = () => {};
  assert.deepEqual(readSettings({}, warn), { port: 3888, maxConcurrentRuns: 2, runTimeoutMs: 180_000 });
  assert.deepEqual(readSettings({ PORT: '0', POCKET_SCRAPER_MAX_CONCURRENT: '4', POCKET_SCRAPER_RUN_TIMEOUT_MS: '500' }, warn),
    { port: 0, maxConcurrentRuns: 4, runTimeoutMs: 500 });
  assert.deepEqual(readSettings({ PORT: '70000', POCKET_SCRAPER_MAX_CONCURRENT: 'two', POCKET_SCRAPER_RUN_TIMEOUT_MS: '3m' }, warn),
    { port: 3888, maxConcurrentRuns: 2, runTimeoutMs: 180_000 });
});

test('a timed-out run reports the timeout and frees its slot only after the browser closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-run-timeout-'));
  const token = 'a'.repeat(64);
  const auth = { Authorization: `Bearer ${token}` };
  const site = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<p>Never clickable</p>'); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const server = spawn(process.execPath, ['server.js'], { cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: '0', POCKET_SCRAPER_DATA: join(dir, 'store.json'), POCKET_SCRAPER_TOKEN: token,
      POCKET_SCRAPER_RUN_TIMEOUT_MS: '1500', POCKET_SCRAPER_MAX_CONCURRENT: 'two' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timeout')), 5000);
      server.once('error', reject);
      server.stdout.on('data', chunk => { const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
    });
    assert.match(stderr, /POCKET_SCRAPER_MAX_CONCURRENT=two is not a whole number/);
    const get = async path => (await fetch(base + path, { headers: auth })).json();
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const recipe = await (await post('/api/recipes', { name: 'Hangs', url: `http://127.0.0.1:${site.address().port}`,
      fields: [{ name: 'p', selector: 'p' }], steps: [{ type: 'click', selector: '#never', waitMs: 0 }, { type: 'extract' }] })).json();
    assert.equal((await post('/api/run/' + recipe.id)).status, 202);
    let run;
    for (const started = Date.now(); Date.now() - started < 15_000;) {
      [run] = await get('/api/runs?recipeId=' + recipe.id);
      if (run && run.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(run.status, 'error');
    assert.equal(run.error, 'Run timed out after 2s.');
    assert.deepEqual((await get('/api/health')).running, []);
  } finally {
    const done = once(server, 'close');
    server.kill();
    await done;
    await new Promise(resolve => site.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

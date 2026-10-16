import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { captureFields } from '../extension/capture.js';

const root = new URL('../', import.meta.url);
test('tab extraction saves through API, deduplicates, and is readable over Claude MCP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-capture-'));
  const env = { ...process.env, PORT: '0', POCKET_SCRAPER_DATA: join(dir, 'store.json') };
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
      server.once('error', reject);
      server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const recipe = await (await post('/api/recipes', { name: 'Release notes', url: 'https://example.org/releases', fields: [
      { name: 'release', selector: 'h3', kind: 'text' }, { name: 'notes', selector: '.notes', kind: 'text' }, { name: 'link', selector: 'a', kind: 'href' }
    ] })).json();
    browser = await chromium.launch({ headless: true, ...(process.env.SCRAPER_BROWSER_PATH ? { executablePath: process.env.SCRAPER_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    await page.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h3>October release</h3><div class="notes">New feature text</div><a href="/details">Details</a>' }));
    await page.goto('https://example.org/releases');
    const capture = await page.evaluate(({ func, fields }) => new Function(`return (${func})`)()(fields, location.origin), { func: captureFields.toString(), fields: recipe.fields });
    assert.equal(capture.rows[0].fields.notes, 'New feature text');
    assert.equal(capture.rows[0].fields.link, 'https://example.org/details');
    const first = await (await post('/api/capture/' + recipe.id, capture)).json();
    assert.equal(first.status, 'success'); assert.equal(first.newCount, 1); assert.equal(first.source, 'chrome-tab');
    const second = await (await post('/api/capture/' + recipe.id, capture)).json();
    assert.equal(second.newCount, 0);
    assert.equal((await post('/api/capture/' + recipe.id, { ...capture, pageUrl: 'https://other.example/' })).status, 400);
    assert.equal((await post('/api/capture/' + recipe.id, { ...capture, rows: [{ pageUrl: capture.pageUrl, fields: { unknown: 'text' } }] })).status, 400);
    const empty = await (await post('/api/capture/' + recipe.id, { ...capture, rows: [], warnings: ['No matches'] })).json();
    assert.equal(empty.status, 'error');
    const mcp = spawn(process.execPath, ['mcp.js'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; mcp.stdout.on('data', chunk => output += chunk);
    const done = once(mcp, 'close');
    const calls = [{ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'read_scraped_records', arguments: { recipe_id: recipe.id } } },
      { id: 4, method: 'tools/call', params: { name: 'read_scraper_runs', arguments: { recipe_id: recipe.id } } }];
    mcp.stdin.end(calls.map(c => JSON.stringify({ jsonrpc: '2.0', ...c })).join('\n') + '\n');
    assert.equal((await done)[0], 0);
    const responses = output.trim().split('\n').map(JSON.parse);
    assert.equal(responses[1].result.tools.length, 3);
    const records = JSON.parse(responses[2].result.content[0].text);
    assert.equal(records.length, 1); assert.equal(records[0].fields.notes, 'New feature text'); assert.equal(records[0].pageUrl, capture.pageUrl);
    assert.ok(records[0].observedAt); assert.equal(records[0].runId, first.id);
    const runs = JSON.parse(responses[3].result.content[0].text);
    assert.equal(runs.length, 3); assert.ok(runs.every(r => r.source === 'chrome-tab'));
    await assert.rejects(page.evaluate(({ func }) => new Function(`return (${func})`)( )([{ name: 'bad', selector: '[' }], location.origin), { func: captureFields.toString() }), /Invalid selector/);
  } finally {
    if (browser) await browser.close();
    const stopped = once(server, 'close'); server.kill(); await stopped;
    rmSync(dir, { recursive: true, force: true });
  }
});

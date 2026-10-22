import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrape } from '../runner.js';
import { defaultStore, normalizeRecipe, addRecords } from '../store.js';
import { renderPlist, runLaunchdCli } from '../scripts/launchd.js';

const root = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(root, 'fixture.html'), 'utf8');

test('CSS extraction, recorded click, link URLs, deduplication', async () => {
  try {
    const url = 'https://example.org';
    const recipe = normalizeRecipe({ name: 'Fixture', url, rowSelector: 'li',
      fields: [{ name: 'title', selector: 'a.job', kind: 'text' }, { name: 'url', selector: 'a.job', kind: 'href' }, { name: 'location', selector: '.location', kind: 'text' }],
      actions: [{ selector: '#show-more', waitMs: 50 }] });
    const { rows, warnings } = await scrape(recipe, { fixtureHtml: fixture });
    assert.equal(warnings.length, 0);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].fields.title, 'Research Analyst');
    assert.equal(rows[0].fields.url, url + '/jobs/1');
    assert.equal(rows[1].fields.location, 'Remote');
    const db = defaultStore();
    assert.equal(addRecords(db, recipe.id, rows, 'run-1'), 2);
    assert.equal(addRecords(db, recipe.id, rows, 'run-2'), 0);
    assert.equal(db.records.length, 2);
  } finally { /* No network server needed for offline browser test. */ }
});

test('recipes reject missing data fields and invalid URLs', () => {
  assert.throws(() => normalizeRecipe({ name: 'bad', url: 'file:///secret', fields: [{ name: 'x', selector: 'h1' }] }), /HTTP/);
  assert.throws(() => normalizeRecipe({ name: 'bad', url: 'https://example.org', fields: [] }), /fields/);
});

test('ordered steps wait for AJAX updates and extract each repeated state', async () => {
  const recipe = normalizeRecipe({ name: 'Workflow', url: 'https://example.org',
    fields: [{ name: 'value', selector: '#value' }],
    actions: [{ selector: '#must-not-run' }], nextSelector: '#must-not-run', maxPages: 5,
    steps: [{ type: 'click', selector: '#next', waitMs: 0 }, { type: 'wait', waitMs: 150 }, { type: 'extract' }],
    repeatCount: 3 });
  const result = await scrape(recipe, { fixtureHtml: `<span id="value">0</span><button id="next" onclick="setTimeout(() => document.querySelector('#value').textContent = ++window.n, 30)">Next</button><script>window.n=0</script>` });
  assert.deepEqual(result.rows.map(row => row.fields.value), ['1', '2', '3']);
  assert.deepEqual(result.warnings, []);
});

test('workflow supports multiple extraction points and identifies empty fields', async () => {
  const recipe = normalizeRecipe({ name: 'Two snapshots', url: 'https://example.org',
    fields: [{ name: 'value', selector: '#value' }],
    steps: [{ type: 'extract' }, { type: 'click', selector: '#change', waitMs: 0 }, { type: 'extract' }] });
  const result = await scrape(recipe, { fixtureHtml: `<span id="value">Before</span><button id="change" onclick="document.querySelector('#value').remove()">Remove</button>` });
  assert.deepEqual(result.rows.map(row => row.fields.value), ['Before']);
  assert.deepEqual(result.warnings, ['Repeat 1, step 3 (extract): no nonempty records']);
});

test('workflow validation rejects malformed and unbounded sequences', () => {
  const base = { name: 'Validation', url: 'https://example.org', fields: [{ name: 'title', selector: 'h1' }] };
  for (const steps of [[], {}, [null], [{ type: 'unknown' }], [{ type: 'click', selector: '' }, { type: 'extract' }], [{ type: 'wait', waitMs: -1 }, { type: 'extract' }], [{ type: 'wait', waitMs: Infinity }, { type: 'extract' }], [{ type: 'wait' }], Array(51).fill({ type: 'extract' })]) {
    assert.throws(() => normalizeRecipe({ ...base, steps }));
  }
  for (const repeatCount of [0, 31, 1.5, 'invalid']) {
    assert.throws(() => normalizeRecipe({ ...base, steps: [{ type: 'extract' }], repeatCount }));
  }
  assert.equal(normalizeRecipe(base).steps, undefined);
  assert.equal(normalizeRecipe({ ...base, steps: [{ type: 'extract' }] }).repeatCount, 1);
});


test('security verification is an error rather than successful empty extraction', async () => {
  const recipe = normalizeRecipe({ name: 'Blocked', url: 'https://example.org', fields: [{ name: 'title', selector: 'h3' }] });
  await assert.rejects(scrape(recipe, { fixtureHtml: '<title>Just a moment...</title><p>Cloudflare: Performing security verification</p>' }), /security verification instead of/);
});

test('HTTP access failures explain why extraction cannot run', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => { res.writeHead(403); res.end('Forbidden'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const recipe = normalizeRecipe({ name: 'Denied', url: `http://127.0.0.1:${server.address().port}`, fields: [{ name: 'title', selector: 'h3' }] });
    await assert.rejects(scrape(recipe), /HTTP 403.*separate from your Chrome tab/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('selector health warns when one field in a multi-field recipe is empty across all cards', async () => {
  const recipe = normalizeRecipe({
    name: 'Drifted field',
    url: 'https://example.org',
    rowSelector: 'li',
    fields: [
      { name: 'title', selector: 'a.job', kind: 'text' },
      { name: 'salary', selector: '.missing-salary', kind: 'text' }
    ]
  });
  const { rows, warnings } = await scrape(recipe, { fixtureHtml: fixture });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields.title, 'Research Analyst');
  assert.equal(rows[0].fields.salary, '');
  assert.deepEqual(warnings, [
    'Page 1: Record 1: no matches for salary',
    'Page 1: Record 2: no matches for salary',
    'Page 1: Selector health: field "salary" (.missing-salary) was empty across all 2 record(s)'
  ]);
});

test('in-place AJAX nextSelector pagination deduplicates seen rows and stops when no new records load', async () => {
  const ajaxHtml = `
    <ul id="items"><li class="card"><span class="name">Item 1</span></li></ul>
    <button id="load-more" onclick="
      window.clicks = (window.clicks || 0) + 1;
      if (window.clicks === 1) {
        const li = document.createElement('li');
        li.className = 'card';
        li.innerHTML = '<span class=\\'name\\'>Item 2</span>';
        document.getElementById('items').appendChild(li);
      }
    ">Load More</button>
  `;
  const recipe = normalizeRecipe({
    name: 'AJAX Load More',
    url: 'https://example.org',
    rowSelector: 'li.card',
    fields: [{ name: 'name', selector: '.name', kind: 'text' }],
    nextSelector: '#load-more',
    maxPages: 5
  });
  const { rows, warnings } = await scrape(recipe, { fixtureHtml: ajaxHtml });
  assert.deepEqual(rows.map(r => r.fields.name), ['Item 1', 'Item 2']);
  assert.deepEqual(warnings, ['Next button did not load new records; stopping pagination.']);
});

test('macOS launchd helper renders escaped plist XML and supports write/install/uninstall/status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-launchd-'));
  try {
    const plistPath = join(dir, 'com.pocketscraper.server.plist');
    const calls = [];
    const execLaunchctl = args => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };

    const xml = renderPlist({
      label: 'com.pocketscraper.server',
      nodePath: '/opt/homebrew/bin/node',
      workingDirectory: '/Users/test/pocket & scraper',
      logDir: join(dir, 'logs'),
      env: { PATH: '/opt/homebrew/bin:/usr/bin', POCKET_SCRAPER_DATA: '/Users/test/data/store.json' }
    });
    assert.match(xml, /<string>com\.pocketscraper\.server<\/string>/);
    assert.match(xml, /pocket &amp; scraper/);
    assert.match(xml, /POCKET_SCRAPER_DATA/);

    runLaunchdCli(['--install', '--out', plistPath], { uid: 501, workingDirectory: dir, execLaunchctl, stderr: () => {} });
    assert.equal(existsSync(plistPath), true);
    assert.match(readFileSync(plistPath, 'utf8'), /com\.pocketscraper\.server/);
    assert.deepEqual(calls.map(c => c[0]), ['bootout', 'bootstrap']);

    const statusRes = runLaunchdCli(['--status', '--out', plistPath], { uid: 501, workingDirectory: dir, execLaunchctl, stdout: () => {} });
    assert.equal(statusRes.loaded, true);

    runLaunchdCli(['--uninstall', '--out', plistPath], { uid: 501, workingDirectory: dir, execLaunchctl, stderr: () => {} });
    assert.equal(existsSync(plistPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

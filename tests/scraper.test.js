import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrape } from '../runner.js';
import { defaultStore, normalizeRecipe, addRecords } from '../store.js';
import { extractFields } from '../extension/extract.js';
import { browserOptions, sessionStatus } from '../browser-session.js';
import { chromium } from 'playwright';

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
    'Selector health: field "salary" (.missing-salary) was empty in 1 of 1 extraction(s), first at Page 1',
    'Page 1: Record 1: no matches for salary',
    'Page 1: Record 2: no matches for salary'
  ]);
});

const cards = n => `<ul>${Array.from({ length: n }, (_, i) => `<li><a class="job">Job ${i}</a></li>`).join('')}</ul>`;
const drifted = { url: 'https://example.org', rowSelector: 'li',
  fields: [{ name: 'title', selector: 'a.job' }, { name: 'salary', selector: '.missing-salary' }] };

test('selector health is reported once per run, not once per extraction', async () => {
  const recipe = normalizeRecipe({ ...drifted, name: 'Repeated drift', steps: [{ type: 'extract' }, { type: 'extract' }, { type: 'extract' }] });
  const { warnings } = await scrape(recipe, { fixtureHtml: fixture });
  const health = warnings.filter(w => w.includes('Selector health'));
  assert.deepEqual(health, ['Selector health: field "salary" (.missing-salary) was empty in 3 of 3 extraction(s), first at Repeat 1, step 1 (extract)']);
});

test('one extraction keeps the health warning within the 30 warnings a tab capture accepts', async () => {
  const browser = await chromium.launch({ headless: true, ...browserOptions() });
  try {
    const page = await browser.newPage();
    await page.setContent(cards(35));
    const output = await page.evaluate(extractFields, { fields: drifted.fields, rowSelector: 'li' });
    assert.equal(output.warnings.length, 30);
    assert.match(output.warnings[0], /^Selector health: field "salary"/);
    assert.deepEqual(output.emptyFields, [{ name: 'salary', selector: '.missing-salary' }]);
  } finally { await browser.close(); }
});

test('a run keeps at most 100 warnings and says how many more there were', async () => {
  const recipe = normalizeRecipe({ ...drifted, name: 'Noisy', steps: Array(5).fill({ type: 'extract' }) });
  const { warnings } = await scrape(recipe, { fixtureHtml: cards(35) });
  // 1 health warning + 5 extractions x 30 record warnings = 151; the runner's own
  // health report does not crowd out record warnings.
  assert.equal(warnings.length, 101);
  assert.match(warnings[0], /^Selector health/);
  assert.equal(warnings.filter(w => w.startsWith('Repeat 1, step 1')).length, 30);
  assert.equal(warnings[100], '…and 51 more warnings');
});

// Next replaces the list with the following page after delayMs; hidden on the last page.
const pager = (pages, delayMs = 0) => `<ul id="items"></ul><button id="next">Next</button><script>
  const pages = ${JSON.stringify(pages)}; let i = 0;
  const show = () => {
    document.getElementById('items').innerHTML = pages[i].map(n => '<li class="card"><span class="name">' + n + '</span></li>').join('');
    document.getElementById('next').hidden = i === pages.length - 1;
  };
  document.getElementById('next').onclick = () => setTimeout(() => { i++; show(); }, ${delayMs});
  show();
</script>`;
const paged = (name, maxPages = 5) => normalizeRecipe({ name, url: 'https://example.org', rowSelector: 'li.card',
  fields: [{ name: 'name', selector: '.name' }], nextSelector: '#next', maxPages });

test('in-place "Load more" pagination keeps only appended records and stops when nothing new loads', async () => {
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
    fields: [{ name: 'name', selector: '.name' }],
    nextSelector: '#load-more',
    maxPages: 5
  });
  const { rows, warnings } = await scrape(recipe, { fixtureHtml: ajaxHtml, pageChangeTimeoutMs: 500 });
  assert.deepEqual(rows.map(r => r.fields.name), ['Item 1', 'Item 2']);
  assert.deepEqual(warnings, ['Next button did not load new records within 1s; stopping pagination.']);
});

test('in-place pagination keeps records that repeat an earlier page and carries on', async () => {
  const { rows, warnings } = await scrape(paged('Repeats'), { fixtureHtml: pager([['A', 'B'], ['B', 'C'], ['D']]), pageChangeTimeoutMs: 2000 });
  assert.deepEqual(rows.map(r => r.fields.name), ['A', 'B', 'B', 'C', 'D']);
  assert.deepEqual(warnings, []);
});

test('a page made only of earlier records still counts as a new page', async () => {
  const { rows, warnings } = await scrape(paged('Subset', 2), { fixtureHtml: pager([['A', 'B'], ['A']]), pageChangeTimeoutMs: 2000 });
  assert.deepEqual(rows.map(r => r.fields.name), ['A', 'B', 'A']);
  assert.deepEqual(warnings, []);
});

test('in-place pagination waits for a slow next page instead of stopping', async () => {
  const { rows, warnings } = await scrape(paged('Slow'), { fixtureHtml: pager([['A'], ['B']], 1500) });
  assert.deepEqual(rows.map(r => r.fields.name), ['A', 'B']);
  assert.deepEqual(warnings, []);
});

test('pagination waits out an emptied or half-drawn list instead of reading it', async () => {
  // Next empties the list (a spinner), then draws the next page one record at a time.
  const html = `<ul id="items"><li class="name">A</li><li class="name">B</li></ul><button id="next">Next</button><script>
    document.getElementById('next').onclick = () => {
      const items = document.getElementById('items');
      items.innerHTML = '';
      setTimeout(() => { items.innerHTML = '<li class="name">C</li>'; }, 400);
      setTimeout(() => { items.innerHTML += '<li class="name">D</li>'; document.getElementById('next').hidden = true; }, 700);
    };
  </script>`;
  const recipe = normalizeRecipe({ name: 'Spinner', url: 'https://example.org', fields: [{ name: 'name', selector: '.name' }], nextSelector: '#next', maxPages: 5 });
  const { rows, warnings } = await scrape(recipe, { fixtureHtml: html, pageChangeTimeoutMs: 3000 });
  assert.deepEqual(rows.map(r => r.fields.name), ['A', 'B', 'C', 'D']);
  assert.deepEqual(warnings, []);
});

test('a next page that never shows records fails the run instead of ending quietly', async () => {
  const html = `<ul><li class="card"><span class="name">A</span></li></ul>
    <button id="next" onclick="document.body.innerHTML = '<p>Please sign in</p>'">Next</button>`;
  await assert.rejects(scrape(paged('Signed out'), { fixtureHtml: html, pageChangeTimeoutMs: 1000 }), /No record containers matched/);
});

const abortAfter = ms => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Run timed out after 0s.')), ms);
  return controller.signal;
};

test('a cancelled run closes its browser instead of waiting on a hung page call', async () => {
  const recipe = normalizeRecipe({ name: 'Hung click', url: 'https://example.org', fields: [{ name: 'p', selector: 'p' }],
    steps: [{ type: 'click', selector: '#never', waitMs: 0 }, { type: 'extract' }] });
  const started = Date.now();
  await assert.rejects(scrape(recipe, { fixtureHtml: '<p>x</p>', signal: abortAfter(300) }), /^Error: Run timed out after 0s\.$/);
  assert.ok(Date.now() - started < 5000, 'rejects well before the 20 s click timeout');
});

test('a cancelled run stops a long wait step', async () => {
  const recipe = normalizeRecipe({ name: 'Long wait', url: 'https://example.org', fields: [{ name: 'p', selector: 'p' }],
    steps: [{ type: 'wait', waitMs: 30000 }, { type: 'extract' }] });
  const started = Date.now();
  await assert.rejects(scrape(recipe, { fixtureHtml: '<p>x</p>', signal: abortAfter(300) }), /Run timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('a cancelled session run releases the website session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-abort-session-'));
  try {
    const recipe = normalizeRecipe({ name: 'Session hang', url: 'https://example.org', useBrowserSession: true, fields: [{ name: 'p', selector: 'p' }],
      steps: [{ type: 'click', selector: '#never', waitMs: 0 }, { type: 'extract' }] });
    await assert.rejects(scrape(recipe, { fixtureHtml: '<p>x</p>', signal: abortAfter(500), sessionOptions: { profileRoot: dir } }), /Run timed out/);
    assert.equal(sessionStatus(recipe).busy, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

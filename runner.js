import { extractFields } from './extension/extract.js';
import { chromium } from 'playwright';
import { acquireSession, unattendedOptions } from './browser-session.js';

const timeout = 20_000;
const MAX_WARNINGS = 100;
// Rejects with the abort reason as soon as the run is cancelled.
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});
const signature = output => output.rows.map(r => JSON.stringify(r.fields));
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const extendsList = (list, prefix) => prefix.length < list.length && prefix.every((x, i) => x === list[i]);

export async function scrape(recipe, opts = {}) {
  const { signal } = opts;
  let browser;
  let context;
  if (recipe.useBrowserSession) context = await acquireSession(recipe, opts.sessionOptions);
  else {
    const { userAgent, ...launchOptions } = await unattendedOptions();
    browser = await chromium.launch({ headless: true, ...launchOptions });
    try { context = await browser.newContext({ userAgent }); }
    catch (error) { await browser.close(); throw error; }
  }
  // A cancelled run closes its browser at once, so hung page calls fail and the
  // session lock is released; the run then reports the abort reason.
  let closing;
  const close = () => closing ||= browser ? browser.close() : context.close();
  const onAbort = () => { close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const rows = [];
  const warnings = [];
  const emptyFields = new Map();
  let extractions = 0;
  try {
    signal?.throwIfAborted();
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    let documentStatus = 200;
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documentStatus = response.status();
    });
    function checkStatus() {
      if (documentStatus >= 400) throw Object.assign(new Error(`Website returned HTTP ${documentStatus}. The scraper session is separate from your Chrome tab; complete session setup for access failures.`), { code: [401, 403, 429].includes(documentStatus) ? 'SESSION_ATTENTION' : 'HTTP_ERROR' });
    }
    async function checkChallenge() {
      const challenge = await page.evaluate(() => {
        const title = document.title.trim();
        const text = document.body?.innerText || '';
        return /^(just a moment|attention required)/i.test(title) &&
          /cloudflare|verify you are human|verifies you are not a bot|security verification/i.test(text);
      });
      if (challenge) throw Object.assign(new Error('Website is showing browser security verification instead of the requested content. Open session setup in the dashboard, complete verification, then finish setup and retry.'), { code: 'SESSION_ATTENTION' });
    }
    const read = async () => JSON.parse(await page.evaluate(extractFields, { fields: recipe.fields, rowSelector: recipe.rowSelector, serialize: true }));

    if (opts.fixtureHtml) {
      // Offline integration tests can exercise the real browser without network access.
      await page.setContent(`<base href="${recipe.url}">` + opts.fixtureHtml);
    } else {
      const response = await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (response) documentStatus = response.status();
      checkStatus();
    }
    // Returns the page's record signature. When `previous` is a prefix of it, the
    // page kept the earlier records and appended more ("Load more"); only the
    // appended ones are new. Repeated values are kept: they can be real records.
    async function extract(label, { previous } = {}) {
      await page.waitForLoadState('domcontentloaded');
      checkStatus();
      await checkChallenge();
      const output = await read();
      const current = signature(output);
      const batch = previous && extendsList(current, previous) ? output.rows.slice(previous.length) : output.rows;
      extractions++;
      for (const field of output.emptyFields) {
        const seen = emptyFields.get(field.name) || { ...field, count: 0, first: label };
        seen.count++;
        emptyFields.set(field.name, seen);
      }
      warnings.push(...output.warnings.filter(w => !w.startsWith('Selector health:')).map(w => `${label}: ${w}`));
      if (!batch.length) warnings.push(`${label}: no nonempty records`);
      rows.push(...batch);
      if (rows.length > 5000 || Buffer.byteLength(JSON.stringify(rows)) > 2_000_000) throw new Error('Run exceeds 5000 rows or 2 MB. Narrow the selection.');
      return current;
    }
    // After a Next click, wait until the records differ from the last page, however
    // the site loads them (navigation, pushState or in-place AJAX).
    const changeTimeout = opts.pageChangeTimeoutMs ?? 10_000;
    async function waitForChange(previous) {
      const deadline = Date.now() + changeTimeout;
      do {
        await pause(250, signal);
        checkStatus();
        try {
          if (!sameList(signature(await read()), previous)) return true;
        } catch {
          // Mid-navigation or mid-render; keep waiting unless verification is showing.
          await checkChallenge().catch(error => { if (error.code === 'SESSION_ATTENTION') throw error; });
        }
      } while (Date.now() < deadline);
      return false;
    }
    function result() {
      if (!rows.length) throw new Error('No records collected. Check selectors, sign-in, and page content.');
      const health = [...emptyFields.values()].map(f => `Selector health: field "${f.name}" (${f.selector}) was empty in ${f.count} of ${extractions} extraction(s), first at ${f.first}`);
      const all = [...health, ...warnings];
      const extra = all.length - MAX_WARNINGS;
      return { rows, warnings: extra > 0 ? [...all.slice(0, MAX_WARNINGS), `…and ${extra} more warnings`] : all };
    }

    if (recipe.steps) {
      for (let cycle = 0; cycle < (recipe.repeatCount || 1); cycle++) {
        for (const [index, step] of recipe.steps.entries()) {
          const label = `Repeat ${cycle + 1}, step ${index + 1} (${step.type})`;
          try {
            if (step.type === 'click') {
              await page.locator(step.selector).first().click({ timeout });
              await pause(step.waitMs, signal);
            } else if (step.type === 'wait') {
              await pause(step.waitMs, signal);
            } else if (step.type === 'extract') {
              await extract(label);
            } else throw new Error('Unknown step type');
          } catch (error) {
            throw Object.assign(new Error(`${label}: ${error.message}`), { code: error.code });
          }
        }
      }
      return result();
    }
    await pause(400, signal);
    for (const action of recipe.actions || []) {
      await page.locator(action.selector).first().click({ timeout });
      await pause(action.waitMs || 700, signal);
    }
    const visited = new Set();
    let previous;
    let inPlace = false;
    for (let pageNo = 0; pageNo < (recipe.maxPages || 1); pageNo++) {
      const url = page.url();
      if (!inPlace && visited.has(url) && pageNo > 0) {
        warnings.push('Pagination repeated the same URL; stopping to avoid a loop.');
        break;
      }
      visited.add(url);
      previous = await extract(`Page ${pageNo + 1}`, { previous });
      if (pageNo + 1 >= (recipe.maxPages || 1) || !recipe.nextSelector) break;
      const next = page.locator(recipe.nextSelector).first();
      if (!(await next.count()) || !(await next.isVisible()) || !(await next.isEnabled()) || (await next.getAttribute('aria-disabled')) === 'true') break;
      const before = page.url();
      await next.click();
      if (!(await waitForChange(previous))) {
        warnings.push(`Next button did not load new records within ${Math.round(changeTimeout / 1000)}s; stopping pagination.`);
        break;
      }
      inPlace = page.url() === before;
    }
    return result();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await close().catch(error => { if (!signal?.aborted) throw error; });
  }
}

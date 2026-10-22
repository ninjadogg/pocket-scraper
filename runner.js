import { extractFields } from './extension/extract.js';
import { chromium } from 'playwright';
import { acquireSession, unattendedOptions } from './browser-session.js';

const timeout = 20_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function scrape(recipe, opts = {}) {
  let browser;
  let context;
  if (recipe.useBrowserSession) context = await acquireSession(recipe, opts.sessionOptions);
  else {
    const { userAgent, ...launchOptions } = await unattendedOptions();
    browser = await chromium.launch({ headless: true, ...launchOptions });
    try { context = await browser.newContext({ userAgent }); }
    catch (error) { await browser.close(); throw error; }
  }
  const rows = [];
  const warnings = [];
  try {
    context ||= await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    let documentStatus = 200;
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documentStatus = response.status();
    });
    function checkStatus() {
      if (documentStatus >= 400) throw Object.assign(new Error(`Website returned HTTP ${documentStatus}. The scraper session is separate from your Chrome tab; complete session setup for access failures.`), { code: [401, 403, 429].includes(documentStatus) ? 'SESSION_ATTENTION' : 'HTTP_ERROR' });
    }

    if (opts.fixtureHtml) {
      // Offline integration tests can exercise the real browser without network access.
      await page.setContent(`<base href="${recipe.url}">` + opts.fixtureHtml);
    } else {
      const response = await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (response) documentStatus = response.status();
      checkStatus();
    }
    async function extract(label, { inPlace = false, seenRows } = {}) {
      await page.waitForLoadState('domcontentloaded');
      checkStatus();
      const challenge = await page.evaluate(() => {
        const title = document.title.trim();
        const text = document.body?.innerText || '';
        return /^(just a moment|attention required)/i.test(title) &&
          /cloudflare|verify you are human|verifies you are not a bot|security verification/i.test(text);
      });
      if (challenge) throw Object.assign(new Error('Website is showing browser security verification instead of the requested content. Open session setup in the dashboard, complete verification, then finish setup and retry.'), { code: 'SESSION_ATTENTION' });
      const output = JSON.parse(await page.evaluate(extractFields, { fields: recipe.fields, rowSelector: recipe.rowSelector, serialize: true }));
      const batch = inPlace && seenRows
        ? output.rows.filter(r => !seenRows.has(JSON.stringify(r.fields)))
        : output.rows;
      if (inPlace && !batch.length) return false;
      if (seenRows) for (const r of batch) seenRows.add(JSON.stringify(r.fields));
      warnings.push(...output.warnings.map(w => `${label}: ${w}`));
      if (!batch.length) warnings.push(`${label}: no nonempty records`);
      rows.push(...batch);
      if (rows.length > 5000 || Buffer.byteLength(JSON.stringify(rows)) > 2_000_000) throw new Error('Run exceeds 5000 rows or 2 MB. Narrow the selection.');
      return true;
    }
    function result() {
      if (!rows.length) throw new Error('No records collected. Check selectors, sign-in, and page content.');
      return { rows, warnings };
    }

    if (recipe.steps) {
      for (let cycle = 0; cycle < (recipe.repeatCount || 1); cycle++) {
        for (const [index, step] of recipe.steps.entries()) {
          const label = `Repeat ${cycle + 1}, step ${index + 1} (${step.type})`;
          try {
            if (step.type === 'click') {
              await page.locator(step.selector).first().click({ timeout });
              await pause(step.waitMs);
            } else if (step.type === 'wait') {
              await pause(step.waitMs);
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
    await pause(400);
    for (const action of recipe.actions || []) {
      await page.locator(action.selector).first().click({ timeout });
      await pause(action.waitMs || 700);
    }
    const visited = new Set();
    const seenRows = new Set();
    let inPlace = false;
    for (let pageNo = 0; pageNo < (recipe.maxPages || 1); pageNo++) {
      const url = page.url();
      if (!inPlace && visited.has(url) && pageNo > 0) {
        warnings.push('Pagination repeated the same URL; stopping to avoid a loop.');
        break;
      }
      visited.add(url);
      const progressed = await extract(`Page ${pageNo + 1}`, { inPlace, seenRows });
      if (!progressed) {
        warnings.push('Next button did not load new records; stopping pagination.');
        break;
      }
      if (pageNo + 1 >= (recipe.maxPages || 1) || !recipe.nextSelector) break;
      const next = page.locator(recipe.nextSelector).first();
      if (!(await next.count()) || !(await next.isVisible()) || !(await next.isEnabled()) || (await next.getAttribute('aria-disabled')) === 'true') break;
      const before = page.url();
      await next.click();
      await pause(900);
      inPlace = page.url() === before;
    }
    return result();
  } finally {
    if (browser) await browser.close();
    else await context.close();
  }
}

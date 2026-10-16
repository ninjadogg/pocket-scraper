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
    if (opts.fixtureHtml) {
      // Offline integration tests can exercise the real browser without network access.
      await page.setContent(`<base href="${recipe.url}">` + opts.fixtureHtml);
    } else {
      const response = await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (response && !response.ok()) {
        throw Object.assign(new Error(`Website returned HTTP ${response.status()} at ${new URL(page.url()).origin}. ${[401, 403, 429].includes(response.status()) ? (recipe.useBrowserSession ? 'Saved session needs attention. Open session setup in the dashboard, complete sign-in or verification, then finish setup and retry.' : 'Access was denied or rate-limited; the site may require sign-in or browser verification. The scraper uses a fresh browser session, separate from your Chrome tab.') : 'The requested page could not be loaded.'}`), { code: [401, 403, 429].includes(response.status()) ? 'SESSION_ATTENTION' : 'HTTP_ERROR' });
      }
    }
    async function extract(label) {
      const challenge = await page.evaluate(() => {
        const title = document.title.trim();
        const text = document.body?.innerText || '';
        return /^(just a moment|attention required)/i.test(title) &&
          /cloudflare|verify you are human|verifies you are not a bot|security verification/i.test(text);
      });
      if (challenge) throw Object.assign(new Error('Website is showing browser security verification instead of the requested content. Open session setup in the dashboard, complete verification, then finish setup and retry.'), { code: 'SESSION_ATTENTION' });
      const columns = {};
      for (const field of recipe.fields) {
        columns[field.name] = await page.locator(field.selector).evaluateAll((elements, kind) =>
          elements.map(el => {
            if (kind === 'href') return el.href || el.getAttribute('href') || '';
            if (kind === 'html') return el.innerHTML.trim();
            if (kind === 'value') return el.value ?? el.getAttribute('value') ?? '';
            return (el.innerText || el.textContent || '').trim();
          }), field.kind);
        if (!columns[field.name].length) warnings.push(`${label}: no matches for ${field.name}`);
      }
      const count = Math.max(0, ...Object.values(columns).map(a => a.length));
      for (let i = 0; i < count; i++) {
        const fields = Object.fromEntries(recipe.fields.map(f => [f.name, columns[f.name][i] ?? '']));
        if (Object.values(fields).every(x => !x)) continue;
        rows.push({ pageUrl: page.url(), fields });
      }
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
      return { rows, warnings };
    }
    await pause(400);
    for (const action of recipe.actions || []) {
      await page.locator(action.selector).first().click({ timeout });
      await pause(action.waitMs || 700);
    }
    const visited = new Set();
    for (let pageNo = 0; pageNo < (recipe.maxPages || 1); pageNo++) {
      const url = page.url();
      if (visited.has(url) && pageNo > 0) {
        warnings.push('Pagination repeated the same URL; stopping to avoid a loop.');
        break;
      }
      visited.add(url);
      await extract(`Page ${pageNo + 1}`);
      if (pageNo + 1 >= (recipe.maxPages || 1) || !recipe.nextSelector) break;
      const next = page.locator(recipe.nextSelector).first();
      if (!(await next.count()) || !(await next.isVisible()) || !(await next.isEnabled())) break;
      const before = page.url();
      await next.click();
      await pause(900);
      // Some pagination updates rows in place (URL unchanged). We stop on duplicate URL
      // rather than re-collect the first page indefinitely.
      if (page.url() === before) {
        warnings.push('Next button did not change URL; in-place pagination is not supported yet.');
        break;
      }
    }
    return { rows, warnings };
  } finally {
    if (browser) await browser.close();
    else await context.close();
  }
}

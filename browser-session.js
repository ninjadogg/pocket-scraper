import { chromium } from 'playwright';
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_PATH } from './store.js';

const busy = new Map();
const setups = new Map();
export const sessionKey = recipe => createHash('sha256').update(new URL(recipe.url).origin).digest('hex');
export function browserOptions() {
  if (process.env.SCRAPER_BROWSER_PATH) return { executablePath: process.env.SCRAPER_BROWSER_PATH };
  // Use installed Chrome if Playwright's matching browser has not been downloaded.
  if (!existsSync(chromium.executablePath()) && process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) return { channel: 'chrome' };
  return {};
}
// Keep setup and unattended runs on the same browser identity. A default
// HeadlessChrome identity can be rejected even when its cookies are valid.
let identityPromise;
export async function unattendedOptions() {
  identityPromise ||= (async () => {
    const browser = await chromium.launch({ headless: true, ...browserOptions() });
    try {
      const page = await browser.newPage();
      return (await page.evaluate(() => navigator.userAgent)).replace('HeadlessChrome/', 'Chrome/');
    } finally { await browser.close(); }
  })().catch(error => { identityPromise = undefined; throw error; });
  return {
    ...browserOptions(),
    userAgent: await identityPromise,
    args: ['--disable-blink-features=AutomationControlled']
  };
}
export function sessionStatus(recipe) {
  const key = sessionKey(recipe);
  return { busy: busy.has(key), setupOpen: setups.has(key) };
}
export async function acquireSession(recipe, { headless = true, profileRoot = join(dirname(DATA_PATH), 'browser-profiles') } = {}) {
  const key = sessionKey(recipe);
  if (busy.has(key)) throw Object.assign(new Error('This website’s browser session is busy. Finish session setup or wait for its current run.'), { code: 'SESSION_BUSY' });
  busy.set(key, true);
  try {
    mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    const path = join(profileRoot, key);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    const context = await chromium.launchPersistentContext(path, { headless, ...await unattendedOptions() });
    const cookiePath = join(path, 'pocket-cookies.json');
    try {
      if (existsSync(cookiePath)) await context.addCookies(JSON.parse(readFileSync(cookiePath, 'utf8')));
    } catch (error) { await context.close(); throw error; }
    const close = context.close.bind(context);
    context.close = async () => {
      try {
        const cookies = await context.cookies();
        writeFileSync(cookiePath + '.tmp', JSON.stringify(cookies), { mode: 0o600 });
        renameSync(cookiePath + '.tmp', cookiePath);
      } finally { await close(); }
    };
    context.once('close', () => { busy.delete(key); setups.delete(key); });
    return context;
  } catch (error) { busy.delete(key); throw error; }
}
export async function openSessionSetup(recipe) {
  const key = sessionKey(recipe);
  if (setups.has(key)) return;
  const context = await acquireSession(recipe, { headless: false });
  setups.set(key, context);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (error) { await context.close(); throw error; }
}
export async function finishSessionSetup(recipe) {
  const context = setups.get(sessionKey(recipe));
  if (context) await context.close();
  else if (sessionStatus(recipe).busy) throw new Error('Wait for the current run to finish.');
}

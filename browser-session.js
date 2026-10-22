import { chromium } from 'playwright';
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_PATH } from './store.js';
import { sessionKey, COOKIE_FILE, profileRootFor } from './session-paths.js';

const busy = new Map();
const setups = new Map();
const cookiePaths = new WeakMap();
let saveCount = 0;
export { sessionKey };
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
export async function acquireSession(recipe, { headless = true, profileRoot = profileRootFor(DATA_PATH) } = {}) {
  const key = sessionKey(recipe);
  if (busy.has(key)) throw Object.assign(new Error('This website’s browser session is busy. Finish session setup or wait for its current run.'), { code: 'SESSION_BUSY' });
  busy.set(key, true);
  try {
    mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    const path = join(profileRoot, key);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    const context = await chromium.launchPersistentContext(path, { headless, ...await unattendedOptions() });
    const cookiePath = join(path, COOKIE_FILE);
    try {
      if (existsSync(cookiePath)) await context.addCookies(JSON.parse(readFileSync(cookiePath, 'utf8')));
    } catch (error) { await context.close(); throw error; }
    persistCookiesOnClose(context, cookiePath);
    cookiePaths.set(context, cookiePath);
    context.once('close', () => { busy.delete(key); setups.delete(key); });
    return context;
  } catch (error) { busy.delete(key); throw error; }
}
// Atomic, owner-only snapshot of the context's cookies, including session-only
// ones a browser restart would drop. Rejects (keeping the previous file) when the
// browser is already gone.
export async function saveCookies(context, cookiePath) {
  const cookies = await context.cookies();
  const tmp = `${cookiePath}.${process.pid}.${++saveCount}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cookies), { mode: 0o600 });
    renameSync(tmp, cookiePath);
  } catch (error) { rmSync(tmp, { force: true }); throw error; }
}
// Closing the context saves its cookies first.
export function persistCookiesOnClose(context, cookiePath) {
  const close = context.close.bind(context);
  context.close = async (...args) => {
    try { await saveCookies(context, cookiePath); } finally { await close(...args); }
  };
  return context;
}
// Session setup can end without Finish setup: the person closes the window, and the
// browser may exit before anything can be read. So save after each page load
// (debounced), every intervalMs while setup is open, and when the last page closes
// — then close the context so the profile is released. Handlers never throw.
export function watchSessionSetup(context, cookiePath, { intervalMs = 30_000, loadDelayMs = 1_000 } = {}) {
  let closed = false;
  let loadTimer;
  let chain = Promise.resolve();
  const save = () => {
    if (!closed) chain = chain.then(() => closed ? undefined : saveCookies(context, cookiePath)).catch(() => {});
    return chain;
  };
  const onLoad = () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(save, loadDelayMs);
    loadTimer.unref?.();
  };
  const onPageClose = () => {
    try {
      if (closed || context.pages().length) return;
      clearTimeout(loadTimer);
      // The close wrapper saves before the browser closes.
      Promise.resolve().then(() => context.close()).catch(() => {});
    } catch { /* never throw from an event handler */ }
  };
  const watch = page => { page.on('load', onLoad); page.on('close', onPageClose); };
  context.pages().forEach(watch);
  context.on('page', watch);
  const timer = setInterval(save, intervalMs);
  timer.unref?.();
  context.once('close', () => { closed = true; clearInterval(timer); clearTimeout(loadTimer); });
  return { save };
}
export async function openSessionSetup(recipe) {
  const key = sessionKey(recipe);
  if (setups.has(key)) return;
  const context = await acquireSession(recipe, { headless: false });
  setups.set(key, context);
  watchSessionSetup(context, cookiePaths.get(context));
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

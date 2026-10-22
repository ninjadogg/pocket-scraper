// Session setup must save cookies however it ends. No browser is launched: a fake
// context stands in for Playwright's BrowserContext.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistCookiesOnClose, watchSessionSetup } from '../browser-session.js';

class FakeContext extends EventEmitter {
  constructor(jar) { super(); this.jar = jar; this.open = []; this.alive = true; this.closes = 0; }
  pages() { return [...this.open]; }
  async cookies() { if (!this.alive) throw new Error('Target page, context or browser has been closed'); return this.jar; }
  async close() { this.closes++; if (this.alive) { this.alive = false; this.emit('close'); } }
  newPage() { const page = new EventEmitter(); this.open.push(page); this.emit('page', page); return page; }
  closePage(page) { this.open = this.open.filter(p => p !== page); page.emit('close', page); }
}
const sessionCookie = { name: 'login', value: 'fixture-session-1', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' };
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); }
};
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-setup-'));
  return { dir, cookiePath: join(dir, 'pocket-cookies.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test('closing the last setup window saves session-only cookies and releases the profile', async () => {
  const { cookiePath, done } = setup();
  try {
    const context = persistCookiesOnClose(new FakeContext([sessionCookie]), cookiePath);
    watchSessionSetup(context, cookiePath, { intervalMs: 60_000 });
    const first = context.newPage();
    const popup = context.newPage();
    context.closePage(popup);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(context.closes, 0, 'another window is still open');
    context.closePage(first);
    await until(() => context.closes === 1);
    assert.deepEqual(JSON.parse(readFileSync(cookiePath, 'utf8')), [sessionCookie]);
    if (process.platform !== 'win32') assert.equal(statSync(cookiePath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(cookiePath, '..')), ['pocket-cookies.json'], 'no temp files left');
  } finally { done(); }
});

test('setup saves periodically and after page loads, and stops when the context closes', async () => {
  const { cookiePath, done } = setup();
  try {
    const context = persistCookiesOnClose(new FakeContext([]), cookiePath);
    watchSessionSetup(context, cookiePath, { intervalMs: 25, loadDelayMs: 5 });
    const page = context.newPage();
    context.jar = [sessionCookie];
    await until(() => existsSync(cookiePath) && readFileSync(cookiePath, 'utf8').includes('fixture-session-1'));
    rmSync(cookiePath);
    page.emit('load');
    await until(() => existsSync(cookiePath));
    await context.close();
    rmSync(cookiePath);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(existsSync(cookiePath), false, 'no saves after close');
  } finally { done(); }
});

test('a browser that is already gone never throws from a handler and keeps the last saved file', async () => {
  const { cookiePath, done } = setup();
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    writeFileSync(cookiePath, JSON.stringify([sessionCookie]), { mode: 0o600 });
    const fake = new FakeContext([]);
    let underlyingCloses = 0;
    fake.close = async () => { underlyingCloses++; fake.emit('close'); };
    const context = persistCookiesOnClose(fake, cookiePath);
    watchSessionSetup(context, cookiePath, { intervalMs: 10, loadDelayMs: 1 });
    const page = context.newPage();
    context.alive = false; // the browser process exited with its window
    page.emit('load');
    assert.doesNotThrow(() => context.closePage(page));
    await until(() => underlyingCloses === 1);
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(JSON.parse(readFileSync(cookiePath, 'utf8')), [sessionCookie]);
  } finally { process.off('unhandledRejection', onUnhandled); done(); }
});

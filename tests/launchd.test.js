import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderPlist, runLaunchdCli } from '../scripts/launchd.js';

const SCRIPT = fileURLToPath(new URL('../scripts/launchd.js', import.meta.url));
const quiet = { stdout: () => {}, stderr: () => {} };

test('macOS launchd helper renders escaped plist XML and supports write/install/uninstall/status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-launchd-'));
  try {
    const plistPath = join(dir, 'com.pocketscraper.server.plist');
    const calls = [];
    let loaded = false;
    const execLaunchctl = args => {
      calls.push(args);
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'bootout') loaded = false;
      return { status: args[0] === 'print' && !loaded ? 113 : 0, stdout: '', stderr: '' };
    };

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

    runLaunchdCli(['--install', '--out', plistPath], { uid: 501, workingDirectory: dir, env: {}, execLaunchctl, sleep: () => {}, ...quiet });
    assert.equal(existsSync(plistPath), true);
    assert.match(readFileSync(plistPath, 'utf8'), /com\.pocketscraper\.server/);
    assert.deepEqual(calls.map(c => c[0]), ['bootout', 'print', 'bootstrap']);

    const statusRes = runLaunchdCli(['--status', '--out', plistPath], { uid: 501, workingDirectory: dir, execLaunchctl, ...quiet });
    assert.equal(statusRes.loaded, true);

    runLaunchdCli(['--uninstall', '--out', plistPath], { uid: 501, workingDirectory: dir, execLaunchctl, ...quiet });
    assert.equal(existsSync(plistPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plist carries every server setting except the connection token, and bad values are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-launchd-env-'));
  try {
    let err = '';
    const { xml } = runLaunchdCli(['--write', '--out', join(dir, 'agent.plist')], {
      workingDirectory: dir,
      env: { PATH: '/usr/bin', PORT: '4000', POCKET_SCRAPER_MAX_CONCURRENT: '3', POCKET_SCRAPER_RUN_TIMEOUT_MS: '3m', POCKET_SCRAPER_TOKEN: 'SECRET-token' },
      stdout: () => {}, stderr: text => { err += text; }
    });
    assert.match(xml, /<key>PORT<\/key>\s*<string>4000<\/string>/);
    assert.match(xml, /<key>POCKET_SCRAPER_MAX_CONCURRENT<\/key>\s*<string>3<\/string>/);
    assert.match(xml, /<key>POCKET_SCRAPER_RUN_TIMEOUT_MS<\/key>/);
    assert.equal(/TOKEN|SECRET/.test(xml), false, 'the token stays out of the plist');
    assert.match(err, /Warning: POCKET_SCRAPER_RUN_TIMEOUT_MS=3m is not a whole number/);
    assert.match(err, /POCKET_SCRAPER_TOKEN is not written to the plist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--install waits for the old service to unload and retries a failed bootstrap once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-launchd-reload-'));
  try {
    const plistPath = join(dir, 'agent.plist');
    const install = script => {
      const calls = [];
      const sleeps = [];
      const execLaunchctl = args => { calls.push(args[0]); return { status: script(args[0], calls), stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }; };
      const run = () => runLaunchdCli(['--install', '--out', plistPath], { uid: 501, workingDirectory: dir, env: {}, execLaunchctl, sleep: ms => sleeps.push(ms), ...quiet });
      return { calls, sleeps, run };
    };
    // Still loaded for two checks after bootout, then gone.
    const loaded = install((cmd, calls) => cmd === 'print' ? (calls.filter(c => c === 'print').length <= 2 ? 0 : 113) : 0);
    loaded.run();
    assert.deepEqual(loaded.calls, ['bootout', 'print', 'print', 'print', 'bootstrap']);
    assert.deepEqual(loaded.sleeps, [200, 200]);
    // First bootstrap fails, the retry succeeds.
    const flaky = install((cmd, calls) => cmd === 'print' ? 113 : cmd === 'bootstrap' && calls.filter(c => c === 'bootstrap').length === 1 ? 5 : 0);
    flaky.run();
    assert.deepEqual(flaky.calls, ['bootout', 'print', 'bootstrap', 'bootstrap']);
    assert.deepEqual(flaky.sleeps, [1000]);
    // Both attempts fail: report launchctl's message.
    const broken = install(cmd => cmd === 'print' ? 113 : cmd === 'bootstrap' ? 5 : 0);
    assert.throws(() => broken.run(), /launchctl bootstrap failed: Bootstrap failed: 5/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI runs when started through a symlink in a folder whose name has a space', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket launchd main '));
  try {
    const link = join(dir, 'launchd.js');
    symlinkSync(SCRIPT, link);
    const res = spawnSync(process.execPath, [link, '--print'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /<plist version="1.0">/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

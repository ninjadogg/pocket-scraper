// export-cookies: selection, formats and file safety. Fixture cookies only; every
// fixture value contains "SECRET" so tests can assert values never reach the terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, utimesSync, existsSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { main, loadSessions, selectCookies, parseSite, formatHeader, envValue, mergeEnv } from '../export-cookies.js';
import { sessionKey } from '../browser-session.js';

const SCRIPT = fileURLToPath(new URL('../export-cookies.js', import.meta.url));
const NOW = Date.UTC(2026, 9, 19, 12) ;
const FUTURE = NOW / 1000 + 86400 * 30;
const PAST = NOW / 1000 - 3600;
const c = (name, domain, extra = {}) => ({ name, value: `SECRET-${name}-${domain}`, domain, path: '/', expires: FUTURE, httpOnly: true, secure: true, sameSite: 'Lax', ...extra });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-export-'));
  const dataPath = join(dir, 'store.json');
  const recipes = [{ name: 'Docs', url: 'https://docs.example.com/notes' }, { name: 'SSO', url: 'https://login.example.com/' }];
  writeFileSync(dataPath, JSON.stringify({ recipes, runs: [], records: [] }));
  const profile = (recipe, cookies, mtime) => {
    const folder = join(dir, 'browser-profiles', sessionKey(recipe));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'pocket-cookies.json');
    writeFileSync(file, JSON.stringify(cookies), { mode: 0o600 });
    utimesSync(file, mtime, mtime);
  };
  // Older session: the docs recipe.
  profile(recipes[0], [
    c('docs_sid', 'docs.example.com', { expires: -1 }),
    c('shared', '.example.com', { value: 'SECRET-old-shared' }),
    c('api_only', 'docs.example.com', { path: '/api' }),
    c('stale', 'docs.example.com', { expires: PAST }),
    c('plain', 'docs.example.com', { secure: false }),
    c('other_site', 'www.other.test')
  ], new Date(NOW - 86400_000));
  // Newer session: an SSO login that set a parent-domain cookie.
  profile(recipes[1], [
    c('shared', '.example.com', { value: 'SECRET-new-shared' }),
    c('sso', '.example.com'),
    c('login_only', 'login.example.com')
  ], new Date(NOW - 3600_000));
  return { dir, dataPath, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(args, dataPath, opts = {}) {
  let out = '', err = '';
  const code = main(args, { dataPath, now: NOW, stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } }, ...opts });
  return { code, out, err };
}
const noSecrets = text => assert.equal(/SECRET/.test(text), false, `a cookie value leaked: ${text}`);

test('selection follows browser rules: domain, path, secure, expiry', () => {
  const f = fixture();
  try {
    const { sessions } = loadSessions(f.dataPath);
    const names = url => selectCookies(sessions, parseSite(url), { now: NOW }).cookies.map(x => x.name).sort();
    assert.deepEqual(names('https://docs.example.com/'), ['docs_sid', 'plain', 'shared', 'sso']);
    assert.deepEqual(names('docs.example.com/api/v1'), ['api_only', 'docs_sid', 'plain', 'shared', 'sso']);
    assert.deepEqual(names('https://docs.example.com/apiary'), ['docs_sid', 'plain', 'shared', 'sso'], 'path prefix must end at a "/"');
    assert.deepEqual(names('http://docs.example.com/'), ['plain'], 'secure cookies only over https');
    assert.deepEqual(names('https://example.com/'), ['shared', 'sso'], 'host-only cookies stay on their host');
    assert.deepEqual(names('https://a.docs.example.com/'), ['shared', 'sso']);
    assert.deepEqual(names('https://badexample.com/'), []);
    const docs = selectCookies(sessions, parseSite('https://docs.example.com/api/x'), { now: NOW });
    assert.equal(docs.cookies[0].name, 'api_only', 'longer paths first');
    assert.deepEqual(docs.expired.map(x => x.name), ['stale']);
  } finally { f.done(); }
});

test('the same cookie in several saved sessions comes from the most recently saved one, and the summary says so', () => {
  const f = fixture();
  try {
    const { sessions } = loadSessions(f.dataPath);
    const shared = selectCookies(sessions, parseSite('docs.example.com'), { now: NOW }).cookies.filter(x => x.name === 'shared');
    assert.deepEqual(shared.map(x => x.value), ['SECRET-new-shared']);
    const out = join(f.dir, 'docs.cookie');
    const r = run(['--site', 'docs.example.com', '--out', out], f.dataPath);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /cookie shared \(\.example\.com \/\) is saved in 2 sessions; used the most recently saved/);
    assert.match(r.err, /session-only cookies \(docs_sid\)/);
    assert.match(r.err, /1 matching cookie has expired and was left out: stale/);
    assert.match(r.err, /wider login than docs\.example\.com alone \(cookies set on a parent domain: shared \(\.example\.com\), sso \(\.example\.com\)\)\. Use --only/);
    noSecrets(r.err);
    assert.equal(r.out, '');
  } finally { f.done(); }
});

test('header output is the raw `a=b; c=d` line that release radar --cookie-header parses', t => {
  const f = fixture();
  try {
    const cookies = [
      { name: 'sid', value: 'abc/+=def%20==' }, { name: 'pref', value: 'x y,z:1' },
      { name: 'JWT', value: 'eyJhbGciOi.eyJzdWIi.sig-_' }, { name: 'q', value: '"quoted"' }
    ];
    const header = formatHeader(cookies);
    assert.equal(header, 'sid=abc/+=def%20==; pref=x y,z:1; JWT=eyJhbGciOi.eyJzdWIi.sig-_; q="quoted";');
    assert.throws(() => formatHeader([{ name: 'bad', value: 'a;b' }]), /cookie "bad": its value contains ";"/);
    assert.throws(() => formatHeader([{ name: 'bad', value: 'a\nb' }]), /control/);
    const file = join(f.dir, 'h.cookie');
    writeFileSync(file, header + '\n');

    // Use release radar's own jar_from_header when that checkout exists; otherwise a
    // verbatim copy of it (release-radar 66011e1, scripts/safari_session.py).
    const real = process.env.RELEASE_RADAR_SAFARI_SESSION || join(homedir(), 'Repos', 'release-radar', 'scripts', 'safari_session.py');
    const py = `
import importlib.util, json, sys, time, http.cookiejar
path, header_file = sys.argv[1], sys.argv[2]
try:
    spec = importlib.util.spec_from_file_location("safari_session", path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    jar_from_header, source = mod.jar_from_header, "release-radar"
except FileNotFoundError:
    source = "vendored copy"
    def jar_from_cookies(cookies):
        jar = http.cookiejar.CookieJar()
        for c in cookies:
            dom = c["domain"]
            jar.set_cookie(http.cookiejar.Cookie(version=0, name=c["name"], value=c["value"], port=None, port_specified=False, domain=dom, domain_specified=dom.startswith("."), domain_initial_dot=dom.startswith("."), path=c["path"] or "/", path_specified=True, secure=c["secure"], expires=c["expires"], discard=False, comment=None, comment_url=None, rest={}))
        return jar
    def jar_from_header(header_text, domain):
        cookies = []
        for pair in header_text.strip().strip('"').split(";"):
            if "=" in pair:
                name, _, value = pair.strip().partition("=")
                cookies.append({"domain": "." + domain.lstrip("."), "name": name, "value": value, "path": "/", "secure": True, "httponly": False, "expires": int(time.time()) + 86400 * 30})
        return jar_from_cookies(cookies)
jar = jar_from_header(open(header_file).read(), "docs.example.com")
print(json.dumps({"source": source, "cookies": sorted([c.name, c.value] for c in jar)}))
`;
    const python = ['python3', 'python'].find(cmd => !spawnSync(cmd, ['--version']).error);
    if (!python) { t.skip('python3 not available: header parse not cross-checked'); return; }
    const result = spawnSync(python, ['-I', '-c', py, real, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    t.diagnostic(`parsed with ${parsed.source}`);
    assert.deepEqual(parsed.cookies, cookies.map(x => [x.name, x.value]).sort());
  } finally { f.done(); }
});

// Compose v2 (compose-go) .env rules for an unquoted value: trim, an inline comment
// starts at whitespace + "#", and $VAR / ${VAR} are interpolated.
function composeDotenv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    assert.ok(!/^\s*["'`]/.test(value), 'exporter never emits quoted values');
    const comment = value.search(/\s#/);
    if (comment !== -1) value = value.slice(0, comment);
    env[m[1]] = value.trim().replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, '');
  }
  return env;
}
// dotenv (npm, used by many hosts) line rule for unquoted values: stop at "#", trim.
function npmDotenv(text) {
  const env = {};
  const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  let m;
  while ((m = LINE.exec(text))) env[m[1]] = (m[2] || '').trim();
  return env;
}

test('env lines round-trip through .env parsers; unsafe values are refused by name', t => {
  const header = 'sid=abc/+=def%20==; pref=x y,z:1; t={a:1}';
  const cookies = [{ name: 'sid', value: 'abc/+=def%20==' }, { name: 'pref', value: 'x y,z:1' }, { name: 't', value: '{a:1}' }];
  const line = `RADAR_AUTH_VENDOR=${envValue('RADAR_AUTH_VENDOR', cookies)}\n`;
  assert.equal(line, `RADAR_AUTH_VENDOR=${header}\n`);
  assert.equal(composeDotenv(line).RADAR_AUTH_VENDOR, header);
  assert.equal(npmDotenv(line).RADAR_AUTH_VENDOR, header);
  assert.equal(parseEnv(line).RADAR_AUTH_VENDOR, header, 'Node built-in .env parser');
  // docker run --env-file takes the value literally.
  assert.equal(line.slice(line.indexOf('=') + 1, -1), header);
  const python = ['python3', 'python'].find(cmd => !spawnSync(cmd, ['--version']).error);
  const dotenv = python && spawnSync(python, ['-I', '-c', 'import sys, json, io\nfrom dotenv import dotenv_values\nprint(json.dumps(dotenv_values(stream=io.StringIO(sys.argv[1]))))', line], { encoding: 'utf8' });
  if (dotenv?.status === 0) assert.equal(JSON.parse(dotenv.stdout).RADAR_AUTH_VENDOR, header, 'python-dotenv');
  else t.diagnostic('python-dotenv not available; compose/npm/Node parsers checked');

  for (const ch of ['#', '$', '"', "'", '`', '\\']) {
    assert.throws(() => envValue('RADAR_AUTH_VENDOR', [{ name: 'ok', value: 'a' }, { name: 'tricky', value: `SECRET${ch}x` }]),
      e => /cookie "tricky" contains/.test(e.message) && !/SECRET/.test(e.message), `refuses ${ch}`);
  }
  assert.throws(() => envValue('lower', cookies), /Invalid variable name/);
  assert.equal(envValue('SCRAPER_CONNECTWISE_AUTHTOKEN', [{ name: 'other', value: 'x' }, { name: 'authtoken', value: 'eyJ.abc.def' }]), 'eyJ.abc.def', 'bare JWT for ConnectWise');
});

test('--list shows sessions without any cookie value', () => {
  const f = fixture();
  try {
    const r = run(['--list'], f.dataPath);
    assert.equal(r.code, 0);
    noSecrets(r.out); noSecrets(r.err);
    assert.match(r.out, /https:\/\/docs\.example\.com {2}\(recipes: Docs\)/);
    assert.match(r.out, /cookies {9}6 \(1 expired\)/);
    assert.match(r.out, /covers {10}\.example\.com, docs\.example\.com, www\.other\.test/);
    assert.match(r.out, /session-only {4}yes/);
    assert.match(r.out, /earliest expiry \d{4}-/);
    // A corrupt file is reported without quoting it.
    const bad = join(f.dir, 'browser-profiles', 'f'.repeat(64));
    mkdirSync(bad); writeFileSync(join(bad, 'pocket-cookies.json'), '[{"name":"x","value":"SECRET-broken"');
    const again = run(['--list'], f.dataPath);
    assert.match(again.out, /problem {9}not a valid cookie file/);
    noSecrets(again.out);
  } finally { f.done(); }
});

test('refuses without --out or --stdout, and the CLI exits 2 with a --list hint when nothing matches', () => {
  const f = fixture();
  try {
    const env = { ...process.env, POCKET_SCRAPER_DATA: f.dataPath };
    const none = spawnSync(process.execPath, [SCRIPT, '--site', 'docs.example.com'], { env, encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.equal(none.stdout, '');
    assert.match(none.stderr, /--out <file>.*or --stdout/);
    noSecrets(none.stderr);
    const missing = spawnSync(process.execPath, [SCRIPT, '--site', 'nowhere.test', '--stdout'], { env, encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /no saved cookies would be sent to https:\/\/nowhere\.test\/[\s\S]*export-cookies -- --list/);
    const ok = spawnSync(process.execPath, [SCRIPT, '--site', 'login.example.com', '--only', 'login_only', '--stdout'], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'login_only=SECRET-login_only-login.example.com\n');
    noSecrets(ok.stderr);
  } finally { f.done(); }
});

test('--out writes owner-only, atomically, and refuses symlinks and existing files', t => {
  const f = fixture();
  try {
    const out = join(f.dir, 'site.cookie');
    let r = run(['--site', 'https://docs.example.com/', '--out', out], f.dataPath);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(out, 'utf8'), 'shared=SECRET-new-shared; sso=SECRET-sso-.example.com; docs_sid=SECRET-docs_sid-docs.example.com; plain=SECRET-plain-docs.example.com\n');
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
    r = run(['--site', 'docs.example.com', '--out', out], f.dataPath);
    assert.equal(r.code, 1);
    assert.match(r.err, /Refusing to replace existing .*--force/);
    r = run(['--site', 'docs.example.com', '--out', out, '--force'], f.dataPath);
    assert.equal(r.code, 0, r.err);

    const state = join(f.dir, 'site.storage-state.json');
    r = run(['--site', 'docs.example.com', '--only', 'sso', '--format', 'storage-state', '--out', state], f.dataPath);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(readFileSync(state, 'utf8'));
    assert.deepEqual(parsed.origins, []);
    assert.deepEqual(Object.keys(parsed.cookies[0]).sort(), ['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value']);

    const victim = join(f.dir, 'victim.txt');
    writeFileSync(victim, 'keep');
    const link = join(f.dir, 'link.cookie');
    try { symlinkSync(victim, link); } catch { t.diagnostic('symlinks unavailable here; symlink refusal not exercised'); return; }
    r = run(['--site', 'docs.example.com', '--out', link, '--force'], f.dataPath);
    assert.equal(r.code, 1);
    assert.match(r.err, /symbolic link/);
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
  } finally { f.done(); }
});

test('--env writes one line per variable; all-or-nothing when any site lacks cookies', () => {
  const f = fixture();
  try {
    const out = join(f.dir, 'radar.env');
    let r = run(['--env', 'RADAR_AUTH_DOCS=https://docs.example.com/@docs_sid,plain', '--env', 'RADAR_AUTH_LOGIN=login.example.com@login_only', '--out', out], f.dataPath);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(out, 'utf8'),
      'RADAR_AUTH_DOCS=docs_sid=SECRET-docs_sid-docs.example.com; plain=SECRET-plain-docs.example.com\n' +
      'RADAR_AUTH_LOGIN=login_only=SECRET-login_only-login.example.com\n');
    assert.match(r.err, /^RADAR_AUTH_DOCS: https:\/\/docs\.example\.com\/ — 2 cookies: docs_sid, plain$/m);
    assert.match(r.err, /^RADAR_AUTH_LOGIN: https:\/\/login\.example\.com\/ — 1 cookie: login_only$/m);
    noSecrets(r.err);

    // --format env --var still works for one pair.
    const single = join(f.dir, 'single.cookies.env');
    r = run(['--site', 'login.example.com', '--only', 'login_only', '--format', 'env', '--var', 'RADAR_AUTH_X', '--out', single], f.dataPath);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(single, 'utf8'), 'RADAR_AUTH_X=login_only=SECRET-login_only-login.example.com\n');
    r = run(['--site', 'login.example.com', '--format', 'env', '--var', 'bad-name', '--stdout'], f.dataPath);
    assert.equal(r.code, 1);

    // One missing site (or one missing --only name) writes nothing at all.
    const none = join(f.dir, 'none.env');
    for (const args of [
      ['--env', 'RADAR_AUTH_DOCS=docs.example.com', '--env', 'RADAR_AUTH_GONE=https://gone.test'],
      ['--env', 'RADAR_AUTH_DOCS=docs.example.com@docs_sid,nope'],
      ['--env', 'RADAR_AUTH_DOCS=docs.example.com@stale']
    ]) {
      r = run([...args, '--out', none], f.dataPath);
      assert.equal(r.code, 2, r.err);
      assert.equal(existsSync(none), false);
      assert.match(r.err, /missing: RADAR_AUTH_(GONE|DOCS)/);
      assert.match(r.err, /Nothing was written/);
      noSecrets(r.err);
    }
    r = run(['--site', 'docs.example.com', '--only', 'nope', '--out', none], f.dataPath);
    assert.equal(r.code, 2);
    assert.equal(existsSync(none), false);
  } finally { f.done(); }
});

test('--merge replaces only the named variables and keeps every other byte', () => {
  const f = fixture();
  try {
    const out = join(f.dir, '.env');
    const before = [
      '# ISTAR worker settings\r',
      'API_WORKER_URL=http://api:3000\r',
      '',
      '  # RADAR_AUTH_LOGIN=commented out stays',
      'RADAR_AUTH_LOGIN=old-value # note',
      'MULTI="first line',
      'RADAR_AUTH_DOCS=inside a quoted value, not a variable',
      'end"',
      'export   OTHER = keep me  ',
      'TRAILING=no newline at end'
    ].join('\n');
    writeFileSync(out, before, { mode: 0o640 });
    if (process.platform !== 'win32') chmodSync(out, 0o640);
    const r = run(['--env', 'RADAR_AUTH_LOGIN=login.example.com@login_only', '--env', 'RADAR_AUTH_DOCS=docs.example.com@docs_sid', '--out', out, '--merge'], f.dataPath);
    assert.equal(r.code, 0, r.err);
    const expected = before.replace('RADAR_AUTH_LOGIN=old-value # note', 'RADAR_AUTH_LOGIN=login_only=SECRET-login_only-login.example.com')
      + '\r\nRADAR_AUTH_DOCS=docs_sid=SECRET-docs_sid-docs.example.com\r\n';
    assert.equal(readFileSync(out, 'utf8'), expected);
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600, 'never looser than 0600');
    noSecrets(r.err);
    // A second merge only swaps the values again.
    assert.equal(mergeEnv(expected, { RADAR_AUTH_DOCS: 'x=1' }), expected.replace('docs_sid=SECRET-docs_sid-docs.example.com', 'x=1'));
    assert.throws(() => mergeEnv('RADAR_AUTH_DOCS="a\nb"\n', { RADAR_AUTH_DOCS: 'x=1' }), /multi-line/);
    const merged = run(['--site', 'docs.example.com', '--out', out, '--merge'], f.dataPath);
    assert.equal(merged.code, 1, '--merge needs env output');
  } finally { f.done(); }
});

test('--merge into a file that cannot be read is a clean error, not a crash', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'permissions are not enforced here' }, () => {
  const f = fixture();
  try {
    const out = join(f.dir, '.env');
    writeFileSync(out, 'KEEP=1\n', { mode: 0o600 });
    chmodSync(out, 0o200);
    const r = run(['--env', 'RADAR_AUTH_DOCS=docs.example.com@docs_sid', '--out', out, '--merge'], f.dataPath);
    assert.equal(r.code, 1);
    assert.match(r.err, /export-cookies: Cannot read .*\.env: EACCES/);
    chmodSync(out, 0o600);
    assert.equal(readFileSync(out, 'utf8'), 'KEEP=1\n', 'the file is untouched');
  } finally { f.done(); }
});

test('export-cookies does not load Playwright', () => {
  const hook = fileURLToPath(new URL('./fixtures/no-playwright.mjs', import.meta.url));
  const res = spawnSync(process.execPath, ['--import', hook, SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /Usage:/);
  // The hook does catch a module that needs Playwright.
  const control = spawnSync(process.execPath, ['--import', hook, fileURLToPath(new URL('../browser-session.js', import.meta.url))], { encoding: 'utf8' });
  assert.notEqual(control.status, 0);
  assert.match(control.stderr, /Playwright was loaded/);
});

test('the CLI runs when started through a symlink in a folder whose name has a space', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket export main '));
  try {
    const link = join(dir, 'export-cookies.js');
    symlinkSync(SCRIPT, link);
    const res = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /Usage:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an expired copy in a newer session never hides a live copy in an older one', () => {
  const url = parseSite('docs.example.com');
  const newer = { cookies: [c('sso', '.example.com', { value: 'SECRET-expired', expires: PAST })] };
  const older = { cookies: [c('sso', '.example.com', { value: 'SECRET-live' })] };
  const picked = selectCookies([newer, older], url, { now: NOW });
  assert.deepEqual(picked.cookies.map(x => x.value), ['SECRET-live']);
  assert.deepEqual(picked.expired, []);
  const none = selectCookies([newer], url, { now: NOW });
  assert.deepEqual(none.cookies, []);
  assert.deepEqual(none.expired.map(x => x.value), ['SECRET-expired'], 'still reported when no live copy exists');
});

test('a relative --out is written where the command was typed, not in the package folder', () => {
  const f = fixture();
  try {
    const r = run(['--site', 'docs.example.com', '--out', 'docs.cookie'], f.dataPath, { cwd: f.dir });
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(join(f.dir, 'docs.cookie')), true);
  } finally { f.done(); }
});

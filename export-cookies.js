#!/usr/bin/env node
// Hand a website login saved by Pocket Scraper to another tool as a Cookie header,
// a .env line, or a Playwright storage state. Cookie values are written only to the
// file named by --out or, when asked explicitly, to --stdout; never to the terminal
// summary, which lists cookie names only.
import { parseArgs } from 'node:util';
import { readdirSync, readFileSync, realpathSync, statSync, lstatSync, writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_PATH } from './store.js';
import { sessionKey, COOKIE_FILE, profileRootFor } from './session-paths.js';

export { COOKIE_FILE, profileRootFor };
/** Above this many cookies, the summary suggests --only. */
export const WIDE_SELECTION = 10;
/** ISTAR and its scraper_worker share this variable and expect the bare MindTouch JWT. */
export const CONNECTWISE_ENV = 'SCRAPER_CONNECTWISE_AUTHTOKEN';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// RFC 6265 cookie-name token characters.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Characters a .env parser may treat specially in an unquoted value: comments (#),
// quotes, interpolation ($), escapes (\) and command substitution (`).
const ENV_UNSAFE = /[#"'`$\\]/;

export class ExportError extends Error {
  constructor(message, code = 1) { super(message); this.exitCode = code; }
}

const USAGE = `Usage:
  npm run export-cookies -- --list
  npm run export-cookies -- --env VAR=<url-or-host>[@name,...] [--env ...] (--out <file> [--merge] | --stdout)
  npm run export-cookies -- --site <url-or-host> [--only name,...] [--format header|env|storage-state] [--var NAME]
                            (--out <file> [--force | --merge] | --stdout)

Exported cookies are a live login. Write them to a private file with --out; --stdout
must be asked for explicitly. --out never replaces an existing file unless --force
(replace it) or --merge (env output: update only the named variables) is given.`;

// ── saved sessions ───────────────────────────────────────────────────────────

function originLabels(dataPath) {
  const labels = new Map();
  try {
    const store = JSON.parse(readFileSync(dataPath, 'utf8'));
    for (const recipe of Array.isArray(store.recipes) ? store.recipes : []) {
      try {
        const key = sessionKey(recipe);
        const label = labels.get(key) || { origin: new URL(recipe.url).origin, recipes: [] };
        label.recipes.push(String(recipe.name || ''));
        labels.set(key, label);
      } catch { /* a recipe without a valid URL has no session */ }
    }
  } catch { /* labels are a convenience only */ }
  return labels;
}

const validCookie = c => c && typeof c === 'object' && typeof c.name === 'string' && typeof c.value === 'string'
  && typeof c.domain === 'string' && c.domain !== '';

/** Every saved session file, newest first. Never includes file contents in errors. */
export function loadSessions(dataPath = DATA_PATH) {
  const root = profileRootFor(dataPath);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return { root, sessions: [] };
    throw new ExportError(`Cannot read ${root}: ${error.code || 'error'}`);
  }
  const labels = originLabels(dataPath);
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, COOKIE_FILE);
    let stat;
    try { stat = statSync(file); } catch { continue; }
    const session = { id: entry.name, file, mtimeMs: stat.mtimeMs, label: labels.get(entry.name), cookies: [], malformed: 0, error: null };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error();
      for (const cookie of parsed) validCookie(cookie) ? session.cookies.push(cookie) : session.malformed++;
    } catch {
      // JSON.parse messages quote the input, which may be a cookie value.
      session.error = 'not a valid cookie file';
    }
    sessions.push(session);
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  return { root, sessions };
}

const expired = (cookie, now) => cookie.expires > 0 && cookie.expires * 1000 < now;
const sessionOnly = cookie => !(cookie.expires > 0);
const iso = seconds => new Date(seconds * 1000).toISOString();
const shortId = id => id.slice(0, 12);

export function listSessions({ root, sessions }, now = Date.now()) {
  if (!sessions.length) return `No saved sessions in ${root}.\nUse "Open session setup" in the dashboard to save a login first.\n`;
  const lines = [`Saved sessions in ${root} (${sessions.length}), newest first:`];
  for (const s of sessions) {
    lines.push('', `profile ${shortId(s.id)}${s.label ? `  ${s.label.origin}  (recipes: ${s.label.recipes.join(', ')})` : '  (no recipe uses this profile now)'}`);
    lines.push(`  saved           ${new Date(s.mtimeMs).toISOString()}`);
    if (s.error) { lines.push(`  problem         ${s.error}`); continue; }
    const domains = [...new Set(s.cookies.map(c => c.domain.toLowerCase()))].sort();
    const dated = s.cookies.filter(c => c.expires > 0 && !expired(c, now)).map(c => c.expires);
    lines.push(`  cookies         ${s.cookies.length} (${s.cookies.filter(c => expired(c, now)).length} expired${s.malformed ? `, ${s.malformed} malformed` : ''})`);
    lines.push(`  covers          ${domains.join(', ') || '-'}`);
    lines.push(`  earliest expiry ${dated.length ? iso(Math.min(...dated)) : '-'}`);
    lines.push(`  session-only    ${s.cookies.some(sessionOnly) ? 'yes (these end when the site ends the login session)' : 'no'}`);
  }
  return lines.join('\n') + '\n';
}

// ── selection ────────────────────────────────────────────────────────────────

export function parseSite(input) {
  const text = String(input || '').trim();
  if (!text) throw new ExportError('A site is required (a URL or a host name).');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch {
    throw new ExportError(`Not a valid URL or host: ${text}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ExportError('Only http and https sites are supported.');
  if (url.username || url.password) throw new ExportError('Leave user names and passwords out of the site URL.');
  return url;
}

export function domainMatches(cookieDomain, host) {
  const domain = cookieDomain.toLowerCase();
  if (!domain.startsWith('.')) return host === domain;
  return host === domain.slice(1) || host.endsWith(domain);
}

export function pathMatches(cookiePath, requestPath) {
  const path = cookiePath || '/';
  if (requestPath === path) return true;
  return requestPath.startsWith(path) && (path.endsWith('/') || requestPath[path.length] === '/');
}

const isParentDomain = (cookie, host) => {
  const domain = cookie.domain.toLowerCase().replace(/^\./, '');
  return domain !== host;
};

/**
 * The cookies a browser would send to `url`, gathered across every saved session.
 * When the same name+domain+path is saved more than once, the most recently saved
 * session with a live copy wins (it holds the newest state the site set).
 */
export function selectCookies(sessions, url, { now = Date.now(), only } = {}) {
  const host = url.hostname.toLowerCase();
  const requestPath = url.pathname || '/';
  const https = url.protocol === 'https:';
  const chosen = new Map();
  const stale = new Map();
  const duplicates = [];
  for (const session of sessions) { // newest first
    for (const cookie of session.cookies) {
      if (!domainMatches(cookie.domain, host) || !pathMatches(cookie.path, requestPath)) continue;
      if (cookie.secure && !https) continue;
      if (only && !only.includes(cookie.name)) continue;
      const key = `${cookie.name}\0${cookie.domain.toLowerCase()}\0${cookie.path || '/'}`;
      // An expired copy never hides a live one saved in an older session file.
      if (expired(cookie, now)) {
        if (!stale.has(key)) stale.set(key, cookie);
        continue;
      }
      const held = chosen.get(key);
      if (held) {
        if (held.session !== session) {
          const note = duplicates.find(d => d.key === key);
          if (note) note.count++;
          else duplicates.push({ key, name: cookie.name, domain: cookie.domain, path: cookie.path || '/', count: 2, used: held.session });
        }
        continue;
      }
      chosen.set(key, { cookie, session });
    }
  }
  const live = [...chosen.values()];
  // Browsers send longer paths first; keep the saved order otherwise.
  const cookies = live.map((c, i) => ({ ...c, i }))
    .sort((a, b) => (b.cookie.path || '/').length - (a.cookie.path || '/').length || a.i - b.i)
    .map(c => c.cookie);
  const missing = only ? only.filter(name => !cookies.some(c => c.name === name)) : [];
  const expiredOnly = [...stale].filter(([key]) => !chosen.has(key)).map(([, cookie]) => cookie);
  return { url, host, cookies, expired: expiredOnly, duplicates, missing, only };
}

// ── formats ──────────────────────────────────────────────────────────────────

function checkCookie(cookie) {
  if (!COOKIE_NAME.test(cookie.name)) return 'its name contains characters a Cookie header cannot carry';
  if (/[^\x20-\x7e]/.test(cookie.value)) return 'its value contains control or non-ASCII characters';
  if (cookie.value.includes(';')) return 'its value contains ";"';
  if (cookie.value !== cookie.value.trim()) return 'its value starts or ends with a space';
  return null;
}

/**
 * A raw Cookie header, `a=b; c=d`, plus a newline. No `Cookie:` prefix: release
 * radar's jar_from_header() splits the file on ";" and "=" after .strip().strip('"'),
 * so a prefix would become part of the first name. If the last value ends with a
 * double quote, a trailing ";" protects it from that strip('"').
 */
export function formatHeader(cookies) {
  const bad = cookies.map(c => [c.name, checkCookie(c)]).filter(([, why]) => why);
  if (bad.length) {
    throw new ExportError(`Cannot write a Cookie header: ${bad.map(([name, why]) => `cookie "${name}": ${why}`).join('; ')}. Use --format storage-state for this site.`);
  }
  const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  return header.endsWith('"') ? header + ';' : header;
}

/**
 * The value for one env var. SCRAPER_CONNECTWISE_AUTHTOKEN carries the bare
 * `authtoken` value: ISTAR's scraper_worker prepends `authtoken=` unconditionally
 * and release_radar_worker does so when the value has no "=".
 */
export function envValue(name, cookies) {
  if (!ENV_NAME.test(name)) throw new ExportError(`Invalid variable name "${name}": use capital letters, digits and _, not starting with a digit.`);
  let value;
  if (name === CONNECTWISE_ENV) {
    const tokens = cookies.filter(c => c.name === 'authtoken');
    if (!tokens.length) throw new ExportError(`${CONNECTWISE_ENV} needs the "authtoken" cookie, which is not among the selected cookies.`, 2);
    const why = checkCookie(tokens[0]);
    if (why) throw new ExportError(`Cannot write ${name}: cookie "authtoken": ${why}.`);
    value = tokens[0].value;
    if (value.includes('=')) throw new ExportError(`Cannot write ${name}: the authtoken value contains "=", so ISTAR would read it as a whole Cookie header. Use RADAR_AUTH_* style output instead.`);
  } else {
    value = formatHeader(cookies);
  }
  const unsafe = (name === CONNECTWISE_ENV ? cookies.filter(c => c.name === 'authtoken').slice(0, 1) : cookies)
    .filter(c => ENV_UNSAFE.test(c.value)).map(c => c.name);
  if (unsafe.length || ENV_UNSAFE.test(value)) {
    throw new ExportError(`Cannot write ${name} as a .env line: cookie ${unsafe.map(n => `"${n}"`).join(', ') || 'value'} contains # " ' \` $ or \\, which .env parsers (docker compose, Easypanel, docker --env-file) treat differently. Export it with --format header and set the variable as a secret by hand.`);
  }
  if (!value) throw new ExportError(`Cannot write ${name}: the value would be empty.`);
  return value;
}

export function formatStorageState(cookies) {
  const keep = ({ name, value, domain, path, expires, httpOnly, secure, sameSite }) =>
    ({ name, value, domain, path: path || '/', expires: typeof expires === 'number' ? expires : -1, httpOnly: Boolean(httpOnly), secure: Boolean(secure), sameSite: sameSite || 'Lax' });
  return JSON.stringify({ cookies: cookies.map(keep), origins: [] }, null, 2) + '\n';
}

// ── .env merge ───────────────────────────────────────────────────────────────

const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=)(.*)$/;

/** Does an assignment's value open a quote it does not close on the same line? */
function opensMultiline(value) {
  const v = value.trimStart();
  const quote = v[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  for (let i = 1; i < v.length; i++) {
    if (v[i] === '\\' && quote === '"') { i++; continue; }
    if (v[i] === quote) return null;
  }
  return quote;
}

/**
 * Replace the lines that assign `values`' names and keep every other byte. Names
 * not present are appended. Lines inside another variable's multi-line quoted
 * value are never touched.
 */
export function mergeEnv(original, values) {
  const parts = original.split('\n');
  const seen = new Set();
  let open = null;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    if (open) { if (line.includes(open)) open = null; continue; }
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    const [, lead, name, eq, value] = match;
    const quote = opensMultiline(value);
    if (Object.hasOwn(values, name)) {
      if (quote) throw new ExportError(`Cannot merge: ${name} in the existing file has a multi-line quoted value. Remove it and run again.`);
      parts[i] = `${lead}${name}${eq}${values[name]}${cr}`;
      seen.add(name);
    } else if (quote) open = quote;
  }
  let text = parts.join('\n');
  const missing = Object.keys(values).filter(name => !seen.has(name));
  if (missing.length) {
    const eol = /\r\n/.test(original) ? '\r\n' : '\n';
    if (text && !text.endsWith('\n')) text += eol;
    text += missing.map(name => `${name}=${values[name]}${eol}`).join('');
  }
  return text;
}

// ── output ───────────────────────────────────────────────────────────────────

function inspectTarget(target) {
  let stat;
  try { stat = lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ExportError(`Cannot check ${target}: ${error.code || 'error'}`);
  }
  if (stat.isSymbolicLink()) throw new ExportError(`Refusing to write ${target}: it is a symbolic link.`);
  if (!stat.isFile()) throw new ExportError(`Refusing to write ${target}: it is not a regular file.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new ExportError(`Refusing to write ${target}: it is owned by another user.`);
  return stat;
}

/**
 * Atomically write a secret file, owner-only. Refuses symlinks, non-regular files
 * and files owned by someone else; replaces an existing file only when `replace`
 * is set, or merges into it when `merge(oldText)` is given.
 */
export function writeSecret(target, text, { replace = false, merge } = {}) {
  const abs = resolve(target);
  const stat = inspectTarget(abs);
  if (stat && !replace && !merge) throw new ExportError(`Refusing to replace existing ${abs}. Pass --force to replace it, or --merge (env output) to update only the exported variables.`);
  let mode = 0o600;
  if (stat && merge) {
    let old;
    try { old = readFileSync(abs, 'utf8'); }
    catch (error) { throw new ExportError(`Cannot read ${abs}: ${error.code || error.message}`); }
    text = merge(old);
    mode = stat.mode & 0o600; // keep the file's mode, never looser than owner-only
  } else if (merge) text = merge('');
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    // rename replaces the directory entry itself; it never follows a symlink
    // planted after the check above.
    renameSync(tmp, abs);
  } catch (error) {
    rmSync(tmp, { force: true });
    if (error instanceof ExportError) throw error;
    throw new ExportError(`Cannot write ${abs}: ${error.code || error.message}`);
  }
  return abs;
}

// ── command line ─────────────────────────────────────────────────────────────

const splitNames = text => {
  const names = String(text).split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) throw new ExportError('--only / @names needs at least one cookie name.');
  for (const name of names) if (!COOKIE_NAME.test(name)) throw new ExportError(`Not a cookie name: ${name}`);
  return [...new Set(names)];
};

/** `VAR=<url-or-host>[@name,...]`; the site may not contain "@". */
export function parsePair(text) {
  const eq = String(text).indexOf('=');
  if (eq < 1) throw new ExportError(`--env expects VAR=<url-or-host>[@cookie,...], got "${text}".`);
  const name = text.slice(0, eq);
  let site = text.slice(eq + 1);
  let only;
  const at = site.lastIndexOf('@');
  if (at !== -1) { only = splitNames(site.slice(at + 1)); site = site.slice(0, at); }
  if (site.includes('@')) throw new ExportError(`--env ${name}: the site may not contain "@".`);
  if (!ENV_NAME.test(name)) throw new ExportError(`Invalid variable name "${name}": use capital letters, digits and _, not starting with a digit.`);
  return { name, url: parseSite(site), only };
}

function describe(selection, stderr, label) {
  const { cookies, expired: stale, duplicates, url, host, only } = selection;
  const names = cookies.map(c => c.name);
  stderr.write(`${label}: ${url.href} — ${cookies.length} cookie${cookies.length === 1 ? '' : 's'}: ${names.join(', ') || '-'}\n`);
  const dated = cookies.filter(c => c.expires > 0);
  if (dated.length) {
    const first = dated.reduce((a, b) => (b.expires < a.expires ? b : a));
    stderr.write(`  earliest expiry ${iso(first.expires)} (${first.name})\n`);
  }
  const warn = text => stderr.write(`  warning: ${text}\n`);
  if (stale.length) warn(`${stale.length} matching cookie${stale.length === 1 ? ' has' : 's have'} expired and ${stale.length === 1 ? 'was' : 'were'} left out: ${stale.map(c => c.name).join(', ')}. Sign in again with "Open session setup" if the export does not work.`);
  const transient = cookies.filter(sessionOnly).map(c => c.name);
  if (transient.length) warn(`session-only cookies (${transient.join(', ')}) stop working when the site ends this login session; re-export after signing in again.`);
  for (const d of duplicates) warn(`cookie ${d.name} (${d.domain} ${d.path}) is saved in ${d.count} sessions; used the most recently saved (profile ${shortId(d.used.id)}, ${new Date(d.used.mtimeMs).toISOString()}).`);
  const repeated = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (repeated.length) warn(`cookie name${repeated.length === 1 ? '' : 's'} ${repeated.join(', ')} appear${repeated.length === 1 ? 's' : ''} more than once (different domain or path); servers usually read the first, release radar's --cookie-header keeps the last.`);
  const parents = [...new Set(cookies.filter(c => isParentDomain(c, host)).map(c => `${c.name} (${c.domain})`))];
  if (parents.length || cookies.length > WIDE_SELECTION) {
    const why = parents.length ? `cookies set on a parent domain: ${parents.join(', ')}` : `${cookies.length} cookies`;
    warn(`this export carries a wider login than ${host} alone (${why}).${only ? '' : ' Use --only (or VAR=<site>@name) to export just the cookies the tool needs.'}`);
  }
}

function noCookies(selection, label) {
  const { url, expired: stale, missing } = selection;
  if (missing.length && selection.cookies.length) return `${label}: ${url.href} has no live cookie named ${missing.join(', ')}${stale.some(c => missing.includes(c.name)) ? ' (expired)' : ''}`;
  if (missing.length) return `${label}: no live cookie named ${missing.join(', ')} would be sent to ${url.href}${stale.length ? ' (the saved ones have expired)' : ''}`;
  return `${label}: no saved cookies would be sent to ${url.href}${stale.length ? ` (${stale.length} matching cookie${stale.length === 1 ? ' has' : 's have'} expired)` : ''}`;
}

// `npm run` starts scripts in the package folder; a relative --out means the folder
// the command was typed in (INIT_CWD).
export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, dataPath = DATA_PATH, now = Date.now(), cwd = process.env.INIT_CWD || process.cwd() } = {}) {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv, allowPositionals: false, strict: true, options: {
          list: { type: 'boolean' }, site: { type: 'string' }, only: { type: 'string' },
          format: { type: 'string' }, var: { type: 'string' }, env: { type: 'string', multiple: true },
          out: { type: 'string' }, stdout: { type: 'boolean' }, force: { type: 'boolean' },
          merge: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
        }
      });
    } catch (error) { throw new ExportError(`${error.message}\n\n${USAGE}`); }
    const o = parsed.values;
    if (o.help) { stderr.write(USAGE + '\n'); return 0; }
    if (o.list) {
      if (o.site || o.env || o.out || o.stdout) throw new ExportError(`--list takes no other options.\n\n${USAGE}`);
      stdout.write(listSessions(loadSessions(dataPath), now));
      return 0;
    }
    if (!o.site && !o.env) throw new ExportError(`Choose --list, --site or --env.\n\n${USAGE}`);
    if (o.site && o.env) throw new ExportError('Use either --site or --env, not both.');
    if (o.env && (o.format && o.format !== 'env' || o.var || o.only)) throw new ExportError('--env already names the variable and format; use VAR=<site>@name,... instead of --only.');
    const format = o.env ? 'env' : (o.format || 'header');
    if (!['header', 'env', 'storage-state'].includes(format)) throw new ExportError(`Unknown --format ${format}: use header, env or storage-state.`);
    if (format === 'env' && o.site && !o.var) throw new ExportError('--format env needs --var NAME (for example --var RADAR_AUTH_VENDOR).');
    if (format !== 'env' && o.var) throw new ExportError('--var is only used with --format env.');
    if (o.var && !ENV_NAME.test(o.var)) throw new ExportError(`Invalid variable name "${o.var}": use capital letters, digits and _, not starting with a digit.`);
    if (o.out && o.stdout) throw new ExportError('Use either --out or --stdout, not both.');
    if (!o.out && !o.stdout) throw new ExportError(`Say where the cookies go: --out <file> (private, mode 600) or --stdout. They are a live login, so nothing is printed by default.\n\n${USAGE}`);
    if (o.merge && (!o.out || format !== 'env')) throw new ExportError('--merge updates an existing .env file: use it with --out and env output.');
    if (o.merge && o.force) throw new ExportError('Use either --merge or --force, not both.');

    const pairs = o.env ? o.env.map(parsePair) : [{ name: o.var, url: parseSite(o.site), only: o.only ? splitNames(o.only) : undefined }];
    const names = pairs.map(p => p.name).filter(Boolean);
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) throw new ExportError(`${twice} is given more than once.`);
    for (const pair of pairs) {
      if (pair.name === CONNECTWISE_ENV && pair.only && (pair.only.length !== 1 || pair.only[0] !== 'authtoken')) {
        throw new ExportError(`${CONNECTWISE_ENV} holds only the authtoken cookie; drop the other names.`);
      }
    }

    const { sessions } = loadSessions(dataPath);
    const selections = pairs.map(pair => ({
      pair,
      label: format === 'env' ? pair.name : 'site',
      // The ConnectWise variable can only ever carry authtoken.
      selection: selectCookies(sessions, pair.url, { now, only: pair.only || (format === 'env' && pair.name === CONNECTWISE_ENV ? ['authtoken'] : undefined) })
    }));
    for (const { selection, label } of selections) describe(selection, stderr, label);
    const empty = selections.filter(s => !s.selection.cookies.length || s.selection.missing.length);
    if (empty.length) {
      for (const s of empty) stderr.write(`missing: ${noCookies(s.selection, s.label)}\n`);
      throw new ExportError(`Nothing was written. See which sessions are saved with: npm run export-cookies -- --list`, 2);
    }

    let text, merge;
    if (format === 'header') text = formatHeader(selections[0].selection.cookies) + '\n';
    else if (format === 'storage-state') text = formatStorageState(selections[0].selection.cookies);
    else {
      const values = {};
      for (const { pair, selection } of selections) values[pair.name] = envValue(pair.name, selection.cookies);
      text = Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join('');
      if (o.merge) merge = old => mergeEnv(old, values);
    }

    if (o.stdout) {
      stdout.write(text);
      stderr.write(`Wrote ${format} output to standard output.\n`);
    } else {
      const path = writeSecret(resolve(cwd, o.out), text, { replace: o.force, merge });
      stderr.write(`${o.merge ? 'Updated' : 'Wrote'} ${path} (${format}, owner-only). Treat it like a password; never commit it.\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ExportError)) throw error;
    stderr.write(`export-cookies: ${error.message}\n`);
    return error.exitCode;
  }
}

// Compare real paths: argv[1] keeps symlinks as typed, import.meta.url does not.
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  process.exitCode = main();
}

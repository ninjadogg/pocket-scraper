#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SERVER_ENV, readSettings } from '../settings.js';

export const DEFAULT_LABEL = 'com.pocketscraper.server';

const xmlEscape = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

export function renderPlist({
  label = DEFAULT_LABEL,
  nodePath = process.execPath,
  workingDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  serverPath = join(workingDirectory, 'server.js'),
  logDir = join(workingDirectory, 'data', 'logs'),
  env = {}
} = {}) {
  // Everything the server reads except POCKET_SCRAPER_TOKEN, which stays out of the plist.
  const envEntries = {
    PATH: env.PATH || process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    ...Object.fromEntries(SERVER_ENV.filter(name => env[name]).map(name => [name, env[name]]))
  };
  const envXml = Object.entries(envEntries)
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(nodePath)}</string>
      <string>${xmlEscape(serverPath)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(logDir, 'launchd.out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(logDir, 'launchd.err.log'))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}

function writePlistAtomically(plistPath, content) {
  const dir = dirname(plistPath);
  mkdirSync(dir, { recursive: true });
  if (existsSync(plistPath) && lstatSync(plistPath).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink: ${plistPath}`);
  }
  const tmp = `${plistPath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, plistPath);
}

export function runLaunchdCli(argv = process.argv.slice(2), {
  uid = typeof process.getuid === 'function' ? process.getuid() : 501,
  home = homedir(),
  workingDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  nodePath = process.execPath,
  env = process.env,
  execLaunchctl = args => spawnSync('launchctl', args, { encoding: 'utf8' }),
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text)
} = {}) {
  let mode = 'print';
  let outPath = null;
  let label = DEFAULT_LABEL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--print') mode = 'print';
    else if (arg === '--write') mode = 'write';
    else if (arg === '--install') mode = 'install';
    else if (arg === '--uninstall') mode = 'uninstall';
    else if (arg === '--status') mode = 'status';
    else if (arg === '--out') {
      outPath = argv[++i];
      if (!outPath) throw new Error('--out requires a file path');
    } else if (arg === '--label') {
      label = argv[++i];
      if (!label) throw new Error('--label requires a label');
    } else throw new Error(`Unknown option: ${arg}`);
  }

  const plistPath = resolve(outPath || join(home, 'Library', 'LaunchAgents', `${label}.plist`));
  const logDir = join(workingDirectory, 'data', 'logs');
  const xml = renderPlist({ label, nodePath, workingDirectory, logDir, env });
  const domain = `gui/${uid}`;
  if (mode === 'write' || mode === 'install') {
    readSettings(env, text => stderr(`Warning: ${text}\n`));
    if (env.POCKET_SCRAPER_TOKEN) stderr('Note: POCKET_SCRAPER_TOKEN is not written to the plist; the LaunchAgent uses the key the server last saved in .api-auth.json.\n');
  }

  if (mode === 'print') {
    stdout(xml);
    return { mode, plistPath, xml };
  }

  if (mode === 'write') {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    writePlistAtomically(plistPath, xml);
    stderr(`Wrote LaunchAgent plist to ${plistPath}\n`);
    return { mode, plistPath, xml };
  }

  if (mode === 'install') {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    writePlistAtomically(plistPath, xml);
    execLaunchctl(['bootout', domain, plistPath]);
    // bootout returns before the old service is gone; bootstrapping too soon fails
    // with "Bootstrap failed: 5: Input/output error".
    for (let waited = 0; waited < 5000 && execLaunchctl(['print', `${domain}/${label}`]).status === 0; waited += 200) sleep(200);
    let res = execLaunchctl(['bootstrap', domain, plistPath]);
    if (res.status !== 0) {
      sleep(1000);
      res = execLaunchctl(['bootstrap', domain, plistPath]);
    }
    if (res.status !== 0) {
      throw new Error(`launchctl bootstrap failed: ${(res.stderr || res.stdout || '').trim()}`);
    }
    stderr(`Installed and started ${label} (${plistPath})\n`);
    return { mode, plistPath, xml };
  }

  if (mode === 'uninstall') {
    execLaunchctl(['bootout', domain, plistPath]);
    if (existsSync(plistPath)) rmSync(plistPath);
    stderr(`Uninstalled ${label} (${plistPath})\n`);
    return { mode, plistPath };
  }

  if (mode === 'status') {
    const res = execLaunchctl(['print', `${domain}/${label}`]);
    const loaded = res.status === 0;
    stdout(`${label}: ${loaded ? 'loaded' : 'not loaded'} (plist: ${existsSync(plistPath) ? plistPath : 'missing'})\n`);
    return { mode, plistPath, loaded };
  }
}

// Compare real paths: argv[1] keeps symlinks and spaces as typed, import.meta.url does not.
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  try {
    runLaunchdCli();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

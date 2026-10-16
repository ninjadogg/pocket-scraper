import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_PATH } from './store.js';

const path = join(dirname(DATA_PATH), '.api-auth.json');
let state;
function persist() {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + '.tmp', JSON.stringify(state), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export function authState() {
  if (!state) {
    state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { token: randomBytes(32).toString('hex'), origins: [] };
    if (process.env.POCKET_SCRAPER_TOKEN) state.token = process.env.POCKET_SCRAPER_TOKEN;
    if (!/^[a-f0-9]{64}$/.test(state.token)) throw new Error('Connection key must be 64 hexadecimal characters');
    persist();
  }
  return state;
}
export function validToken(header) {
  const expected = Buffer.from('Bearer ' + authState().token);
  const actual = Buffer.from(String(header || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function pairOrigin(origin) {
  if (!/^chrome-extension:\/\/[a-z]{32}$/.test(origin || '')) throw new Error('Pair from the Pocket Scraper extension');
  if (!authState().origins.includes(origin)) { state.origins.push(origin); persist(); }
}

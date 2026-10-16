import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, saveStore, normalizeRecipe, appendRun, addRecords } from './store.js';
import { scrape } from './runner.js';
import { sessionStatus, openSessionSetup, finishSessionSetup, sessionKey } from './browser-session.js';
import { importTabCapture } from './capture.js';

const PORT = Number(process.env.PORT || 3888);
const HOST = '127.0.0.1'; // Deliberately inaccessible over LAN.
const ROOT = dirname(fileURLToPath(import.meta.url));
let store = loadStore();
const running = new Set();

function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

async function body(req, limit = 250_000) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > limit) throw new Error('Payload too large');
  }
  return JSON.parse(data || '{}');
}

async function run(recipe) {
  if (running.has(recipe.id)) return { queued: false, message: 'Already running' };
  if (recipe.useBrowserSession && sessionStatus(recipe).busy) return { queued: false, message: 'Website session is busy' };
  running.add(recipe.id);
  const runRecord = { id: crypto.randomUUID(), recipeId: recipe.id, startedAt: new Date().toISOString(), status: 'running' };
  appendRun(store, runRecord);
  saveStore(store);
  try {
    const output = await scrape(recipe);
    runRecord.status = 'success';
    runRecord.rowCount = output.rows.length;
    runRecord.newCount = addRecords(store, recipe.id, output.rows, runRecord.id);
    runRecord.warnings = output.warnings;
  } catch (error) {
    runRecord.status = recipe.useBrowserSession && error.code === 'SESSION_ATTENTION' ? 'needs_attention' : 'error';
    if (runRecord.status === 'needs_attention') {
      for (const r of store.recipes) if (r.useBrowserSession && sessionKey(r) === sessionKey(recipe)) r.sessionNeedsAttention = true;
    }
    runRecord.error = error.message;
    console.error(`[${recipe.name}] ${error.stack || error}`);
  } finally {
    runRecord.finishedAt = new Date().toISOString();
    // Respect any schedule changes made while this run was executing.
    const latest = store.recipes.find(r => r.id === recipe.id);
    if (latest?.scheduleMinutes) latest.nextRunAt = new Date(Date.now() + latest.scheduleMinutes * 60_000).toISOString();
    saveStore(store);
    running.delete(recipe.id);
  }
  return runRecord;
}

function toCsv(records) {
  const fieldNames = [...new Set(records.flatMap(r => Object.keys(r.fields)))];
  const quoted = x => `"${String(x ?? '').replaceAll('"', '""')}"`;
  return [ ['observed_at', 'page_url', ...fieldNames].map(quoted).join(','),
    ...records.map(r => [r.observedAt, r.pageUrl, ...fieldNames.map(f => r.fields[f])].map(quoted).join(','))
  ].join('\r\n');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = !origin || /^chrome-extension:\/\/[a-z]{32}$/.test(origin) || origin === `http://${HOST}:${PORT}`;
  if (!allowed) return send(res, 403, { error: 'Not allowed from this origin' });
  if (origin?.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = url.pathname;
    if (p === '/' && req.method === 'GET') {
      return send(res, 200, readFileSync(join(ROOT, 'dashboard.html'), 'utf8'), 'text/html');
    }
    if (p === '/api/health') return send(res, 200, { ok: true, running: [...running], recipes: store.recipes.length });
    if (p === '/api/recipes' && req.method === 'GET') return send(res, 200, store.recipes.map(r => ({ ...r, session: sessionStatus(r) })));
    if (p === '/api/recipes' && req.method === 'POST') {
      const input = await body(req);
      const index = store.recipes.findIndex(r => r.id === input.id);
      const recipe = normalizeRecipe(input, index >= 0 ? store.recipes[index] : undefined);
      if (index >= 0) store.recipes[index] = recipe;
      else store.recipes.push(recipe);
      saveStore(store);
      return send(res, 200, recipe);
    }
    if (p.startsWith('/api/recipes/') && req.method === 'DELETE') {
      const id = p.slice('/api/recipes/'.length);
      store.recipes = store.recipes.filter(r => r.id !== id);
      saveStore(store);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/capture/') && req.method === 'POST') {
      const recipe = store.recipes.find(r => r.id === p.slice('/api/capture/'.length));
      if (!recipe) return send(res, 404, { error: 'Unknown recipe' });
      const result = importTabCapture(store, recipe, await body(req, 2_000_000));
      saveStore(store);
      return send(res, 200, result);
    }
    if (p.startsWith('/api/session/') && req.method === 'POST') {
      const [, , , id, action] = p.split('/');
      const recipe = store.recipes.find(r => r.id === id);
      if (!recipe) return send(res, 404, { error: 'Unknown recipe' });
      if (running.has(id)) return send(res, 409, { error: 'Wait for the current run to finish.' });
      if (action === 'open') {
        await openSessionSetup(recipe);
        recipe.useBrowserSession = true;
        recipe.sessionNeedsAttention = true;
      } else if (action === 'finish') {
        await finishSessionSetup(recipe);
        for (const r of store.recipes) if (sessionKey(r) === sessionKey(recipe)) r.sessionNeedsAttention = false;
      } else return send(res, 400, { error: 'Unknown session action' });
      saveStore(store);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/run/') && req.method === 'POST') {
      const id = p.slice('/api/run/'.length);
      const recipe = store.recipes.find(r => r.id === id);
      if (!recipe) return send(res, 404, { error: 'Unknown recipe' });
      if (recipe.useBrowserSession && sessionStatus(recipe).busy) return send(res, 409, { error: 'Website session is busy. Finish setup or wait for the current run.' });
      if (recipe.sessionNeedsAttention) return send(res, 409, { error: 'Complete session setup and click Finish setup before retrying.' });
      // Respond immediately; run status is visible in /api/runs.
      void run({ ...recipe });
      return send(res, 202, { ok: true, id });
    }
    if (p === '/api/runs' && req.method === 'GET') {
      const id = url.searchParams.get('recipeId');
      return send(res, 200, store.runs.filter(r => !id || r.recipeId === id).slice(0, 100));
    }
    if (p === '/api/records' && req.method === 'GET') {
      const id = url.searchParams.get('recipeId');
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      return send(res, 200, store.records.filter(r => !id || r.recipeId === id).slice(0, limit));
    }
    if (p.startsWith('/api/export/') && req.method === 'GET') {
      const id = p.slice('/api/export/'.length).replace(/\.csv$/, '');
      res.setHeader('Content-Disposition', `attachment; filename="${id}.csv"`);
      return send(res, 200, toCsv(store.records.filter(r => r.recipeId === id)), 'text/csv');
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return send(res, 400, { error: error.message });
  }
});

// Minimal persisted interval scheduler. Keep `npm start` running to trigger jobs.
setInterval(() => {
  const now = Date.now();
  for (const recipe of store.recipes) {
    if (!recipe.sessionNeedsAttention && !(recipe.useBrowserSession && sessionStatus(recipe).busy) && recipe.scheduleMinutes && recipe.nextRunAt && Date.parse(recipe.nextRunAt) <= now && !running.has(recipe.id)) {
      recipe.nextRunAt = new Date(now + recipe.scheduleMinutes * 60_000).toISOString();
      saveStore(store);
      void run({ ...recipe });
    }
  }
}, 10_000).unref();
server.listen(PORT, HOST, () => console.log(`Pocket Scraper: http://${HOST}:${server.address().port}`));

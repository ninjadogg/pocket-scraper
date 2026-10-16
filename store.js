import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export const DATA_PATH = process.env.POCKET_SCRAPER_DATA || join(root, 'data', 'store.json');
export const defaultStore = () => ({ recipes: [], runs: [], records: [] });

export function loadStore() {
  if (!existsSync(DATA_PATH)) return defaultStore();
  return { ...defaultStore(), ...JSON.parse(readFileSync(DATA_PATH, 'utf8')) };
}

export function saveStore(store) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, DATA_PATH);
}

export function normalizeRecipe(input, old) {
  const recipe = {
    id: old?.id || crypto.randomUUID(),
    name: String(input.name || '').trim().slice(0, 120),
    url: String(input.url || '').trim(),
    fields: (Array.isArray(input.fields) ? input.fields : []).map(f => ({
      name: String(f.name || '').trim().slice(0, 80),
      selector: String(f.selector || '').trim().slice(0, 500),
      kind: ['text', 'href', 'html', 'value'].includes(f.kind) ? f.kind : 'text'
    })),
    actions: (Array.isArray(input.actions) ? input.actions : []).map(a => ({
      selector: String(a.selector || '').trim().slice(0, 500),
      waitMs: Math.min(5000, Math.max(0, Number(a.waitMs) || 700))
    })),
    rowSelector: String(input.rowSelector || '').trim().slice(0, 500),
    nextSelector: String(input.nextSelector || '').trim().slice(0, 500),
    maxPages: Math.min(30, Math.max(1, Number(input.maxPages) || 1)),
    scheduleMinutes: Math.min(43200, Math.max(0, Number(input.scheduleMinutes) || 0)),
    createdAt: old?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextRunAt: null
  };
  if (!recipe.name) throw new Error('Recipe name is required');
  let url;
  try { url = new URL(recipe.url); } catch { throw new Error('Enter a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  const sameOrigin = old && new URL(old.url).origin === url.origin;
  recipe.useBrowserSession = input.useBrowserSession === undefined ? Boolean(sameOrigin && old.useBrowserSession) : input.useBrowserSession === true;
  recipe.sessionNeedsAttention = Boolean(sameOrigin && old.sessionNeedsAttention && recipe.useBrowserSession);
  if (!recipe.fields.length || recipe.fields.length > 30) throw new Error('Choose 1–30 fields');
  if (recipe.fields.some(f => !f.name || !f.selector)) throw new Error('Each field needs a name and CSS selector');
  if (new Set(recipe.fields.map(f => f.name)).size !== recipe.fields.length) throw new Error('Field names must be distinct');
  if (recipe.actions.length > 20 || recipe.actions.some(a => !a.selector)) throw new Error('Invalid click actions');
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 50) {
      throw new Error('Choose 1–50 workflow steps');
    }
    recipe.steps = input.steps.map(step => {
      if (!step || !['click', 'wait', 'extract'].includes(step.type)) throw new Error('Invalid workflow step');
      if (step.type === 'extract') return { type: 'extract' };
      const waitMs = Number(step.waitMs ?? (step.type === 'click' ? 700 : 1000));
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new Error('Step wait must be 0–30000 milliseconds');
      if (step.type === 'wait') return { type: 'wait', waitMs };
      const selector = String(step.selector || '').trim();
      if (!selector || selector.length > 500) throw new Error('Click step needs a selector (up to 500 characters)');
      return { type: 'click', selector, waitMs };
    });
    if (!recipe.steps.some(step => step.type === 'extract')) throw new Error('Add an Extract step');
    recipe.repeatCount = Number(input.repeatCount ?? 1);
    if (!Number.isInteger(recipe.repeatCount) || recipe.repeatCount < 1 || recipe.repeatCount > 30) {
      throw new Error('Repeat count must be a whole number from 1 to 30');
    }
  }
  if (recipe.scheduleMinutes) {
    // Editing other fields should not reset a running schedule unless cadence changed.
    recipe.nextRunAt = old?.scheduleMinutes === recipe.scheduleMinutes && old?.nextRunAt
      ? old.nextRunAt
      : new Date(Date.now() + recipe.scheduleMinutes * 60_000).toISOString();
  }
  return recipe;
}

export function appendRun(store, run) {
  store.runs.unshift(run);
  store.runs = store.runs.slice(0, 1000);
}

export function addRecords(store, recipeId, rows, runId) {
  let added = 0;
  const known = new Set(store.records.filter(r => r.recipeId === recipeId).map(r => r.key));
  for (const row of rows) {
    // URL and field values form the identity; changed values become new records.
    const payload = { pageUrl: row.pageUrl, fields: row.fields };
    const key = JSON.stringify(payload);
    if (known.has(key)) continue;
    known.add(key);
    store.records.unshift({ recipeId, runId, key, ...payload, observedAt: new Date().toISOString() });
    added++;
  }
  return added;
}

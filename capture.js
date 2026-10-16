import { appendRun, addRecords } from './store.js';

export function importTabCapture(store, recipe, input) {
  const pageUrl = new URL(input.pageUrl);
  if (!['http:', 'https:'].includes(pageUrl.protocol) || pageUrl.origin !== new URL(recipe.url).origin) throw new Error('Capture must come from the recipe’s website');
  if (!Array.isArray(input.rows) || input.rows.length > 5000) throw new Error('Capture must contain at most 5000 rows');
  if (!Array.isArray(input.warnings) || input.warnings.length > 30 || input.warnings.some(w => typeof w !== 'string' || w.length > 1000)) throw new Error('Invalid capture warnings');
  const rows = input.rows.map(row => {
    if (!row || row.pageUrl !== input.pageUrl || !row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) throw new Error('Invalid capture row');
    if (Object.keys(row.fields).length !== recipe.fields.length || recipe.fields.some(f => typeof row.fields[f.name] !== 'string')) throw new Error('Captured fields do not match this recipe');
    return { pageUrl: pageUrl.href, fields: Object.fromEntries(recipe.fields.map(f => [f.name, row.fields[f.name]])) };
  }).filter(row => Object.values(row.fields).some(Boolean));
  const now = new Date().toISOString();
  const run = { id: crypto.randomUUID(), recipeId: recipe.id, startedAt: now, finishedAt: now,
    source: 'chrome-tab', pageUrl: pageUrl.href, status: rows.length ? 'success' : 'error',
    rowCount: rows.length, newCount: 0, warnings: input.warnings };
  if (!rows.length) run.error = 'No text or values were collected. Pick the fields again on the current page.';
  run.newCount = addRecords(store, recipe.id, rows, run.id);
  appendRun(store, run);
  return run;
}

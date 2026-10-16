import { installPicker } from './picker.js';
const $ = id => document.getElementById(id);
const API = 'http://127.0.0.1:3888';
let draft = { fields: [], actions: [], maxPages: 1, scheduleMinutes: 0 };
let recipes = [];
const message = txt => { $('message').textContent = txt; };
async function api(path, options = {}) {
  const res = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function el(tag, content, attrs = {}) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  for (const [key, value] of Object.entries(attrs)) node[key] = value;
  return node;
}
function inputsToDraft() {
  if (draft.steps) draft.repeatCount = Number($('repeatCount').value);
  draft.name = $('name').value;
  draft.url = $('url').value;
  draft.maxPages = Number($('maxPages').value) || 1;
  draft.scheduleMinutes = Number($('schedule').value) || 0;
}
async function persist() { inputsToDraft(); await chrome.storage.local.set({ draft }); }
function showDraft() {
  $('name').value = draft.name || '';
  $('url').value = draft.url || '';
  $('maxPages').value = draft.maxPages || 1;
  $('schedule').value = String(draft.scheduleMinutes || 0);
  $('fields').replaceChildren();
  draft.fields ||= [];
  draft.fields.forEach((f, i) => {
    const line = el('div', undefined, { className: 'item' });
    const label = el('div', `${f.name} (${f.kind})`);
    const row = el('div', undefined, { className: 'row' });
    const input = el('input', undefined, { value: f.selector, title: 'CSS selector — edit if needed' });
    input.addEventListener('change', () => { f.selector = input.value; void persist(); });
    const remove = el('button', '×', { title: 'Remove field' });
    remove.onclick = async () => { draft.fields.splice(i, 1); await persist(); showDraft(); };
    row.append(input, remove); line.append(label, row); $('fields').append(line);
  });
  $('workflow').value = draft.steps ? 'steps' : 'legacy';
  $('workflowControls').hidden = !draft.steps;
  $('pickNext').disabled = Boolean(draft.steps);
  $('maxPages').disabled = Boolean(draft.steps);
  $('repeatCount').value = draft.repeatCount || 1;
  $('steps').replaceChildren();
  (draft.steps || []).forEach((step, i) => {
    const line = el('div', undefined, { className: 'item' });
    line.append(el('div', `${i + 1}. ${step.type === 'extract' ? 'Extract all selected fields' : step.type === 'click' ? 'Click element' : 'Wait'}`));
    if (step.type === 'click') {
      const selector = el('input', undefined, { value: step.selector, title: 'Click target' });
      selector.onchange = () => { step.selector = selector.value; void persist(); };
      line.append(selector);
    }
    if (step.type !== 'extract') {
      line.append(el('div', step.type === 'click' ? 'Wait after click (milliseconds)' : 'Wait (milliseconds)'));
      const wait = el('input', undefined, { type: 'number', min: '0', max: '30000', value: step.waitMs });
      wait.onchange = () => { step.waitMs = Number(wait.value); void persist(); };
      line.append(wait);
    }
    const row = el('div', undefined, { className: 'row' });
    for (const [label, delta] of [['Move up', -1], ['Move down', 1]]) {
      const move = el('button', label, { disabled: i + delta < 0 || i + delta >= draft.steps.length });
      move.onclick = async () => {
        [draft.steps[i], draft.steps[i + delta]] = [draft.steps[i + delta], draft.steps[i]];
        await persist(); showDraft();
      };
      row.append(move);
    }
    const remove = el('button', 'Remove');
    remove.onclick = async () => { draft.steps.splice(i, 1); await persist(); showDraft(); };
    row.append(remove); line.append(row); $('steps').append(line);
  });
  $('actions').hidden = Boolean(draft.steps);
  $('actions').replaceChildren();
  (draft.actions || []).forEach((a, i) => {
    const line = el('div', undefined, { className: 'row' });
    const input = el('input', undefined, { value: a.selector, title: 'Click before extracting' });
    input.addEventListener('change', () => { a.selector = input.value; void persist(); });
    const remove = el('button', '×', { title: 'Remove click step' });
    remove.onclick = async () => { draft.actions.splice(i, 1); await persist(); showDraft(); };
    line.append(input, remove); $('actions').append(line);
  });
  if (draft.nextSelector) {
    const line = el('div', undefined, { className: 'item' });
    line.append(el('span', 'Next-page selector'));
    const row = el('div', undefined, { className: 'row' });
    const input = el('input', undefined, { value: draft.nextSelector });
    input.addEventListener('change', () => { draft.nextSelector = input.value; void persist(); });
    const remove = el('button', '×');
    remove.onclick = async () => { draft.nextSelector = ''; await persist(); showDraft(); };
    row.append(input, remove); line.append(row); $('actions').append(line);
  }
  if (draft.lastPick) message('Selected ' + draft.lastPick);
}
async function pick(mode) {
  try {
    await persist();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open an HTTP(S) website tab first.');
    const fieldName = $('fieldName').value || `field_${draft.fields.length + 1}`;
    const kind = $('kind').value;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: installPicker, args: [mode, fieldName, kind] });
    message('Now click the element in the webpage.');
  } catch (e) { message('Error: ' + e.message); }
}
async function save() {
  await persist();
  const result = await api('/api/recipes', { method: 'POST', body: JSON.stringify(draft) });
  draft.id = result.id;
  await chrome.storage.local.set({ draft });
  await listRecipes();
  $('saved').value = result.id;
  return result;
}
async function listRecipes() {
  recipes = await api('/api/recipes');
  $('saved').replaceChildren(el('option', 'New recipe', { value: '' }));
  for (const r of recipes) $('saved').append(el('option', r.name, { value: r.id }));
}
$('workflow').onchange = async () => {
  if ($('workflow').value === 'steps') {
    draft.steps = [...(draft.actions || []).map(a => ({ ...a, type: 'click' })), { type: 'extract' }];
    $('repeatCount').value = 1;
  } else { delete draft.steps; delete draft.repeatCount; }
  await persist(); showDraft();
};
$('addWait').onclick = async () => { draft.steps.push({ type: 'wait', waitMs: 1000 }); await persist(); showDraft(); };
$('addExtract').onclick = async () => { draft.steps.push({ type: 'extract' }); await persist(); showDraft(); };
$('repeatCount').onchange = () => void persist();
$('pickField').onclick = () => pick('field');
$('pickAction').onclick = () => pick('action');
$('pickNext').onclick = () => pick('next');
$('save').onclick = async () => { try { await save(); message('Saved. Scheduler runs while npm start is running.'); } catch (e) { message('Error: ' + e.message); } };
$('run').onclick = async () => { try { const r = await save(); await api('/api/run/' + r.id, { method: 'POST' }); message('Run started. Open Results to view the output.'); } catch (e) { message('Error: ' + e.message); } };
$('capture').onclick = async () => {
  $('capture').disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open the website in this Chrome tab first.');
    inputsToDraft();
    if (new URL(tab.url).origin !== new URL(draft.url).origin) throw new Error('Open a page on the recipe’s website first.');
    const recipe = await save();
    message('Collecting fields from this Chrome tab…');
    const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB', tabId: tab.id, recipe });
    if (result.error) throw new Error(result.error);
    if (result.run.status === 'error') throw new Error(result.run.error);
    message(`Collected ${result.run.rowCount} rows (${result.run.newCount} new). ${result.run.warnings.join(' ')} Open Results to view them.`);
  } catch (error) { message('Error: ' + error.message); }
  finally { $('capture').disabled = false; }
};
$('dashboard').onclick = () => chrome.tabs.create({ url: API });
$('saved').onchange = async () => {
  const id = $('saved').value;
  if (id) draft = structuredClone(recipes.find(r => r.id === id));
  else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    draft = { name: '', url: /^https?:/.test(tab?.url || '') ? tab.url : '', fields: [], actions: [], maxPages: 1, scheduleMinutes: 0 };
  }
  await chrome.storage.local.set({ draft }); showDraft();
};
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const stored = await chrome.storage.local.get('draft');
    draft = stored.draft || { fields: [], actions: [], maxPages: 1, scheduleMinutes: 0 };
    if (!draft.url && /^https?:/.test(tab?.url || '')) draft.url = tab.url;
    showDraft();
    await listRecipes();
    if (draft.id) $('saved').value = draft.id;
  } catch (e) { message('Start server with npm start. ' + e.message); }
})();

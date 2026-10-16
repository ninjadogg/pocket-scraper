import { captureFields } from './capture.js';
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'PICK_RESULT') return;
  chrome.storage.local.get('draft').then(({ draft }) => {
    draft ||= { fields: [], actions: [], maxPages: 1, scheduleMinutes: 0 };
    if (message.mode === 'field') {
      const name = message.fieldName?.trim() || `field_${draft.fields.length + 1}`;
      const existing = draft.fields.findIndex(f => f.name === name);
      const field = { name, selector: message.selector, kind: message.kind || 'text' };
      if (existing >= 0) draft.fields[existing] = field;
      else draft.fields.push(field);
    } else if (message.mode === 'action') {
      if (draft.steps) draft.steps.push({ type: 'click', selector: message.selector, waitMs: 700 });
      else {
        draft.actions ||= [];
        draft.actions.push({ selector: message.selector, waitMs: 700 });
      }
    } else if (message.mode === 'next') {
      draft.nextSelector = message.selector;
      if ((draft.maxPages || 1) === 1) draft.maxPages = 5;
    }
    draft.lastPick = `${message.mode}: ${message.selector} (${message.matches} matches)`;
    return chrome.storage.local.set({ draft });
  }).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
  return true;
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'CAPTURE_TAB') return;
  (async () => {
    const recipe = message.recipe;
    const [capture] = await chrome.scripting.executeScript({ target: { tabId: message.tabId }, func: captureFields,
      args: [recipe.fields, new URL(recipe.url).origin] });
    if (!capture?.result) throw new Error('Could not read this page. Reopen the extension on the website and try again.');
    const payload = JSON.stringify(capture.result);
    if (new TextEncoder().encode(payload).length > 2_000_000) throw new Error('Capture is too large. Select fewer fields or a smaller page section.');
    const response = await fetch('http://127.0.0.1:3888/api/capture/' + encodeURIComponent(recipe.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload
    });
    const run = await response.json();
    if (!response.ok) throw new Error(run.error || 'Could not save capture');
    return { run };
  })().then(sendResponse).catch(error => sendResponse({ error: error.message }));
  return true;
});
